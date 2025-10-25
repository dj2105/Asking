// /src/views/Marking.js
//
// Marking phase — streamlined neutral layout tinted by the current game hue.

import { ensureAuth, db } from "../lib/firebase.js";
import {
  doc,
  collection,
  getDoc,
  onSnapshot,
  updateDoc,
  serverTimestamp,
  runTransaction,
} from "firebase/firestore";

import * as MathsPaneMod from "../lib/MathsPane.js";
import { resumeRoundTimer, pauseRoundTimer, getRoundTimerTotal, clearRoundTimer } from "../lib/RoundTimer.js";
import { clampCode, getHashParams, getStoredRole } from "../lib/util.js";
const mountMathsPane =
  (typeof MathsPaneMod?.default === "function" ? MathsPaneMod.default :
   typeof MathsPaneMod?.mount === "function" ? MathsPaneMod.mount :
   typeof MathsPaneMod?.default?.mount === "function" ? MathsPaneMod.default.mount :
   null);

const VERDICT = { RIGHT: "right", WRONG: "wrong", UNKNOWN: "unknown" };
const MARK_COUNT = 3;

function el(tag, attrs = {}, kids = []) {
  const node = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (k === "class") node.className = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  (Array.isArray(kids) ? kids : [kids]).forEach((child) =>
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child)
  );
  return node;
}

function same(a, b) {
  return String(a || "").trim() === String(b || "").trim();
}

function resolveCorrectAnswer(answer = {}, fallbackItem = {}) {
  if (answer.correct) return answer.correct;
  if (fallbackItem.correct_answer) return fallbackItem.correct_answer;
  return "";
}

function countCorrectAnswers(answers = [], items = []) {
  let total = 0;
  for (let i = 0; i < answers.length; i += 1) {
    const answer = answers[i] || {};
    const chosen = answer.chosen || "";
    if (!chosen) continue;
    const correct = resolveCorrectAnswer(answer, items[i] || {});
    if (correct && same(chosen, correct)) total += 1;
  }
  return total;
}

const roomRef = (code) => doc(db, "rooms", code);
const roundSubColRef = (code) => collection(roomRef(code), "rounds");

