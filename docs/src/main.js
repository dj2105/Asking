// ensure hash router lands on lobby by default
(function ensureDefaultHash() {
  const hash = (location.hash || "").trim();
  if (hash && hash !== "#/" && hash !== "#") return;

  const rawPath = (location.pathname || "/").replace(/\/+/g, "/");
  const cleanedPath = rawPath.replace(/^\/+|\/+$|^$/g, "");
  const segments = cleanedPath ? cleanedPath.split("/") : [];
  const lastSegment = segments[segments.length - 1] || "";
  const segment = lastSegment.toLowerCase();
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
  ]);

  const url = new URL(window.location.href);
  const searchParams = new URLSearchParams(url.search || "");

  const basePath = (() => {
    if (!rawPath || rawPath === "/") return "/";
    if (rawPath.endsWith("/")) return rawPath;

    if (lastSegment && knownDirect.has(segment)) {
      const trimmed = rawPath.slice(0, rawPath.length - lastSegment.length);
      return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
    }

    if (lastSegment.includes(".")) {
      const idx = rawPath.lastIndexOf("/");
      if (idx <= 0) return "/";
      return rawPath.slice(0, idx + 1) || "/";
    }

    return `${rawPath}/`;
  })();

  url.pathname = basePath || "/";
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

const GAME_ROUNDS = 5;
const PRE_STAGE_ROUTES = ["lobby", "keyroom", "coderoom", "seeding"];
const ROUND_STAGE_ROUTES = ["countdown", "questions", "marking", "award"];
const POST_STAGE_ROUTES = ["maths", "final"];
const FINAL_STAGE_INDEX =
  PRE_STAGE_ROUTES.length + GAME_ROUNDS * ROUND_STAGE_ROUTES.length + POST_STAGE_ROUTES.length - 1;
const MAX_BG_DEPTH = 0.8;

const TOP_ALIGNED_ROUTES = new Set(["keyroom", "award", "final"]);

function clampRoundIndex(raw) {
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return 1;
  if (num > GAME_ROUNDS) return GAME_ROUNDS;
  return Math.round(num);
}

function stageIndexForRoute(route, qs) {
  const name = (route || "").toLowerCase();
  if (name === "watcher" || name === "rejoin") return 0;
  const round = clampRoundIndex(qs.get("round"));

  const preIdx = PRE_STAGE_ROUTES.indexOf(name);
  if (preIdx !== -1) return preIdx;

  const roundIdx = ROUND_STAGE_ROUTES.indexOf(name);
  if (roundIdx !== -1) {
    const roundBase = (round - 1) * ROUND_STAGE_ROUTES.length;
    return PRE_STAGE_ROUTES.length + roundBase + roundIdx;
  }

  if (name === "maths") {
    return PRE_STAGE_ROUTES.length + GAME_ROUNDS * ROUND_STAGE_ROUTES.length;
  }

  if (name === "final") {
    return FINAL_STAGE_INDEX;
  }

  return 0;
}

function applyBackgroundDepth(route, qs) {
  const index = stageIndexForRoute(route, qs);
  const clampedIndex = Math.max(0, Math.min(FINAL_STAGE_INDEX, index));
  const ratio = FINAL_STAGE_INDEX > 0 ? clampedIndex / FINAL_STAGE_INDEX : 0;
  const depth = Math.min(MAX_BG_DEPTH, ratio * MAX_BG_DEPTH);
  const lightness = 96 - ratio * (96 - 20);
  const saturation = 32 - ratio * 32;

  const root = document.documentElement;
  if (!root) return;
  root.style.setProperty("--paper-l", `${lightness.toFixed(2)}%`);
  root.style.setProperty("--paper-s", `${Math.max(0, saturation).toFixed(2)}%`);
  root.style.setProperty("--bg-depth", depth.toFixed(4));
}

if ("scrollRestoration" in history) {
  try { history.scrollRestoration = "manual"; } catch {}
}

const ScrollReset = (() => {
  let pending = 0;
  let lastKey = "";

  const toKey = (route, qs) => {
    const pairs = [];
    if (qs && typeof qs.forEach === "function") {
      qs.forEach((value, key) => { pairs.push([key, value]); });
    }
    pairs.sort((a, b) => {
      if (a[0] === b[0]) return String(a[1] || "").localeCompare(String(b[1] || ""));
      return String(a[0] || "").localeCompare(String(b[0] || ""));
    });
    const query = pairs.map(([key, value]) => `${key}=${value}`).join("&");
    return `${route || ""}?${query}`;
  };

  const flush = () => {
    pending = 0;
    try {
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    } catch {
      window.scrollTo(0, 0);
    }
    if (document?.documentElement) document.documentElement.scrollTop = 0;
    if (document?.body) document.body.scrollTop = 0;
  };

  return {
    reset(route, qs) {
      const key = toKey(route, qs);
      if (!key || key === lastKey) return;
      lastKey = key;
      if (pending) cancelAnimationFrame(pending);
      pending = requestAnimationFrame(flush);
    },
  };
})();

