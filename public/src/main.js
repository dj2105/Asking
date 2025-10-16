import ScoreStrip from "./lib/ScoreStrip.js";
import { clampCode, getLastSession } from "./lib/util.js";

// ensure hash router lands on a usable hash route when visiting path URLs directly
(function ensureDefaultHash() {
  const rawHash = (location.hash || "").trim();
  if (rawHash && rawHash !== "#/" && rawHash !== "#") return;

  const search = new URLSearchParams(location.search || "");
  const sanitizedSearch = new URLSearchParams();
  for (const [key, value] of search.entries()) {
    if (key === "code") {
      const code = clampCode(value);
      if (code) sanitizedSearch.set("code", code);
    } else if (key === "round") {
      const round = parseInt(value, 10);
      if (Number.isFinite(round) && round > 0) sanitizedSearch.set("round", String(round));
    } else {
      sanitizedSearch.set(key, value);
    }
  }

  const path = location.pathname || "/";
  const segments = path.split("/").filter(Boolean);
  const lastSegment = segments.length ? segments[segments.length - 1].toLowerCase() : "";
  const basePath = (() => {
    const trimmed = path.replace(/[^/]*$/, "");
    if (!trimmed) return "/";
    return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
  })();

  const buildHash = (route, params) => {
    const source = params instanceof URLSearchParams ? params : sanitizedSearch;
    const qp = new URLSearchParams(source);
    const query = qp.toString();
    return query ? `#/${route}?${query}` : `#/${route}`;
  };

  const buildRejoin = (intent) => {
    const qp = new URLSearchParams();
    const fromSearch = sanitizedSearch.get("code");
    const last = getLastSession();
    const fallback = last?.code ? clampCode(last.code) : "";
    const code = fromSearch || fallback;
    if (code) qp.set("code", code);
    if (intent) qp.set("intent", intent);
    const query = qp.toString();
    return query ? `#/rejoin?${query}` : "#/rejoin";
  };

  let target = null;
  switch (lastSegment) {
    case "lobby":
    case "keyroom":
    case "coderoom":
    case "seeding":
    case "countdown":
    case "maths":
    case "final":
    case "watcher":
      target = buildHash(lastSegment);
      break;
    case "questions":
    case "marking":
    case "award":
      target = buildRejoin(lastSegment);
      break;
    case "rejoin":
      target = buildHash("rejoin");
      break;
    default:
      break;
  }

  if (!target) {
    target = buildHash("lobby");
  }

  location.replace(`${basePath}${target}`);
})();
// /src/main.js
//
// Minimal hash router + global score strip mounting.
// - Routes to views in /src/views
// - Mounts the ScoreStrip on every *game* route except: lobby, keyroom, seeding, final
// - Expects each view module to export default { mount(container), unmount? }
//
// Game routes (hash-based):
//   #/lobby
//   #/keyroom
//   #/seeding?code=ABC
//   #/countdown?code=ABC&round=N
//   #/questions?code=ABC&round=N
//   #/marking?code=ABC&round=N
//   #/award?code=ABC&round=N
//   #/maths?code=ABC
//   #/final?code=ABC
//
// Notes:
// - Views themselves initialise Firebase/auth; router keeps concerns simple.
// - The score strip binds by `code` and recomputes from room + rounds snapshots.
// - Hue is set by each view; router leaves theme to the views.

const app = document.getElementById("app");

// Keep track of mounted view instance so we can unmount cleanly.
let current = { route: "", mod: null, unmount: null };

// Routes that should NOT show the score strip
const STRIP_EXCLUDE = new Set(["lobby", "keyroom", "coderoom", "seeding", "final", "watcher", "rejoin"]);

// Map route -> dynamic import path
const VIEW_MAP = {
  lobby:     () => import("./views/Lobby.js"),
  keyroom:   () => import("./views/KeyRoom.js"),
  coderoom:  () => import("./views/CodeRoom.js"),
  seeding:   () => import("./views/SeedProgress.js"),
  countdown: () => import("./views/Countdown.js"),
  questions: () => import("./views/Questions.js"),
  marking:   () => import("./views/Marking.js"),
  award:     () => import("./views/Award.js"),
  maths:     () => import("./views/Maths.js"),
  final:     () => import("./views/Final.js"),
  watcher:   () => import("./roomWatcher.js"),
  rejoin:    () => import("./views/Rejoin.js"),
};

function parseHash() {
  const raw = location.hash || "#/lobby";
  const [path, q] = raw.split("?");
  const route = (path.replace(/^#\//, "") || "lobby").toLowerCase();
  const qs = new URLSearchParams(q || "");
  return { route, qs };
}

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

async function mountRoute() {
  const { route, qs } = parseHash();
  // Guard unknown routes → lobby
  const load = VIEW_MAP[route];

  if (!load && route !== "lobby") {
    console.log(`[router] redirect ${route} -> lobby`);
    location.replace("#/lobby");
    return; // stop, next load will mount lobby
  }

  const actualRoute = load ? route : "lobby";
  const importer = load || VIEW_MAP.lobby;

  console.log(`[router] mount ${actualRoute}`);

  // Unmount old view (if any)
  if (typeof current?.unmount === "function") {
    try { await current.unmount(); } catch {}
  }
  current = { route: actualRoute, mod: null, unmount: null };

  // Fresh container for the new view
  clearNode(app);

  // Load and mount the view
  try {
    const mod = await importer();
    const view = mod?.default || mod;

    if (!view || typeof view.mount !== "function") {
      throw new Error(`[router] ${route}: missing mount() export`);
    }

    await view.mount(app, Object.fromEntries(qs.entries()));
    current.mod = view;
    current.unmount = (typeof view.unmount === "function") ? view.unmount.bind(view) : null;

    // Conditionally mount the score strip (not in lobby/keyroom/seeding/final)
    if (!STRIP_EXCLUDE.has(actualRoute)) {
      // Prefer code from URL
      const code = (qs.get("code") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
      if (code) {
        // Mount or update the strip at the top of the current view container
        ScoreStrip.mount(app, { code });
      } else {
        // If no code present (edge case), hide to avoid stale display
        ScoreStrip.hide();
      }
    } else {
      // Explicitly hide for excluded routes
      ScoreStrip.hide();
    }
  } catch (e) {
    // Hard failure: show a tiny crash card (keeps UX within visual language)
    console.error("[router] mount failed:", e);
    ScoreStrip.hide();
    app.innerHTML = `
      <div class="view"><div class="card">
        <div class="mono" style="font-weight:700;margin-bottom:6px;">Oops — couldn’t load “${route}”.</div>
        <div class="mono small" style="opacity:.8">Try going back to the lobby.</div>
      </div></div>`;
  }
}

// Boot + navigation
window.addEventListener("hashchange", mountRoute);
window.addEventListener("load", mountRoute);
