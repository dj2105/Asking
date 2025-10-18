const BASE = {
  "font-base": "Courier Prime, \"Courier New\", Courier, monospace",
  ink: "#0d152f",
  muted: "rgba(13, 21, 47, 0.64)",
  "soft-line": "rgba(13, 21, 47, 0.18)",
  paper: "#f6f7ff",
  card: "rgba(255, 255, 255, 0.9)",
  "card-bright": "rgba(255, 255, 255, 0.96)",
  "card-outline": "rgba(13, 21, 47, 0.08)",
  accent: "#ff6f5b",
  "accent-strong": "#ff9a3c",
  "accent-soft": "rgba(255, 111, 91, 0.18)",
  "accent-contrast": "#05070f",
  glow: "rgba(255, 111, 91, 0.32)",
  "glow-soft": "rgba(8, 18, 40, 0.16)",
  "bg-top": "#f5f7ff",
  "bg-middle": "#fef1ee",
  "bg-bottom": "#fff9eb",
  beam: "rgba(255, 255, 255, 0.24)",
  "strip-start": "#0d152f",
  "strip-end": "#1a2f66",
  "strip-text": "#f8fbff",
  ok: "#19c995",
  bad: "#ff4a68",
};

const ROUND_THEMES = [
  {
    ink: "#111433",
    muted: "rgba(17, 20, 51, 0.64)",
    "soft-line": "rgba(17, 20, 51, 0.2)",
    paper: "#fff7fb",
    card: "rgba(255, 255, 255, 0.9)",
    "card-bright": "rgba(255, 255, 255, 0.97)",
    "card-outline": "rgba(255, 93, 143, 0.2)",
    accent: "#ff5d8f",
    "accent-strong": "#ff9a42",
    "accent-soft": "rgba(255, 93, 143, 0.16)",
    "accent-contrast": "#0b0814",
    glow: "rgba(255, 93, 143, 0.35)",
    "glow-soft": "rgba(255, 154, 66, 0.24)",
    "bg-top": "#fff0f8",
    "bg-middle": "#ffe0f0",
    "bg-bottom": "#fff8eb",
    beam: "rgba(255, 255, 255, 0.36)",
    "strip-start": "#ff5d8f",
    "strip-end": "#ff9a42",
    "strip-text": "#140713",
  },
  {
    ink: "#071b33",
    muted: "rgba(7, 27, 51, 0.65)",
    "soft-line": "rgba(7, 27, 51, 0.16)",
    paper: "#f2fbff",
    card: "rgba(255, 255, 255, 0.92)",
    "card-bright": "rgba(255, 255, 255, 0.97)",
    "card-outline": "rgba(22, 210, 255, 0.2)",
    accent: "#16d2ff",
    "accent-strong": "#5372ff",
    "accent-soft": "rgba(22, 210, 255, 0.18)",
    "accent-contrast": "#021019",
    glow: "rgba(22, 210, 255, 0.32)",
    "glow-soft": "rgba(83, 114, 255, 0.24)",
    "bg-top": "#ecfbff",
    "bg-middle": "#e0ecff",
    "bg-bottom": "#f3f0ff",
    beam: "rgba(255, 255, 255, 0.38)",
    "strip-start": "#16d2ff",
    "strip-end": "#5372ff",
    "strip-text": "#031229",
  },
  {
    ink: "#06261f",
    muted: "rgba(6, 38, 31, 0.62)",
    "soft-line": "rgba(6, 38, 31, 0.16)",
    paper: "#f0fff7",
    card: "rgba(255, 255, 255, 0.9)",
    "card-bright": "rgba(255, 255, 255, 0.96)",
    "card-outline": "rgba(82, 242, 172, 0.22)",
    accent: "#52f2ac",
    "accent-strong": "#00c7be",
    "accent-soft": "rgba(82, 242, 172, 0.18)",
    "accent-contrast": "#021410",
    glow: "rgba(82, 242, 172, 0.32)",
    "glow-soft": "rgba(0, 199, 190, 0.26)",
    "bg-top": "#e9fff4",
    "bg-middle": "#dffcf4",
    "bg-bottom": "#ecfff5",
    beam: "rgba(255, 255, 255, 0.34)",
    "strip-start": "#52f2ac",
    "strip-end": "#00c7be",
    "strip-text": "#02231c",
  },
  {
    ink: "#180b33",
    muted: "rgba(24, 11, 51, 0.62)",
    "soft-line": "rgba(24, 11, 51, 0.16)",
    paper: "#f9f2ff",
    card: "rgba(255, 255, 255, 0.92)",
    "card-bright": "rgba(255, 255, 255, 0.97)",
    "card-outline": "rgba(200, 107, 255, 0.2)",
    accent: "#c86bff",
    "accent-strong": "#ff74b8",
    "accent-soft": "rgba(200, 107, 255, 0.18)",
    "accent-contrast": "#0e0616",
    glow: "rgba(200, 107, 255, 0.35)",
    "glow-soft": "rgba(255, 116, 184, 0.24)",
    "bg-top": "#f6ecff",
    "bg-middle": "#ffe6f8",
    "bg-bottom": "#fdf2ff",
    beam: "rgba(255, 255, 255, 0.32)",
    "strip-start": "#c86bff",
    "strip-end": "#ff74b8",
    "strip-text": "#210a2d",
  },
  {
    ink: "#2b0c1e",
    muted: "rgba(43, 12, 30, 0.64)",
    "soft-line": "rgba(43, 12, 30, 0.18)",
    paper: "#fff7ef",
    card: "rgba(255, 255, 255, 0.92)",
    "card-bright": "rgba(255, 255, 255, 0.97)",
    "card-outline": "rgba(255, 179, 71, 0.2)",
    accent: "#ffb347",
    "accent-strong": "#ff5e62",
    "accent-soft": "rgba(255, 179, 71, 0.2)",
    "accent-contrast": "#140708",
    glow: "rgba(255, 94, 98, 0.36)",
    "glow-soft": "rgba(255, 179, 71, 0.26)",
    "bg-top": "#fff3e5",
    "bg-middle": "#ffe4ec",
    "bg-bottom": "#fff7dd",
    beam: "rgba(255, 255, 255, 0.34)",
    "strip-start": "#ffb347",
    "strip-end": "#ff5e62",
    "strip-text": "#220d15",
  },
];

