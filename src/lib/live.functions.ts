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

type PhotonFeature = {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    osm_id?: number;
    osm_type?: string;
    osm_key?: string;
    osm_value?: string;
    name?: string;
    street?: string;
    city?: string;
    district?: string;
    state?: string;
    countrycode?: string;
  };
};

type CacheBody = { places: Place[]; error: string | null };
const cache = new Map<string, { at: number; body: CacheBody }>();
const hits = new Map<string, number[]>();

let v4Ready = false;

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
  if (recent.length >= 40) {
    hits.set("all", recent);
    return true;
  }
  recent.push(now);
  hits.set("all", recent);
  return false;
}

function bboxFor(lat?: number | null, lon?: number | null): string {
  if (lat != null && lon != null) {
    const span = 0.55;
    return `${(lon - span).toFixed(4)},${(lat - span).toFixed(4)},${(lon + span).toFixed(4)},${(lat + span).toFixed(4)}`;
  }
  return "-100.05,18.95,-98.55,20.05";
}

function variants(mode: Mode, q: string): string[] {
  if (mode === "metro") return q.toLowerCase().includes("metro") ? [q] : [q, `${q} metro`];
  if (mode === "cablebus") return [q, `${q} cablebus`];
  if (mode === "tren") return q.toLowerCase().includes("tren") ? [q] : [q, `${q} tren`];
  if (mode === "bus") return [q, `${q} parada`];
  return [q];
}

function toPlace(feature: PhotonFeature, loose = false): Place | null {
  const coords = feature.geometry?.coordinates;
  const props = feature.properties;
  if (!coords || coords.length < 2 || !props) return null;
  const [lon, lat] = coords;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (props.countrycode && props.countrycode !== "MX") return null;
  const name = (props.name || props.street || "").trim();
  if (!name) return null;
  const key = props.osm_key || "";
  const value = props.osm_value || "";
  const where = [props.district, props.city, props.state].filter(Boolean).slice(0, 2).join(" · ");
  return {
    id: `${props.osm_type || "x"}:${props.osm_id || `${lat.toFixed(5)},${lon.toFixed(5)}`}`,
    name,
    detail: [kindLabel(key, value), where].filter(Boolean).join(" · "),
    lat,
    lon,
    kind: loose ? kindLabel(key, value) : kindLabel(key, value),
  };
}

async function photonSearch(
  q: string,
  bbox: string,
  lat?: number | null,
  lon?: number | null,
): Promise<PhotonFeature[]> {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", q);
  url.searchParams.set("limit", "8");
  url.searchParams.set("lang", "en");
  url.searchParams.set("bbox", bbox);
  if (lat != null && lon != null) {
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lon));
  }
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": UA },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error("search");
  const json = (await res.json()) as { features?: PhotonFeature[] };
  return json.features ?? [];
}

function rank(q: string, place: Place): number {
  const name = place.name.toLowerCase();
  const query = q.toLowerCase();
  let score = 0;
  if (name === query) score += 5;
  else if (name.startsWith(query)) score += 3;
  else if (name.includes(query)) score += 2;
  if (place.kind === "Estación" || place.kind === "Cable" || place.kind === "Parada") score += 1;
  return score;
}

export const searchPlaces = createServerFn({ method: "POST" })
  .validator((input: unknown) => searchSchema.parse(input))
  .handler(async ({ data }) => {
    const key = `s:${data.mode}:${data.q.toLowerCase()}:${data.lat ?? ""}:${data.lon ?? ""}`;
    const cached = recall(key);
    if (cached) return cached;
    if (await limited()) {
      return { places: [], error: "Demasiadas búsquedas. Espera un momento." };
    }
    await preferV4();
    const bbox = bboxFor(data.lat, data.lon);
    const seen = new Set<string>();
    const places: Place[] = [];
    try {
      for (const query of variants(data.mode, data.q)) {
        const features = await photonSearch(query, bbox, data.lat, data.lon);
        for (const feature of features) {
          const props = feature.properties;
          const name = props?.name || props?.street || "";
          const strict = matchesMode(data.mode, props?.osm_key || "", props?.osm_value || "", name);
          if (data.mode !== "lugar" && !strict) continue;
          const place = toPlace(feature);
          if (!place || seen.has(place.id)) continue;
          seen.add(place.id);
          places.push(place);
        }
        if (places.length >= 6) break;
      }
      if (places.length === 0 && data.mode !== "lugar") {
        const features = await photonSearch(data.q, bbox, data.lat, data.lon);
        for (const feature of features) {
          const place = toPlace(feature, true);
          if (!place || seen.has(place.id)) continue;
          seen.add(place.id);
          places.push(place);
          if (places.length >= 6) break;
        }
      }
      places.sort((a, b) => rank(data.q, b) - rank(data.q, a));
      const seenNames = new Set<string>();
      const unique = places.filter((place) => {
        const key = place.name.toLocaleLowerCase("es");
        if (seenNames.has(key)) return false;
        seenNames.add(key);
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
  return `[out:json][timeout:12];(${clause});out tags 16;`;
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
          signal: AbortSignal.timeout(9000),
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
          places.push({
            id: `${element.type}:${element.id}`,
            name,
            detail: [kindLabel(keyName, value), tags.network, tags.operator]
              .filter(Boolean)
              .slice(0, 2)
              .join(" · "),
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
    await preferV4();
    try {
      const url = new URL("https://photon.komoot.io/reverse");
      url.searchParams.set("lat", String(data.lat));
      url.searchParams.set("lon", String(data.lon));
      url.searchParams.set("lang", "en");
      const res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": UA },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) return { place: null as Place | null };
      const json = (await res.json()) as { features?: PhotonFeature[] };
      const place = toPlace(json.features?.[0] ?? {});
      return { place };
    } catch {
      return { place: null as Place | null };
    }
  });
