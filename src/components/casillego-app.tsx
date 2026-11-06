import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import * as Slider from "@radix-ui/react-slider";
import * as Switch from "@radix-ui/react-switch";
import {
  ArrowLeftRight,
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
import { CITY_CENTER, bearingDegrees, clampMeters, formatDistance, haversine, movePoint, sideLabel, walkingLabel } from "@/lib/geo";
import { nearbyPlaces, reversePlace, searchPlaces, stationExits } from "@/lib/live.functions";
import { useCasillego, type ActiveTrip } from "@/lib/store";
import { MODES, modeLabel, type Mode, type Place, type SavedRoute } from "@/lib/types";
import { RideMap } from "@/components/ride-map";

type Tab = "hoy" | "rutas" | "mapa" | "ajustes";

type Draft = {
  mode: Mode;
  board: Place | null;
  alight: Place | null;
  transfer: Place | null;
  note: string;
  alertMeters: number;
  everyday: boolean;
  name: string;
};

type View =
  | { id: Tab }
  | { id: "composer"; draft: Draft }
  | { id: "pick"; draft: Draft; field: "board" | "alight" | "transfer" }
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
    transfer: null,
    note: "",
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
  const closestRef = useRef(Number.POSITIVE_INFINITY);
  const reachedRef = useRef(false);
  const passedRef = useRef(0);
  const [alarmKind, setAlarmKind] = useState<"near" | "passed">("near");
  const [heading, setHeading] = useState<number | null>(null);

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
      setAlarmKind("near");
      return;
    }
    if (trip.alarmed) {
      firedRef.current = true;
      setAlarming(true);
    } else {
      firedRef.current = false;
      setAlarming(false);
      setAlarmKind("near");
    }
    insideRef.current = 0;
    closestRef.current = Number.POSITIVE_INFINITY;
    reachedRef.current = false;
    passedRef.current = 0;
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
        const goal = current.leg === "transfer" && current.transfer ? current.transfer : current.alight;
        const dist = haversine(next, goal);
        setDistance(dist);
        if (dist < closestRef.current) closestRef.current = dist;
        const accOk = !Number.isFinite(next.acc) || next.acc < Math.max(90, current.alertMeters);
        if (dist <= current.alertMeters && accOk) {
          insideRef.current += 1;
          reachedRef.current = true;
          passedRef.current = 0;
        } else if (dist > current.alertMeters * 1.3) {
          insideRef.current = 0;
        }
        if (reachedRef.current && dist > closestRef.current + 140 && dist > current.alertMeters) {
          passedRef.current += 1;
        }
        const armed = !firedRef.current && !current.alarmed;
        const kind = insideRef.current >= 2 ? "near" : passedRef.current >= 2 ? "passed" : null;
        if (armed && kind) {
          firedRef.current = true;
          setSilenced(false);
          setAlarmKind(kind);
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
  }, [trip?.startedAt, trip?.leg]);

  useEffect(() => {
    if (!trip) return;
    const onOrient = (event: DeviceOrientationEvent) => {
      const ios = (event as DeviceOrientationEvent & { webkitCompassHeading?: number }).webkitCompassHeading;
      if (typeof ios === "number" && Number.isFinite(ios)) {
        setHeading(ios);
        return;
      }
      if (event.absolute && typeof event.alpha === "number" && Number.isFinite(event.alpha)) {
        setHeading((360 - event.alpha + 360) % 360);
      }
    };
    window.addEventListener("deviceorientation", onOrient);
    return () => window.removeEventListener("deviceorientation", onOrient);
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

  function askCompass() {
    const orientation = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<string>;
    };
    if (typeof orientation.requestPermission === "function") {
      void orientation.requestPermission().catch(() => undefined);
    }
  }

  function begin(draft: Draft) {
    if (!draft.board || !draft.alight) return;
    unlockAudio();
    askCompass();
    const transfer =
      draft.transfer &&
      haversine(draft.transfer, draft.board) >= 80 &&
      haversine(draft.transfer, draft.alight) >= 80
        ? draft.transfer
        : null;
    const name = draft.name.trim() || `${draft.board.name} → ${draft.alight.name}`;
    const id = crypto.randomUUID();
    const note = draft.note.trim().slice(0, 140);
    const saved: SavedRoute = {
      id,
      name,
      mode: draft.mode,
      board: draft.board,
      alight: draft.alight,
      transfer,
      note,
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
      transfer,
      note,
      leg: transfer ? "transfer" : "alight",
      alertMeters: draft.alertMeters,
      startedAt: Date.now(),
      alarmed: false,
    });
  }

  function launch(next: ActiveTrip) {
    unlockAudio();
    askCompass();
    stopAlarm();
    setSilenced(false);
    setAlarmKind("near");
    firedRef.current = false;
    insideRef.current = 0;
    closestRef.current = Number.POSITIVE_INFINITY;
    reachedRef.current = false;
    passedRef.current = 0;
    useCasillego.getState().startTrip(next);
    if (useCasillego.getState().settings.keepAwake) void acquireWake();
    setView({ id: "trip" });
  }

  function continueLeg() {
    stopAlarm();
    firedRef.current = false;
    insideRef.current = 0;
    closestRef.current = Number.POSITIVE_INFINITY;
    reachedRef.current = false;
    passedRef.current = 0;
    setSilenced(false);
    setAlarming(false);
    setAlarmKind("near");
    useCasillego.getState().continueLeg();
  }

  function finish() {
    const current = useCasillego.getState().trip;
    const meters = distance;
    stopAlarm();
    void releaseWake();
    firedRef.current = false;
    insideRef.current = 0;
    setAlarming(false);
    setSilenced(false);
    setAlarmKind("near");
    closestRef.current = Number.POSITIVE_INFINITY;
    reachedRef.current = false;
    passedRef.current = 0;
    useCasillego.getState().endTrip();
    if (current && meters != null && Number.isFinite(meters)) {
      useCasillego.getState().noteArrival({
        meters: Math.max(0, Math.round(meters)),
        name: current.alight.name,
        at: Date.now(),
      });
    }
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
              heading={heading}
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
          <span className="text-sm font-medium">
            Viaje en curso · {trip.leg === "transfer" && trip.transfer ? trip.transfer.name : trip.alight.name}
          </span>
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
        <AlarmOverlay
          trip={trip}
          kind={alarmKind}
          distance={distance}
          silenced={silenced}
          onSilence={() => {
            stopAlarm();
            setSilenced(true);
          }}
          onRearm={() => {
            stopAlarm();
            firedRef.current = false;
            insideRef.current = 0;
            passedRef.current = 0;
            reachedRef.current = false;
            closestRef.current = Number.POSITIVE_INFINITY;
            setSilenced(false);
            setAlarming(false);
            setAlarmKind("near");
            useCasillego.getState().rearm();
          }}
          onContinue={continueLeg}
          onFinish={finish}
        />
      ) : null}
    </div>
  );
}