const STAGE_THEMES = {
  default: {},
  lobby: {
    ink: "#0d1a3a",
    muted: "rgba(13, 26, 58, 0.65)",
    paper: "#f3f6ff",
    card: "rgba(255, 255, 255, 0.92)",
    "card-bright": "rgba(255, 255, 255, 0.98)",
    "card-outline": "rgba(90, 123, 255, 0.25)",
    accent: "#5a7bff",
    "accent-strong": "#8ec5ff",
    "accent-soft": "rgba(90, 123, 255, 0.2)",
    "accent-contrast": "#03070f",
    glow: "rgba(90, 123, 255, 0.35)",
    "glow-soft": "rgba(90, 123, 255, 0.2)",
    "bg-top": "#eef3ff",
    "bg-middle": "#dfeaff",
    "bg-bottom": "#f7f9ff",
    beam: "rgba(255, 255, 255, 0.3)",
    "strip-start": "#5a7bff",
    "strip-end": "#8ec5ff",
    "strip-text": "#0b1633",
  },
  keyroom: {
    ink: "#1b1733",
    muted: "rgba(27, 23, 51, 0.62)",
    paper: "#fff5ee",
    card: "rgba(255, 255, 255, 0.9)",
    "card-bright": "rgba(255, 255, 255, 0.97)",
    "card-outline": "rgba(255, 138, 61, 0.18)",
    accent: "#ff8a3d",
    "accent-strong": "#ffd86b",
    "accent-soft": "rgba(255, 138, 61, 0.25)",
    "accent-contrast": "#140804",
    glow: "rgba(255, 138, 61, 0.32)",
    "glow-soft": "rgba(255, 216, 107, 0.22)",
    "bg-top": "#fff3ea",
    "bg-middle": "#ffeedb",
    "bg-bottom": "#fff9e7",
    beam: "rgba(255, 255, 255, 0.32)",
    "strip-start": "#ff8a3d",
    "strip-end": "#ffd86b",
    "strip-text": "#241208",
  },
  coderoom: {
    ink: "#161636",
    muted: "rgba(22, 22, 54, 0.62)",
    paper: "#f3f0ff",
    card: "rgba(255, 255, 255, 0.9)",
    "card-bright": "rgba(255, 255, 255, 0.97)",
    "card-outline": "rgba(133, 108, 255, 0.22)",
    accent: "#7368ff",
    "accent-strong": "#b198ff",
    "accent-soft": "rgba(115, 104, 255, 0.24)",
    "accent-contrast": "#08051a",
    glow: "rgba(115, 104, 255, 0.34)",
    "glow-soft": "rgba(177, 152, 255, 0.22)",
    "bg-top": "#f0ecff",
    "bg-middle": "#ede7ff",
    "bg-bottom": "#f7f2ff",
    beam: "rgba(255, 255, 255, 0.28)",
    "strip-start": "#7368ff",
    "strip-end": "#b198ff",
    "strip-text": "#0f0b2a",
  },
  seeding: {
    ink: "#113121",
    muted: "rgba(17, 49, 33, 0.6)",
    paper: "#f0fff6",
    card: "rgba(255, 255, 255, 0.92)",
    "card-bright": "rgba(255, 255, 255, 0.97)",
    "card-outline": "rgba(75, 224, 134, 0.2)",
    accent: "#4be086",
    "accent-strong": "#8ef7c1",
    "accent-soft": "rgba(75, 224, 134, 0.2)",
    "accent-contrast": "#03140a",
    glow: "rgba(75, 224, 134, 0.32)",
    "glow-soft": "rgba(142, 247, 193, 0.22)",
    "bg-top": "#e7fff3",
    "bg-middle": "#dbffeb",
    "bg-bottom": "#f3fff6",
    beam: "rgba(255, 255, 255, 0.3)",
    "strip-start": "#4be086",
    "strip-end": "#8ef7c1",
    "strip-text": "#08301b",
  },
  watcher: {
    ink: "#0e1d36",
    muted: "rgba(14, 29, 54, 0.66)",
    paper: "#edf4ff",
    card: "rgba(255, 255, 255, 0.92)",
    "card-bright": "rgba(255, 255, 255, 0.97)",
    "card-outline": "rgba(59, 141, 255, 0.18)",
    accent: "#3b8dff",
    "accent-strong": "#74c0ff",
    "accent-soft": "rgba(59, 141, 255, 0.2)",
    "accent-contrast": "#03060d",
    glow: "rgba(59, 141, 255, 0.32)",
    "glow-soft": "rgba(116, 192, 255, 0.24)",
    "bg-top": "#e7f1ff",
    "bg-middle": "#dbeaff",
    "bg-bottom": "#f1f7ff",
    beam: "rgba(255, 255, 255, 0.28)",
    "strip-start": "#3b8dff",
    "strip-end": "#74c0ff",
    "strip-text": "#0a1629",
  },
  rejoin: {
    ink: "#102335",
    muted: "rgba(16, 35, 53, 0.64)",
    paper: "#eef8ff",
    card: "rgba(255, 255, 255, 0.92)",
    "card-bright": "rgba(255, 255, 255, 0.97)",
    "card-outline": "rgba(0, 166, 255, 0.2)",
    accent: "#00a6ff",
    "accent-strong": "#62d2ff",
    "accent-soft": "rgba(0, 166, 255, 0.22)",
    "accent-contrast": "#01121a",
    glow: "rgba(0, 166, 255, 0.32)",
    "glow-soft": "rgba(98, 210, 255, 0.24)",
    "bg-top": "#e9f7ff",
    "bg-middle": "#daf0ff",
    "bg-bottom": "#f2fbff",
    beam: "rgba(255, 255, 255, 0.3)",
    "strip-start": "#00a6ff",
    "strip-end": "#62d2ff",
    "strip-text": "#051a2b",
  },
  maths: {
    ink: "#0b2330",
    muted: "rgba(11, 35, 48, 0.62)",
    paper: "#eefcff",
    card: "rgba(255, 255, 255, 0.9)",
    "card-bright": "rgba(255, 255, 255, 0.96)",
    "card-outline": "rgba(0, 189, 214, 0.2)",
    accent: "#00bdd6",
    "accent-strong": "#4df2ff",
    "accent-soft": "rgba(0, 189, 214, 0.24)",
    "accent-contrast": "#021215",
    glow: "rgba(0, 189, 214, 0.32)",
    "glow-soft": "rgba(77, 242, 255, 0.24)",
    "bg-top": "#e5fcff",
    "bg-middle": "#dff5ff",
    "bg-bottom": "#effcff",
    beam: "rgba(255, 255, 255, 0.32)",
    "strip-start": "#00bdd6",
    "strip-end": "#4df2ff",
    "strip-text": "#032127",
  },
  final: {
    ink: "#23120b",
    muted: "rgba(35, 18, 11, 0.62)",
    paper: "#fff7ec",
    card: "rgba(255, 255, 255, 0.92)",
    "card-bright": "rgba(255, 255, 255, 0.98)",
    "card-outline": "rgba(255, 190, 92, 0.22)",
    accent: "#ffb347",
    "accent-strong": "#ffe082",
    "accent-soft": "rgba(255, 179, 71, 0.26)",
    "accent-contrast": "#1a0b05",
    glow: "rgba(255, 179, 71, 0.34)",
    "glow-soft": "rgba(255, 224, 130, 0.28)",
    "bg-top": "#fff3df",
    "bg-middle": "#ffe8d1",
    "bg-bottom": "#fff8e8",
    beam: "rgba(255, 255, 255, 0.36)",
    "strip-start": "#ffb347",
    "strip-end": "#ffe082",
    "strip-text": "#21150a",
  },
};