const app = document.getElementById("app");

// Keep track of mounted view instance so we can unmount cleanly.
let current = { route: "", mod: null, unmount: null };

// Routes that should NOT show the score strip
const STRIP_EXCLUDE = new Set(["lobby", "keyroom", "coderoom", "seeding", "final", "watcher", "rejoin"]);

let centerFrame = 0;
let centerObserver = null;
let centerObservedView = null;

function resetCenteredView() {
  if (!app) return;
  const view = app.querySelector(".view");
  if (!view) return;
  view.style.position = "";
  view.style.left = "";
  view.style.top = "";
  view.style.transform = "";
  view.style.margin = "";
  if (centerObserver) {
    centerObserver.disconnect();
    centerObserver = null;
  }
  centerObservedView = null;
}

function applyLayoutMode(route) {
  const body = document.body;
  if (!body) return;
  const centered = !TOP_ALIGNED_ROUTES.has(route);
  body.classList.toggle("layout-centered", centered);
  body.classList.toggle("layout-top", !centered);
  body.classList.toggle("layout-scroll-lock", centered);
  if (!centered) resetCenteredView();
}

function readMetric(styles, name) {
  if (!styles) return 0;
  const raw = styles.getPropertyValue(name);
  if (!raw) return 0;
  const num = parseFloat(raw);
  return Number.isFinite(num) ? num : 0;
}

function centerActiveView() {
  centerFrame = 0;
  if (!document.body.classList.contains("layout-centered")) return;
  if (!app) return;
  const view = app.querySelector(".view");
  if (!view) return;

  const docEl = document.documentElement;
  const computed = docEl ? getComputedStyle(docEl) : null;
  const topGap = readMetric(computed, "--score-strip-top-gap");
  const stripHeight = readMetric(computed, "--score-strip-height");
  const clearance = readMetric(computed, "--score-strip-clearance") || topGap * 2 + stripHeight;
  const hasStrip = document.body.classList.contains("has-score-strip");

  const viewportHeight = Math.max(window.innerHeight || 0, docEl?.clientHeight || 0);
  if (viewportHeight <= 0) return;

  const rect = view.getBoundingClientRect();
  const viewHeight = rect.height;
  const naturalTop = (viewportHeight - viewHeight) / 2;
  const minTopBase = hasStrip ? clearance : topGap;
  const minTop = Math.max(0, minTopBase);
  const maxTop = Math.max(minTop, viewportHeight - viewHeight);
  const top = Math.min(Math.max(minTop, naturalTop), maxTop);

  view.style.position = "relative";
  view.style.left = "";
  view.style.top = `${top}px`;
  view.style.transform = "";
  view.style.margin = "0 auto";
}

function queueCentering() {
  if (!document.body.classList.contains("layout-centered")) {
    resetCenteredView();
    if (centerFrame) {
      cancelAnimationFrame(centerFrame);
      centerFrame = 0;
    }
    return;
  }
  if (typeof ResizeObserver === "function") {
    const view = app?.querySelector(".view");
    if (view) {
      if (!centerObserver) {
        centerObserver = new ResizeObserver(() => queueCentering());
      }
      if (centerObservedView !== view) {
        centerObserver.disconnect();
        centerObserver.observe(view);
        centerObservedView = view;
      }
    }
  }
  if (centerFrame) cancelAnimationFrame(centerFrame);
  centerFrame = requestAnimationFrame(centerActiveView);
}

window.addEventListener("resize", queueCentering);
window.addEventListener("score-strip:layout", queueCentering);

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

  applyLayoutMode(actualRoute);

  // Unmount old view (if any)
  if (typeof current?.unmount === "function") {
    try { await current.unmount(); } catch {}
  }
  current = { route: actualRoute, mod: null, unmount: null };

  // Fresh container for the new view
  clearNode(app);

  applyBackgroundDepth(actualRoute, qs);

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

    ScrollReset.reset(actualRoute, qs);
    queueCentering();
  } catch (e) {
    // Hard failure: show a tiny crash card (keeps UX within visual language)
    console.error("[router] mount failed:", e);
    ScoreStrip.hide();
    app.innerHTML = `
      <div class="view"><div class="card">
        <div class="mono" style="font-weight:700;margin-bottom:6px;">Oops — couldn’t load “${route}”.</div>
        <div class="mono small" style="opacity:.8">Try going back to the lobby.</div>
      </div></div>`;
    ScrollReset.reset(actualRoute, qs);
    queueCentering();
  }
}

// Boot + navigation
window.addEventListener("hashchange", mountRoute);
window.addEventListener("load", mountRoute);
mountRoute().catch((err) => console.error("[router] initial mount failed:", err));
