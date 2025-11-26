const PRE_STAGE = new Set(["lobby", "keyroom", "coderoom", "seeding", "rejoin"]);
const ROUND_STAGE = new Set(["countdown", "questions", "marking", "award", "maths"]);
const FINAL_STAGE = new Set(["final"]);

const RETRO_THEMES = [
  {
    name: "retro-cyan-magenta",
    panelBg: "#00ffd0",
    panelBorder: "#000000",
    text: "#001b12",
    accent: "#ff006e",
    patternColor: "#00382c",
  },
  {
    name: "retro-lime-purple",
    panelBg: "#7aff00",
    panelBorder: "#000000",
    text: "#0a1b00",
    accent: "#a000ff",
    patternColor: "#1c3f00",
  },
  {
    name: "retro-magenta-yellow",
    panelBg: "#ff00ff",
    panelBorder: "#000000",
    text: "#100010",
    accent: "#ffee00",
    patternColor: "#3a003a",
  },
  {
    name: "retro-amber-blue",
    panelBg: "#ff8800",
    panelBorder: "#000000",
    text: "#1f0b00",
    accent: "#00d9ff",
    patternColor: "#3f2100",
  },
  {
    name: "retro-electric-blue",
    panelBg: "#00a0ff",
    panelBorder: "#000000",
    text: "#001022",
    accent: "#ffea00",
    patternColor: "#002a59",
  },
  {
    name: "retro-apple-green",
    panelBg: "#00ff66",
    panelBorder: "#000000",
    text: "#00160a",
    accent: "#ff3af2",
    patternColor: "#004223",
  },
];

const PRE_THEME_KEY = "retro-pre-theme-index";

function clampRound(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  if (n > 5) return 5;
  return Math.round(n);
}

function hashToIndex(text) {
  const str = String(text || "");
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash % RETRO_THEMES.length;
}

function pickThemeByIndex(index) {
  const safe = Number(index);
  const idx = Number.isInteger(safe) && safe >= 0 ? safe % RETRO_THEMES.length : 0;
  return RETRO_THEMES[idx];
}

function persistPreTheme(index) {
  try {
    sessionStorage.setItem(PRE_THEME_KEY, String(index));
  } catch (err) {
    console.warn("[theme] unable to persist pre-theme", err);
  }
}

function loadPreThemeIndex() {
  try {
    const raw = sessionStorage.getItem(PRE_THEME_KEY);
    if (raw == null) return null;
    const num = Number(raw);
    return Number.isInteger(num) ? num : null;
  } catch (err) {
    console.warn("[theme] unable to read pre-theme", err);
    return null;
  }
}

function nextRandomIndex(excludeIndex = null) {
  const pool = RETRO_THEMES.map((_, idx) => idx).filter((idx) => idx !== excludeIndex);
  if (!pool.length) return 0;
  const pick = Math.floor(Math.random() * pool.length);
  return pool[pick];
}

function themeForPreStage() {
  const stored = loadPreThemeIndex();
  const index = stored != null ? stored : nextRandomIndex();
  if (stored == null) persistPreTheme(index);
  return pickThemeByIndex(index);
}

function themeForRound(roomCode, round = 1) {
  const r = clampRound(round);
  const seed = `${roomCode || "offline"}:${r}`;
  return pickThemeByIndex(hashToIndex(seed));
}

function themeForFinal(roomCode, round = 5) {
  const lastRoundTheme = themeForRound(roomCode, round);
  const finalIndex = hashToIndex(`${roomCode || "offline"}:final`);
  const candidate = pickThemeByIndex(finalIndex);
  if (candidate.name !== lastRoundTheme.name) return candidate;
  return pickThemeByIndex((finalIndex + 1) % RETRO_THEMES.length);
}

function applyThemeVars(theme) {
  if (!theme) return theme;
  const root = document.documentElement;
  if (!root) return theme;
  const classes = Array.from(root.classList || []);
  classes
    .filter((name) => name && name.startsWith("theme-"))
    .forEach((name) => root.classList.remove(name));
  const target = {
    "--panel-bg": theme.panelBg,
    "--panel-border": theme.panelBorder,
    "--panel-text": theme.text,
    "--accent": theme.accent,
    "--accent-soft": theme.accent,
    "--retro-pattern": theme.patternColor,
    "--retro-shadow": theme.panelBorder,
    "--bg": "#000000",
    "--bg-soft": "#000000",
    "--card": theme.panelBg,
    "--card-ink": theme.text,
    "--ink": theme.text,
  };
  Object.entries(target).forEach(([key, value]) => {
    root.style.setProperty(key, value);
  });
  if (root?.classList) root.classList.add("theme-retro");
  if (document?.body) document.body.classList.add("retro-active");
  return theme;
}

export function applyRoundTheme(round = 1, roomCode = "") {
  return applyThemeVars(themeForRound(roomCode, round));
}

export function applyStageTheme(viewName, round = 1, roomCode = "") {
  const key = String(viewName || "").toLowerCase();
  if (PRE_STAGE.has(key)) return applyThemeVars(themeForPreStage());
  if (FINAL_STAGE.has(key)) return applyThemeVars(themeForFinal(roomCode, round));
  if (ROUND_STAGE.has(key)) return applyThemeVars(themeForRound(roomCode, round));
  return applyThemeVars(themeForRound(roomCode, round));
}

export function clearTheme() {
  const root = document.documentElement;
  if (!root) return;
  const props = [
    "--panel-bg",
    "--panel-border",
    "--panel-text",
    "--accent",
    "--accent-soft",
    "--retro-pattern",
    "--retro-shadow",
    "--card",
    "--card-ink",
    "--bg",
    "--bg-soft",
    "--ink",
  ];
  props.forEach((key) => root.style.removeProperty(key));
  const classes = Array.from(root.classList || []);
  classes
    .filter((name) => name && name.startsWith("theme-"))
    .forEach((name) => root.classList.remove(name));
  if (document?.body) document.body.classList.remove("retro-active");
}