const ROUND_STAGES = new Set(["countdown", "questions", "marking", "award", "interlude"]);

function normaliseRound(round) {
  const n = Number(round);
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > ROUND_THEMES.length) {
    return ((Math.floor(n) - 1) % ROUND_THEMES.length) + 1;
  }
  return Math.max(1, Math.floor(n));
}

export function applyTheme(stage = "", options = {}) {
  const root = document?.documentElement;
  if (!root) return;

  const key = String(stage || "").trim().toLowerCase();
  const isRoundStage = ROUND_STAGES.has(key);
  const tokens = { ...BASE };

  const defaultStageTokens = STAGE_THEMES.default || {};
  Object.assign(tokens, defaultStageTokens);

  if (isRoundStage) {
    const idx = normaliseRound(options.round) - 1;
    const roundTokens = ROUND_THEMES[idx] || ROUND_THEMES[0];
    Object.assign(tokens, roundTokens);
    if (STAGE_THEMES[key]) {
      Object.assign(tokens, STAGE_THEMES[key]);
    }
  } else if (STAGE_THEMES[key]) {
    Object.assign(tokens, STAGE_THEMES[key]);
  }

  for (const [token, value] of Object.entries(tokens)) {
    if (value != null) {
      root.style.setProperty(`--${token}`, String(value));
    }
  }

  if (key) {
    root.setAttribute("data-theme-stage", key);
  } else {
    root.removeAttribute("data-theme-stage");
  }

  if (isRoundStage) {
    root.setAttribute("data-theme-round", String(normaliseRound(options.round)));
  } else {
    root.removeAttribute("data-theme-round");
  }
}

export default { applyTheme };
