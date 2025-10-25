// /src/views/Marking.js
//
// Marking phase — judge opponent answers while a hidden timer keeps running.
// • Shows opponent questions + chosen answers with ✓/✕/I DUNNO toggles.
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
    const saturation = (24 + Math.random() * 8).toFixed(1);
    const lightness = (30 + Math.random() * 6).toFixed(1);
    const rootStyle = document.documentElement.style;
    rootStyle.setProperty("--ink-h", String(hue));
    rootStyle.setProperty("--ink-s", `${saturation}%`);
    rootStyle.setProperty("--ink-l", `${lightness}%`);

    container.innerHTML = "";
    const root = el("div", { class: "view view-marking stage-center phase-shell" });

    const title = el("h1", { class: "mono phase-title" }, "Marking");
    const chipRow = el("div", { class: "phase-chips" });
    const chips = [1, 2, 3].map((n) => {
      const chip = el("button", { class: "phase-chip", type: "button" }, String(n));
      chip.setAttribute("aria-current", "false");
      chipRow.appendChild(chip);
      return chip;
    });

    const panel = el("div", { class: "phase-panel phase-panel--marking" });
    const questionNode = el("div", { class: "mono phase-panel__prompt" }, "");
    const dividerTop = el("div", { class: "phase-panel__divider" });
    const answerBox = el("div", { class: "marking-answer" });
    const answerLabel = el("div", { class: "marking-answer__label mono small" }, "");
    const answerText = el("div", { class: "mono marking-answer__text" }, "");
    answerBox.appendChild(answerLabel);
    answerBox.appendChild(answerText);
    const dividerBottom = el("div", { class: "phase-panel__divider" });
    const verdictRow = el("div", { class: "marking-choices" });
    const btnRight = el(
      "button",
      {
        class: "btn mark-choice mark-choice--tick",
        type: "button",
        title: "Mark as correct",
        "aria-pressed": "false",
      },
      "✓"
    );
    const btnUnknown = el(
      "button",
      {
        class: "btn mark-choice mark-choice--unknown",
        type: "button",
        title: "Mark as unsure",
        "aria-pressed": "false",
      },
      "I dunno"
    );
    const btnWrong = el(
      "button",
      {
        class: "btn mark-choice mark-choice--cross",
        type: "button",
        title: "Mark as incorrect",
        "aria-pressed": "false",
      },
      "✕"
    );
    verdictRow.appendChild(btnRight);
    verdictRow.appendChild(btnUnknown);
    verdictRow.appendChild(btnWrong);

    panel.appendChild(questionNode);
    panel.appendChild(dividerTop);
    panel.appendChild(answerBox);
    panel.appendChild(dividerBottom);
    panel.appendChild(verdictRow);

    const submitBtn = el(
      "button",
      { class: "btn phase-submit", type: "button", disabled: "disabled" },
      "Submit"
    );

    root.appendChild(title);
    root.appendChild(chipRow);
    root.appendChild(panel);
    root.appendChild(submitBtn);

    container.appendChild(root);

    let idx = 0;
    let totalMarks = 3;
    let marks = new Array(totalMarks).fill(null);
    let published = false;
    let submitting = false;
    let advanceTimer = null;
    let waitingForOpponent = false;
    let tripletReady = false;

    chips.forEach((chip, index) => {
      chip.addEventListener("click", () => {
        if (published || submitting || !tripletReady) return;
        showMark(index);
      });
    });

    const updateChips = () => {
      const canNavigate = tripletReady && !published && !submitting;
      chips.forEach((chip, index) => {
        const isCurrent = index === idx;
        const mark = marks[index];
        const isComplete = mark === VERDICT.RIGHT || mark === VERDICT.WRONG || mark === VERDICT.UNKNOWN;
        chip.classList.toggle("is-active", isCurrent);
        chip.classList.toggle("is-complete", isComplete);
        chip.disabled = !canNavigate;
        chip.setAttribute("aria-current", isCurrent ? "step" : "false");
      });
    };

    const setVerdictsEnabled = (enabled) => {
      const allow = Boolean(enabled) && tripletReady && !published && !submitting;
      btnRight.disabled = !allow;
      btnWrong.disabled = !allow;
      btnUnknown.disabled = !allow;
    };

    const applyVerdictStyles = () => {
      const mark = marks[idx];
      const isRight = mark === VERDICT.RIGHT;
      const isWrong = mark === VERDICT.WRONG;
      const isUnknown = mark === VERDICT.UNKNOWN;
      btnRight.classList.toggle("is-selected", isRight);
      btnWrong.classList.toggle("is-selected", isWrong);
      btnUnknown.classList.toggle("is-selected", isUnknown);
      btnRight.setAttribute("aria-pressed", isRight ? "true" : "false");
      btnWrong.setAttribute("aria-pressed", isWrong ? "true" : "false");
      btnUnknown.setAttribute("aria-pressed", isUnknown ? "true" : "false");
    };

    const updateSubmitState = () => {
      if (submitting) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Submitting…";
        submitBtn.classList.add("is-busy");
        submitBtn.classList.remove("is-ready");
        submitBtn.classList.remove("is-submitted");
        return;
      }

      submitBtn.classList.remove("is-busy");

      if (published) {
        submitBtn.disabled = true;
        submitBtn.textContent = waitingForOpponent ? "Waiting…" : "Submitted";
        submitBtn.classList.add("is-submitted");
        submitBtn.classList.remove("is-ready");
        return;
      }

      const ready = tripletReady && marks.every((value) => value === VERDICT.RIGHT || value === VERDICT.WRONG || value === VERDICT.UNKNOWN);
      submitBtn.disabled = !ready;
      submitBtn.textContent = "Submit";
      submitBtn.classList.toggle("is-ready", ready);
      submitBtn.classList.remove("is-submitted");
    };

    const setWaitingState = (_message) => {
      waitingForOpponent = true;
      panel.classList.add("is-locked", "is-waiting");
      setVerdictsEnabled(false);
      updateChips();
      updateSubmitState();
    };

    const setLoadingState = (message) => {
      panel.classList.add("is-locked", "is-waiting");
      questionNode.textContent = message || "Loading…";
      answerLabel.textContent = "";
      answerText.textContent = "";
      setVerdictsEnabled(false);
      updateChips();
      updateSubmitState();
    };

    const clearLoadingState = () => {
      panel.classList.remove("is-waiting");
      if (!published) panel.classList.remove("is-locked");
    };

    const findNextPending = (fromIndex) => {
      if (!tripletReady) return null;
      const total = Math.min(chips.length, totalMarks);
      for (let offset = 1; offset <= total; offset += 1) {
        const target = (fromIndex + offset) % total;
        const value = marks[target];
        const isSet = value === VERDICT.RIGHT || value === VERDICT.WRONG || value === VERDICT.UNKNOWN;
        if (!isSet) return target;
      }
      return null;
    };

    setLoadingState("Preparing responses…");

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
    totalMarks = Math.min(chips.length, Math.max(3, oppItems.length || 0));
    marks = new Array(totalMarks).fill(null);
    answerLabel.textContent = `${oppName}’s answer`;

    const markValue = (value) => {
      if (value === VERDICT.RIGHT) return VERDICT.RIGHT;
      if (value === VERDICT.WRONG) return VERDICT.WRONG;
      if (value === VERDICT.UNKNOWN) return VERDICT.UNKNOWN;
      return VERDICT.UNKNOWN;
    };

    const clearAdvanceTimer = () => {
      if (advanceTimer) {
        clearTimeout(advanceTimer);
        advanceTimer = null;
      }
    };

    const showMark = (targetIdx) => {
      clearAdvanceTimer();
      if (targetIdx < 0) targetIdx = 0;
      if (targetIdx >= totalMarks) targetIdx = totalMarks - 1;
      idx = targetIdx;
      const currentItem = oppItems[idx] || {};
      const questionText = currentItem.question || "(missing question)";
      const chosenAnswer = oppAnswers[idx] || "(no answer recorded)";
      questionNode.textContent = questionText;
      answerText.textContent = chosenAnswer;
      clearLoadingState();
      if (!published) panel.classList.remove("is-locked");
      setVerdictsEnabled(true);
      applyVerdictStyles();
      updateChips();
      if (!published) {
        resumeRoundTimer(timerContext);
      }
      updateSubmitState();
    };

    const submitMarks = async () => {
      if (published || submitting) return;
      if (!tripletReady || !marks.every((value) => value === VERDICT.RIGHT || value === VERDICT.WRONG || value === VERDICT.UNKNOWN)) return;
      submitting = true;
      waitingForOpponent = false;
      clearAdvanceTimer();
      setVerdictsEnabled(false);
      panel.classList.add("is-locked");
      updateSubmitState();
      const safeMarks = marks.map((value) => markValue(value));
      pauseRoundTimer(timerContext);
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
        setWaitingState();
        clearRoundTimer(timerContext);
      } catch (err) {
        console.warn("[marking] submit failed:", err);
        submitting = false;
        if (!published) {
          panel.classList.remove("is-waiting");
          panel.classList.remove("is-locked");
          waitingForOpponent = false;
          updateSubmitState();
          setVerdictsEnabled(true);
          resumeRoundTimer(timerContext);
        }
      }
    };

    const handleVerdict = (value) => {
      if (published || submitting) return;
      clearAdvanceTimer();
      marks[idx] = markValue(value);
      applyVerdictStyles();
      updateChips();
      updateSubmitState();
      advanceTimer = setTimeout(() => {
        advanceTimer = null;
        if (published || submitting) return;
        const nextIdx = findNextPending(idx);
        if (nextIdx === null) {
          updateSubmitState();
        } else {
          showMark(nextIdx);
        }
      }, 500);
    };

    btnRight.addEventListener("click", () => handleVerdict(VERDICT.RIGHT));
    btnWrong.addEventListener("click", () => handleVerdict(VERDICT.WRONG));
    btnUnknown.addEventListener("click", () => handleVerdict(VERDICT.UNKNOWN));

    submitBtn.addEventListener("click", () => {
      if (submitting || published) return;
      submitMarks();
    });

    const existingMarks = (((roomData0.marking || {})[myRole] || {})[round] || []);
    tripletReady = totalMarks > 0;
    if (Array.isArray(existingMarks) && existingMarks.length >= totalMarks && existingMarks.every((value) => value)) {
      marks = marks.map((_, i) => markValue(existingMarks[i]));
      published = true;
      showMark(Math.min(totalMarks - 1, chips.length - 1));
      setVerdictsEnabled(false);
      pauseRoundTimer(timerContext);
      clearRoundTimer(timerContext);
      setWaitingState();
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
        marks = marks.map((_, i) => markValue(incomingMarks[i]));
        published = true;
        submitting = false;
        clearAdvanceTimer();
        updateChips();
        setVerdictsEnabled(false);
        pauseRoundTimer(timerContext);
        clearRoundTimer(timerContext);
        setWaitingState();
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
