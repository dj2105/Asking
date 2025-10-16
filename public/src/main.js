// ensure hash router lands on lobby by default
(function ensureDefaultHash() {
  const hash = (location.hash || "").trim();
  if (hash && hash !== "#/" && hash !== "#") return;

  const rawPath = (location.pathname || "/").replace(/\/+/g, "/");
  const cleanedPath = rawPath.replace(/^\/+|\/+$|^$/g, "");
  const segment = cleanedPath.split("/")[0].toLowerCase();
  const knownDirect = new Set([
    "lobby",
    "keyroom",
    "coderoom",
    "seeding",
    "countdown",
    "questions",
    "marking",
    "award",
    "maths",
    "final",
    "watcher",
    "rejoin",
    "interlude",
  ]);

  const url = new URL(window.location.href);
  const searchParams = new URLSearchParams(url.search || "");
  url.pathname = "/";
  url.search = "";

  if (segment && segment !== "index.html" && knownDirect.has(segment)) {
    if (segment === "questions" || segment === "marking" || segment === "award") {
      const rejoinParams = new URLSearchParams(searchParams);
      rejoinParams.set("step", segment);
      rejoinParams.set("auto", "1");
      url.hash = `#/rejoin?${rejoinParams.toString()}`;
      location.replace(url.toString());
      return;
    }

    const query = searchParams.toString();
    url.hash = query ? `#/${segment}?${query}` : `#/${segment}`;
    location.replace(url.toString());
    return;
  }

  const query = searchParams.toString();
  url.hash = query ? `#/lobby?${query}` : "#/lobby";
  location.replace(url.toString());
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

import ScoreStrip from "./lib/ScoreStrip.js";

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
  interlude: () => import("./views/Interlude.js"),
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
