const THEME_PREFIX = "theme-";

const ROUND_THEMES = {
  1: "theme-dawn",
  2: "theme-midday",
  3: "theme-sunset",
  4: "theme-dusk",
  5: "theme-night",
};

const VIEW_THEMES = {
  lobby: "theme-lobby",
  keyroom: "theme-lobby",
  coderoom: "theme-lobby",
  seeding: "theme-lobby",
  award: "theme-night",
  final: "theme-night",
  maths: "theme-night",
};

function clampRound(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  if (n > 5) return 5;
  return Math.round(n);
}

function applyThemeClass(themeName) {
  const root = document.documentElement;
  if (!root || !themeName) return;
  const classes = Array.from(root.classList);
  classes
    .filter((name) => name && name.startsWith(THEME_PREFIX))
    .forEach((name) => root.classList.remove(name));
  root.classList.add(themeName);
}

export function applyRoundTheme(round = 1) {
  const theme = ROUND_THEMES[clampRound(round)] || ROUND_THEMES[1];
  applyThemeClass(theme);
  return theme;
}

export function applyStageTheme(viewName, round = 1) {
  const key = String(viewName || "").toLowerCase();
  const theme = VIEW_THEMES[key] || ROUND_THEMES[clampRound(round)] || ROUND_THEMES[1];
  applyThemeClass(theme);
  return theme;
}

export function clearTheme() {
  const root = document.documentElement;
  if (!root) return;
  const classes = Array.from(root.classList);
  classes
    .filter((name) => name && name.startsWith(THEME_PREFIX))
    .forEach((name) => root.classList.remove(name));
}
