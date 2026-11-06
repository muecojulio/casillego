import type { Mode } from "@/lib/types";

export function matchesMode(mode: Mode, key: string, value: string, name: string): boolean {
  const k = key.toLowerCase();
  const v = value.toLowerCase();
  const n = name.toLowerCase();
  if (!n) return false;
  if (mode === "lugar") return true;
  if (mode === "cablebus") {
    return k === "aerialway" || n.includes("cable") || n.includes("mexicable");
  }
  if (mode === "bus") {
    return (
      v === "bus_stop" ||
      v === "bus_station" ||
      n.includes("metrobús") ||
      n.includes("metrobus") ||
      n.includes("mexibús") ||
      n.includes("mexibus") ||
      n.includes("parada") ||
      n.includes("rtp")
    );
  }
  if (mode === "metro") {
    const busish =
      v === "bus_stop" ||
      v === "bus_station" ||
      n.includes("metrobús") ||
      n.includes("metrobus") ||
      n.includes("mexibús");
    if (busish) return false;
    const station = k === "railway" && (v === "station" || v === "stop" || v === "halt" || v === "subway_entrance");
    return station || v === "subway" || n.includes("metro");
  }
  const station = k === "railway" && (v === "station" || v === "stop" || v === "halt");
  return (
    station ||
    n.includes("tren") ||
    n.includes("suburbano") ||
    n.includes("insurgente") ||
    n.includes("ligero")
  );
}

export function kindLabel(key: string, value: string): string {
  const k = key.toLowerCase();
  const v = value.toLowerCase();
  if (k === "aerialway") return "Cable";
  if (v === "bus_stop") return "Parada";
  if (v === "bus_station") return "Central";
  if (k === "railway") return "Estación";
  if (k === "highway") return "Calle";
  return "Lugar";
}
