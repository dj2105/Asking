const BASE_THEME = {
  ink: "#041221",
  inkSoft: "rgba(4, 18, 33, 0.64)",
  paper: "#f5f9ff",
  paperStrong: "#ffffff",
  card: "rgba(255, 255, 255, 0.9)",
  muted: "rgba(4, 18, 33, 0.6)",
  softLine: "rgba(4, 18, 33, 0.14)",
  accent: "#ff5c8a",
  accentStrong: "#f42d72",
  accentSoft: "rgba(244, 45, 114, 0.18)",
  accentGlow: "rgba(244, 45, 114, 0.24)",
  accentRing: "rgba(244, 45, 114, 0.35)",
  accentContrast: "#020812",
  appGradient:
    "radial-gradient(140% 160% at 50% 0%, #fff9f0 0%, #ffe5f6 46%, #edf6ff 100%)",
  beamGradient:
    "linear-gradient(135deg, rgba(255, 255, 255, 0.7) 0%, rgba(244, 45, 114, 0.12) 70%)",
  chromeGlow: "rgba(255, 255, 255, 0.34)",
  shadow: "0 28px 52px rgba(4, 18, 33, 0.16)",
  shadowSoft: "0 18px 42px rgba(4, 18, 33, 0.12)",
  stripBg:
    "linear-gradient(90deg, rgba(4, 18, 33, 0.88) 0%, rgba(4, 18, 33, 0.74) 55%, rgba(4, 18, 33, 0.88) 100%)",
  stripBorder: "rgba(255, 255, 255, 0.42)",
};

const PROGRESSION_BASE = [
  {
    paper: "#fff7f0",
    paperStrong: "#ffffff",
    gradientMid: "#ffe066",
    gradientEnd: "#ffe3ff",
    accent: "#ff6f61",
    accentStrong: "#ff2d7a",
    stripMid: "#ff4fa3",
    glow: "#ffd37a",
  },
  {
    paper: "#f4f4ff",
    paperStrong: "#ffffff",
    gradientMid: "#c3a7ff",
    gradientEnd: "#d2f7ff",
    accent: "#805bff",
    accentStrong: "#6c2dff",
    stripMid: "#00c8ff",
    glow: "#a48bff",
  },
  {
    paper: "#f0fff8",
    paperStrong: "#ffffff",
    gradientMid: "#7fffd2",
    gradientEnd: "#d5f8ff",
    accent: "#00c988",
    accentStrong: "#00a7c7",
    stripMid: "#00f0ff",
    glow: "#7effd4",
  },
  {
    paper: "#fff4f8",
    paperStrong: "#ffffff",
    gradientMid: "#ff8ad8",
    gradientEnd: "#ffe9d6",
    accent: "#ff5fcf",
    accentStrong: "#ff415c",
    stripMid: "#ff8a3d",
    glow: "#ffafda",
  },
  {
    paper: "#f6fbff",
    paperStrong: "#ffffff",
    gradientMid: "#5ad3ff",
    gradientEnd: "#fff7cc",
    accent: "#2b9eff",
    accentStrong: "#ffb33b",
    stripMid: "#58e2ff",
    glow: "#ffd45a",
  },
];

const PROGRESS_STAGES = new Set([
  "countdown",
  "questions",
  "marking",
  "award",
  "interlude",
]);

const HEX_RE = /^#?([a-f0-9]{3}|[a-f0-9]{6})$/i;

