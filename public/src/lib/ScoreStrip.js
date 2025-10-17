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
//   • Timer badge is optional and controlled by the active view via setTimer()/hideTimer().
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
  refs: {
    inner: null,
    leftCode: null,
    leftRound: null,
    hostScore: null,
    guestScore: null,
    timerWrap: null,
    timerValue: null,
  },
  timer: {
    visible: false,
    value: "",
  },
};

function same(a, b) {
  return String(a || "").trim() === String(b || "").trim();
}

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

  for (let r = 1; r <= 5; r += 1) {
    const rd = roundDocs[r] || {};
    const hostItems = rd.hostItems || [];
    const guestItems = rd.guestItems || [];

    const hostAnswers = ((answers.host || {})[r] || []);
    const guestAnswers = ((answers.guest || {})[r] || []);

    hostScore += countCorrectAnswers(hostAnswers, hostItems);
    guestScore += countCorrectAnswers(guestAnswers, guestItems);
  }

  return { hostScore, guestScore };
}

function ensureStructure() {
  if (!state.node) return;
  if (state.refs.inner) return;

  const inner = document.createElement("div");
  inner.className = "score-strip__inner";

  const left = document.createElement("div");
  left.className = "score-strip__left";

  const codeSpan = document.createElement("span");
  codeSpan.className = "ss-code";
  codeSpan.textContent = "—";

  const roundSpan = document.createElement("span");
  roundSpan.className = "ss-round";
  roundSpan.textContent = "Round 1";

  left.append(codeSpan, roundSpan);

  const timerWrap = document.createElement("div");
  timerWrap.className = "score-strip__timer";
  timerWrap.setAttribute("aria-hidden", "true");

  const timerBadge = document.createElement("div");
  timerBadge.className = "score-timer-badge mono";

  const timerValue = document.createElement("span");
  timerValue.className = "score-timer-value";
  timerBadge.appendChild(timerValue);

  timerWrap.appendChild(timerBadge);

  const right = document.createElement("div");
  right.className = "score-strip__right";

  const hostName = document.createElement("span");
  hostName.className = "ss-name";
  hostName.textContent = "Daniel";

  const hostScore = document.createElement("span");
  hostScore.className = "ss-score";
  hostScore.textContent = "0";

  const sep = document.createElement("span");
  sep.className = "ss-sep";

  const guestName = document.createElement("span");
  guestName.className = "ss-name";
  guestName.textContent = "Jaime";

  const guestScore = document.createElement("span");
  guestScore.className = "ss-score";
  guestScore.textContent = "0";

  right.append(hostName, hostScore, sep, guestName, guestScore);

  inner.append(left, timerWrap, right);

  state.node.innerHTML = "";
  state.node.appendChild(inner);

  state.refs.inner = inner;
  state.refs.leftCode = codeSpan;
  state.refs.leftRound = roundSpan;
  state.refs.hostScore = hostScore;
  state.refs.guestScore = guestScore;
  state.refs.timerWrap = timerWrap;
  state.refs.timerValue = timerValue;

  syncTimer();
}

function syncTimer() {
  const wrap = state.refs.timerWrap;
  const valueNode = state.refs.timerValue;
  if (!wrap || !valueNode) return;

  if (state.timer.visible) {
    wrap.classList.add("is-visible");
    wrap.setAttribute("aria-hidden", "false");
    valueNode.textContent = state.timer.value;
  } else {
    wrap.classList.remove("is-visible");
    wrap.setAttribute("aria-hidden", "true");
    valueNode.textContent = "";
  }
}

function render() {
  if (!state.node) return;
  ensureStructure();

  const code = state.code || "—";
  const round = state.roomData?.round ?? 1;

  const { hostScore, guestScore } = computeScores(state.roomData || {}, state.roundDocs);

  if (state.refs.leftCode) state.refs.leftCode.textContent = code;
  if (state.refs.leftRound) state.refs.leftRound.textContent = `Round ${round}`;
  if (state.refs.hostScore) state.refs.hostScore.textContent = String(hostScore);
  if (state.refs.guestScore) state.refs.guestScore.textContent = String(guestScore);

  syncTimer();
}

async function bind(code) {
  cleanup();

  state.code = code;
  if (!code) return;

  ensureStructure();

  state.unsubRoom = onSnapshot(roomRef(code), (snap) => {
    state.roomData = snap.data() || {};
    render();
  });

  for (let r = 1; r <= 5; r += 1) {
    const dref = doc(roundSubColRef(code), String(r));
    try {
      const snap = await getDoc(dref);
      if (snap.exists()) state.roundDocs[r] = snap.data() || {};
    } catch (err) {
      console.warn("[score-strip] failed to preload round", r, err);
    }
    const unsub = onSnapshot(dref, (s) => {
      if (s.exists()) {
        state.roundDocs[r] = s.data() || {};
        render();
      }
    });
    state.unsubRounds.push(unsub);
  }
}

function cleanup() {
  try { state.unsubRoom && state.unsubRoom(); } catch {}
  state.unsubRoom = null;
  for (const u of state.unsubRounds) {
    try { u(); } catch {}
  }
  state.unsubRounds = [];
  state.roundDocs = {};
  hideTimer();
  // keep node so we can reuse it between routes
}

export function mount(container, { code } = {}) {
  if (!container) return;
  if (!state.node) {
    const n = document.createElement("div");
    n.className = "score-strip mono";
    container.prepend(n);
    state.node = n;
  } else if (!state.node.isConnected) {
    container.prepend(state.node);
  }
  ensureStructure();
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

function formatTimerValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.max(0, Math.floor(value)));
  }
  return String(value);
}

export function setTimer(value) {
  state.timer.visible = true;
  state.timer.value = formatTimerValue(value);
  syncTimer();
}

export function hideTimer() {
  state.timer.visible = false;
  state.timer.value = "";
  syncTimer();
}

export default { mount, update, hide, setTimer, hideTimer };
