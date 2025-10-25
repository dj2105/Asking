// /src/views/Marking.js
//
// Marking phase — judge opponent answers while a hidden timer keeps running.
// • Shows opponent questions + chosen answers with ✓/✕/I dunno toggles.
// • No visible countdown; the round timer resumes when marking begins and stops on submission.
// • Submission writes marking.{role}.{round}, timings.{role}.{round}, markingAck.{role}.{round} = true.
// • Host advances to Award once both acknowledgements are present.

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

import { resumeRoundTimer, pauseRoundTimer, getRoundTimerTotal, clearRoundTimer } from "../lib/RoundTimer.js";
import { clampCode, getHashParams, getStoredRole } from "../lib/util.js";

const VERDICT = { RIGHT: "right", WRONG: "wrong", UNKNOWN: "unknown" };

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
    const root = el("div", { class: "view view-marking stage-center qa-shell" });

    const heading = el("div", { class: "qa-heading mono" }, "Marking");
    const switcher = el("div", { class: "qa-switcher" });
    const chips = [0, 1, 2].map((i) => {
      const chip = el(
        "button",
        {
          class: "qa-chip",
          type: "button",
          "aria-label": `Mark question ${i + 1}`,
        },
        String(i + 1)
      );
      switcher.appendChild(chip);
      return chip;
    });

    const questionBlock = el("div", { class: "qa-question" });
    const questionText = el("div", { class: "qa-question__text" }, "Preparing marks…");
    const answerPreview = el("div", { class: "qa-question__answer" }, "");
    questionBlock.appendChild(questionText);
    questionBlock.appendChild(answerPreview);

    const judgeRow = el("div", { class: "qa-answers qa-answers--judge" });
    const btnRight = el(
      "button",
      {
        class: "qa-judge qa-judge--tick",
        type: "button",
        "aria-pressed": "false",
      },
      "✓"
    );
    const btnUnknown = el(
      "button",
      {
        class: "qa-judge qa-judge--unknown",
        type: "button",
        "aria-pressed": "false",
      },
      "I dunno"
    );
    const btnWrong = el(
      "button",
      {
        class: "qa-judge qa-judge--cross",
        type: "button",
        "aria-pressed": "false",
      },
      "✕"
    );
    judgeRow.appendChild(btnRight);
    judgeRow.appendChild(btnUnknown);
    judgeRow.appendChild(btnWrong);

    btnRight.disabled = true;
    btnUnknown.disabled = true;
    btnWrong.disabled = true;
    judgeRow.classList.add("qa-answers--hidden");

    const submitBtn = el(
      "button",
      { class: "qa-submit", type: "button", disabled: "disabled" },
      "Submit"
    );
    const defaultSubmitLabel = "Submit";
    let customSubmitLabel = null;
    const setSubmitLabel = (text) => {
      customSubmitLabel = typeof text === "string" && text.trim() ? text : null;
      submitBtn.textContent = customSubmitLabel || defaultSubmitLabel;
    };
    setSubmitLabel();

    root.appendChild(heading);
    root.appendChild(switcher);
    root.appendChild(questionBlock);
    root.appendChild(judgeRow);
    root.appendChild(submitBtn);

    container.appendChild(root);

    const rRef = roomRef(code);
    const rdRef = doc(roundSubColRef(code), String(round));

    const roomSnap = await getDoc(rRef);
    const roomData0 = roomSnap.data() || {};
    const { hostUid, guestUid } = roomData0.meta || {};
    const storedRole = getStoredRole(code);
    const myRole = storedRole === "host" || storedRole === "guest"
      ? storedRole
      : hostUid === me.uid ? "host" : guestUid === me.uid ? "guest" : "guest";
    const oppRole = myRole === "host" ? "guest" : "host";
    const oppName = oppRole === "host" ? "Daniel" : "Jaime";

    const timerContext = { code, role: myRole, round };

    const rdSnap = await getDoc(rdRef);
    const rd = rdSnap.data() || {};
    const oppItems = (oppRole === "host" ? rd.hostItems : rd.guestItems) || [];
    const oppAnswers = (((roomData0.answers || {})[oppRole] || {})[round] || []).map((a) => a?.chosen || "");
    const totalMarks = Math.max(3, oppItems.length || 0);

    let idx = 0;
    let marks = new Array(totalMarks).fill(null);
    let published = false;
    let submitting = false;
    let advanceTimer = null;

    const setQuestionText = (text) => {
      questionText.textContent = text || "";
    };

    const setAnswerText = (text) => {
      answerPreview.textContent = text || "";
    };

    const markValue = (value) => {
      if (value === VERDICT.RIGHT) return VERDICT.RIGHT;
      if (value === VERDICT.WRONG) return VERDICT.WRONG;
      return VERDICT.UNKNOWN;
    };

    const isMarked = (value) =>
      value === VERDICT.RIGHT || value === VERDICT.WRONG || value === VERDICT.UNKNOWN;

    const clearAdvanceTimer = () => {
      if (advanceTimer) {
        clearTimeout(advanceTimer);
        advanceTimer = null;
      }
    };

    const setVerdictsEnabled = (enabled) => {
      [btnRight, btnUnknown, btnWrong].forEach((btn) => {
        btn.disabled = !enabled;
        btn.classList.toggle("qa-judge--disabled", !enabled);
      });
    };

    const updateVerdictStyles = () => {
      const mark = marks[idx];
      const isRight = mark === VERDICT.RIGHT;
      const isWrong = mark === VERDICT.WRONG;
      const isUnknown = mark === VERDICT.UNKNOWN;
      btnRight.classList.toggle("qa-judge--selected", isRight);
      btnWrong.classList.toggle("qa-judge--selected", isWrong);
      btnUnknown.classList.toggle("qa-judge--selected", isUnknown);
      btnRight.setAttribute("aria-pressed", isRight ? "true" : "false");
      btnWrong.setAttribute("aria-pressed", isWrong ? "true" : "false");
      btnUnknown.setAttribute("aria-pressed", isUnknown ? "true" : "false");
    };

    const updateChipStates = () => {
      chips.forEach((chip, chipIdx) => {
        const answered = isMarked(marks[chipIdx]);
        chip.classList.toggle("qa-chip--active", chipIdx === idx);
        chip.classList.toggle("qa-chip--answered", answered);
        chip.disabled = submitting;
      });
    };

    const updateSubmitState = () => {
      const complete = marks.every((value) => isMarked(value));
      submitBtn.disabled = !complete || submitting || published;
      submitBtn.classList.toggle(
        "qa-submit--ready",
        complete && !submitting && !published
      );
      if (!published && !submitting && customSubmitLabel !== null) {
        setSubmitLabel(null);
      }
    };

    const findNextPending = (fromIndex) => {
      for (let i = fromIndex + 1; i < totalMarks; i += 1) {
        if (!isMarked(marks[i])) return i;
      }
      for (let i = 0; i < totalMarks; i += 1) {
        if (!isMarked(marks[i])) return i;
      }
      return fromIndex;
    };

    const showMark = (targetIdx) => {
      clearAdvanceTimer();
      if (totalMarks <= 0) return;
      if (targetIdx < 0) targetIdx = 0;
      if (targetIdx >= totalMarks) targetIdx = totalMarks - 1;
      idx = targetIdx;
      const currentItem = oppItems[idx] || {};
      const rawQuestion = currentItem.question || "";
      const chosenAnswer = oppAnswers[idx] || "";
      const displayQuestion = rawQuestion
        ? `${idx + 1}. ${rawQuestion}`
        : `${idx + 1}. (missing question)`;
      const answerLine = chosenAnswer
        ? `${oppName} answered: ${chosenAnswer}`
        : `${oppName} left this blank`;
      setQuestionText(displayQuestion);
      setAnswerText(answerLine);
      judgeRow.classList.remove("qa-answers--hidden");
      if (!(published || submitting)) {
        setVerdictsEnabled(true);
        setSubmitLabel(null);
      } else {
        setVerdictsEnabled(false);
      }
      updateVerdictStyles();
      updateChipStates();
      updateSubmitState();
      if (!(published || submitting)) {
        resumeRoundTimer(timerContext);
      }
    };

    const showWaitingState = (text) => {
      const label = text || `Waiting for ${oppName}…`;
      if (totalMarks > 0) {
        const safeIdx = Math.min(Math.max(idx, 0), totalMarks - 1);
        showMark(safeIdx);
      }
      setVerdictsEnabled(false);
      updateVerdictStyles();
      updateChipStates();
      submitBtn.disabled = true;
      submitBtn.classList.remove("qa-submit--ready");
      setSubmitLabel(label);
      pauseRoundTimer(timerContext);
    };

    const submitMarks = async () => {
      if (published || submitting) return;
      submitting = true;
      clearAdvanceTimer();
      const safeMarks = marks.map((value) => markValue(value));
      setVerdictsEnabled(false);
      updateVerdictStyles();
      updateChipStates();
      setSubmitLabel("Submitting…");
      updateSubmitState();
      const totalSecondsRaw = getRoundTimerTotal(timerContext) / 1000;
      const totalSeconds = Math.max(0, Math.round(totalSecondsRaw * 100) / 100);
      pauseRoundTimer(timerContext);
      const patch = {
        [`marking.${myRole}.${round}`]: safeMarks,
        [`markingAck.${myRole}.${round}`]: true,
        [`timings.${myRole}.${round}`]: { totalSeconds },
        "timestamps.updatedAt": serverTimestamp(),
      };

      try {
        await updateDoc(rRef, patch);
        marks = safeMarks;
        published = true;
        submitting = false;
        showWaitingState(`Waiting for ${oppName}…`);
        clearRoundTimer(timerContext);
      } catch (err) {
        console.warn("[marking] submit failed:", err);
        submitting = false;
        setSubmitLabel(null);
        showMark(idx);
        setVerdictsEnabled(true);
        updateSubmitState();
        resumeRoundTimer(timerContext);
      }
    };

    const handleVerdict = (value) => {
      if (published || submitting) return;
      clearAdvanceTimer();
      marks[idx] = markValue(value);
      updateVerdictStyles();
      updateChipStates();
      updateSubmitState();
      const targetIdx = findNextPending(idx);
      advanceTimer = setTimeout(() => {
        advanceTimer = null;
        if (published || submitting) return;
        if (targetIdx !== idx) {
          showMark(targetIdx);
        } else {
          updateVerdictStyles();
        }
      }, 240);
    };

    btnRight.addEventListener("click", () => handleVerdict(VERDICT.RIGHT));
    btnUnknown.addEventListener("click", () => handleVerdict(VERDICT.UNKNOWN));
    btnWrong.addEventListener("click", () => handleVerdict(VERDICT.WRONG));

    chips.forEach((chip, chipIdx) => {
      chip.addEventListener("click", () => {
        if (submitting) return;
        showMark(chipIdx);
      });
    });

    submitBtn.addEventListener("click", () => submitMarks());

    const existingMarks = (((roomData0.marking || {})[myRole] || {})[round] || []);
    if (Array.isArray(existingMarks) && existingMarks.length === 3) {
      marks = new Array(totalMarks).fill(null).map((_, i) => markValue(existingMarks[i]));
      published = true;
      updateVerdictStyles();
      updateChipStates();
      updateSubmitState();
      showWaitingState("Review submitted");
      clearRoundTimer(timerContext);
    } else {
      showMark(0);
    }

    let stopRoomWatch = null;
    let finalizing = false;

    const finalizeRound = async () => {
      if (finalizing) return;
      finalizing = true;
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
      } finally {
        finalizing = false;
      }
    };

    stopRoomWatch = onSnapshot(rRef, (snap) => {
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
        marks = new Array(totalMarks).fill(null).map((_, i) => markValue(incomingMarks[i]));
        published = true;
        submitting = false;
        updateVerdictStyles();
        updateChipStates();
        updateSubmitState();
        showWaitingState(ackOpp ? "Waiting for opponent" : "Review submitted");
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
      try { stopRoomWatch && stopRoomWatch(); } catch {}
      pauseRoundTimer(timerContext);
    };
  },

  async unmount() { /* instance handles cleanup */ }
};
