import { create } from "zustand";
import { persist } from "zustand/middleware";
import { clampMeters } from "@/lib/geo";
import type { SavedRoute } from "@/lib/types";

export type Settings = {
  defaultAlertMeters: number;
  sound: boolean;
  vibrate: boolean;
  keepAwake: boolean;
};

export type ActiveTrip = {
  id: string;
  name: string;
  mode: SavedRoute["mode"];
  board: SavedRoute["board"];
  alight: SavedRoute["alight"];
  alertMeters: number;
  startedAt: number;
  alarmed: boolean;
};

export type ArrivalNote = {
  meters: number;
  name: string;
  at: number;
};

type State = {
  routes: SavedRoute[];
  settings: Settings;
  trip: ActiveTrip | null;
  lastArrival: ArrivalNote | null;
  saveRoute: (route: SavedRoute) => void;
  removeRoute: (id: string) => void;
  clearRoutes: () => void;
  updateSettings: (patch: Partial<Settings>) => void;
  startTrip: (trip: ActiveTrip) => void;
  markAlarmed: () => void;
  rearm: () => void;
  endTrip: () => void;
  noteArrival: (note: ArrivalNote) => void;
  dismissArrival: () => void;
};

const defaultSettings: Settings = {
  defaultAlertMeters: 500,
  sound: true,
  vibrate: true,
  keepAwake: true,
};

export const useCasillego = create<State>()(
  persist(
    (set) => ({
      routes: [],
      settings: defaultSettings,
      trip: null,
      lastArrival: null,
      saveRoute: (route) =>
        set((state) => ({
          routes: [route, ...state.routes.filter((item) => item.id !== route.id)].slice(0, 40),
        })),
      removeRoute: (id) =>
        set((state) => ({ routes: state.routes.filter((item) => item.id !== id) })),
      clearRoutes: () => set({ routes: [] }),
      updateSettings: (patch) =>
        set((state) => ({
          settings: {
            ...state.settings,
            ...patch,
            defaultAlertMeters: clampMeters(
              patch.defaultAlertMeters ?? state.settings.defaultAlertMeters,
            ),
          },
        })),
      startTrip: (trip) => set({ trip: { ...trip, alertMeters: clampMeters(trip.alertMeters) } }),
      markAlarmed: () =>
        set((state) => (state.trip ? { trip: { ...state.trip, alarmed: true } } : state)),
      rearm: () =>
        set((state) => (state.trip ? { trip: { ...state.trip, alarmed: false } } : state)),
      endTrip: () => set({ trip: null }),
      noteArrival: (note) => set({ lastArrival: note }),
      dismissArrival: () => set({ lastArrival: null }),
    }),
    { name: "casillego-v1", skipHydration: true },
  ),
);
