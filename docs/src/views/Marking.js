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
import { applyPastelTheme } from "../lib/palette.js";

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

    const resetTheme = applyPastelTheme();

    container.innerHTML = "";

    let idx = 0;
    let totalMarks = 3;
    let marks = new Array(totalMarks).fill(null);
    let published = false;
    let submitting = false;
    let waitingForOpponent = false;
    let advanceTimer = null;

    const root = el("div", { class: "view view-marking qa-stage" });
    const title = el("h1", { class: "qa-title mono" }, "Marking");
    const chipRow = el("div", { class: "qa-chip-row" });
    const panel = el("div", { class: "qa-panel" });
    const qText = el("div", { class: "mono qa-panel__prompt" }, "Loading…");
    const divider = el("div", { class: "qa-divider" });
    const answerText = el("div", { class: "qa-panel__response" }, "");
    const marksRow = el("div", { class: "qa-mark-row" });
    const btnRight = el("button", {
      class: "qa-mark qa-mark--tick",
      type: "button",
      "aria-pressed": "false",
    }, "✓");
    const btnUnknown = el("button", {
      class: "qa-mark qa-mark--idk",
      type: "button",
      "aria-pressed": "false",
    }, "I DUNNO");
    const btnWrong = el("button", {
      class: "qa-mark qa-mark--cross",
      type: "button",
      "aria-pressed": "false",
    }, "✕");
    marksRow.appendChild(btnRight);
    marksRow.appendChild(btnUnknown);
    marksRow.appendChild(btnWrong);
    panel.appendChild(qText);
    panel.appendChild(divider);
    panel.appendChild(answerText);
    panel.appendChild(marksRow);

    const submitRow = el("div", { class: "qa-submit" });
    const submitBtn = el(
      "button",
      { class: "qa-submit-btn", type: "button", disabled: "disabled" },
      "Submit Marking"
    );
    submitRow.appendChild(submitBtn);

    root.appendChild(title);
    root.appendChild(chipRow);
    root.appendChild(panel);
    root.appendChild(submitRow);

    container.appendChild(root);

    const chipButtons = [0, 1, 2].map((position) => {
      const chip = el(
        "button",
        {
          class: "qa-chip",
          type: "button",
          "aria-label": `Question ${position + 1}`,
          "aria-pressed": "false",
        },
        String(position + 1)
      );
      chip.addEventListener("click", () => {
        if (submitting || published) return;
        showMark(position);
      });
      chipRow.appendChild(chip);
      return chip;
    });

    const setPanelLoading = (loading) => {
      panel.classList.toggle("qa-panel--loading", loading);
    };

    const applyVerdictStyles = () => {
      const mark = marks[idx];
      const isRight = mark === VERDICT.RIGHT;
      const isWrong = mark === VERDICT.WRONG;
      const isUnknown = mark === VERDICT.UNKNOWN;
      btnRight.classList.toggle("qa-mark--selected", isRight);
      btnWrong.classList.toggle("qa-mark--selected", isWrong);
      btnUnknown.classList.toggle("qa-mark--selected", isUnknown);
      btnRight.setAttribute("aria-pressed", isRight ? "true" : "false");
      btnWrong.setAttribute("aria-pressed", isWrong ? "true" : "false");
      btnUnknown.setAttribute("aria-pressed", isUnknown ? "true" : "false");
    };

    const setButtonsEnabled = (enabled) => {
      btnRight.disabled = !enabled;
      btnWrong.disabled = !enabled;
      btnUnknown.disabled = !enabled;
      panel.classList.toggle("qa-panel--locked", !enabled);
      applyVerdictStyles();
    };

    const setChipsEnabled = (enabled) => {
      chipButtons.forEach((chip) => {
        chip.disabled = !enabled;
      });
    };

    const clearAdvanceTimer = () => {
      if (advanceTimer) {
        clearTimeout(advanceTimer);
        advanceTimer = null;
      }
    };

    const updateChipStates = () => {
      chipButtons.forEach((chip, position) => {
        const isActive = position === idx;
        const isDone = marks[position] !== null;
        chip.classList.toggle("qa-chip--active", isActive);
        chip.classList.toggle("qa-chip--done", isDone);
        chip.setAttribute("aria-pressed", isActive ? "true" : "false");
      });
    };

    const refreshSubmitState = () => {
      const ready = marks.length === totalMarks && marks.every((value) => value !== null);
      let label = "Submit Marking";
      let disabled = false;
      const isReady = ready && !published && !submitting;
      if (submitting) {
        label = "Submitting…";
        disabled = true;
      } else if (published) {
        disabled = true;
        label = waitingForOpponent ? "Submitted — waiting…" : "Submitted";
      } else if (!ready) {
        disabled = true;
      }
      submitBtn.disabled = disabled;
      submitBtn.classList.toggle("is-ready", isReady);
      submitBtn.textContent = label;
    };

    const nextUnmarked = (fromIndex) => {
      for (let i = fromIndex + 1; i < totalMarks; i += 1) {
        if (marks[i] === null) return i;
      }
      for (let i = 0; i < totalMarks; i += 1) {
        if (marks[i] === null) return i;
      }
      return null;
    };

    const markValue = (value) => {
      if (value === null || value === undefined) return null;
      if (value === VERDICT.RIGHT || value === true) return VERDICT.RIGHT;
      if (value === VERDICT.WRONG || value === false) return VERDICT.WRONG;
      if (value === VERDICT.UNKNOWN) return VERDICT.UNKNOWN;
      if (typeof value === "string") {
        const trimmed = value.trim().toLowerCase();
        if (trimmed === VERDICT.RIGHT) return VERDICT.RIGHT;
        if (trimmed === VERDICT.WRONG) return VERDICT.WRONG;
        if (trimmed === VERDICT.UNKNOWN) return VERDICT.UNKNOWN;
      }
      return VERDICT.UNKNOWN;
    };

    const normaliseMark = (value) => markValue(value);

    setPanelLoading(true);
    setButtonsEnabled(false);
    setChipsEnabled(false);
    refreshSubmitState();

    let timerContext = { code, role: "guest", round };

    const showMark = (targetIdx) => {
      clearAdvanceTimer();
      if (targetIdx < 0) targetIdx = 0;
      if (targetIdx >= totalMarks) targetIdx = totalMarks - 1;
      idx = targetIdx;
      const currentItem = oppItems[idx] || {};
      const questionText = currentItem.question || "(missing question)";
      const chosenAnswer = oppAnswers[idx] || "";
      qText.textContent = questionText;
      answerText.textContent = chosenAnswer
        ? `“${chosenAnswer}”`
        : "“(no answer recorded)”";
      applyVerdictStyles();
      updateChipStates();
      setPanelLoading(false);
      if (!published && !submitting) {
        setButtonsEnabled(true);
        setChipsEnabled(true);
        resumeRoundTimer(timerContext);
      } else {
        setButtonsEnabled(false);
        setChipsEnabled(false);
        pauseRoundTimer(timerContext);
      }
      refreshSubmitState();
    };

    const handleVerdict = (value) => {
      if (published || submitting) return;
      clearAdvanceTimer();
      marks[idx] = markValue(value);
      applyVerdictStyles();
      updateChipStates();
      refreshSubmitState();
      advanceTimer = setTimeout(() => {
        advanceTimer = null;
        if (published || submitting) return;
        const nextIndex = nextUnmarked(idx);
        if (nextIndex === null) return;
        showMark(nextIndex);
      }, 500);
    };

    btnRight.addEventListener("click", () => handleVerdict(VERDICT.RIGHT));
    btnWrong.addEventListener("click", () => handleVerdict(VERDICT.WRONG));
    btnUnknown.addEventListener("click", () => handleVerdict(VERDICT.UNKNOWN));

    const publishMarks = async () => {
      if (submitting || published) return;
      if (marks.length !== totalMarks) return;
      const ready = marks.every((value) => value !== null);
      if (!ready) return;

      clearAdvanceTimer();
      submitting = true;
      setButtonsEnabled(false);
      setChipsEnabled(false);
      pauseRoundTimer(timerContext);
      refreshSubmitState();

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
        marks = safeMarks;
        submitting = false;
        published = true;
        waitingForOpponent = true;
        refreshSubmitState();
        clearRoundTimer(timerContext);
      } catch (err) {
        console.warn("[marking] submit failed:", err);
        submitting = false;
        if (!published) {
          setButtonsEnabled(true);
          setChipsEnabled(true);
          resumeRoundTimer(timerContext);
          refreshSubmitState();
        }
      }
    };

    submitBtn.addEventListener("click", () => {
      if (submitBtn.disabled) return;
      publishMarks();
    });

    let oppItems = [];
    let oppAnswers = [];

    const rRef = roomRef(code);
    const rdRef = doc(roundSubColRef(code), String(round));

    const roomSnap = await getDoc(rRef);
    const roomData0 = roomSnap.data() || {};
    const { hostUid, guestUid } = roomData0.meta || {};
    const storedRole = getStoredRole(code);
    const myRole =
      storedRole === "host" || storedRole === "guest"
        ? storedRole
        : hostUid === me.uid
          ? "host"
          : guestUid === me.uid
            ? "guest"
            : "guest";
    const oppRole = myRole === "host" ? "guest" : "host";

    timerContext = { code, role: myRole, round };

    const rdSnap = await getDoc(rdRef);
    const rd = rdSnap.data() || {};
    oppItems = (oppRole === "host" ? rd.hostItems : rd.guestItems) || [];
    oppAnswers = (((roomData0.answers || {})[oppRole] || {})[round] || []).map((a) => a?.chosen || "");
    totalMarks = Math.max(3, oppItems.length || 0);
    marks = new Array(totalMarks).fill(null);

    const existingMarks = (((roomData0.marking || {})[myRole] || {})[round] || []);
    const markingAckData = roomData0.markingAck || {};
    const ackMineInitial = Boolean(((markingAckData[myRole] || {})[round]));
    const ackOppInitial = Boolean(((markingAckData[oppRole] || {})[round]));

    if (Array.isArray(existingMarks) && existingMarks.length) {
      marks = marks.map((_, i) => normaliseMark(existingMarks[i]));
    }

    updateChipStates();

    if (ackMineInitial && marks.every((value) => value !== null)) {
      published = true;
      waitingForOpponent = !ackOppInitial;
      setButtonsEnabled(false);
      setChipsEnabled(false);
      pauseRoundTimer(timerContext);
      clearRoundTimer(timerContext);
      refreshSubmitState();
    }

    if (marks.every((value) => value !== null) && !published) {
      refreshSubmitState();
    }

    const firstUnmarked = nextUnmarked(-1);
    if (totalMarks === 0) {
      qText.textContent = "No questions available.";
      answerText.textContent = "";
      setButtonsEnabled(false);
      setChipsEnabled(false);
      setPanelLoading(false);
    } else if (published) {
      const targetIndex = Math.min(totalMarks - 1, 2);
      showMark(targetIndex);
    } else {
      const targetIndex = firstUnmarked !== null ? firstUnmarked : Math.min(totalMarks - 1, 0);
      showMark(targetIndex);
    }

    refreshSubmitState();

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
        marks = new Array(totalMarks).fill(null).map((_, i) => normaliseMark(incomingMarks[i]));
        published = true;
        submitting = false;
        waitingForOpponent = !ackOpp;
        setButtonsEnabled(false);
        setChipsEnabled(false);
        pauseRoundTimer(timerContext);
        clearRoundTimer(timerContext);
        applyVerdictStyles();
        updateChipStates();
        refreshSubmitState();
      } else if (published) {
        waitingForOpponent = !ackOpp;
        refreshSubmitState();
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
      resetTheme();
    };
  },
  async unmount() { /* instance handles cleanup */ }
};
    setPanelLoading(true);
    setButtonsEnabled(false);
    setChipsEnabled(false);
    refreshSubmitState();

