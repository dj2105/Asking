// /src/lib/theme.js
// Central theme engine: bright→dark progression across the game.
// API: applyTheme({ phase: "lobby|keyroom|seeding|countdown|questions|marking|award|interlude|maths|final", round?:1..5 })

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n|0));

/**
 * We keep hue harmonious and adjust saturation/lightness by phase/round.
 * - Early screens are airy and light.
 * - Each round steps a little darker.
 * - Final is the starkest.
 */
export function applyTheme({ phase, round=1 }) {
  round = clamp(round, 1, 5);

  // Base (harmonious) hue and ranges — tweakable:
  // Use a calm blue-violet family; rotate hue slightly per round for subtle variety.
  const baseHue = 230;              // mid-indigo (clean, legible)
  const hueStep = 4;                // tiny rotation per round
  const h = (baseHue + (round-1)*hueStep) % 360;

  // Lightness ramp by phase (bg gets darker over time)
  // Values are percent lightness for BG and ink (text/UI) in HSL.
  const ramps = {
    lobby:      { bgL: 98, inkL: 16, s: 72 },
    keyroom:    { bgL: 97, inkL: 18, s: 72 },
    seeding:    { bgL: 96, inkL: 18, s: 70 },
    countdown:  { bgL: 94, inkL: 18, s: 70 },
    questions:  { bgL: 92 - (round-1)*2, inkL: 18, s: 70 },
    marking:    { bgL: 90 - (round-1)*2, inkL: 18, s: 70 },
    award:      { bgL: 88 - (round-1)*2, inkL: 18, s: 68 },
    interlude:  { bgL: 86 - (round-1)*2, inkL: 18, s: 68 },
    maths:      { bgL: 82, inkL: 14, s: 66 },
    final:      { bgL: 14, inkL: 96, s: 10 }  // stark + dark with light ink
  };

  const r = ramps[phase] || ramps.lobby;
  const root = document.documentElement;

  root.style.setProperty("--ink-h", String(h));
  root.style.setProperty("--ink-s", `${r.s}%`);
  root.style.setProperty("--ink-l", `${r.inkL}%`);

  // Background is solid or near-solid, blended with white/black to stay seam-free
  root.style.setProperty("--bg-h", String(h));
  root.style.setProperty("--bg-s", `${Math.max(30, r.s)}%`);
  root.style.setProperty("--bg-l", `${r.bgL}%`);

  // Extra tokens for subtle elevation, rings, and button fills
  root.style.setProperty("--elev-ink-mix", "18%"); // outlines
  root.style.setProperty("--ring-mix", "62%");
  root.style.setProperty("--focus-alpha", "0.22");

  // Body phase class (for future refinements if needed)
  const body = document.body;
  body.classList.forEach(c => { if (c.startsWith("phase-")) body.classList.remove(c); });
  body.classList.add(`phase-${phase}`);
}
