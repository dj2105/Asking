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
// Timer helpers (for questions/marking views only):
//   import { startTimer, stopTimer, hideTimer, setTimerValue } from "../lib/ScoreStrip.js";
//
// Implementation notes:
//   • Listens to the room doc and round docs (1..5) to compute scores.
//   • Assumes host == “Daniel”, guest == “Jaime” (labels only; IDs come from room.meta).
//   • Safe if some fields are missing during seeding/early rounds.
//   • Timer state is kept here so views can request a central countdown badge.

import { db } from "./firebase.js";
import { doc, collection, getDoc, onSnapshot } from "firebase/firestore";

const roomRef = (code) => doc(db, "rooms", code);
const roundSubColRef = (code) => collection(roomRef(code), "rounds");

const state = {
  node: null,
  inner: null,
  leftNode: null,
  rightNode: null,
  timerWrap: null,
  timerBadge: null,
  unsubRoom: null,
  unsubRounds: [],
  code: null,
  roundDocs: {}, // { [round]: data }
  roomData: null,
};

const timerState = {
  visible: false,
  remaining: 0,
  deadline: 0,
  interval: null,
  onExpire: null,
  expireNotified: false,
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

function clearTimerInterval() {
  if (timerState.interval) {
    clearInterval(timerState.interval);
    timerState.interval = null;
  }
}

function applyTimerVisibility() {
  if (!state.timerWrap) return;
  if (timerState.visible) {
    state.timerWrap.classList.add("is-visible");
    state.timerWrap.setAttribute("aria-hidden", "false");
  } else {
    state.timerWrap.classList.remove("is-visible");
    state.timerWrap.setAttribute("aria-hidden", "true");
  }
}

function updateTimerText(seconds) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  timerState.remaining = safe;
  if (state.timerBadge) {
    state.timerBadge.textContent = String(safe);
  }
}

function handleTimerTick() {
  if (!timerState.deadline) return;
  const remainingMs = timerState.deadline - Date.now();
  const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  updateTimerText(remainingSeconds);

  if (remainingMs <= 0) {
    clearTimerInterval();
    if (!timerState.expireNotified) {
      timerState.expireNotified = true;
      const cb = timerState.onExpire;
      timerState.onExpire = null;
      if (typeof cb === "function") {
        try { cb(); } catch (err) {
          console.warn("[score-strip] timer callback failed", err);
        }
      }
    }
  }
}

function ensureStructure() {
  if (!state.node || state.inner) return;

  state.node.innerHTML = "";
  const inner = document.createElement("div");
  inner.className = "score-strip__inner";

  const left = document.createElement("div");
  left.className = "score-strip__left";

  const timerWrap = document.createElement("div");
  timerWrap.className = "score-strip__timer";
  timerWrap.setAttribute("aria-hidden", "true");

  const timerBadge = document.createElement("div");
  timerBadge.className = "score-strip__timer-badge mono";
  timerBadge.textContent = "0";
  timerWrap.appendChild(timerBadge);

  const right = document.createElement("div");
  right.className = "score-strip__right";

  inner.appendChild(left);
  inner.appendChild(timerWrap);
  inner.appendChild(right);

  state.node.appendChild(inner);

  state.inner = inner;
  state.leftNode = left;
  state.rightNode = right;
  state.timerWrap = timerWrap;
  state.timerBadge = timerBadge;

  applyTimerVisibility();
  updateTimerText(timerState.remaining);
}

function render() {
  if (!state.node) return;
  ensureStructure();

  const code = state.code || "—";
  const round = state.roomData?.round ?? 1;

  const { hostScore, guestScore } = computeScores(state.roomData || {}, state.roundDocs);

  const leftHTML = `<span class="ss-code">${code}</span><span class="ss-round">Round ${round}</span>`;
  const rightHTML = `<span class="ss-name">Daniel</span><span class="ss-score">${hostScore}</span>` +
    `<span class="ss-sep"></span>` +
    `<span class="ss-name">Jaime</span><span class="ss-score">${guestScore}</span>`;

  if (state.leftNode) state.leftNode.innerHTML = leftHTML;
  if (state.rightNode) state.rightNode.innerHTML = rightHTML;
}

async function bind(code) {
  cleanup();

  state.code = code;
  if (!code) return;

  state.unsubRoom = onSnapshot(roomRef(code), (snap) => {
    state.roomData = snap.data() || {};
    render();
  });

  for (let r = 1; r <= 5; r += 1) {
    const dref = doc(roundSubColRef(code), String(r));
    try {
      const s = await getDoc(dref);
      if (s.exists()) state.roundDocs[r] = s.data() || {};
    } catch {}
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
  stopTimer({ keepVisible: false, reset: true });
}

export function mount(container, { code } = {}) {
  if (!container) return;
  if (!state.node) {
    const n = document.createElement("div");
    n.className = "score-strip mono";
    container.prepend(n);
    state.node = n;
    ensureStructure();
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

export function startTimer({ seconds, onExpire } = {}) {
  const secs = Math.max(0, Math.ceil(Number(seconds) || 0));
  timerState.deadline = Date.now() + secs * 1000;
  timerState.onExpire = typeof onExpire === "function" ? onExpire : null;
  timerState.expireNotified = false;
  timerState.visible = true;
  applyTimerVisibility();
  updateTimerText(secs);
  clearTimerInterval();
  if (secs <= 0) {
    handleTimerTick();
    return;
  }
  timerState.interval = setInterval(handleTimerTick, 200);
  handleTimerTick();
}

export function stopTimer({ keepVisible = false, reset = false } = {}) {
  clearTimerInterval();
  timerState.deadline = 0;
  timerState.onExpire = null;
  timerState.expireNotified = false;
  if (reset) updateTimerText(0);
  if (!keepVisible) {
    timerState.visible = false;
    applyTimerVisibility();
  }
}

export function showTimer() {
  timerState.visible = true;
  applyTimerVisibility();
}

export function hideTimer() {
  stopTimer({ keepVisible: false, reset: true });
}

export function setTimerValue(seconds, { visible } = {}) {
  const secs = Math.max(0, Math.ceil(Number(seconds) || 0));
  updateTimerText(secs);
  if (visible === true) {
    timerState.visible = true;
    applyTimerVisibility();
  } else if (visible === false) {
    timerState.visible = false;
    applyTimerVisibility();
  }
}

export default {
  mount,
  update,
  hide,
  startTimer,
  stopTimer,
  showTimer,
  hideTimer,
  setTimerValue,
};
