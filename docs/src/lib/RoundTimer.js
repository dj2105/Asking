// /src/lib/RoundTimer.js
//
// Local round timer utility used to measure each player's elapsed time per round.
// - Stores state in sessionStorage (fallback to in-memory Map when unavailable).
// - Supports pause/resume semantics so we can exclude waiting periods between phases.
// - Consumers should call resumeRoundTimer when a timed activity begins and
//   pauseRoundTimer when it temporarily stops. Once the round finishes, call
//   clearRoundTimer to discard stored data.

const MEMORY_STORE = new Map();
const STORAGE_PREFIX = "jemima-rt:";

function safeNow() {
  return Date.now();
}

function clampCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 3);
}

function makeKey({ code, role, round }) {
  const safeCode = clampCode(code);
  const safeRole = role === "host" || role === "guest" ? role : "player";
  const safeRound = Number.isFinite(Number(round)) ? String(Number(round)) : "1";
  return `${safeCode}:${safeRole}:${safeRound}`;
}

function getStore() {
  try {
    if (typeof window !== "undefined" && window.sessionStorage) {
      return window.sessionStorage;
    }
  } catch (err) {
    // sessionStorage may be unavailable (Safari private mode, etc.).
  }
  return null;
}

function loadState(key) {
  if (!key) return { accumulated: 0, running: false, lastStart: null };
  const store = getStore();
  if (store) {
    try {
      const raw = store.getItem(STORAGE_PREFIX + key);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          accumulated: Number(parsed.accumulated) || 0,
          running: Boolean(parsed.running),
          lastStart: Number(parsed.lastStart) || null,
        };
      }
    } catch (err) {
      // Ignore corrupt storage and fall back to memory copy.
    }
  }
  if (MEMORY_STORE.has(key)) {
    return { ...MEMORY_STORE.get(key) };
  }
  return { accumulated: 0, running: false, lastStart: null };
}

function persistState(key, state) {
  if (!key) return;
  const clean = {
    accumulated: Number(state.accumulated) || 0,
    running: Boolean(state.running),
    lastStart: Number(state.lastStart) || null,
  };
  const store = getStore();
  if (store) {
    try {
      store.setItem(STORAGE_PREFIX + key, JSON.stringify(clean));
    } catch (err) {
      // On quota errors, fall back to in-memory storage.
      MEMORY_STORE.set(key, clean);
      return;
    }
  }
  MEMORY_STORE.set(key, clean);
}

function deleteState(key) {
  if (!key) return;
  const store = getStore();
  if (store) {
    try {
      store.removeItem(STORAGE_PREFIX + key);
    } catch (err) {
      // ignore
    }
  }
  MEMORY_STORE.delete(key);
}

export function resumeRoundTimer(context = {}, now = safeNow()) {
  const key = makeKey(context);
  const state = loadState(key);
  if (state.running) return;
  state.running = true;
  state.lastStart = Number.isFinite(now) ? now : safeNow();
  persistState(key, state);
}

export function pauseRoundTimer(context = {}, now = safeNow()) {
  const key = makeKey(context);
  const state = loadState(key);
  if (!state.running) return;
  const current = Number.isFinite(now) ? now : safeNow();
  if (Number.isFinite(state.lastStart)) {
    const delta = Math.max(0, current - state.lastStart);
    state.accumulated += delta;
  }
  state.running = false;
  state.lastStart = null;
  persistState(key, state);
}

export function getRoundTimerTotal(context = {}, now = safeNow()) {
  const key = makeKey(context);
  const state = loadState(key);
  let total = Number(state.accumulated) || 0;
  if (state.running && Number.isFinite(state.lastStart)) {
    const current = Number.isFinite(now) ? now : safeNow();
    total += Math.max(0, current - state.lastStart);
  }
  return total;
}

export function clearRoundTimer(context = {}) {
  const key = makeKey(context);
  deleteState(key);
}

export default {
  resumeRoundTimer,
  pauseRoundTimer,
  getRoundTimerTotal,
  clearRoundTimer,
};
