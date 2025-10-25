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

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function hslToRgb(h, s, l) {
  const hh = ((h % 360) + 360) % 360;
  const ss = clamp01(s / 100);
  const ll = clamp01(l / 100);
  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = ll - c / 2;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (hh < 60) { r1 = c; g1 = x; b1 = 0; }
  else if (hh < 120) { r1 = x; g1 = c; b1 = 0; }
  else if (hh < 180) { r1 = 0; g1 = c; b1 = x; }
  else if (hh < 240) { r1 = 0; g1 = x; b1 = c; }
  else if (hh < 300) { r1 = x; g1 = 0; b1 = c; }
  else { r1 = c; g1 = 0; b1 = x; }

  return [r1 + m, g1 + m, b1 + m].map((channel) => Math.round(channel * 255));
}

function parseCssColor(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;

  const hexMatch = value.match(/^#([0-9a-f]{3,8})$/i);
  if (hexMatch) {
    const hex = hexMatch[1];
    if (hex.length === 3) {
      return hex.split("").map((ch) => parseInt(ch + ch, 16));
    }
    if (hex.length >= 6) {
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
      ];
    }
  }

  const rgbMatch = value.match(/^rgba?\(([^)]+)\)$/i);
  if (rgbMatch) {
    const parts = rgbMatch[1]
      .split(",")
      .map((part) => parseFloat(part.trim()))
      .filter((num, idx) => idx < 3 && Number.isFinite(num));
    if (parts.length === 3) return parts.map((channel) => Math.max(0, Math.min(255, Math.round(channel))));
  }

  const hslMatch = value.match(/^hsla?\(([^)]+)\)$/i);
  if (hslMatch) {
    const parts = hslMatch[1].split(",");
    if (parts.length >= 3) {
      const h = parseFloat(parts[0]);
      const s = parseFloat(parts[1]);
      const l = parseFloat(parts[2]);
      if (Number.isFinite(h) && Number.isFinite(s) && Number.isFinite(l)) {
        return hslToRgb(h, s, l);
      }
    }
  }

  return null;
}

function rgbToHex([r, g, b]) {
  const toHex = (v) => {
    const clamped = Math.max(0, Math.min(255, Math.round(v)));
    return clamped.toString(16).padStart(2, "0");
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

const StageTone = (() => {
  const TOTAL_ROUNDS = 5;
  const PER_ROUND_PHASES = ["countdown", "questions", "marking", "award"];
  const EXTRA_PHASES = ["maths", "final"];
  const TARGET_RGB = [42, 42, 42];
  const TOTAL_STEPS = PER_ROUND_PHASES.length * TOTAL_ROUNDS + EXTRA_PHASES.length;

  const fallbackBase = parseCssColor("#f3f6f9") || [243, 246, 249];

  const clampRound = (maybeRound) => {
    const n = Number(maybeRound);
    if (!Number.isFinite(n)) return 1;
    if (n < 1) return 1;
    if (n > TOTAL_ROUNDS) return TOTAL_ROUNDS;
    return Math.floor(n);
  };

  const progressFor = (route, round) => {
    const stage = String(route || "").toLowerCase();
    const perRoundIndex = PER_ROUND_PHASES.indexOf(stage);
    if (perRoundIndex !== -1) {
      const safeRound = clampRound(round);
      return safeRound > 0
        ? (safeRound - 1) * PER_ROUND_PHASES.length + perRoundIndex
        : perRoundIndex;
    }
    if (stage === "maths") {
      return PER_ROUND_PHASES.length * TOTAL_ROUNDS;
    }
    if (stage === "final") {
      return Math.max(TOTAL_STEPS - 1, 0);
    }
    return 0;
  };

  const mix = (base, target, ratio) => base.map((channel, idx) => channel + (target[idx] - channel) * ratio);

  const apply = (route, round) => {
    const steps = Math.max(TOTAL_STEPS - 1, 1);
    const index = Math.max(0, Math.min(progressFor(route, round), steps));
    const progress = steps ? index / steps : 0;

    const computed = getComputedStyle(document.documentElement).getPropertyValue("--paper-base");
    const baseRgb = parseCssColor(computed) || fallbackBase;
    const mixed = mix(baseRgb, TARGET_RGB, progress);
    document.documentElement.style.setProperty("--paper", rgbToHex(mixed));
    document.documentElement.style.setProperty("--stage-tone-progress", progress.toFixed(3));
  };

  return { apply };
})();

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

    StageTone.apply(actualRoute, qs.get("round"));

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
  }
}

// Boot + navigation
window.addEventListener("hashchange", mountRoute);
window.addEventListener("load", mountRoute);
mountRoute().catch((err) => console.error("[router] initial mount failed:", err));
