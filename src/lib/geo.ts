export const CITY_CENTER = { lat: 19.4326, lon: -99.1332 };

export function haversine(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const earth = 6371000;
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const dPhi = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h =
    Math.sin(dPhi / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return "—";
  if (meters < 950) return `${Math.max(0, Math.round(meters))} m`;
  const km = meters / 1000;
  return `${km >= 10 ? km.toFixed(0) : km.toFixed(1)} km`;
}

export function circleFeature(lon: number, lat: number, meters: number) {
  const steps = 64;
  const earth = 6378137;
  const coords: [number, number][] = [];
  for (let i = 0; i <= steps; i += 1) {
    const bearing = (i / steps) * Math.PI * 2;
    const dx = meters * Math.cos(bearing);
    const dy = meters * Math.sin(bearing);
    const dLat = (dy / earth) * (180 / Math.PI);
    const dLon = (dx / (earth * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI);
    coords.push([lon + dLon, lat + dLat]);
  }
  return {
    type: "Feature" as const,
    properties: {},
    geometry: { type: "Polygon" as const, coordinates: [coords] },
  };
}

export function clampMeters(value: number): number {
  if (!Number.isFinite(value)) return 500;
  return Math.min(2000, Math.max(150, Math.round(value / 50) * 50));
}
