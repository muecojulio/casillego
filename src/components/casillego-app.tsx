import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import * as Slider from "@radix-ui/react-slider";
import * as Switch from "@radix-ui/react-switch";
import {
  Bell,
  Bus,
  Cable,
  LocateFixed,
  Map as MapIcon,
  MapPin,
  Plus,
  Route,
  Settings,
  Shield,
  Square,
  TrainFront,
  TramFront,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import { acquireWake, releaseWake, startSiren, startVibrate, stopAlarm, unlockAudio } from "@/lib/alarm";
import { CITY_CENTER, clampMeters, formatDistance, haversine } from "@/lib/geo";
import { nearbyPlaces, reversePlace, searchPlaces } from "@/lib/live.functions";
import { useCasillego, type ActiveTrip } from "@/lib/store";
import { MODES, modeLabel, type Mode, type Place, type SavedRoute } from "@/lib/types";
import { RideMap } from "@/components/ride-map";

type Tab = "hoy" | "rutas" | "mapa" | "ajustes";

type Draft = {
  mode: Mode;
  board: Place | null;
  alight: Place | null;
  alertMeters: number;
  everyday: boolean;
  name: string;
};

type View =
  | { id: Tab }
  | { id: "composer"; draft: Draft }
  | { id: "pick"; draft: Draft; field: "board" | "alight" }
  | { id: "trip" };

type Fix = { lat: number; lon: number; acc: number };

const PRESETS = [250, 400, 600, 900, 1500];

const primary =
  "press inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-signal px-5 text-base font-medium text-bg disabled:opacity-40";
const quiet =
  "press inline-flex h-12 items-center justify-center gap-2 rounded-full border border-fg/15 bg-surface px-4 text-fg";

export function Mark() {
  return (
    <svg viewBox="0 0 48 28" className="h-7 w-12 text-fg" aria-hidden="true">
      <path d="M2 20h44" stroke="currentColor" strokeWidth="1.6" fill="none" />
      <circle cx="33" cy="13" r="4.5" fill="var(--color-signal)" />
    </svg>
  );
}

function modeIcon(mode: Mode) {
  if (mode === "metro") return TrainFront;
  if (mode === "cablebus") return Cable;
  if (mode === "tren") return TramFront;
  if (mode === "bus") return Bus;
  return MapPin;
}

function blankDraft(meters: number): Draft {
  return {
    mode: "metro",
    board: null,
    alight: null,
    alertMeters: clampMeters(meters),
    everyday: true,
    name: "",
  };
}

function gpsMessage(code: number) {
  if (code === 1) {
    return "Ubicación bloqueada. En el iPhone: Ajustes, Privacidad, Localización, y permite Casillego o Safari al usarla.";
  }
  if (code === 2) return "No hay señal de ubicación ahora.";
  if (code === 3) return "La ubicación tardó demasiado. Prueba en un lugar más abierto.";
  return "No se pudo leer la ubicación.";
}

async function here(): Promise<Fix> {
  const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 4000,
    });
  });
  return { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy };
}

