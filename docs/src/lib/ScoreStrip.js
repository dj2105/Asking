// /src/lib/ScoreStrip.js
//
// Full-width score strip shown across the game (not in lobby/keyroom/seeding/final).
// Scoring model (per latest spec):
//   • Players earn +1 for each question they answered correctly in their own question round.
//   • Marking verdicts do not influence the score strip.
// Running totals are the cumulative question points across completed rounds.
//
// API:
//   import ScoreStrip from "../lib/ScoreStrip.js";
//   ScoreStrip.mount(container, { code });
//   ScoreStrip.update({ code }); // optional; will rebind if code changed
//   ScoreStrip.hide();
//
// Implementation notes:
//   • Listens to the room doc and round docs (1..5) to compute scores.
//   • Assumes host == “Daniel”, guest == “Jaime” (labels only; IDs come from room.meta).
//   • Safe if some fields are missing during seeding/early rounds.
//
// Visuals are defined mainly in styles.css (.score-strip); this module only renders DOM.

import { db } from "./firebase.js";
import { doc, onSnapshot } from "firebase/firestore";

const roomRef = (code) => doc(db, "rooms", code);
const state = {
  node: null,
  unsubRoom: null,
  code: null,
  roomData: null,
  resizeHandler: null,
  clearanceFrame: 0,
};

function parseGap(value) {
  if (!value) return NaN;
  const trimmed = String(value).trim();
  if (!trimmed) return NaN;
  const parsed = parseFloat(trimmed);
  if (Number.isNaN(parsed)) return NaN;
  return parsed;
}

function updateClearance() {
  const body = document.body;
  if (!body) return;
  if (!state.node || !state.node.isConnected) {
    body.style.removeProperty("--score-strip-clearance");
    return;
  }

  let gap = 32;
  try {
    const root = document.documentElement;
    if (root) {
      const computed = getComputedStyle(root).getPropertyValue("--score-strip-gap");
      const parsedGap = parseGap(computed);
      if (Number.isFinite(parsedGap)) gap = parsedGap;
    }
  } catch {}

  const height = state.node.offsetHeight || 0;
  const clearance = Math.max(0, height + gap * 2);
  body.style.setProperty("--score-strip-clearance", `${clearance}px`);
}

function scheduleClearanceUpdate() {
  if (state.clearanceFrame) cancelAnimationFrame(state.clearanceFrame);
  state.clearanceFrame = requestAnimationFrame(() => {
    state.clearanceFrame = 0;
    updateClearance();
  });
}

function ensureResizeListener() {
  if (state.resizeHandler) return;
  state.resizeHandler = () => scheduleClearanceUpdate();
  window.addEventListener("resize", state.resizeHandler);
}

function computeScores(roomData = {}) {
  const scores = roomData.scores || {};
  const bonuses = roomData.speedBonuses || {};
  const hostRounds = scores.host || {};
  const guestRounds = scores.guest || {};
  const hostBonuses = bonuses.host || {};
  const guestBonuses = bonuses.guest || {};
  let hostScore = 0;
  let guestScore = 0;
  for (let r = 1; r <= 5; r += 1) {
    hostScore += Number(hostRounds[r] || 0) + Number(hostBonuses[r] || 0);
    guestScore += Number(guestRounds[r] || 0) + Number(guestBonuses[r] || 0);
  }
  return { hostScore, guestScore };
}

function render() {
  if (!state.node) return;
  const code  = state.code || "—";
  const round = state.roomData?.round ?? 1;

  const tickerText = (
    state.roomData?.tickerText ||
    state.roomData?.ticker ||
    ""
  ).trim();

  const { hostScore, guestScore } = computeScores(state.roomData || {});

  state.node.innerHTML = `
    <div class="score-strip__bar">
      <div class="score-strip__cell score-strip__cell--code">
        <div class="score-strip__label">CODE</div>
        <div class="score-strip__value score-strip__value--code">${code}</div>
      </div>
      <div class="score-strip__cell score-strip__cell--round">
        <div class="score-strip__label">ROUND</div>
        <div class="score-strip__value score-strip__value--round">${round}</div>
      </div>
      <div class="score-strip__cell score-strip__cell--scores">
        <div class="score-strip__player">
          <span class="score-strip__player-name">Daniel</span>
          <span class="score-strip__player-score">${hostScore}</span>
        </div>
        <div class="score-strip__player">
          <span class="score-strip__player-name">Jaime</span>
          <span class="score-strip__player-score">${guestScore}</span>
        </div>
      </div>
    </div>
    <div class="ticker ${tickerText ? "" : "is-hidden"}" aria-live="polite">
      <span class="ticker-marquee">${tickerText}</span>
    </div>
  `;
  scheduleClearanceUpdate();
}

async function bind(code) {
  cleanup();

  state.code = code;
  if (!code) return;

  // Room listener
  state.unsubRoom = onSnapshot(roomRef(code), (snap) => {
    state.roomData = snap.data() || {};
    render();
  });
}

function cleanup() {
  try { state.unsubRoom && state.unsubRoom(); } catch {}
  state.unsubRoom = null;
  // keep node so we can reuse it between routes
}

export function mount(container, { code } = {}) {
  if (!container) return;
  if (!state.node) {
    const n = document.createElement("div");
    n.className = "score-strip";
    container.prepend(n); // top of the view
    state.node = n;
  } else if (!state.node.isConnected) {
    container.prepend(state.node);
  } else if (state.node.parentNode === container && container.firstChild !== state.node) {
    container.insertBefore(state.node, container.firstChild);
  } else if (state.node.parentNode !== container) {
    container.prepend(state.node);
  }
  document.body.classList.add("has-score-strip");
  ensureResizeListener();
  scheduleClearanceUpdate();
  bind(code);
}

export function update({ code } = {}) {
  if (code && code !== state.code) bind(code);
  else render();
}

export function hide() {
  cleanup();
  if (state.node && state.node.parentNode) {
    state.node.parentNode.removeChild(state.node);
  }
  document.body.classList.remove("has-score-strip");
  if (state.resizeHandler) {
    window.removeEventListener("resize", state.resizeHandler);
    state.resizeHandler = null;
  }
  if (state.clearanceFrame) {
    cancelAnimationFrame(state.clearanceFrame);
    state.clearanceFrame = 0;
  }
  if (document.body) {
    document.body.style.removeProperty("--score-strip-clearance");
  }
}

export default { mount, update, hide };