export const MODES = [
  { id: "metro", label: "Metro", hint: "Estaciones del STC" },
  { id: "cablebus", label: "Cablebús", hint: "Cablebús y Mexicable" },
  { id: "tren", label: "Tren", hint: "Suburbano, ligero, Insurgente" },
  { id: "bus", label: "Transporte", hint: "Metrobús, RTP, camión" },
  { id: "lugar", label: "Cualquier lugar", hint: "Un punto del mapa" },
] as const;

export type Mode = (typeof MODES)[number]["id"];

export type Place = {
  id: string;
  name: string;
  detail: string;
  lat: number;
  lon: number;
  kind: string;
};

export type SavedRoute = {
  id: string;
  name: string;
  mode: Mode;
  board: Place;
  alight: Place;
  alertMeters: number;
  everyday: boolean;
  updatedAt: number;
};

export function modeLabel(mode: Mode): string {
  return MODES.find((item) => item.id === mode)?.label ?? "Ruta";
}