export function CasillegoApp() {
  const routes = useCasillego((state) => state.routes);
  const settings = useCasillego((state) => state.settings);
  const trip = useCasillego((state) => state.trip);
  const [view, setView] = useState<View>({ id: "hoy" });
  const [fix, setFix] = useState<Fix | null>(null);
  const [distance, setDistance] = useState<number | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [alarming, setAlarming] = useState(false);
  const [silenced, setSilenced] = useState(false);
  const firedRef = useRef(false);
  const insideRef = useRef(0);

  useEffect(() => {
    let live = true;
    void Promise.resolve(useCasillego.persist.rehydrate()).finally(() => {
      if (!live) return;
      if (useCasillego.getState().trip) setView({ id: "trip" });
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!trip) {
      setDistance(null);
      setAlarming(false);
      return;
    }
    if (trip.alarmed) {
      firedRef.current = true;
      setAlarming(true);
    } else {
      firedRef.current = false;
      setAlarming(false);
    }
    insideRef.current = 0;
    setGpsError(null);
    if (useCasillego.getState().settings.keepAwake) void acquireWake();
    if (!("geolocation" in navigator)) {
      setGpsError("Este navegador no comparte la ubicación.");
      return;
    }
    const watch = navigator.geolocation.watchPosition(
      (pos) => {
        const current = useCasillego.getState().trip;
        if (!current) return;
        const next = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          acc: pos.coords.accuracy,
        };
        setFix(next);
        const dist = haversine(next, current.alight);
        setDistance(dist);
        const accOk = !Number.isFinite(next.acc) || next.acc < Math.max(90, current.alertMeters);
        if (dist <= current.alertMeters && accOk) insideRef.current += 1;
        else if (dist > current.alertMeters * 1.3) insideRef.current = 0;
        if (insideRef.current >= 2 && !firedRef.current && !current.alarmed) {
          firedRef.current = true;
          setSilenced(false);
          useCasillego.getState().markAlarmed();
          setAlarming(true);
          const prefs = useCasillego.getState().settings;
          if (prefs.sound) startSiren();
          if (prefs.vibrate) startVibrate();
        }
      },
      (err) => setGpsError(gpsMessage(err.code)),
      { enableHighAccuracy: true, maximumAge: 4000, timeout: 20000 },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, [trip?.startedAt]);

  useEffect(() => {
    const onVis = () => {
      const state = useCasillego.getState();
      if (document.visibilityState === "visible" && state.trip && state.settings.keepAwake) {
        void acquireWake();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  useEffect(() => {
    document.title = alarming ? "Ya casi llegas · Casillego" : "Casillego";
  }, [alarming]);

  function openComposer(seed?: Partial<Draft>) {
    setView({
      id: "composer",
      draft: { ...blankDraft(settings.defaultAlertMeters), ...seed },
    });
  }

  function begin(draft: Draft) {
    if (!draft.board || !draft.alight) return;
    unlockAudio();
    const name = draft.name.trim() || `${draft.board.name} → ${draft.alight.name}`;
    const id = crypto.randomUUID();
    const saved: SavedRoute = {
      id,
      name,
      mode: draft.mode,
      board: draft.board,
      alight: draft.alight,
      alertMeters: draft.alertMeters,
      everyday: draft.everyday,
      updatedAt: Date.now(),
    };
    if (draft.everyday) useCasillego.getState().saveRoute(saved);
    launch({
      id,
      name,
      mode: draft.mode,
      board: draft.board,
      alight: draft.alight,
      alertMeters: draft.alertMeters,
      startedAt: Date.now(),
      alarmed: false,
    });
  }

  function launch(next: ActiveTrip) {
    unlockAudio();
    stopAlarm();
    setSilenced(false);
    firedRef.current = false;
    insideRef.current = 0;
    useCasillego.getState().startTrip(next);
    if (useCasillego.getState().settings.keepAwake) void acquireWake();
    setView({ id: "trip" });
  }

  function finish() {
    stopAlarm();
    void releaseWake();
    firedRef.current = false;
    insideRef.current = 0;
    setAlarming(false);
    setSilenced(false);
    useCasillego.getState().endTrip();
    setView({ id: "hoy" });
  }

  const tab: Tab = view.id === "rutas" || view.id === "mapa" || view.id === "ajustes" ? view.id : "hoy";
  const showDock = view.id !== "pick" && view.id !== "composer";

  return (
    <div className="mx-auto flex min-h-dvh max-w-lg flex-col overflow-x-hidden bg-bg text-fg">
      <p className="sr-only" aria-live="assertive">
        {alarming && trip
          ? `Ya casi llegas a ${trip.alight.name}. ${distance != null ? formatDistance(distance) : ""}`
          : ""}
      </p>
      {view.id === "composer" ? (
        <Composer
          draft={view.draft}
          fix={fix}
          onChange={(draft) => setView({ id: "composer", draft })}
          onClose={() => setView({ id: "hoy" })}
          onPick={(field) => setView({ id: "pick", draft: view.draft, field })}
          onLocate={setFix}
          onStart={() => begin(view.draft)}
        />
      ) : null}
      {view.id === "pick" ? (
        <PickScreen
          draft={view.draft}
          field={view.field}
          fix={fix}
          onCancel={() => setView({ id: "composer", draft: view.draft })}
          onUse={(place) =>
            setView({
              id: "composer",
              draft: { ...view.draft, [view.field]: place },
            })
          }
        />
      ) : null}
      {view.id !== "composer" && view.id !== "pick" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {view.id === "trip" && trip ? (
            <TripScreen
              trip={trip}
              fix={fix}
              distance={distance}
              gpsError={gpsError}
              onStop={finish}
            />
          ) : null}
          {view.id === "hoy" ? (
            <Home
              routes={routes}
              trip={trip}
              onNew={() => openComposer()}
              onOpenTrip={() => setView({ id: "trip" })}
              onStart={launch}
            />
          ) : null}
          {view.id === "rutas" ? (
            <RoutesScreen
              routes={routes}
              onNew={() => openComposer()}
              onStart={launch}
            />
          ) : null}
          {view.id === "mapa" ? (
            <MapScreen
              fix={fix}
              onFix={setFix}
              onCreate={(alight, mode) => openComposer({ alight, mode, board: null })}
            />
          ) : null}
          {view.id === "ajustes" ? <SettingsScreen fix={fix} onFix={setFix} /> : null}
        </div>
      ) : null}

      {trip && view.id !== "trip" && view.id !== "pick" && view.id !== "composer" ? (
        <button
          type="button"
          className="press mx-4 mb-3 flex items-center justify-between rounded-full bg-signal px-4 py-3 text-left text-bg"
          onClick={() => setView({ id: "trip" })}
        >
          <span className="text-sm font-medium">Viaje en curso · {trip.alight.name}</span>
          <span className="font-display text-lg">
            {distance != null ? formatDistance(distance) : "GPS"}
          </span>
        </button>
      ) : null}

      {showDock ? (
        <nav className="dock sticky bottom-0 grid grid-cols-4 border-t border-fg/10 bg-bg/95 backdrop-blur">
          <DockButton id="hoy" current={tab} icon={Bell} label="Hoy" onClick={() => setView({ id: "hoy" })} />
          <DockButton id="rutas" current={tab} icon={Route} label="Rutas" onClick={() => setView({ id: "rutas" })} />
          <DockButton id="mapa" current={tab} icon={MapIcon} label="Mapa" onClick={() => setView({ id: "mapa" })} />
          <DockButton
            id="ajustes"
            current={tab}
            icon={Settings}
            label="Ajustes"
            onClick={() => setView({ id: "ajustes" })}
          />
        </nav>
      ) : null}

      {alarming && trip ? (
        <div className="fixed inset-0 z-50 flex flex-col bg-bg px-6 pb-10 pt-16">
          <div className="relative mx-auto mt-4 size-40">
            {!silenced ? (
              <span className="absolute inset-0 rounded-full bg-signal/30 motion-safe:animate-ping" />
            ) : null}
            <span className="absolute inset-8 grid place-items-center rounded-full bg-signal text-bg">
              <Bell className="size-8" />
            </span>
          </div>
          <h2 className="mt-8 text-center font-display text-5xl leading-none">Ya casi llegas</h2>
          <p className="mt-3 text-center text-lg text-fg">{trip.alight.name}</p>
          <p className="mt-6 text-center font-display text-4xl text-signal">
            {distance != null ? formatDistance(distance) : "Buscando señal"}
          </p>
          <p className="mt-2 text-center text-sm text-muted">
            Aviso a {formatDistance(trip.alertMeters)}
            {silenced ? " · silencio" : ""}
          </p>
          <div className="mt-auto grid gap-3">
            <button
              type="button"
              className={quiet}
              onClick={() => {
                stopAlarm();
                setSilenced(true);
              }}
            >
              <Volume2 className="size-4" />
              Silenciar
            </button>
            <button
              type="button"
              className={quiet}
              onClick={() => {
                stopAlarm();
                firedRef.current = false;
                insideRef.current = 0;
                setSilenced(false);
                setAlarming(false);
                useCasillego.getState().rearm();
              }}
            >
              Volver a armar
            </button>
            <button type="button" className={primary} onClick={finish}>
              <Square className="size-4" />
              Ya bajé
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DockButton({
  id,
  current,
  icon: Icon,
  label,
  onClick,
}: {
  id: Tab;
  current: Tab;
  icon: typeof Bell;
  label: string;
  onClick: () => void;
}) {
  const active = id === current;
  return (
    <button
      type="button"
      className={`press flex h-16 flex-col items-center justify-center gap-1 text-xs ${active ? "text-signal" : "text-muted"}`}
      onClick={onClick}
    >
      <Icon className="size-5" strokeWidth={1.75} />
      {label}
    </button>
  );
}

function Home({
  routes,
  trip,
  onNew,
  onOpenTrip,
  onStart,
}: {
  routes: SavedRoute[];
  trip: ActiveTrip | null;
  onNew: () => void;
  onOpenTrip: () => void;
  onStart: (trip: ActiveTrip) => void;
}) {
  const everyday = routes.filter((route) => route.everyday).slice(0, 4);
  return (
    <div className="flex-1 px-5 pt-8 pb-4">
      <header className="stagger">
        <Mark />
        <h1 className="mt-4 font-display text-5xl leading-none">Casillego</h1>
        <p className="mt-3 max-w-xs text-base text-muted">
          Te avisa antes de que se te pase la parada.
        </p>
      </header>
      <button type="button" className={`${primary} mt-8`} onClick={onNew}>
        <Plus className="size-5" />
        Nueva ruta
      </button>
      {trip ? (
        <button
          type="button"
          className={`${quiet} mt-3 w-full`}
          onClick={onOpenTrip}
        >
          Seguir viaje a {trip.alight.name}
        </button>
      ) : null}
      <ol className="mt-8 grid grid-cols-3 gap-3 text-sm">
        {[
          ["01", "Subes y bajas"],
          ["02", "Metros de aviso"],
          ["03", "Alarma al llegar"],
        ].map(([n, label]) => (
          <li key={n} className="rounded-3xl bg-surface px-3 py-4">
            <span className="font-display text-xl text-signal">{n}</span>
            <p className="mt-2 text-fg">{label}</p>
          </li>
        ))}
      </ol>
      <section className="mt-8">
        <h2 className="text-sm text-muted">Rutas cotidianas</h2>
        {everyday.length === 0 ? (
          <p className="mt-3 rounded-3xl border border-fg/10 px-4 py-5 text-sm text-muted">
            Todavía no hay ninguna. La primera puede ser la de mañana.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {everyday.map((route) => (
              <RouteCard key={route.id} route={route} onStart={onStart} compact />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function RoutesScreen({
  routes,
  onNew,
  onStart,
}: {
  routes: SavedRoute[];
  onNew: () => void;
  onStart: (trip: ActiveTrip) => void;
}) {
  const [onlyDaily, setOnlyDaily] = useState(true);
  const shown = (onlyDaily ? routes.filter((route) => route.everyday) : routes).slice().sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
  return (
    <div className="flex-1 px-5 pt-8 pb-4">
      <div className="flex items-end justify-between gap-3">
        <h1 className="font-display text-4xl">Rutas</h1>
        <button type="button" className={`${quiet} h-11`} onClick={onNew}>
          <Plus className="size-4" />
          Nueva
        </button>
      </div>
      <div className="mt-4 flex gap-2">
        <FilterChip active={onlyDaily} onClick={() => setOnlyDaily(true)} label="Cotidianas" />
        <FilterChip active={!onlyDaily} onClick={() => setOnlyDaily(false)} label="Todas" />
      </div>
      {shown.length === 0 ? (
        <p className="mt-6 text-sm text-muted">Nada guardado en este filtro.</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {shown.map((route) => (
            <RouteCard key={route.id} route={route} onStart={onStart} />
          ))}
        </ul>
      )}
    </div>
  );
}

function FilterChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`press h-10 rounded-full px-4 text-sm ${active ? "bg-signal text-bg" : "bg-surface text-muted"}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function RouteCard({
  route,
  onStart,
  compact = false,
}: {
  route: SavedRoute;
  onStart: (trip: ActiveTrip) => void;
  compact?: boolean;
}) {
  const [armedDelete, setArmedDelete] = useState(false);
  const Icon = modeIcon(route.mode);
  return (
    <li className="rounded-3xl bg-surface p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-full bg-bg text-signal">
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{route.name}</p>
          <p className="mt-1 truncate text-sm text-muted">
            {modeLabel(route.mode)} · {route.board.name} → {route.alight.name}
          </p>
          <p className="mt-1 text-sm text-signal">Aviso a {formatDistance(route.alertMeters)}</p>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          className={`${primary} h-11`}
          onClick={() =>
            onStart({
              id: route.id,
              name: route.name,
              mode: route.mode,
              board: route.board,
              alight: route.alight,
              alertMeters: route.alertMeters,
              startedAt: Date.now(),
              alarmed: false,
            })
          }
        >
          Iniciar
        </button>
        {compact ? null : armedDelete ? (
          <button
            type="button"
            className={`${quiet} h-11 px-3 text-sm`}
            onClick={() => useCasillego.getState().removeRoute(route.id)}
          >
            Confirmar
          </button>
        ) : (
          <button
            type="button"
            className={`${quiet} h-11 px-3`}
            aria-label={`Borrar ${route.name}`}
            onClick={() => setArmedDelete(true)}
          >
            <Trash2 className="size-4" />
          </button>
        )}
      </div>
    </li>
  );
}

function Composer({
  draft,
  fix,
  onChange,
  onClose,
  onPick,
  onLocate,
  onStart,
}: {
  draft: Draft;
  fix: Fix | null;
  onChange: (draft: Draft) => void;
  onClose: () => void;
  onPick: (field: "board" | "alight") => void;
  onLocate: (fix: Fix) => void;
  onStart: () => void;
}) {
  const same =
    draft.board && draft.alight ? haversine(draft.board, draft.alight) < 80 : false;
  const ready = Boolean(draft.board && draft.alight && !same);
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between px-5 pt-6">
        <h1 className="font-display text-4xl">Nueva ruta</h1>
        <button type="button" className={`${quiet} size-11 px-0`} onClick={onClose} aria-label="Cerrar">
          <X className="size-5" />
        </button>
      </header>
      <div className="flex-1 space-y-6 overflow-y-auto px-5 pt-6 pb-8">
        <ModePicker mode={draft.mode} onChange={(mode) => onChange({ ...draft, mode })} />
        <PlaceField
          label="Dónde subes"
          mode={draft.mode}
          value={draft.board}
          bias={fix}
          onChange={(board) => onChange({ ...draft, board })}
          onPickMap={() => onPick("board")}
          onLocate={onLocate}
        />
        <PlaceField
          label="Dónde bajas"
          mode={draft.mode}
          value={draft.alight}
          bias={fix}
          onChange={(alight) => onChange({ ...draft, alight })}
          onPickMap={() => onPick("alight")}
          onLocate={onLocate}
        />
        <DistancePicker
          meters={draft.alertMeters}
          onChange={(alertMeters) => onChange({ ...draft, alertMeters })}
        />
        <label className="block">
          <span className="text-sm text-muted">Nombre, si quieres</span>
          <input
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value.slice(0, 80) })}
            placeholder={
              draft.board && draft.alight ? `${draft.board.name} → ${draft.alight.name}` : "Casa → trabajo"
            }
            className="mt-2 h-12 w-full rounded-2xl border border-fg/10 bg-surface px-4 outline-none placeholder:text-muted focus:border-signal"
          />
        </label>
        <div className="flex items-center justify-between gap-4 rounded-3xl bg-surface px-4 py-3">
          <div>
            <p className="font-medium">Ruta cotidiana</p>
            <p className="text-sm text-muted">Queda en este teléfono para repetirla.</p>
          </div>
          <Switch.Root
            checked={draft.everyday}
            onCheckedChange={(everyday) => onChange({ ...draft, everyday })}
            className="relative h-7 w-12 shrink-0 rounded-full bg-fg/15 transition-colors data-[state=checked]:bg-signal"
            aria-label="Guardar como ruta cotidiana"
          >
            <Switch.Thumb className="block size-5 translate-x-1 rounded-full bg-fg transition-transform duration-200 data-[state=checked]:translate-x-6 data-[state=checked]:bg-bg" />
          </Switch.Root>
        </div>
        {same ? (
          <p className="text-sm text-signal">La subida y la bajada están en el mismo punto.</p>
        ) : null}
        {draft.board && draft.alight && !same ? (
          <p className="text-sm text-muted">
            En línea recta hay {formatDistance(haversine(draft.board, draft.alight))}. El aviso usa
            tu distancia real a la bajada, no ese trazo.
          </p>
        ) : null}
        <button type="button" className={primary} disabled={!ready} onClick={onStart}>
          Iniciar viaje
        </button>
      </div>
    </div>
  );
}

function ModePicker({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {MODES.map((item) => {
        const Icon = modeIcon(item.id);
        const active = item.id === mode;
        return (
          <button
            key={item.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(item.id)}
            className={`press flex h-16 shrink-0 flex-col justify-center rounded-2xl px-3 text-left ${active ? "bg-signal text-bg" : "bg-surface text-fg"}`}
          >
            <span className="flex items-center gap-2 text-sm font-medium">
              <Icon className="size-4" />
              {item.label}
            </span>
            <span className={`text-xs ${active ? "text-bg/70" : "text-muted"}`}>{item.hint}</span>
          </button>
        );
      })}
    </div>
  );
}

function PlaceField({
  label,
  mode,
  value,
  bias,
  onChange,
  onPickMap,
  onLocate,
}: {
  label: string;
  mode: Mode;
  value: Place | null;
  bias: Fix | null;
  onChange: (place: Place | null) => void;
  onPickMap: () => void;
  onLocate: (fix: Fix) => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Place[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const req = useRef(0);

  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      setError(null);
      return;
    }
    const id = ++req.current;
    const timer = window.setTimeout(() => {
      setLoading(true);
      void searchPlaces({
        data: { q: q.trim(), mode, lat: bias?.lat, lon: bias?.lon },
      })
        .then((result) => {
          if (id !== req.current) return;
          setHits(result.places);
          setError(result.error);
        })
        .catch(() => {
          if (id !== req.current) return;
          setHits([]);
          setError("No se pudo consultar el mapa en vivo.");
        })
        .finally(() => {
          if (id === req.current) setLoading(false);
        });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [q, mode, bias?.lat, bias?.lon]);

  return (
    <div>
      <p className="text-sm text-muted">{label}</p>
      {value ? (
        <div className="mt-2 flex items-center justify-between gap-3 rounded-2xl bg-surface px-4 py-3">
          <div className="min-w-0">
            <p className="truncate font-medium">{value.name}</p>
            <p className="truncate text-sm text-muted">{value.detail}</p>
          </div>
          <button type="button" className="text-sm text-signal" onClick={() => onChange(null)}>
            Cambiar
          </button>
        </div>
      ) : (
        <>
          <input
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Nombre de estación o lugar"
            className="mt-2 h-12 w-full rounded-2xl border border-fg/10 bg-surface px-4 outline-none placeholder:text-muted focus:border-signal"
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className={`${quiet} h-11 flex-1 text-sm`}
              disabled={locating}
              onClick={() => {
                setLocating(true);
                setError(null);
                void here()
                  .then(async (next) => {
                    onLocate(next);
                    const rev = await reversePlace({ data: { lat: next.lat, lon: next.lon } });
                    onChange(
                      rev.place ?? {
                        id: `me:${next.lat.toFixed(4)}`,
                        name: "Mi ubicación",
                        detail: "Punto actual",
                        lat: next.lat,
                        lon: next.lon,
                        kind: "Aquí",
                      },
                    );
                  })
                  .catch((err: GeolocationPositionError) => setError(gpsMessage(err.code)))
                  .finally(() => setLocating(false));
              }}
            >
              <LocateFixed className="size-4" />
              {locating ? "Ubicando" : "Mi ubicación"}
            </button>
            <button type="button" className={`${quiet} h-11 flex-1 text-sm`} onClick={onPickMap}>
              <MapPin className="size-4" />
              En el mapa
            </button>
          </div>
          {loading ? <p className="mt-2 text-sm text-muted">Buscando en vivo…</p> : null}
          {error ? <p className="mt-2 text-sm text-signal">{error}</p> : null}
          {hits.length > 0 ? (
            <ul className="mt-2 overflow-hidden rounded-2xl border border-fg/10">
              {hits.map((place) => (
                <li key={place.id}>
                  <button
                    type="button"
                    className="press flex w-full flex-col px-4 py-3 text-left hover:bg-surface"
                    onClick={() => {
                      onChange(place);
                      setQ("");
                      setHits([]);
                    }}
                  >
                    <span className="font-medium">{place.name}</span>
                    <span className="text-sm text-muted">{place.detail}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {!loading && q.trim().length >= 2 && hits.length === 0 && !error ? (
            <p className="mt-2 text-sm text-muted">Sin resultados. Prueba el nombre de la estación.</p>
          ) : null}
        </>
      )}
    </div>
  );
}

function DistancePicker({ meters, onChange }: { meters: number; onChange: (meters: number) => void }) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <p className="text-sm text-muted">Avisarme cuando falten</p>
        <p className="font-display text-3xl text-signal">{formatDistance(meters)}</p>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            className={`press h-10 rounded-full px-3 text-sm ${meters === preset ? "bg-signal text-bg" : "bg-surface text-fg"}`}
            onClick={() => onChange(preset)}
          >
            {formatDistance(preset)}
          </button>
        ))}
      </div>
      <Slider.Root
        className="relative mt-4 flex h-11 w-full touch-none items-center"
        min={150}
        max={2000}
        step={50}
        value={[meters]}
        onValueChange={(value) => onChange(clampMeters(value[0] ?? meters))}
        aria-label="Distancia de la alarma"
      >
        <Slider.Track className="relative h-1.5 grow rounded-full bg-fg/15">
          <Slider.Range className="absolute h-full rounded-full bg-signal" />
        </Slider.Track>
        <Slider.Thumb className="block size-7 rounded-full border-2 border-signal bg-bg" />
      </Slider.Root>
    </div>
  );
}

function PickScreen({
  draft,
  field,
  fix,
  onCancel,
  onUse,
}: {
  draft: Draft;
  field: "board" | "alight";
  fix: Fix | null;
  onCancel: () => void;
  onUse: (place: Place) => void;
}) {
  const [pin, setPin] = useState<Place | null>(field === "board" ? draft.board : draft.alight);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between px-5 py-4">
        <div>
          <p className="text-sm text-muted">{field === "board" ? "Dónde subes" : "Dónde bajas"}</p>
          <h1 className="font-display text-3xl">Toca el mapa</h1>
        </div>
        <button type="button" className={`${quiet} h-11`} onClick={onCancel}>
          Volver
        </button>
      </header>
      <RideMap
        className="min-h-72 w-full flex-1"
        center={pin ?? fix ?? CITY_CENTER}
        user={fix}
        board={field === "board" ? pin : draft.board}
        alight={field === "alight" ? pin : draft.alight}
        radiusMeters={field === "alight" ? draft.alertMeters : 0}
        focus={pin}
        onPick={(next) => {
          setPin({
            id: `pin:${next.lat.toFixed(4)}:${next.lon.toFixed(4)}`,
            name: "Punto en el mapa",
            detail: "Marcado a mano",
            lat: next.lat,
            lon: next.lon,
            kind: "Mapa",
          });
        }}
      />
      <div className="space-y-3 px-5 py-4">
        <p className="text-sm text-muted">{pin ? pin.name : "Todavía no hay punto."}</p>
        <button
          type="button"
          className={primary}
          disabled={!pin || busy}
          onClick={() => {
            if (!pin) return;
            setBusy(true);
            void reversePlace({ data: { lat: pin.lat, lon: pin.lon } })
              .then((result) => onUse(result.place ?? pin))
              .catch(() => onUse(pin))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Identificando…" : "Usar este punto"}
        </button>
      </div>
    </div>
  );
}

function TripScreen({
  trip,
  fix,
  distance,
  gpsError,
  onStop,
}: {
  trip: ActiveTrip;
  fix: Fix | null;
  distance: number | null;
  gpsError: string | null;
  onStop: () => void;
}) {
  const Icon = modeIcon(trip.mode);
  const inside = distance != null && distance <= trip.alertMeters;
  return (
    <div className="flex-1 px-5 pt-8 pb-4">
      <p className="flex items-center gap-2 text-sm text-muted">
        <Icon className="size-4 text-signal" />
        {modeLabel(trip.mode)} · {trip.name}
      </p>
      <h1 className="mt-3 font-display text-6xl leading-none">
        {distance != null ? formatDistance(distance) : "—"}
      </h1>
      <p className="mt-3 text-lg">para bajar en {trip.alight.name}</p>
      <p className="mt-1 text-sm text-muted">
        Subiste en {trip.board.name}. Alarma a {formatDistance(trip.alertMeters)}.
      </p>
      <div className="mt-5 overflow-hidden rounded-3xl">
        <RideMap
          center={fix ?? trip.alight}
          user={fix}
          board={trip.board}
          alight={trip.alight}
          radiusMeters={trip.alertMeters}
          focus={trip.alight}
        />
      </div>
      <p className={`mt-3 text-sm ${inside ? "text-signal" : "text-muted"}`}>
        {gpsError
          ? gpsError
          : fix
            ? `Precisión ±${Math.round(fix.acc)} m. ${fix.acc > 100 ? "Señal débil: el aviso puede atrasarse." : "Mantén esta pantalla abierta."}`
            : "Esperando la primera ubicación…"}
      </p>
      <button type="button" className={`${quiet} mt-6 w-full`} onClick={onStop}>
        <Square className="size-4" />
        Terminar viaje
      </button>
    </div>
  );
}

function MapScreen({
  fix,
  onFix,
  onCreate,
}: {
  fix: Fix | null;
  onFix: (fix: Fix) => void;
  onCreate: (place: Place, mode: Mode) => void;
}) {
  const [mode, setMode] = useState<Mode>("metro");
  const [selected, setSelected] = useState<Place | null>(null);
  const [hits, setHits] = useState<Place[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  return (
    <div className="flex-1 px-5 pt-8 pb-4">
      <h1 className="font-display text-4xl">Mapa</h1>
      <div className="mt-4">
        <ModePicker mode={mode} onChange={setMode} />
      </div>
      <input
        value={q}
        onChange={(event) => setQ(event.target.value)}
        placeholder="Buscar estación o lugar"
        className="mt-3 h-12 w-full rounded-2xl border border-fg/10 bg-surface px-4 outline-none placeholder:text-muted focus:border-signal"
      />
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          className={`${quiet} h-11 flex-1 text-sm`}
          onClick={() => {
            setLoading(true);
            void here()
              .then(async (next) => {
                onFix(next);
                const result = await nearbyPlaces({ data: { mode, lat: next.lat, lon: next.lon } });
                setHits(result.places);
                setError(result.error);
                setSelected(result.places[0] ?? null);
              })
              .catch((err: GeolocationPositionError) => setError(gpsMessage(err.code)))
              .finally(() => setLoading(false));
          }}
        >
          <LocateFixed className="size-4" />
          Cerca de mí
        </button>
        <button
          type="button"
          className={`${quiet} h-11 flex-1 text-sm`}
          disabled={q.trim().length < 2 || loading}
          onClick={() => {
            setLoading(true);
            void searchPlaces({
              data: { q: q.trim(), mode, lat: fix?.lat, lon: fix?.lon },
            })
              .then((result) => {
                setHits(result.places);
                setError(result.error);
                setSelected(result.places[0] ?? null);
              })
              .catch(() => setError("No se pudo consultar el mapa en vivo."))
              .finally(() => setLoading(false));
          }}
        >
          Buscar
        </button>
      </div>
      <div className="mt-3 overflow-hidden rounded-3xl">
        <RideMap
          center={selected ?? fix ?? CITY_CENTER}
          user={fix}
          alight={selected}
          radiusMeters={selected ? 400 : 0}
          focus={selected ?? fix}
        />
      </div>
      {loading ? <p className="mt-2 text-sm text-muted">Consultando datos en vivo…</p> : null}
      {error ? <p className="mt-2 text-sm text-signal">{error}</p> : null}
      <ul className="mt-3 space-y-2">
        {hits.map((place) => (
          <li key={place.id}>
            <button
              type="button"
              className={`press w-full rounded-2xl px-4 py-3 text-left ${selected?.id === place.id ? "bg-signal text-bg" : "bg-surface"}`}
              onClick={() => setSelected(place)}
            >
              <span className="block font-medium">{place.name}</span>
              <span className={`block text-sm ${selected?.id === place.id ? "text-bg/70" : "text-muted"}`}>
                {place.detail}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className={`${primary} mt-4`}
        disabled={!selected}
        onClick={() => selected && onCreate(selected, mode)}
      >
        Nueva ruta hasta aquí
      </button>
      <p className="mt-3 text-xs text-muted">Mapa © OpenStreetMap, teselas OpenFreeMap. Búsqueda Photon.</p>
    </div>
  );
}

function SettingsScreen({ fix, onFix }: { fix: Fix | null; onFix: (fix: Fix) => void }) {
  const settings = useCasillego((state) => state.settings);
  const update = useCasillego((state) => state.updateSettings);
  const [confirmClear, setConfirmClear] = useState(false);
  const [testing, setTesting] = useState(false);
  void fix;
  void onFix;
  return (
    <div className="flex-1 space-y-4 px-5 pt-8 pb-6">
      <h1 className="font-display text-4xl">Ajustes</h1>
      <DistancePicker
        meters={settings.defaultAlertMeters}
        onChange={(defaultAlertMeters) => update({ defaultAlertMeters })}
      />
      <ToggleRow
        label="Sonido"
        detail="Dos tonos al entrar en el radio."
        checked={settings.sound}
        onChange={(sound) => update({ sound })}
      />
      <ToggleRow
        label="Vibración"
        detail="En iPhone puede no vibrar una app web."
        checked={settings.vibrate}
        onChange={(vibrate) => update({ vibrate })}
      />
      <ToggleRow
        label="Pantalla activa"
        detail="Intenta que el teléfono no se duerma durante el viaje."
        checked={settings.keepAwake}
        onChange={(keepAwake) => update({ keepAwake })}
      />
      <button
        type="button"
        className={`${quiet} w-full`}
        onClick={() => {
          unlockAudio();
          if (settings.sound) startSiren();
          if (settings.vibrate) startVibrate();
          setTesting(true);
          window.setTimeout(() => {
            stopAlarm();
            setTesting(false);
          }, 2600);
        }}
      >
        <Bell className="size-4" />
        {testing ? "Sonando…" : "Probar alarma"}
      </button>
      <a href="/?install=1&platform=ios" className={`${primary} no-underline`}>
        Instalar en el iPhone
      </a>
      <p className="text-sm text-muted">
        En Android, abre el menú del navegador y elige “Agregar a pantalla de inicio” o “Instalar
        app”. Casillego se abre como aplicación, sin barra del sitio.
      </p>
      <Link to="/privacidad" className={`${quiet} w-full no-underline`}>
        <Shield className="size-4" />
        Privacidad
      </Link>
      {confirmClear ? (
        <button
          type="button"
          className={`${quiet} w-full`}
          onClick={() => {
            useCasillego.getState().clearRoutes();
            setConfirmClear(false);
          }}
        >
          Confirmar borrado de rutas
        </button>
      ) : (
        <button type="button" className={`${quiet} w-full`} onClick={() => setConfirmClear(true)}>
          <Trash2 className="size-4" />
          Borrar rutas guardadas
        </button>
      )}
      <p className="text-xs leading-relaxed text-muted">
        Deja la app abierta mientras viajas. El aviso mide la distancia a tu bajada con el GPS del
        teléfono. No sigue el recorrido del metro por dentro del túnel si no hay señal.
      </p>
    </div>
  );
}

function ToggleRow({
  label,
  detail,
  checked,
  onChange,
}: {
  label: string;
  detail: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-3xl bg-surface px-4 py-3">
      <div>
        <p className="font-medium">{label}</p>
        <p className="text-sm text-muted">{detail}</p>
      </div>
      <Switch.Root
        checked={checked}
        onCheckedChange={onChange}
        className="relative h-7 w-12 shrink-0 rounded-full bg-fg/15 transition-colors data-[state=checked]:bg-signal"
        aria-label={label}
      >
        <Switch.Thumb className="block size-5 translate-x-1 rounded-full bg-fg transition-transform duration-200 data-[state=checked]:translate-x-6 data-[state=checked]:bg-bg" />
      </Switch.Root>
    </div>
  );
}
