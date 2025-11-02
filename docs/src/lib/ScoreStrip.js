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
};

let resizeBound = false;

function updateStripHeight() {
  const body = document.body;
  if (!body) return;
  const height = state.node && state.node.isConnected
    ? Math.round(state.node.getBoundingClientRect().height || 0)
    : 0;
  body.style.setProperty("--score-strip-height", `${height}px`);
}

function bindResizeListener() {
  if (resizeBound) return;
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  window.addEventListener("resize", updateStripHeight);
  resizeBound = true;
}

function unbindResizeListener() {
  if (!resizeBound) return;
  if (typeof window === "undefined" || typeof window.removeEventListener !== "function") return;
  window.removeEventListener("resize", updateStripHeight);
  resizeBound = false;
}

function computeScores(roomData = {}) {
  const scores = roomData.scores || {};
  const hostRounds = scores.host || {};
  const guestRounds = scores.guest || {};
  let hostScore = 0;
  let guestScore = 0;
  for (let r = 1; r <= 5; r += 1) {
    hostScore += Number(hostRounds[r] || 0);
    guestScore += Number(guestRounds[r] || 0);
  }
  return { hostScore, guestScore };
}

function render() {
  if (!state.node) return;
  const code  = state.code || "—";
  const round = state.roomData?.round ?? 1;

  const { hostScore, guestScore } = computeScores(state.roomData || {});

  // Labels fixed by design spec
  const leftHTML  = `<span class="ss-code">${code}</span><span class="ss-round">Round ${round}</span>`;
  const rightHTML = `<span class="ss-name">Daniel</span><span class="ss-score">${hostScore}</span>
                     <span class="ss-sep"></span>
                     <span class="ss-name">Jaime</span><span class="ss-score">${guestScore}</span>`;

  state.node.innerHTML = `
    <div class="score-strip__inner">
      <div class="score-strip__left">${leftHTML}</div>
      <div class="score-strip__right">${rightHTML}</div>
    </div>
  `;
  updateStripHeight();
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
    n.className = "score-strip mono";
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
  bind(code);
  updateStripHeight();
  bindResizeListener();
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
  updateStripHeight();
  unbindResizeListener();
}

export default { mount, update, hide };
