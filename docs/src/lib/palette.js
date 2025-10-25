// /src/lib/palette.js
//
// Shared palette helpers for the refreshed primary-colour UI.
// Provides a small pool of vibrant palettes and applies them to the
// document root with depth-aware adjustments so each phase can dial the
// intensity up or down without compromising contrast.

const PRIMARY_PALETTES = [
  {
    accent: "#0a5dff",
    mutedBase: "#122551",
    contrast: "#ffffff",
  },
  {
    accent: "#ff2d55",
    mutedBase: "#611026",
    contrast: "#ffffff",
  },
  {
    accent: "#ffb400",
    mutedBase: "#6a3c00",
    contrast: "#160a00",
  },
];

const clamp01 = (value) => Math.max(0, Math.min(1, value));

function hexToRgb(hex) {
  const clean = String(hex || "").trim().replace(/^#/, "");
  if (clean.length === 3) {
    const r = clean[0];
    const g = clean[1];
    const b = clean[2];
    return {
      r: parseInt(r + r, 16) || 0,
      g: parseInt(g + g, 16) || 0,
      b: parseInt(b + b, 16) || 0,
    };
  }
  const r = parseInt(clean.slice(0, 2), 16) || 0;
  const g = parseInt(clean.slice(2, 4), 16) || 0;
  const b = parseInt(clean.slice(4, 6), 16) || 0;
  return { r, g, b };
}

function toHexChannel(value) {
  const v = Math.round(Math.max(0, Math.min(255, value)));
  return v.toString(16).padStart(2, "0");
}

function mixHex(hexA, hexB, weight) {
  const t = clamp01(weight);
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  const r = a.r * (1 - t) + b.r * t;
  const g = a.g * (1 - t) + b.g * t;
  const bb = a.b * (1 - t) + b.b * t;
  return `#${toHexChannel(r)}${toHexChannel(g)}${toHexChannel(bb)}`;
}

function toRgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  const a = Math.max(0, Math.min(1, Number(alpha)));
  return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
}

function applyPaletteIndex(index, depth = 0) {
  const palette = PRIMARY_PALETTES[index] || PRIMARY_PALETTES[0];
  const stage = Math.max(0, Math.min(5, Number(depth) || 0));
  const accentStrong = palette.accent;
  const accentEdge = mixHex(accentStrong, "#000000", 0.42 + stage * 0.04);
  const accentSoft = mixHex(accentStrong, "#ffffff", 0.82 - stage * 0.05);
  const accentSoftStrong = mixHex(accentStrong, "#ffffff", 0.66 - stage * 0.05);
  const accentPunch = mixHex(accentStrong, "#ffffff", 0.38);
  const accentPunchStrong = mixHex(accentStrong, "#000000", 0.16 + stage * 0.03);
  const mutedHex = mixHex(palette.mutedBase, "#ffffff", 0.42 + stage * 0.04);
  const softLineHex = mixHex(accentEdge, "#ffffff", 0.76);

  const root = document.documentElement;
  root.style.setProperty("--ink", "#05070f");
  root.style.setProperty("--ink-strong", "#010208");
  root.style.setProperty("--paper", "#ffffff");
  root.style.setProperty("--card", "#ffffff");
  root.style.setProperty("--accent-strong", accentStrong);
  root.style.setProperty("--accent-edge", accentEdge);
  root.style.setProperty("--accent-soft", accentSoft);
  root.style.setProperty("--accent-soft-strong", accentSoftStrong);
  root.style.setProperty("--accent-contrast", palette.contrast);
  root.style.setProperty("--accent-punch", accentPunch);
  root.style.setProperty("--accent-punch-strong", accentPunchStrong);
  root.style.setProperty("--accent-glow", toRgba(accentStrong, 0.22));
  root.style.setProperty("--muted", toRgba(mutedHex, 0.9));
  root.style.setProperty("--soft-line", toRgba(softLineHex, 0.42));
  root.style.setProperty("--shadow-3d", `0 12px 0 0 ${accentEdge}, 0 24px 42px rgba(8, 16, 40, 0.24)`);
  root.style.setProperty("--shadow-3d-soft", `0 10px 0 0 ${accentSoftStrong}, 0 20px 34px rgba(8, 16, 40, 0.2)`);
  root.style.setProperty("--shadow-3d-tight", `0 6px 0 0 ${accentEdge}, 0 14px 24px rgba(8, 16, 40, 0.22)`);
  root.style.setProperty("--shadow-thin", `0 4px 0 0 ${accentSoftStrong}, 0 12px 20px rgba(8, 16, 40, 0.18)`);
  root.style.setProperty("--focus-ring", toRgba(accentStrong, 0.32));
  root.style.setProperty("--accent-index", String(index));
}

export function createViewPalette() {
  const paletteIndex = Math.floor(Math.random() * PRIMARY_PALETTES.length);
  return {
    index: paletteIndex,
    apply(roundNumber = 1) {
      const depth = Math.max(0, Number(roundNumber) - 1 || 0);
      applyPaletteIndex(paletteIndex, depth);
    },
  };
}

export function applySpecificPalette(index = 0, roundNumber = 1) {
  const safeIndex = ((Number(index) % PRIMARY_PALETTES.length) + PRIMARY_PALETTES.length) % PRIMARY_PALETTES.length;
  const depth = Math.max(0, Number(roundNumber) - 1 || 0);
  applyPaletteIndex(safeIndex, depth);
  return safeIndex;
}

export const PALETTES = PRIMARY_PALETTES.map((palette) => ({ ...palette }));