function hexToRgb(hex) {
  if (typeof hex !== "string") return null;
  const match = hex.trim().match(HEX_RE);
  if (!match) return null;
  let value = match[1];
  if (value.length === 3) {
    value = value
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const int = parseInt(value, 16);
  return {
    r: (int >> 16) & 255,
    g: (int >> 8) & 255,
    b: int & 255,
  };
}

function withAlpha(rgb, alpha) {
  if (!rgb) return "rgba(255, 255, 255, 0.2)";
  const a = Math.min(1, Math.max(0, Number(alpha) || 0));
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a})`;
}

function buildProgressionPalette(round) {
  const idx = Math.max(0, Math.min(PROGRESSION_BASE.length - 1, round - 1));
  const step = PROGRESSION_BASE[idx];
  const accentRgb = hexToRgb(step.accentStrong || step.accent);
  const glowRgb = hexToRgb(step.glow || step.accent);
  const paperRgb = hexToRgb(step.paper || "#ffffff");
  const gradientMidRgb = hexToRgb(step.gradientMid || step.accent);
  const gradientEndRgb = hexToRgb(step.gradientEnd || step.paperStrong || step.paper);

  return {
    paper: step.paper || BASE_THEME.paper,
    paperStrong: step.paperStrong || BASE_THEME.paperStrong,
    card: "rgba(255, 255, 255, 0.92)",
    softLine: withAlpha(accentRgb, 0.18),
    accent: step.accent || BASE_THEME.accent,
    accentStrong: step.accentStrong || step.accent || BASE_THEME.accentStrong,
    accentSoft: withAlpha(accentRgb, 0.18),
    accentGlow: withAlpha(glowRgb, 0.32),
    accentRing: withAlpha(accentRgb, 0.38),
    appGradient: `radial-gradient(140% 180% at 50% 0%, ${withAlpha(
      paperRgb,
      1
    )} 0%, ${withAlpha(gradientMidRgb, 0.9)} 46%, ${withAlpha(
      gradientEndRgb,
      1
    )} 100%)`,
    beamGradient: `linear-gradient(135deg, rgba(255, 255, 255, 0.72) 0%, ${withAlpha(
      accentRgb,
      0.16
    )} 70%)`,
    chromeGlow: withAlpha(glowRgb, 0.28),
    stripBg: `linear-gradient(90deg, ${withAlpha(accentRgb, 0.92)} 0%, ${step.stripMid ||
      step.accentStrong ||
      step.accent} 55%, ${withAlpha(accentRgb, 0.92)} 100%)`,
    stripBorder: "rgba(255, 255, 255, 0.52)",
  };
}

const STAGE_OVERRIDES = {
  lobby: () => ({
    paper: "#e9f4ff",
    paperStrong: "#ffffff",
    card: "rgba(255, 255, 255, 0.94)",
    softLine: "rgba(0, 140, 255, 0.18)",
    accent: "#009dff",
    accentStrong: "#00d2ff",
    accentSoft: "rgba(0, 157, 255, 0.18)",
    accentGlow: "rgba(0, 214, 255, 0.32)",
    accentRing: "rgba(0, 157, 255, 0.38)",
    appGradient:
      "radial-gradient(150% 190% at 50% 0%, #e9f4ff 0%, #e8ffee 48%, #eef3ff 100%)",
    beamGradient:
      "linear-gradient(135deg, rgba(255, 255, 255, 0.75) 0%, rgba(0, 210, 255, 0.18) 70%)",
    chromeGlow: "rgba(0, 210, 255, 0.26)",
    stripBg:
      "linear-gradient(90deg, rgba(0, 157, 255, 0.9) 0%, rgba(0, 210, 255, 0.88) 52%, rgba(0, 157, 255, 0.9) 100%)",
    stripBorder: "rgba(255, 255, 255, 0.6)",
  }),
  keyroom: () => ({
    paper: "#fff6ed",
    paperStrong: "#ffffff",
    softLine: "rgba(255, 163, 102, 0.22)",
    accent: "#ff914d",
    accentStrong: "#ff5d7a",
    accentSoft: "rgba(255, 145, 77, 0.22)",
    accentGlow: "rgba(255, 173, 115, 0.32)",
    accentRing: "rgba(255, 145, 77, 0.38)",
    appGradient:
      "radial-gradient(140% 170% at 50% 0%, #fff0df 0%, #ffe4ff 48%, #fff6ed 100%)",
    stripBg:
      "linear-gradient(90deg, rgba(255, 145, 77, 0.92) 0%, rgba(255, 93, 122, 0.9) 52%, rgba(255, 145, 77, 0.92) 100%)",
    stripBorder: "rgba(255, 255, 255, 0.52)",
  }),
  coderoom: () => ({
    paper: "#f1f6ff",
    softLine: "rgba(126, 106, 255, 0.22)",
    accent: "#7e6aff",
    accentStrong: "#4d54ff",
    accentSoft: "rgba(78, 84, 255, 0.2)",
    accentGlow: "rgba(140, 132, 255, 0.32)",
    accentRing: "rgba(78, 84, 255, 0.38)",
    appGradient:
      "radial-gradient(150% 200% at 50% 0%, #f1f6ff 0%, #f3e9ff 46%, #e7fbff 100%)",
    stripBg:
      "linear-gradient(90deg, rgba(78, 84, 255, 0.94) 0%, rgba(126, 106, 255, 0.9) 50%, rgba(78, 84, 255, 0.94) 100%)",
    stripBorder: "rgba(255, 255, 255, 0.48)",
  }),
  seeding: () => ({
    paper: "#f7fffa",
    softLine: "rgba(0, 196, 140, 0.2)",
    accent: "#00c48c",
    accentStrong: "#009bff",
    accentSoft: "rgba(0, 196, 140, 0.22)",
    accentGlow: "rgba(0, 220, 180, 0.3)",
    accentRing: "rgba(0, 196, 140, 0.34)",
    appGradient:
      "radial-gradient(160% 200% at 50% 0%, #f2fffb 0%, #e6fffa 46%, #f5f9ff 100%)",
    stripBg:
      "linear-gradient(90deg, rgba(0, 196, 140, 0.9) 0%, rgba(0, 155, 255, 0.88) 52%, rgba(0, 196, 140, 0.9) 100%)",
    stripBorder: "rgba(255, 255, 255, 0.5)",
  }),
  maths: () => ({
    paper: "#f4fff2",
    softLine: "rgba(115, 204, 0, 0.22)",
    accent: "#73cc00",
    accentStrong: "#24cbaa",
    accentSoft: "rgba(115, 204, 0, 0.22)",
    accentGlow: "rgba(132, 255, 168, 0.36)",
    accentRing: "rgba(115, 204, 0, 0.38)",
    appGradient:
      "radial-gradient(160% 210% at 50% 0%, #f4fff2 0%, #eafff0 46%, #f2fbff 100%)",
    stripBg:
      "linear-gradient(90deg, rgba(36, 203, 170, 0.9) 0%, rgba(115, 204, 0, 0.9) 55%, rgba(36, 203, 170, 0.9) 100%)",
    stripBorder: "rgba(255, 255, 255, 0.52)",
  }),
  final: () => ({
    paper: "#f6f2ff",
    softLine: "rgba(142, 121, 255, 0.2)",
    accent: "#8e79ff",
    accentStrong: "#4ec7ff",
    accentSoft: "rgba(142, 121, 255, 0.22)",
    accentGlow: "rgba(181, 161, 255, 0.34)",
    accentRing: "rgba(142, 121, 255, 0.36)",
    appGradient:
      "radial-gradient(170% 220% at 50% 0%, #f6f2ff 0%, #ecf8ff 48%, #fff6fb 100%)",
    stripBg:
      "linear-gradient(90deg, rgba(142, 121, 255, 0.92) 0%, rgba(78, 199, 255, 0.92) 55%, rgba(142, 121, 255, 0.92) 100%)",
    stripBorder: "rgba(255, 255, 255, 0.52)",
  }),
  rejoin: () => ({
    paper: "#f9f5ff",
    softLine: "rgba(104, 128, 255, 0.22)",
    accent: "#6880ff",
    accentStrong: "#40cfff",
    accentSoft: "rgba(104, 128, 255, 0.2)",
    accentGlow: "rgba(135, 157, 255, 0.32)",
    accentRing: "rgba(104, 128, 255, 0.36)",
    appGradient:
      "radial-gradient(150% 200% at 50% 0%, #f9f5ff 0%, #eef7ff 48%, #fdf6ff 100%)",
    stripBg:
      "linear-gradient(90deg, rgba(104, 128, 255, 0.92) 0%, rgba(64, 207, 255, 0.9) 55%, rgba(104, 128, 255, 0.92) 100%)",
    stripBorder: "rgba(255, 255, 255, 0.5)",
  }),
};

const PROGRESS_EXTRAS = {
  countdown: () => ({
    accentGlow: "rgba(255, 255, 255, 0.4)",
    card: "rgba(255, 255, 255, 0.88)",
  }),
  marking: () => ({
    card: "rgba(255, 255, 255, 0.94)",
    accentGlow: "rgba(255, 255, 255, 0.3)",
  }),
  award: () => ({
    accentGlow: "rgba(255, 255, 255, 0.32)",
  }),
  interlude: () => ({
    accentGlow: "rgba(255, 255, 255, 0.28)",
  }),
};

export function applyStageTheme({ stage, round } = {}) {
  const ctx = {
    stage: String(stage || "default").toLowerCase(),
    round: Number(round) || 1,
  };

  let palette = null;

  if (typeof STAGE_OVERRIDES[ctx.stage] === "function") {
    palette = STAGE_OVERRIDES[ctx.stage](ctx) || {};
  } else if (PROGRESS_STAGES.has(ctx.stage)) {
    palette = buildProgressionPalette(ctx.round);
    const extra = PROGRESS_EXTRAS[ctx.stage];
    if (typeof extra === "function") {
      palette = { ...palette, ...extra(ctx) };
    }
  } else {
    palette = buildProgressionPalette(ctx.round);
  }

  const merged = { ...BASE_THEME, ...palette };
  const root = document.documentElement;
  Object.entries(merged).forEach(([key, value]) => {
    root.style.setProperty(`--${key}`, String(value));
  });
}

export default {
  applyStageTheme,
};

