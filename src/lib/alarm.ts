let ctx: AudioContext | null = null;
let beepTimer = 0;
let vibrateTimer = 0;
let wake: WakeLockSentinel | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  return ctx;
}

export function unlockAudio() {
  const audio = audioContext();
  if (audio && audio.state === "suspended") void audio.resume();
}

function beep() {
  const audio = audioContext();
  if (!audio) return;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = "sine";
  osc.connect(gain);
  gain.connect(audio.destination);
  const now = audio.currentTime;
  osc.frequency.setValueAtTime(784, now);
  osc.frequency.setValueAtTime(988, now + 0.16);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.16, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
  osc.start(now);
  osc.stop(now + 0.44);
}

export function startSiren() {
  if (typeof window === "undefined") return;
  unlockAudio();
  stopSiren();
  beep();
  beepTimer = window.setInterval(beep, 1300);
}

export function stopSiren() {
  if (typeof window === "undefined") return;
  if (beepTimer) window.clearInterval(beepTimer);
  beepTimer = 0;
}

export function startVibrate() {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  const pulse = () => {
    try {
      navigator.vibrate([260, 140, 260, 420]);
    } catch {
      /* some browsers reject vibration without a gesture */
    }
  };
  stopVibrate();
  pulse();
  vibrateTimer = window.setInterval(pulse, 1300);
}

export function stopVibrate() {
  if (typeof window === "undefined") return;
  if (vibrateTimer) window.clearInterval(vibrateTimer);
  vibrateTimer = 0;
  try {
    navigator.vibrate?.(0);
  } catch {
    /* ignore */
  }
}

export function stopAlarm() {
  stopSiren();
  stopVibrate();
}

export async function acquireWake(): Promise<boolean> {
  if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return false;
  try {
    wake = await navigator.wakeLock.request("screen");
    return true;
  } catch {
    return false;
  }
}

export async function releaseWake() {
  try {
    await wake?.release();
  } catch {
    /* ignore */
  }
  wake = null;
}
