// /src/lib/ScoreStrip.js
//
// Full-width score strip shown across the game (not in lobby/keyroom/seeding/final).
// Scoring model (per your spec):
//   • Question-round scores are recorded on the room doc at `scores.questions`.
//   • Each Award phase simply shows the running total from those stored values.
//
// API:
//   import ScoreStrip from "../lib/ScoreStrip.js";
//   ScoreStrip.mount(container, { code });
//   ScoreStrip.update({ code }); // optional; will rebind if code changed
//   ScoreStrip.hide();
//
// Implementation notes:
//   • Listens only to the room doc; the totals are written atomically from Marking → Award.
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

function getQuestionScores(roomData) {
  const base = roomData?.scores?.questions || {};
  const hostScore = Number(base.host ?? 0) || 0;
  const guestScore = Number(base.guest ?? 0) || 0;
  return { hostScore, guestScore };
}

function render() {
  if (!state.node) return;
  const code  = state.code || "—";
  const round = state.roomData?.round ?? 1;

  const { hostScore, guestScore } = getQuestionScores(state.roomData || {});

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
}

function bind(code) {
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
  }
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
}

export default { mount, update, hide };