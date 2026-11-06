import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { kindLabel, matchesMode } from "@/lib/match-place";
import type { Mode, Place } from "@/lib/types";

const UA = "Casillego/1.0 (alarma de llegada; uso personal)";

const modeSchema = z.enum(["metro", "cablebus", "tren", "bus", "lugar"]);

const searchSchema = z.object({
  q: z.string().trim().min(2).max(80),
  mode: modeSchema,
  lat: z.number().gte(-90).lte(90).nullish(),
  lon: z.number().gte(-180).lte(180).nullish(),
});

const pointSchema = z.object({
  mode: modeSchema,
  lat: z.number().gte(-90).lte(90),
  lon: z.number().gte(-180).lte(180),
});

const reverseSchema = z.object({
  lat: z.number().gte(-90).lte(90),
  lon: z.number().gte(-180).lte(180),
});

type NomHit = {
  osm_id?: number;
  osm_type?: string;
  lat?: string;
  lon?: string;
  category?: string;
  type?: string;
  name?: string;
  display_name?: string;
  extratags?: Record<string, string>;
  address?: {
    city?: string;
    town?: string;
    suburb?: string;
    neighbourhood?: string;
    state?: string;
    road?: string;
  };
};

type CacheBody = { places: Place[]; error: string | null };
const cache = new Map<string, { at: number; body: CacheBody }>();
const hits = new Map<string, number[]>();

let v4Ready = false;
let paceChain: Promise<void> = Promise.resolve();
let lastCall = 0;

async function preferV4() {
  if (v4Ready) return;
  try {
    const dns = await import("node:dns");
    dns.setDefaultResultOrder("ipv4first");
    v4Ready = true;
  } catch {
    v4Ready = true;
  }
}

function remember(key: string, body: CacheBody): CacheBody {
  if (cache.size > 80) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), body });
  return body;
}

function recall(key: string): CacheBody | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > 120_000) {
    cache.delete(key);
    return null;
  }
  return hit.body;
}

async function limited(): Promise<boolean> {
  const now = Date.now();
  const recent = (hits.get("all") ?? []).filter((stamp) => now - stamp < 60_000);
  if (recent.length >= 30) {
    hits.set("all", recent);
    return true;
  }
  recent.push(now);
  hits.set("all", recent);
  return false;
}

