// /src/lib/ScoreStrip.js
//
// Full-width score strip shown across the game (not in lobby/keyroom/seeding/final).
// Scoring model (per your spec):
//   • Players MUST answer all 3 questions in Questions (handled elsewhere).
//   • In Marking, the marker earns: +1 if their verdict matches truth of opponent's answer,
//     -1 if it contradicts truth, 0 if left unmarked when timer expires.
// Running totals are the sum of those marking points across completed/ongoing rounds.
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
import { doc, collection, getDoc, onSnapshot } from "firebase/firestore";

const roomRef = (code) => doc(db, "rooms", code);
const roundSubColRef = (code) => collection(roomRef(code), "rounds");

const state = {
  node: null,
  unsubRoom: null,
  unsubRounds: [],
  code: null,
  roundDocs: {}, // { [round]: data }
  roomData: null,
};

function text(s){ return (s ?? "").toString(); }
function same(a,b){ return String(a||"").trim() === String(b||"").trim(); }

function computeScores(roomData, roundDocs) {
  let hostScore = 0; // Daniel
  let guestScore = 0; // Jaime

  const answers = roomData?.answers || {};
  const marking = roomData?.marking || {};

  for (let r = 1; r <= 5; r++) {
    const rd = roundDocs[r];
    if (!rd) continue;

    const hostItems  = rd.hostItems || [];
    const guestItems = rd.guestItems || [];

    const hostAns = ((answers.host || {})[r] || []).map(a => a?.chosen || "");
    const guestAns = ((answers.guest || {})[r] || []).map(a => a?.chosen || "");

    const hostMarks  = ((marking.host  || {})[r] || []); // host marked guest’s answers
    const guestMarks = ((marking.guest || {})[r] || []); // guest marked host’s answers

    // Host marks guest answers:
    for (let i = 0; i < 3; i++) {
      const chosen = guestAns[i];
      const correct = guestItems[i]?.correct_answer;
      const truth = chosen && correct ? same(chosen, correct) : false;
      const verdict = hostMarks[i]; // "right" | "wrong" | "unknown" | undefined
      if (verdict === "right") hostScore += truth ? 1 : -1;
      else if (verdict === "wrong") hostScore += truth ? -1 : 1;
      else hostScore += 0; // unmarked/unknown
    }

    // Guest marks host answers:
    for (let i = 0; i < 3; i++) {
      const chosen = hostAns[i];
      const correct = hostItems[i]?.correct_answer;
      const truth = chosen && correct ? same(chosen, correct) : false;
      const verdict = guestMarks[i];
      if (verdict === "right") guestScore += truth ? 1 : -1;
      else if (verdict === "wrong") guestScore += truth ? -1 : 1;
      else guestScore += 0;
    }
  }

  return { hostScore, guestScore };
}

function render() {
  if (!state.node) return;
  const code  = state.code || "—";
  const round = state.roomData?.round ?? 1;

  const { hostScore, guestScore } = computeScores(state.roomData || {}, state.roundDocs);

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

async function bind(code) {
  cleanup();

  state.code = code;
  if (!code) return;

  // Room listener
  state.unsubRoom = onSnapshot(roomRef(code), (snap) => {
    state.roomData = snap.data() || {};
    render();
  });

  // Preload & listen to rounds 1..5
  for (let r = 1; r <= 5; r++) {
    const dref = doc(roundSubColRef(code), String(r));
    // initial fetch (best-effort)
    try {
      const s = await getDoc(dref);
      if (s.exists()) state.roundDocs[r] = s.data() || {};
    } catch {}
    // live updates
    const u = onSnapshot(dref, (s) => {
      if (s.exists()) {
        state.roundDocs[r] = s.data() || {};
        render();
      }
    });
    state.unsubRounds.push(u);
  }
}

function cleanup() {
  try { state.unsubRoom && state.unsubRoom(); } catch {}
  state.unsubRoom = null;
  for (const u of state.unsubRounds) { try { u(); } catch {} }
  state.unsubRounds = [];
  state.roundDocs = {};
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