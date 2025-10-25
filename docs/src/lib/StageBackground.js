const STORAGE_KEY = "jemima:bg-progress";
const STEP = 0.05;
const MAX_DIM = 0.8;
const RESET_ROUTES = new Set(["lobby", "keyroom", "coderoom", "seeding", "watcher", "rejoin"]);

function readState() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return { visited: [], dim: 0 };
    const parsed = JSON.parse(raw);
    const visited = Array.isArray(parsed?.visited) ? parsed.visited.filter((entry) => typeof entry === "string") : [];
    const dim = Number.isFinite(parsed?.dim) ? Math.max(0, Math.min(MAX_DIM, parsed.dim)) : 0;
    return { visited, dim };
  } catch {
    return { visited: [], dim: 0 };
  }
}

function writeState(state) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

function applyDim(value) {
  const clamped = Math.max(0, Math.min(MAX_DIM, value));
  try {
    document.documentElement.style.setProperty("--bg-dim", clamped.toFixed(3));
  } catch {}
}

function normaliseRound(round) {
  if (round === null || round === undefined) return null;
  const num = Number(round);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : null;
}

export function registerStage(route, params = {}) {
  const cleanRoute = (route || "").toLowerCase();
  const state = readState();

  if (RESET_ROUTES.has(cleanRoute)) {
    state.visited = [];
    state.dim = 0;
    writeState(state);
    applyDim(0);
    return 0;
  }

  const round = normaliseRound(params.round);
  const key = round ? `${cleanRoute}:${round}` : cleanRoute;

  if (key && !state.visited.includes(key)) {
    state.visited.push(key);
    const increments = Math.max(0, state.visited.length - 1);
    state.dim = Math.min(MAX_DIM, increments * STEP);
  }

  if (cleanRoute === "final") {
    state.dim = MAX_DIM;
  }

  writeState(state);
  applyDim(state.dim);
  return state.dim;
}

export function resetStageProgress() {
  const state = { visited: [], dim: 0 };
  writeState(state);
  applyDim(0);
}