function pace() {
  const run = paceChain.then(async () => {
    const wait = Math.max(0, lastCall + 1100 - Date.now());
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCall = Date.now();
  });
  paceChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function viewbox(lat?: number | null, lon?: number | null) {
  const la = lat ?? 19.43;
  const lo = lon ?? -99.14;
  const span = lat != null && lon != null ? 0.35 : 0.55;
  return `${(lo - span).toFixed(3)},${(la + span).toFixed(3)},${(lo + span).toFixed(3)},${(la - span).toFixed(3)}`;
}

function formatLines(raw: string | undefined): string | null {
  if (!raw) return null;
  const parts = raw
    .split(/[;,|]/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  return parts
    .map((part) => {
      if (/l[ií]nea/i.test(part)) return part.replace(/\s+/g, " ");
      if (/^([0-9]{1,2}|[A-Za-z])$/.test(part)) return `Línea ${part.toUpperCase()}`;
      return part;
    })
    .join(", ");
}

function lineFromTags(tags: Record<string, string | undefined> | undefined): string | null {
  if (!tags) return null;
  const lines = formatLines(tags.line || tags.route_ref || tags["route:ref"]);
  const network = (tags.network || "").trim();
  const known = /metro|cable|suburbano|insurgente|metrob[uú]s|mexib[uú]s|tren ligero|rtp/i.test(network)
    ? network
    : "";
  return [lines, known].filter(Boolean).join(" · ") || null;
}

function toPlace(hit: NomHit): Place | null {
  const lat = Number(hit.lat);
  const lon = Number(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const name = (hit.name || hit.address?.road || hit.display_name?.split(",")[0] || "").trim();
  if (!name) return null;
  const where = [hit.address?.neighbourhood || hit.address?.suburb, hit.address?.city || hit.address?.town || hit.address?.state]
    .filter(Boolean)
    .slice(0, 2)
    .join(" · ");
  const key = hit.category || "";
  const value = hit.type || "";
  const line = lineFromTags(hit.extratags);
  return {
    id: `${hit.osm_type || "x"}:${hit.osm_id || `${lat.toFixed(5)},${lon.toFixed(5)}`}`,
    name,
    detail: [kindLabel(key, value), line, where].filter(Boolean).join(" · "),
    lat,
    lon,
    kind: kindLabel(key, value),
  };
}

async function nominatim(path: string, params: Record<string, string>): Promise<unknown> {
  await preferV4();
  await pace();
  const url = new URL(`https://nominatim.openstreetmap.org/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Language": "es",
      "User-Agent": UA,
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error("nominatim");
  return res.json();
}

function rank(q: string, place: Place, modeHit: boolean): number {
  const name = place.name.toLocaleLowerCase("es");
  const query = q.toLocaleLowerCase("es");
  let score = modeHit ? 4 : 0;
  if (name === query) score += 6;
  else if (name.startsWith(query)) score += 4;
  else if (name.includes(query) || query.includes(name)) score += 2;
  if (place.kind === "Estación" || place.kind === "Cable" || place.kind === "Parada") score += 1;
  return score;
}

export const searchPlaces = createServerFn({ method: "POST" })
  .validator((input: unknown) => searchSchema.parse(input))
  .handler(async ({ data }) => {
    const key = `s:${data.mode}:${data.q.toLocaleLowerCase("es")}:${data.lat ?? ""}:${data.lon ?? ""}`;
    const cached = recall(key);
    if (cached) return cached;
    if (await limited()) {
      return { places: [], error: "Demasiadas búsquedas. Espera un momento." };
    }
    try {
      const json = (await nominatim("search", {
        q: data.q,
        format: "jsonv2",
        limit: "8",
        addressdetails: "1",
        extratags: "1",
        countrycodes: "mx",
        viewbox: viewbox(data.lat, data.lon),
      })) as NomHit[];
      const seen = new Set<string>();
      const places: Array<{ place: Place; modeHit: boolean }> = [];
      for (const hit of json) {
        const place = toPlace(hit);
        if (!place || seen.has(place.id)) continue;
        seen.add(place.id);
        places.push({
          place,
          modeHit: matchesMode(data.mode, hit.category || "", hit.type || "", place.name),
        });
      }
      places.sort((a, b) => rank(data.q, b.place, b.modeHit) - rank(data.q, a.place, a.modeHit));
      const seenNames = new Set<string>();
      const unique = places
        .map((item) => item.place)
        .filter((place) => {
          const label = `${place.name.toLocaleLowerCase("es")}|${place.lat.toFixed(3)}`;
          if (seenNames.has(label)) return false;
          seenNames.add(label);
          return true;
        });
      return remember(key, { places: unique.slice(0, 6), error: null });
    } catch {
      return { places: [], error: "No se pudo consultar lugares en vivo. Intenta de nuevo." };
    }
  });

const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
];

function overpassBody(mode: Mode, lat: number, lon: number): string {
  const la = lat.toFixed(5);
  const lo = lon.toFixed(5);
  const clause =
    mode === "cablebus"
      ? `node["aerialway"="station"](around:2200,${la},${lo});`
      : mode === "bus"
        ? `node["highway"="bus_stop"](around:700,${la},${lo});node["amenity"="bus_station"](around:900,${la},${lo});`
        : mode === "lugar"
          ? `node["railway"="station"](around:1200,${la},${lo});node["highway"="bus_stop"](around:600,${la},${lo});node["aerialway"="station"](around:1800,${la},${lo});`
          : `node["railway"="station"](around:1400,${la},${lo});node["railway"="halt"](around:1400,${la},${lo});node["station"="subway"](around:1400,${la},${lo});`;
  return `[out:json][timeout:8];(${clause});out tags 16;`;
}

export const nearbyPlaces = createServerFn({ method: "POST" })
  .validator((input: unknown) => pointSchema.parse(input))
  .handler(async ({ data }) => {
    const key = `n:${data.mode}:${data.lat.toFixed(3)}:${data.lon.toFixed(3)}`;
    const cached = recall(key);
    if (cached) return cached;
    if (await limited()) return { places: [], error: "Demasiadas búsquedas. Espera un momento." };
    await preferV4();
    const body = new URLSearchParams({ data: overpassBody(data.mode, data.lat, data.lon) });
    for (const endpoint of OVERPASS) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { Accept: "application/json", "User-Agent": UA },
          body,
          signal: AbortSignal.timeout(7000),
        });
        if (!res.ok) continue;
        const json = (await res.json()) as {
          elements?: Array<{
            type: string;
            id: number;
            lat?: number;
            lon?: number;
            tags?: Record<string, string>;
          }>;
        };
        const places: Place[] = [];
        for (const element of json.elements ?? []) {
          const tags = element.tags ?? {};
          const name = tags.name || tags.ref;
          if (!name || element.lat == null || element.lon == null) continue;
          const keyName = tags.railway
            ? "railway"
            : tags.aerialway
              ? "aerialway"
              : tags.highway
                ? "highway"
                : tags.amenity
                  ? "amenity"
                  : "public_transport";
          const value = tags[keyName] || tags.station || "yes";
          if (!matchesMode(data.mode, keyName, value, name) && data.mode !== "lugar") continue;
          const line = lineFromTags(tags);
          places.push({
            id: `${element.type}:${element.id}`,
            name,
            detail: [kindLabel(keyName, value), line || tags.operator].filter(Boolean).join(" · "),
            lat: element.lat,
            lon: element.lon,
            kind: kindLabel(keyName, value),
          });
          if (places.length >= 12) break;
        }
        return remember(key, { places, error: null });
      } catch {
        /* try the next public mirror */
      }
    }
    return {
      places: [],
      error: "Las estaciones cercanas no respondieron. Busca por nombre: eso sigue en vivo.",
    };
  });

export const reversePlace = createServerFn({ method: "POST" })
  .validator((input: unknown) => reverseSchema.parse(input))
  .handler(async ({ data }) => {
    if (await limited()) return { place: null as Place | null };
    try {
      const json = (await nominatim("reverse", {
        lat: String(data.lat),
        lon: String(data.lon),
        format: "jsonv2",
        addressdetails: "1",
        extratags: "1",
        zoom: "18",
      })) as NomHit;
      return { place: toPlace(json) };
    } catch {
      return { place: null as Place | null };
    }
  });
