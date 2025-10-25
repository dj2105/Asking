// /src/views/Marking.js
//
// Marking phase — judge opponent answers while a hidden timer keeps running.
// • Shows opponent questions + chosen answers with ✓/✕/I DUNNO toggles.
// • Each verdict auto-focuses the next unanswered slot.
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
    const root = el("div", { class: "view view-marking stage-center marking-neutral" });

    const heading = el("div", { class: "mono qm-heading" }, "Marking");
    const switcher = el("div", { class: "qm-switcher" });
    const chips = [];
    for (let i = 0; i < 3; i += 1) {
      const chip = el(
        "button",
        {
          class: "mono qm-chip",
          type: "button",
          "data-index": String(i),
        },
        String(i + 1)
      );
      chips.push(chip);
      switcher.appendChild(chip);
    }

    const prompt = el("div", { class: "mono qm-question" }, "");
    const answerReveal = el("div", { class: "mono qm-answer" }, "");

    const verdictRow = el("div", { class: "marking-choices" });
    const btnRight = el(
      "button",
      {
        class: "mono marking-btn marking-btn--right",
        type: "button",
        "aria-pressed": "false",
        title: "Mark as correct",
        "aria-label": "Mark as correct",
      },
      "✓"
    );
    const btnUnknown = el(
      "button",
      {
        class: "mono marking-btn marking-btn--unknown",
        type: "button",
        "aria-pressed": "false",
        title: "Mark as unsure",
        "aria-label": "Mark as unsure",
      },
      "I dunno"
    );
    const btnWrong = el(
      "button",
      {
        class: "mono marking-btn marking-btn--wrong",
        type: "button",
        "aria-pressed": "false",
        title: "Mark as incorrect",
        "aria-label": "Mark as incorrect",
      },
      "✕"
    );
    verdictRow.appendChild(btnRight);
    verdictRow.appendChild(btnUnknown);
    verdictRow.appendChild(btnWrong);

    const submitBtn = el(
      "button",
      {
        class: "mono qm-submit",
        type: "button",
        disabled: "disabled",
      },
      "Submit"
    );

    root.appendChild(heading);
    root.appendChild(switcher);
    root.appendChild(prompt);
    root.appendChild(answerReveal);
    root.appendChild(verdictRow);
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

    showMessage("Loading answers…");

    const rdSnap = await getDoc(rdRef);
    const rd = rdSnap.data() || {};
    const oppItems = (oppRole === "host" ? rd.hostItems : rd.guestItems) || [];
    const oppAnswers = (((roomData0.answers || {})[oppRole] || {})[round] || []).map((a) => a?.chosen || "");
    const totalMarks = 3;

    let idx = 0;
    let marks = new Array(totalMarks).fill(null);
    let published = false;
    let submitting = false;
    let markingReady = false;

    const markValue = (value) => {
      if (value === VERDICT.RIGHT) return VERDICT.RIGHT;
      if (value === VERDICT.WRONG) return VERDICT.WRONG;
      return VERDICT.UNKNOWN;
    };

    const normaliseIncomingMark = (value) => {
      if (value === VERDICT.RIGHT) return VERDICT.RIGHT;
      if (value === VERDICT.WRONG) return VERDICT.WRONG;
      if (value === VERDICT.UNKNOWN) return VERDICT.UNKNOWN;
      return null;
    };

    const updateChips = () => {
      chips.forEach((chip, chipIndex) => {
        const answered = Boolean(marks[chipIndex]);
        chip.classList.toggle("is-active", chipIndex === idx);
        chip.classList.toggle("is-answered", answered);
        chip.disabled = !markingReady;
      });
    };

    const updateVerdictButtons = () => {
      const mark = marks[idx];
      const isRight = mark === VERDICT.RIGHT;
      const isWrong = mark === VERDICT.WRONG;
      const isUnknown = mark === VERDICT.UNKNOWN;
      const disabled = !markingReady || published || submitting;
      btnRight.disabled = disabled;
      btnWrong.disabled = disabled;
      btnUnknown.disabled = disabled;
      btnRight.classList.toggle("is-selected", isRight);
      btnWrong.classList.toggle("is-selected", isWrong);
      btnUnknown.classList.toggle("is-selected", isUnknown);
      btnRight.setAttribute("aria-pressed", isRight ? "true" : "false");
      btnWrong.setAttribute("aria-pressed", isWrong ? "true" : "false");
      btnUnknown.setAttribute("aria-pressed", isUnknown ? "true" : "false");
    };

    const updateSubmitState = () => {
      const ready = marks.every((value) => Boolean(value));
      let label = "Submit";
      if (submitting) label = "Submitting…";
      else if (published) label = `Waiting for ${oppName}…`;
      submitBtn.textContent = label;
      submitBtn.disabled = !ready || published || submitting;
      submitBtn.classList.toggle("is-ready", ready && !published && !submitting);
      submitBtn.classList.toggle("is-submitted", published);
      submitBtn.classList.toggle("is-busy", submitting);
    };

    const showMessage = (text) => {
      markingReady = false;
      prompt.textContent = text;
      answerReveal.textContent = "";
      updateChips();
      updateVerdictButtons();
      updateSubmitState();
      pauseRoundTimer(timerContext);
    };

    const setActive = (targetIdx, { fromAuto = false } = {}) => {
      if (!markingReady) return;
      if (!Number.isFinite(targetIdx)) targetIdx = 0;
      if (targetIdx < 0) targetIdx = 0;
      if (targetIdx >= totalMarks) targetIdx = totalMarks - 1;
      idx = targetIdx;
      const currentItem = oppItems[idx] || {};
      const questionText = currentItem.question || "(missing question)";
      const chosenAnswer = oppAnswers[idx] || "(no answer recorded)";
      prompt.textContent = questionText;
      answerReveal.textContent = `${oppName} answered: ${chosenAnswer}`;
      updateChips();
      updateVerdictButtons();
      updateSubmitState();
      if (!fromAuto && !published) resumeRoundTimer(timerContext);
    };

    const focusNext = (fromIndex) => {
      if (!markingReady) return;
      const allMarked = marks.every((value) => Boolean(value));
      if (allMarked) {
        setActive(fromIndex, { fromAuto: true });
        return;
      }
      for (let i = fromIndex + 1; i < totalMarks; i += 1) {
        if (!marks[i]) {
          setActive(i, { fromAuto: true });
          return;
        }
      }
      for (let i = 0; i < totalMarks; i += 1) {
        if (!marks[i]) {
          setActive(i, { fromAuto: true });
          return;
        }
      }
      setActive(fromIndex, { fromAuto: true });
    };

    const handleVerdict = (value) => {
      if (!markingReady || published || submitting) return;
      marks[idx] = markValue(value);
      updateVerdictButtons();
      updateChips();
      updateSubmitState();
      focusNext(idx);
    };

    btnRight.addEventListener("click", () => handleVerdict(VERDICT.RIGHT));
    btnWrong.addEventListener("click", () => handleVerdict(VERDICT.WRONG));
    btnUnknown.addEventListener("click", () => handleVerdict(VERDICT.UNKNOWN));

    chips.forEach((chip, chipIndex) => {
      chip.addEventListener("click", () => {
        if (!markingReady) return;
        setActive(chipIndex);
      });
    });

    const submitMarks = async () => {
      if (published || submitting) return;
      const ready = marks.every((value) => Boolean(value));
      if (!ready) return;
      submitting = true;
      updateVerdictButtons();
      updateSubmitState();
      pauseRoundTimer(timerContext);

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
        updateVerdictButtons();
        updateSubmitState();
        clearRoundTimer(timerContext);
      } catch (err) {
        console.warn("[marking] submit failed:", err);
        submitting = false;
        updateVerdictButtons();
        updateSubmitState();
        if (!published) resumeRoundTimer(timerContext);
      }
    };

    submitBtn.addEventListener("click", () => {
      if (submitBtn.disabled) return;
      submitMarks();
    });

    const existingMarks = (((roomData0.marking || {})[myRole] || {})[round] || []);
    const ackMineInitial = Boolean((((roomData0.markingAck || {})[myRole]) || {})[round]);

    const applyExistingMarks = () => {
      existingMarks.forEach((entry, entryIndex) => {
        if (entryIndex >= totalMarks) return;
        const normalised = normaliseIncomingMark(entry);
        if (normalised) marks[entryIndex] = normalised;
      });
    };

    markingReady = true;
    applyExistingMarks();
    const firstUnmarked = marks.findIndex((value) => !value);
    const startIndex = firstUnmarked === -1 ? totalMarks - 1 : firstUnmarked;

    if (ackMineInitial || (existingMarks.length >= totalMarks && marks.every((value) => Boolean(value)))) {
      published = true;
      setActive(startIndex);
      updateVerdictButtons();
      updateSubmitState();
      pauseRoundTimer(timerContext);
      clearRoundTimer(timerContext);
    } else {
      setActive(startIndex);
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
        marks = new Array(totalMarks).fill(null).map((_, i) => normaliseIncomingMark(incomingMarks[i]) || null);
        published = true;
        submitting = false;
        updateChips();
        updateVerdictButtons();
        updateSubmitState();
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
      try { stopRoomWatch && stopRoomWatch(); } catch {}
      pauseRoundTimer(timerContext);
    };
  },

  async unmount() { /* instance handles cleanup */ }
};