function AlarmOverlay({
  trip,
  kind,
  distance,
  silenced,
  onSilence,
  onRearm,
  onContinue,
  onFinish,
}: {
  trip: ActiveTrip;
  kind: "near" | "passed";
  distance: number | null;
  silenced: boolean;
  onSilence: () => void;
  onRearm: () => void;
  onContinue: () => void;
  onFinish: () => void;
}) {
  const changing = kind === "near" && trip.leg === "transfer" && trip.transfer;
  const goal = changing ? trip.transfer : trip.alight;
  const title = kind === "passed" ? "Ya te pasaste" : changing ? "Aquí cambias" : "Ya casi llegas";
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg px-6 pb-10 pt-16">
      <div className="relative mx-auto mt-4 size-40">
        {!silenced ? <span className="absolute inset-0 rounded-full bg-signal/30 motion-safe:animate-ping" /> : null}
        <span className="absolute inset-8 grid place-items-center rounded-full bg-signal text-bg">
          <Bell className="size-8" />
        </span>
      </div>
      <h2 className="mt-8 text-center font-display text-5xl leading-none">{title}</h2>
      <p className="mt-3 text-center text-lg text-fg">{goal?.name}</p>
      {kind === "passed" ? (
        <p className="mt-2 text-center text-sm text-muted">La parada quedó atrás.</p>
      ) : null}
      <p className="mt-6 text-center font-display text-4xl text-signal">
        {distance != null ? formatDistance(distance) : "Buscando señal"}
      </p>
      <p className="mt-2 text-center text-sm text-muted">
        Aviso a {formatDistance(trip.alertMeters)}
        {silenced ? " · silencio" : ""}
      </p>
      <div className="mt-auto grid gap-3">
        <button type="button" className={quiet} onClick={onSilence}>
          <Volume2 className="size-4" />
          Silenciar
        </button>
        <button type="button" className={quiet} onClick={onRearm}>
          Volver a armar
        </button>
        {trip.transfer && trip.leg === "transfer" ? (
          <button type="button" className={primary} onClick={onContinue}>
            Sigo a {trip.alight.name}
          </button>
        ) : (
          <button type="button" className={primary} onClick={onFinish}>
            <Square className="size-4" />
            Ya bajé
          </button>
        )}
      </div>
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
  const lastArrival = useCasillego((state) => state.lastArrival);
  const suggested = lastArrival ? clampMeters(lastArrival.meters) : null;
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
      {lastArrival ? (
        <section className="mt-6 rounded-3xl border border-signal/40 bg-surface px-4 py-4">
          <p className="text-sm text-muted">Última bajada</p>
          <p className="mt-1 font-medium">
            Bajaste a {formatDistance(lastArrival.meters)} de {lastArrival.name}.
          </p>
          <p className="mt-1 text-sm text-muted">
            Puedes usar esa distancia como aviso la próxima vez.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className={`${primary} h-11 w-auto! flex-1`}
              onClick={() => {
                if (suggested == null) return;
                useCasillego.getState().updateSettings({ defaultAlertMeters: suggested });
                useCasillego.getState().dismissArrival();
              }}
            >
              Usar {suggested != null ? formatDistance(suggested) : ""}
            </button>
            <button
              type="button"
              className={`${quiet} h-11`}
              onClick={() => useCasillego.getState().dismissArrival()}
            >
              Ahora no
            </button>
          </div>
        </section>
      ) : null}
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

function returnName(route: SavedRoute) {
  const parts = route.name.split("→").map((part) => part.trim());
  if (parts.length === 2 && parts[0] && parts[1]) return `${parts[1]} → ${parts[0]}`;
  return `${route.alight.name} → ${route.board.name}`;
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
            {route.transfer ? ` · cambias en ${route.transfer.name}` : ""}
          </p>
          {route.note ? <p className="mt-1 truncate text-sm text-fg">{route.note}</p> : null}
          <p className="mt-1 text-sm text-signal">Aviso a {formatDistance(route.alertMeters)}</p>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          className={`${primary} h-11 w-auto! flex-1`}
          onClick={() =>
            onStart({
              id: route.id,
              name: route.name,
              mode: route.mode,
              board: route.board,
              alight: route.alight,
              transfer: route.transfer ?? null,
              note: route.note ?? "",
              leg: route.transfer ? "transfer" : "alight",
              alertMeters: route.alertMeters,
              startedAt: Date.now(),
              alarmed: false,
            })
          }
        >
          Iniciar
        </button>
        <button
          type="button"
          className={`${quiet} h-11 flex-1 text-sm`}
          onClick={() =>
            onStart({
              id: route.id,
              name: returnName(route),
              mode: route.mode,
              board: route.alight,
              alight: route.board,
              transfer: route.transfer ?? null,
              note: route.note ?? "",
              leg: route.transfer ? "transfer" : "alight",
              alertMeters: route.alertMeters,
              startedAt: Date.now(),
              alarmed: false,
            })
          }
        >
          <ArrowLeftRight className="size-4" />
          Regreso
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
  onPick: (field: "board" | "alight" | "transfer") => void;
  onLocate: (fix: Fix) => void;
  onStart: () => void;
}) {
  const same =
    draft.board && draft.alight ? haversine(draft.board, draft.alight) < 80 : false;
  const transferClose =
    draft.transfer != null &&
    ((draft.board && haversine(draft.transfer, draft.board) < 80) ||
      (draft.alight && haversine(draft.transfer, draft.alight) < 80));
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
        <PlaceField
          label="Dónde cambias, si hace falta"
          mode={draft.mode}
          value={draft.transfer}
          bias={fix}
          onChange={(transfer) => onChange({ ...draft, transfer })}
          onPickMap={() => onPick("transfer")}
          onLocate={onLocate}
        />
        {transferClose ? (
          <p className="text-sm text-signal">El cambio tiene que ser otro punto. Si no, se ignora.</p>
        ) : null}
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
        <label className="block">
          <span className="text-sm text-muted">Nota para ti</span>
          <input
            value={draft.note}
            onChange={(event) => onChange({ ...draft, note: event.target.value.slice(0, 140) })}
            placeholder="Baja por la puerta de atrás"
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

const EXIT_SIDES: Array<[string, number]> = [
  ["Norte", 0],
  ["Oriente", 90],
  ["Sur", 180],
  ["Poniente", 270],
];

function sideChoices(station: Place): Place[] {
  return EXIT_SIDES.map(([name, bearing]) => {
    const point = movePoint(station, bearing, 70);
    return {
      id: `lado:${station.id}:${name}`,
      name,
      detail: "Lado aproximado de la estación",
      lat: point.lat,
      lon: point.lon,
      kind: "Salida",
    };
  });
}

function mergeExits(local: Place[], live: Place[]): Place[] {
  const next = local.map((item) => ({ ...item }));
  const extras: Place[] = [];
  for (const exit of live) {
    const slot = next.find((item) => item.name.toLocaleLowerCase("es") === exit.name.toLocaleLowerCase("es"));
    if (slot) {
      slot.id = exit.id;
      slot.lat = exit.lat;
      slot.lon = exit.lon;
      slot.detail = exit.detail;
    } else {
      extras.push(exit);
    }
  }
  return [...extras, ...next];
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
  const casa = useCasillego((state) => state.anchors?.casa ?? null);
  const trabajo = useCasillego((state) => state.anchors?.trabajo ?? null);
  const [exits, setExits] = useState<Place[]>([]);
  const [station, setStation] = useState<Place | null>(null);

  useEffect(() => {
    if (!value) {
      setStation(null);
      setExits([]);
      return;
    }
    if (value.kind === "Salida") return;
    const stationish = value.kind === "Estación" || value.kind === "Cable";
    if (!stationish) {
      setStation(null);
      setExits([]);
      return;
    }
    setStation(value);
    const local = sideChoices(value);
    setExits(local);
    let live = true;
    void stationExits({ data: { lat: value.lat, lon: value.lon } })
      .then((result) => {
        if (live) setExits(mergeExits(local, result.places));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [value]);

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
        <>
          <div className="mt-2 flex items-center justify-between gap-3 rounded-2xl bg-surface px-4 py-3">
            <div className="min-w-0">
              <p className="truncate font-medium">{value.name}</p>
              <p className="truncate text-sm text-muted">{value.detail}</p>
            </div>
            <button type="button" className="text-sm text-signal" onClick={() => onChange(null)}>
              Cambiar
            </button>
          </div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="press h-9 rounded-full bg-bg px-3 text-sm text-muted"
              onClick={() => useCasillego.getState().setAnchor("casa", value)}
            >
              Es mi casa
            </button>
            <button
              type="button"
              className="press h-9 rounded-full bg-bg px-3 text-sm text-muted"
              onClick={() => useCasillego.getState().setAnchor("trabajo", value)}
            >
              Es mi trabajo
            </button>
          </div>
          {station && exits.length > 0 ? (
            <div className="mt-3">
              <p className="text-sm text-muted">Salida</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {exits.map((exit) => {
                  const picked = value.kind === "Salida" && value.id === exit.id;
                  return (
                    <button
                      key={exit.id}
                      type="button"
                      className={`press h-9 rounded-full px-3 text-sm ${picked ? "bg-signal text-bg" : "bg-bg text-fg"}`}
                      onClick={() =>
                        onChange({
                          ...exit,
                          name: `${station.name.split("·")[0].trim()} · ${exit.name}`,
                          kind: "Salida",
                        })
                      }
                    >
                      {exit.name}
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-xs text-muted">
                Norte, sur, oriente y poniente son un lado aproximado. Si el mapa tiene la puerta, se usa esa.
              </p>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <input
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Estación, colonia o dirección"
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
          {casa || trabajo ? (
            <div className="mt-2 flex gap-2">
              {casa ? (
                <button type="button" className="press h-9 rounded-full bg-surface px-3 text-sm" onClick={() => onChange(casa)}>
                  Casa
                </button>
              ) : null}
              {trabajo ? (
                <button
                  type="button"
                  className="press h-9 rounded-full bg-surface px-3 text-sm"
                  onClick={() => onChange(trabajo)}
                >
                  Trabajo
                </button>
              ) : null}
            </div>
          ) : null}
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
  field: "board" | "alight" | "transfer";
  fix: Fix | null;
  onCancel: () => void;
  onUse: (place: Place) => void;
}) {
  const [pin, setPin] = useState<Place | null>(
    field === "board" ? draft.board : field === "transfer" ? draft.transfer : draft.alight,
  );
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between px-5 py-4">
        <div>
          <p className="text-sm text-muted">
            {field === "board" ? "Dónde subes" : field === "transfer" ? "Dónde cambias" : "Dónde bajas"}
          </p>
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
        via={field === "transfer" ? pin : draft.transfer}
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
  heading,
  gpsError,
  onStop,
}: {
  trip: ActiveTrip;
  fix: Fix | null;
  distance: number | null;
  heading: number | null;
  gpsError: string | null;
  onStop: () => void;
}) {
  const Icon = modeIcon(trip.mode);
  const goal = trip.leg === "transfer" && trip.transfer ? trip.transfer : trip.alight;
  const inside = distance != null && distance <= trip.alertMeters;
  const aim = fix ? sideLabel(bearingDegrees(fix, goal), heading) : "";
  return (
    <div className="flex-1 px-5 pt-8 pb-4">
      <p className="flex items-center gap-2 text-sm text-muted">
        <Icon className="size-4 text-signal" />
        {modeLabel(trip.mode)} · {trip.name}
      </p>
      <h1 className="mt-3 font-display text-6xl leading-none">
        {distance != null ? formatDistance(distance) : "—"}
      </h1>
      <p className="mt-3 text-lg">
        {trip.leg === "transfer" && trip.transfer ? "para cambiar en" : "para bajar en"} {goal.name}
      </p>
      <p className="mt-1 text-sm text-muted">
        Subiste en {trip.board.name}.
        {trip.transfer && trip.leg !== "transfer" ? ` Cambiaste en ${trip.transfer.name}.` : ""}
        {trip.transfer && trip.leg === "transfer" ? ` Luego bajas en ${trip.alight.name}.` : ""} Alarma a{" "}
        {formatDistance(trip.alertMeters)}.
      </p>
      {trip.note ? <p className="mt-2 text-sm text-fg">{trip.note}</p> : null}
      <p className="mt-1 text-sm text-muted">
        {distance != null ? walkingLabel(distance) : "El tiempo a pie aparece con la primera señal."}
      </p>
      {aim ? <p className="mt-1 text-sm text-signal">{aim}</p> : null}
      <div className="mt-5 overflow-hidden rounded-3xl">
        <RideMap
          center={fix ?? goal}
          user={fix}
          board={trip.board}
          via={trip.leg === "transfer" ? trip.alight : trip.transfer}
          alight={goal}
          radiusMeters={trip.alertMeters}
          focus={goal}
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
        placeholder="Estación, colonia o dirección"
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
      <p className="mt-3 text-xs text-muted">Mapa © OpenStreetMap, teselas OpenFreeMap. Búsqueda Nominatim.</p>
    </div>
  );
}

function SettingsScreen({ fix, onFix }: { fix: Fix | null; onFix: (fix: Fix) => void }) {
  const settings = useCasillego((state) => state.settings);
  const anchors = useCasillego((state) => state.anchors);
  const update = useCasillego((state) => state.updateSettings);
  const [confirmClear, setConfirmClear] = useState(false);
  const [testing, setTesting] = useState(false);
  void fix;
  void onFix;
  return (
    <div className="flex-1 space-y-4 px-5 pt-8 pb-6">
      <h1 className="font-display text-4xl">Ajustes</h1>
      <AnchorRow label="Casa" place={anchors?.casa ?? null} onClear={() => useCasillego.getState().setAnchor("casa", null)} />
      <AnchorRow
        label="Trabajo"
        place={anchors?.trabajo ?? null}
        onClear={() => useCasillego.getState().setAnchor("trabajo", null)}
      />
      <p className="text-sm text-muted">Se guardan al elegir un punto y tocar “Es mi casa” o “Es mi trabajo”.</p>
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

function AnchorRow({
  label,
  place,
  onClear,
}: {
  label: string;
  place: Place | null;
  onClear: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-3xl bg-surface px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm text-muted">{label}</p>
        <p className="truncate font-medium">{place ? place.name : "Sin definir"}</p>
      </div>
      {place ? (
        <button type="button" className="text-sm text-signal" onClick={onClear}>
          Quitar
        </button>
      ) : null}
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
