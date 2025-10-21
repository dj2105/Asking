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

function same(a,b){ return String(a||"").trim() === String(b||"").trim(); }

function resolveCorrect(answer = {}, fallbackItem = {}) {
  if (answer.correct) return answer.correct;
  if (fallbackItem.correct_answer) return fallbackItem.correct_answer;
  return "";
}

function countCorrectAnswers(answerList = [], items = []) {
  let total = 0;
  for (let i = 0; i < answerList.length; i += 1) {
    const answer = answerList[i] || {};
    const chosen = answer.chosen;
    if (!chosen) continue;
    const correct = resolveCorrect(answer, items[i] || {});
    if (correct && same(chosen, correct)) total += 1;
  }
  return total;
}

function computeScores(roomData, roundDocs) {
  let hostScore = 0; // Daniel
  let guestScore = 0; // Jaime

  const answers = roomData?.answers || {};

  for (let r = 1; r <= 5; r++) {
    const rd = roundDocs[r] || {};
    const hostItems  = rd.hostItems || [];
    const guestItems = rd.guestItems || [];

    const hostAnswers = ((answers.host || {})[r] || []);
    const guestAnswers = ((answers.guest || {})[r] || []);

    hostScore += countCorrectAnswers(hostAnswers, hostItems);
    guestScore += countCorrectAnswers(guestAnswers, guestItems);
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