export default {
  async mount(container) {
    const me = await ensureAuth();

    const params = getHashParams();
    const code = clampCode(params.get("code") || "");
    let round = parseInt(params.get("round") || "1", 10) || 1;

    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    container.innerHTML = "";
    const root = el("div", { class: "view view-marking" });

    const shell = el("div", { class: "quiz-shell" });
    const heading = el("div", { class: "quiz-heading mono" }, "Marking");
    shell.appendChild(heading);

    const switcher = el("div", { class: "quiz-switcher" });
    const stepButtons = Array.from({ length: MARK_COUNT }).map((_, i) => {
      const btn = el("button", { class: "quiz-step", type: "button" }, String(i + 1));
      btn.disabled = true;
      switcher.appendChild(btn);
      return btn;
    });
    shell.appendChild(switcher);

    const prompt = el("div", { class: "quiz-prompt" });
    const questionNode = el("div", { class: "quiz-question mono" }, "Loading questions…");
    const answerLabel = el("div", { class: "quiz-answer-label mono" }, "");
    const answerText = el("div", { class: "quiz-answer mono" }, "");
    prompt.appendChild(questionNode);
    prompt.appendChild(answerLabel);
    prompt.appendChild(answerText);
    shell.appendChild(prompt);

    const verdictRow = el("div", { class: "quiz-answers quiz-answers--marking" });
    const btnRight = el("button", { class: "mark-option mark-option--right", type: "button" }, "✓");
    const btnUnknown = el("button", { class: "mark-option mark-option--unknown", type: "button" }, "I dunno");
    const btnWrong = el("button", { class: "mark-option mark-option--wrong", type: "button" }, "✕");
    verdictRow.appendChild(btnRight);
    verdictRow.appendChild(btnUnknown);
    verdictRow.appendChild(btnWrong);
    shell.appendChild(verdictRow);

    const submitBtn = el("button", { class: "quiz-submit", type: "button", disabled: true }, "Submit");
    shell.appendChild(submitBtn);

    root.appendChild(shell);

    const mathsMount = el("div", { class: "jemima-maths-pinned" });
    root.appendChild(mathsMount);

    container.appendChild(root);

    let idx = 0;
    let marks = new Array(MARK_COUNT).fill(null);
    let published = false;
    let submitting = false;
    let advanceTimer = null;
    let stopWatcher = null;
    let alive = true;

    const clearAdvanceTimer = () => {
      if (advanceTimer) {
        clearTimeout(advanceTimer);
        advanceTimer = null;
      }
    };

    const markValue = (value) => {
      if (value === VERDICT.RIGHT) return VERDICT.RIGHT;
      if (value === VERDICT.WRONG) return VERDICT.WRONG;
      return VERDICT.UNKNOWN;
    };

    const refreshStepStates = () => {
      stepButtons.forEach((btn, stepIndex) => {
        btn.classList.toggle("is-active", stepIndex === idx);
        btn.classList.toggle("is-answered", marks[stepIndex] !== null && marks[stepIndex] !== undefined);
      });
    };

    const refreshVerdictStyles = () => {
      const current = marks[idx];
      btnRight.classList.toggle("is-selected", current === VERDICT.RIGHT);
      btnWrong.classList.toggle("is-selected", current === VERDICT.WRONG);
      btnUnknown.classList.toggle("is-selected", current === VERDICT.UNKNOWN);
    };

    const refreshSubmitState = () => {
      const ready = marks.every((value) => value !== null && value !== undefined);
      const allowSubmit = ready && !published && !submitting;
      submitBtn.disabled = !allowSubmit;
      submitBtn.classList.toggle("is-ready", allowSubmit);
      submitBtn.classList.toggle("is-submitted", published);
      submitBtn.textContent = published ? "Submitted" : "Submit";
    };

    const refreshInteractivity = () => {
      const allowStep = !submitting;
      stepButtons.forEach((btn) => {
        btn.disabled = !allowStep;
      });
      const allowVerdict = !submitting && !published;
      [btnRight, btnWrong, btnUnknown].forEach((btn) => {
        btn.disabled = !allowVerdict;
      });
    };

    const applyWaitingPrompt = (text) => {
      questionNode.textContent = text;
      answerLabel.textContent = "";
      answerText.textContent = "";
    };

    stepButtons.forEach((btn, buttonIndex) => {
      btn.addEventListener("click", () => {
        clearAdvanceTimer();
        showMark(buttonIndex);
      });
    });

    const nextUnmarkedIndex = (fromIndex) => {
      for (let i = fromIndex + 1; i < marks.length; i += 1) {
        if (marks[i] === null || marks[i] === undefined) return i;
      }
      for (let i = 0; i < marks.length; i += 1) {
        if (marks[i] === null || marks[i] === undefined) return i;
      }
      return -1;
    };

    const timerContext = { code, role: "guest", round };

    const rRef = roomRef(code);

    const roomSnap = await getDoc(rRef);
    const roomData0 = roomSnap.data() || {};
    const { hostUid, guestUid } = roomData0.meta || {};
    const storedRole = getStoredRole(code);
    const myRole = storedRole === "host" || storedRole === "guest"
      ? storedRole
      : hostUid === me.uid ? "host" : guestUid === me.uid ? "guest" : "guest";
    timerContext.role = myRole;

    const oppRole = myRole === "host" ? "guest" : "host";
    const oppName = oppRole === "host" ? "Daniel" : "Jaime";
    answerLabel.textContent = `${oppName} answered`;

    try {
      if (mountMathsPane && roomData0.maths) {
        mountMathsPane(mathsMount, { maths: roomData0.maths, round, mode: "inline", roomCode: code, userUid: me.uid });
      }
    } catch (err) {
      console.warn("[marking] MathsPane mount failed:", err);
    }

    const rdRef = doc(roundSubColRef(code), String(round));
    const rdSnap = await getDoc(rdRef);
    const rd = rdSnap.data() || {};
    const oppItems = (oppRole === "host" ? rd.hostItems : rd.guestItems) || [];

    const answersNode = roomData0.answers || {};
    const oppAnswersRaw = ((answersNode[oppRole] || {})[round] || []);
    const oppAnswers = new Array(MARK_COUNT).fill("").map((_, i) => {
      const entry = oppAnswersRaw[i] || {};
      return entry.chosen || entry.answer || "";
    });

    const showMark = (targetIdx) => {
      if (targetIdx < 0) targetIdx = 0;
      if (targetIdx >= MARK_COUNT) targetIdx = MARK_COUNT - 1;
      idx = targetIdx;
      const currentItem = oppItems[idx] || {};
      const questionText = currentItem.question || "(missing question)";
      const chosenAnswer = oppAnswers[idx] || "(no answer recorded)";
      questionNode.textContent = questionText;
      answerLabel.textContent = `${oppName} answered`;
      answerText.textContent = chosenAnswer;
      refreshStepStates();
      refreshVerdictStyles();
      refreshSubmitState();
      refreshInteractivity();
      resumeRoundTimer(timerContext);
    };

    const handleVerdict = (value) => {
      if (published || submitting) return;
      clearAdvanceTimer();
      marks[idx] = markValue(value);
      refreshStepStates();
      refreshVerdictStyles();
      refreshSubmitState();
      const nextIdx = nextUnmarkedIndex(idx);
      if (nextIdx !== -1) {
        advanceTimer = setTimeout(() => {
          advanceTimer = null;
          if (!alive || submitting || published) return;
          showMark(nextIdx);
        }, 280);
      }
    };

    btnRight.addEventListener("click", () => handleVerdict(VERDICT.RIGHT));
    btnWrong.addEventListener("click", () => handleVerdict(VERDICT.WRONG));
    btnUnknown.addEventListener("click", () => handleVerdict(VERDICT.UNKNOWN));

    const submitMarks = async () => {
      if (published || submitting) return;
      submitting = true;
      refreshInteractivity();
      refreshSubmitState();
      pauseRoundTimer(timerContext);
      applyWaitingPrompt("Submitting review…");
      const safeMarks = marks.map((value) => markValue(value));
      const totalSecondsRaw = getRoundTimerTotal(timerContext) / 1000;
      const totalSeconds = Math.max(0, Math.round(totalSecondsRaw * 100) / 100);
      const patch = {
        [`marking.${myRole}.${round}`]: safeMarks,
        [`markingAck.${myRole}.${round}`]: true,
        [`timings.${myRole}.${round}`]: { totalSeconds },
        "timestamps.updatedAt": serverTimestamp(),
      };

      try {
        await updateDoc(rRef, patch);
        published = true;
        submitting = false;
        marks = safeMarks;
        refreshInteractivity();
        refreshSubmitState();
        applyWaitingPrompt(`Waiting for ${oppName}…`);
        clearRoundTimer(timerContext);
      } catch (err) {
        console.warn("[marking] submit failed:", err);
        submitting = false;
        refreshInteractivity();
        refreshSubmitState();
        showMark(idx);
      }
    };

    submitBtn.addEventListener("click", () => {
      if (submitBtn.disabled || submitting || published) return;
      submitMarks();
    });

    const existingMarks = (((roomData0.marking || {})[myRole] || {})[round] || []);
    if (Array.isArray(existingMarks) && existingMarks.length === MARK_COUNT) {
      marks = new Array(MARK_COUNT).fill(null).map((_, i) => markValue(existingMarks[i]));
      published = true;
      refreshStepStates();
      refreshVerdictStyles();
      refreshSubmitState();
      refreshInteractivity();
      applyWaitingPrompt(`Waiting for ${oppName}…`);
      pauseRoundTimer(timerContext);
      clearRoundTimer(timerContext);
    } else {
      showMark(0);
    }

    const finalizeRound = async () => {
      try {
        await runTransaction(db, async (tx) => {
          const roomSnapCur = await tx.get(rRef);
          if (!roomSnapCur.exists()) return;
          const roomData = roomSnapCur.data() || {};
          if ((roomData.state || "").toLowerCase() !== "marking") return;

          const ackHost = Boolean(((roomData.markingAck || {}).host || {})[round]);
          const ackGuest = Boolean(((roomData.markingAck || {}).guest || {})[round]);
          if (!(ackHost && ackGuest)) return;

          const roundSnapCur = await tx.get(rdRef);
          const roundData = roundSnapCur.exists() ? (roundSnapCur.data() || {}) : {};
          const answersHost = (((roomData.answers || {}).host || {})[round] || []);
          const answersGuest = (((roomData.answers || {}).guest || {})[round] || []);
          const hostItems = roundData.hostItems || [];
          const guestItems = roundData.guestItems || [];

          const roundHostScore = countCorrectAnswers(answersHost, hostItems);
          const roundGuestScore = countCorrectAnswers(answersGuest, guestItems);
          const currentRound = Number(roomData.round) || round;

          tx.update(rRef, {
            state: "award",
            round: currentRound,
            [`scores.host.${currentRound}`]: roundHostScore,
            [`scores.guest.${currentRound}`]: roundGuestScore,
            "timestamps.updatedAt": serverTimestamp(),
          });
        });
      } catch (err) {
        console.warn("[marking] finalize failed:", err);
      }
    };

    stopWatcher = onSnapshot(rRef, (snap) => {
      const data = snap.data() || {};
      const stateName = (data.state || "").toLowerCase();

      if (Number.isFinite(Number(data.round))) {
        const nextRound = Number(data.round);
        if (nextRound !== round) {
          round = nextRound;
          timerContext.round = round;
        }
      }

      if (stateName === "countdown") {
        setTimeout(() => {
          location.hash = `#/countdown?code=${code}&round=${data.round || round}`;
        }, 80);
        return;
      }

      if (stateName === "questions") {
        setTimeout(() => {
          location.hash = `#/questions?code=${code}&round=${data.round || round}`;
        }, 80);
        return;
      }

      if (stateName === "award") {
        setTimeout(() => {
          location.hash = `#/award?code=${code}&round=${data.round || round}`;
        }, 80);
        return;
      }

      if (stateName === "maths") {
        setTimeout(() => { location.hash = `#/maths?code=${code}`; }, 80);
        return;
      }

      const markingAck = data.markingAck || {};
      const ackMine = Boolean(((markingAck[myRole] || {})[round]));
      const ackOpp = Boolean(((markingAck[oppRole] || {})[round]));

      if (ackMine && !published) {
        const incomingMarks = (((data.marking || {})[myRole] || {})[round] || marks);
        marks = new Array(MARK_COUNT).fill(null).map((_, i) => markValue(incomingMarks[i]));
        published = true;
        submitting = false;
        refreshStepStates();
        refreshVerdictStyles();
        refreshSubmitState();
        refreshInteractivity();
        applyWaitingPrompt(ackOpp ? `Waiting for ${oppName}…` : "Review submitted");
        pauseRoundTimer(timerContext);
        clearRoundTimer(timerContext);
      }

      if (myRole === "host" && stateName === "marking" && ackMine && ackOpp) {
        finalizeRound();
      }
    }, (err) => {
      console.warn("[marking] room snapshot error:", err);
    });

    this.unmount = () => {
      clearAdvanceTimer();
      try { stopWatcher && stopWatcher(); } catch {}
      pauseRoundTimer(timerContext);
    };
  },

  async unmount() { /* instance handles cleanup */ }
};
