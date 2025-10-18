const root = typeof document !== "undefined" ? document.documentElement : null;

const STAGE_BASE_PROGRESS = {
  lobby: 0.02,
  keyroom: 0.08,
  coderoom: 0.1,
  seeding: 0.12,
  watcher: 0.14,
  rejoin: 0.16,
  countdown: 0.22,
  interlude: 0.28,
  questions: 0.32,
  marking: 0.42,
  award: 0.52,
  maths: 0.82,
  final: 0.94,
};

const ROUND_WEIGHT = 0.11;

function clamp01(value) {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function wrapHue(h) {
  const r = h % 360;
  return r < 0 ? r + 360 : r;
}

function toHsl(h, s, l, a = 1) {
  const hue = wrapHue(h);
  const sat = Math.max(0, Math.min(100, s));
  const light = Math.max(0, Math.min(100, l));
  const alpha = Math.max(0, Math.min(1, a));
  return `hsla(${Math.round(hue)}, ${Math.round(sat)}%, ${Math.round(light)}%, ${alpha.toFixed(3)})`;
}

function paletteFromProgress(progress) {
  const p = clamp01(progress);
  const baseHue = wrapHue(324 - p * 220);
  const accentHue = wrapHue(baseHue + 34);
  const glowHue = wrapHue(baseHue + 76);

  const ink = toHsl(baseHue, 82, 14 - p * 2);
  const muted = toHsl(baseHue, 40, 38 + p * 10, 0.78);
  const paper = toHsl(baseHue + 188, 92, 96 - p * 8);
  const cardLight = 97 - p * 7;
  const card = `hsla(${wrapHue(baseHue + 194)}, 82%, ${cardLight.toFixed(2)}%, 0.94)`;
  const softLine = toHsl(baseHue, 38, 36 - p * 4, 0.32 + p * 0.14);
  const accent = toHsl(accentHue, 94, 56 - p * 4);
  const accentStrong = toHsl(accentHue, 96, 50 - p * 4);
  const accentSoft = toHsl(accentHue, 86, 78 - p * 6, 0.82);
  const glow = toHsl(glowHue, 98, 74 + p * 8, 0.82);
  const glimmer = toHsl(glowHue + 24, 94, 82 - p * 6, 0.75);
  const gradientStart = toHsl(accentHue + 300, 92, 84 - p * 6, 0.9);
  const gradientMid = toHsl(glowHue, 96, 74 + p * 4, 0.92);
  const gradientEnd = toHsl(baseHue + 210, 86, 88 - p * 12, 0.94);
  const ok = toHsl(accentHue + 90, 82, 46 - p * 4);
  const bad = toHsl(accentHue - 44, 92, 48 - p * 3);
  const shadow = `0 26px 54px ${toHsl(baseHue, 88, 14, 0.28 + p * 0.04)}`;
  const shadowSoft = `0 18px 40px ${toHsl(baseHue, 78, 18, 0.24 + p * 0.04)}`;
  const borderGlow = toHsl(accentHue, 88, 62 + p * 6, 0.42);

  const angle = 148 + p * 52;

  return {
    "--theme-progress": p.toFixed(3),
    "--ink": ink,
    "--muted": muted,
    "--paper": paper,
    "--paper-alt": toHsl(baseHue + 198, 84, 98 - p * 6),
    "--card": card,
    "--soft-line": softLine,
    "--accent": accent,
    "--accent-strong": accentStrong,
    "--accent-soft": accentSoft,
    "--accent-glow": glow,
    "--accent-glimmer": glimmer,
    "--gradient-start": gradientStart,
    "--gradient-mid": gradientMid,
    "--gradient-end": gradientEnd,
    "--gradient-angle": `${angle.toFixed(1)}deg`,
    "--ok": ok,
    "--bad": bad,
    "--shadow": shadow,
    "--shadow-soft": shadowSoft,
    "--ring-glow": borderGlow,
    "--focus-ring": `0 0 0 3px ${toHsl(accentHue, 96, 64, 0.45)}`,
    "--selection": toHsl(accentHue, 96, 72, 0.35),
  };
}

function computeProgress(stage, round = 1) {
  const base = STAGE_BASE_PROGRESS[stage] ?? 0.18;
  const r = Math.max(1, Number(round) || 1);
  const progress = base + (r - 1) * ROUND_WEIGHT;
  return clamp01(progress);
}

export function applySceneTheme(stage, { round = 1 } = {}) {
  if (!root) return;
  const palette = paletteFromProgress(computeProgress(stage, round));
  Object.entries(palette).forEach(([key, value]) => {
    root.style.setProperty(key, value);
  });
}

export function setThemeProgress(progress) {
  if (!root) return;
  const palette = paletteFromProgress(progress);
  Object.entries(palette).forEach(([key, value]) => {
    root.style.setProperty(key, value);
  });
}
