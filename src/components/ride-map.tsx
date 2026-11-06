import { useEffect, useRef, useState } from "react";
import type { GeoJSONSource, Map as MlMap, Marker } from "maplibre-gl";
import { circleFeature } from "@/lib/geo";

const STYLE = "https://tiles.openfreemap.org/styles/liberty";
const SIGNAL = "#e39a3c";
const EMPTY = { type: "FeatureCollection" as const, features: [] };

type Pin = { lat: number; lon: number } | null;

type Props = {
  center: { lat: number; lon: number };
  user?: Pin;
  board?: Pin;
  alight?: Pin;
  radiusMeters?: number;
  focus?: Pin;
  onPick?: (pin: { lat: number; lon: number }) => void;
  className?: string;
};

export function RideMap({
  center,
  user = null,
  board = null,
  alight = null,
  radiusMeters = 0,
  focus = null,
  onPick,
  className,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const onPickRef = useRef(onPick);
  const followed = useRef(false);
  const [ready, setReady] = useState(0);
  const [failed, setFailed] = useState(false);
  onPickRef.current = onPick;

  useEffect(() => {
    let dead = false;
    let map: MlMap | null = null;
    void (async () => {
      const ml = await import("maplibre-gl");
      if (dead || !hostRef.current) return;
      ml.setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");
      map = new ml.Map({
        container: hostRef.current,
        style: STYLE,
        center: [center.lon, center.lat],
        zoom: 13,
        attributionControl: { compact: true },
      });
      map.addControl(new ml.NavigationControl({ showCompass: false }), "top-right");
      map.on("click", (event) => {
        onPickRef.current?.({ lat: event.lngLat.lat, lon: event.lngLat.lng });
      });
      map.on("load", () => {
        if (!map?.getSource("radius")) {
          map?.addSource("radius", { type: "geojson", data: EMPTY });
          map?.addLayer({
            id: "radius-fill",
            type: "fill",
            source: "radius",
            paint: { "fill-color": SIGNAL, "fill-opacity": 0.16 },
          });
          map?.addLayer({
            id: "radius-line",
            type: "line",
            source: "radius",
            paint: { "line-color": SIGNAL, "line-width": 1.5 },
          });
        }
        map?.resize();
        setReady((value) => value + 1);
      });
      mapRef.current = map;
    })().catch(() => {
      if (!dead) setFailed(true);
    });
    const host = hostRef.current;
    const observer =
      host && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => mapRef.current?.resize())
        : null;
    observer?.observe(host as Element);
    return () => {
      dead = true;
      observer?.disconnect();
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !user || followed.current || focus) return;
    followed.current = true;
    map.flyTo({ center: [user.lon, user.lat], zoom: 14, essential: true });
  }, [user, ready, focus]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focus || ready === 0) return;
    map.flyTo({ center: [focus.lon, focus.lat], zoom: 14, essential: true });
  }, [focus?.lat, focus?.lon, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || ready === 0) return;
    let cancelled = false;
    void (async () => {
      const ml = await import("maplibre-gl");
      if (cancelled || mapRef.current !== map) return;
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
      const add = (pin: Pin, className: string, label: string) => {
        if (!pin) return;
        const el = document.createElement("div");
        el.className = className;
        el.title = label;
        const marker = new ml.Marker({ element: el }).setLngLat([pin.lon, pin.lat]).addTo(map);
        markersRef.current.push(marker);
      };
      add(board, "casillego-board", "Subes");
      add(alight, "casillego-alight", "Bajas");
      add(user, "casillego-user", "Tú");
      const source = map.getSource("radius") as GeoJSONSource | undefined;
      if (!source) return;
      if (alight && radiusMeters > 0) {
        source.setData(circleFeature(alight.lon, alight.lat, radiusMeters));
      } else {
        source.setData(EMPTY);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [board, alight, user, radiusMeters, ready]);

  return (
    <div className="relative">
      <div
        ref={hostRef}
        className={`overflow-hidden bg-surface ${onPick ? "cursor-crosshair" : ""} ${className ?? "h-72 w-full"}`}
      />
      {failed ? (
        <p className="pointer-events-none absolute inset-x-4 bottom-4 rounded-2xl bg-bg/90 px-3 py-2 text-sm text-fg">
          El mapa no cargó. Puedes escribir la estación o la dirección.
        </p>
      ) : null}
    </div>
  );
}
