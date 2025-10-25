// /src/views/Marking.js
//
// Marking phase — award-style review with single panel.
// • Presents opponent answers sequentially with numbered chips for navigation.
// • Verdict buttons remain neutral until selected, then adopt green/grey/red feedback tones.
// • Submit activates once every question has a verdict and waits for the opponent before advancing.

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
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  }
  (Array.isArray(kids) ? kids : [kids]).forEach((child) => {
    if (child === undefined || child === null) return;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  });
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

function setHueVariables(hue) {
  const compHue = (hue + 180) % 360;
  document.documentElement.style.setProperty("--ink-h", String(hue));
  document.documentElement.style.setProperty("--ink-comp-h", String(compHue));
}

export default {
  async mount(container) {
    const me = await ensureAuth();

    const params = getHashParams();
    const code = clampCode(params.get("code") || "");
    let round = parseInt(params.get("round") || "1", 10) || 1;

    const hue = Math.floor(Math.random() * 360);
    setHueVariables(hue);

    container.innerHTML = "";
    const root = el("div", { class: "view view-marking stage-center" });
    const card = el("div", { class: "card round-card" });

    const heading = el("div", { class: "mono round-card__heading" }, "MARKING");
    const stepRow = el("div", { class: "round-card__steps" });
    const chips = [0, 1, 2].map((index) => {
      const chip = el("button", {
        class: "round-step",
        type: "button",
        "data-index": String(index),
      }, String(index + 1));
      stepRow.appendChild(chip);
      return chip;
    });

    const prompt = el("div", { class: "mono round-card__prompt" }, "");
    const answerBlock = el("div", { class: "round-card__answer" });
    const answerLabel = el("div", { class: "mono round-card__answer-label" }, "");
    const answerText = el("div", { class: "mono round-card__answer-text" }, "");
    answerBlock.appendChild(answerLabel);
    answerBlock.appendChild(answerText);

    const verdictRow = el("div", { class: "round-card__verdicts" });
    const btnRight = el("button", {
      class: "marking-choice",
      type: "button",
      title: "Mark as correct",
      "aria-pressed": "false",
      "data-verdict": VERDICT.RIGHT,
    }, "✓");
    const btnUnknown = el("button", {
      class: "marking-choice",
      type: "button",
      title: "Mark as unsure",
      "aria-pressed": "false",
      "data-verdict": VERDICT.UNKNOWN,
    }, "I DUNNO");
    const btnWrong = el("button", {
      class: "marking-choice",
      type: "button",
      title: "Mark as incorrect",
      "aria-pressed": "false",
      "data-verdict": VERDICT.WRONG,
    }, "✕");
    verdictRow.appendChild(btnRight);
    verdictRow.appendChild(btnUnknown);
    verdictRow.appendChild(btnWrong);

    const statusText = el("div", { class: "mono round-card__status round-card__status--hidden" }, "");
    const submitBtn = el("button", {
      class: "btn round-card__submit",
      type: "button",
      disabled: "",
    }, "SUBMIT MARKING");

    card.appendChild(heading);
    card.appendChild(stepRow);
    card.appendChild(prompt);
    card.appendChild(answerBlock);
    card.appendChild(verdictRow);
    card.appendChild(statusText);
    card.appendChild(submitBtn);

    const exitPrompt = (() => {
      const title = el("div", { class: "mono round-exit__title" }, "RETURN TO LOBBY?");
      const actions = el("div", { class: "round-exit__actions" });
      const yesBtn = el("button", { class: "btn round-exit__btn" }, "YES");
      const noBtn = el("button", { class: "btn outline round-exit__btn" }, "NO");
      actions.appendChild(yesBtn);
      actions.appendChild(noBtn);
      return { node: el("div", { class: "round-exit round-exit--hidden" }, [title, actions]), yesBtn, noBtn };
    })();

    root.appendChild(card);
    root.appendChild(exitPrompt.node);
    container.appendChild(root);

    let idx = 0;
    let marks = [null, null, null];
    let published = false;
    let submitting = false;
    let advanceTimer = null;
    let stopRoomWatch = null;
    let alive = true;
    let waitMessageDefault = "Waiting…";
    let guardActive = true;
    let chipsEnabled = false;
    let oppItems = [];
    let oppAnswers = [];

    const historySupported = typeof window !== "undefined" && "addEventListener" in window && window.history;

    const timerContext = { code, role: "", round };

    const clearAdvanceTimer = () => {
      if (advanceTimer) {
        clearTimeout(advanceTimer);
        advanceTimer = null;
      }
    };

    const setStatus = (message) => {
      const text = message || "";
      statusText.textContent = text;
      statusText.classList.toggle("round-card__status--hidden", !text);
    };

    const setVerdictsEnabled = (enabled) => {
      const allowed = enabled && !published && !submitting;
      [btnRight, btnUnknown, btnWrong].forEach((btn) => {
        btn.disabled = !allowed;
      });
    };

    const setChipNavigation = (enabled) => {
      chipsEnabled = enabled;
      chips.forEach((chip) => {
        chip.disabled = !enabled || published || submitting;
      });
    };

    setVerdictsEnabled(false);
    setChipNavigation(false);
    setStatus("Preparing review…");

    const updateChips = () => {
      chips.forEach((chip, index) => {
        chip.classList.toggle("round-step--active", index === idx);
        chip.classList.toggle("round-step--answered", marks[index] !== null && marks[index] !== undefined);
        chip.disabled = !chipsEnabled || published || submitting;
      });
    };

    const refreshVerdictStyles = () => {
      const mark = marks[idx];
      const applyState = (btn, isActive, type) => {
        btn.classList.toggle("marking-choice--selected", Boolean(isActive));
        btn.classList.toggle("marking-choice--right", isActive && type === VERDICT.RIGHT);
        btn.classList.toggle("marking-choice--wrong", isActive && type === VERDICT.WRONG);
        btn.classList.toggle("marking-choice--unknown", isActive && type === VERDICT.UNKNOWN);
        if (!isActive) {
          btn.classList.remove("marking-choice--right", "marking-choice--wrong", "marking-choice--unknown");
        }
        btn.setAttribute("aria-pressed", isActive ? "true" : "false");
      };
      applyState(btnRight, mark === VERDICT.RIGHT, VERDICT.RIGHT);
      applyState(btnWrong, mark === VERDICT.WRONG, VERDICT.WRONG);
      applyState(btnUnknown, mark === VERDICT.UNKNOWN, VERDICT.UNKNOWN);
    };

    const updateSubmitState = () => {
      const ready = marks.every((value) => value !== null && value !== undefined) && !published && !submitting;
      submitBtn.disabled = !ready;
      submitBtn.classList.toggle("throb", ready);
    };

    const markValue = (value) => {
      if (value === VERDICT.RIGHT) return VERDICT.RIGHT;
      if (value === VERDICT.WRONG) return VERDICT.WRONG;
      return VERDICT.UNKNOWN;
    };

    const findNextUnmarked = (start) => {
      for (let i = start + 1; i < marks.length; i += 1) {
        if (marks[i] === null || marks[i] === undefined) return i;
      }
      for (let i = 0; i < marks.length; i += 1) {
        if (marks[i] === null || marks[i] === undefined) return i;
      }
      return null;
    };

    const showMark = (targetIdx) => {
      clearAdvanceTimer();
      const clamped = Math.max(0, Math.min(targetIdx, Math.max(oppItems.length, marks.length) - 1));
      idx = clamped;
      const currentItem = oppItems[idx] || {};
      const questionText = currentItem.question || "(missing question)";
      const chosenAnswer = oppAnswers[idx] || "(no answer recorded)";
      prompt.textContent = `${idx + 1}. ${questionText}`;
      answerText.textContent = chosenAnswer;
      setVerdictsEnabled(true);
      setChipNavigation(true);
      setStatus("");
      updateChips();
      refreshVerdictStyles();
      updateSubmitState();
      resumeRoundTimer(timerContext);
    };

    const handleVerdict = (value) => {
      if (published || submitting) return;
      clearAdvanceTimer();
      marks[idx] = markValue(value);
      refreshVerdictStyles();
      updateChips();
      updateSubmitState();
      const nextIdx = findNextUnmarked(idx);
      advanceTimer = setTimeout(() => {
        advanceTimer = null;
        if (!alive || published || submitting) return;
        if (nextIdx === null || nextIdx === idx) {
          showMark(idx);
        } else {
          showMark(nextIdx);
        }
      }, 500);
    };

    [btnRight, btnUnknown, btnWrong].forEach((btn) => {
      btn.addEventListener("click", () => handleVerdict(btn.getAttribute("data-verdict")));
    });

    chips.forEach((chip, index) => {
      chip.addEventListener("click", () => {
        if (!chipsEnabled || published || submitting) return;
        showMark(index);
      });
    });

    let backPromptVisible = false;
    const showExitPrompt = () => {
      if (backPromptVisible) return;
      backPromptVisible = true;
      exitPrompt.node.classList.remove("round-exit--hidden");
    };

    const hideExitPrompt = () => {
      if (!backPromptVisible) return;
      backPromptVisible = false;
      exitPrompt.node.classList.add("round-exit--hidden");
    };

    const handleBackAttempt = () => {
      if (!guardActive) return;
      showExitPrompt();
      if (historySupported && typeof window.history.go === "function") {
        try { window.history.go(1); } catch {}
      } else {
        setTimeout(() => {
          location.hash = `#/marking?code=${code}&round=${round}`;
        }, 0);
      }
    };

    if (historySupported) {
      window.addEventListener("popstate", handleBackAttempt);
    }

    exitPrompt.yesBtn.addEventListener("click", () => {
      guardActive = false;
      hideExitPrompt();
      location.hash = "#/lobby";
    });

    exitPrompt.noBtn.addEventListener("click", () => {
      hideExitPrompt();
    });

    const releaseGuard = () => {
      guardActive = false;
      hideExitPrompt();
    };

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
    const answerOwner = oppRole === "host" ? "Daniel" : "Jaime";
    waitMessageDefault = `Waiting for ${oppName}…`;
    timerContext.role = myRole;

    const rdSnap = await getDoc(rdRef);
    const rd = rdSnap.data() || {};
    oppItems = (oppRole === "host" ? rd.hostItems : rd.guestItems) || [];
    oppAnswers = (((roomData0.answers || {})[oppRole] || {})[round] || []).map((a) => a?.chosen || "");
    const totalMarks = Math.max(3, oppItems.length || 0);
    marks = new Array(totalMarks).fill(null);

    answerLabel.textContent = `${answerOwner}’s answer`;

    const applyExistingMarks = (incoming) => {
      marks = new Array(totalMarks).fill(null).map((_, i) => {
        const value = incoming[i];
        if (value === VERDICT.RIGHT) return VERDICT.RIGHT;
        if (value === VERDICT.WRONG) return VERDICT.WRONG;
        if (value === VERDICT.UNKNOWN) return VERDICT.UNKNOWN;
        return null;
      });
    };

    const submitMarks = async () => {
      if (published || submitting) return;
      submitting = true;
      updateSubmitState();
      clearAdvanceTimer();
      setVerdictsEnabled(false);
      setChipNavigation(false);
      pauseRoundTimer(timerContext);
      const totalSecondsRaw = getRoundTimerTotal(timerContext) / 1000;
      const totalSeconds = Math.max(0, Math.round(totalSecondsRaw * 100) / 100);
      const safeMarks = marks.map((value) => markValue(value));
      const patch = {
        [`marking.${myRole}.${round}`]: safeMarks,
        [`markingAck.${myRole}.${round}`]: true,
        [`timings.${myRole}.${round}`]: { totalSeconds },
        "timestamps.updatedAt": serverTimestamp(),
      };

      try {
        setStatus("Submitting review…");
        await updateDoc(rRef, patch);
        published = true;
        submitting = false;
        marks = safeMarks;
        setStatus(waitMessageDefault);
        updateSubmitState();
        clearRoundTimer(timerContext);
      } catch (err) {
        console.warn("[marking] submit failed:", err);
        submitting = false;
        setStatus("Retrying…");
        setVerdictsEnabled(true);
        setChipNavigation(true);
        resumeRoundTimer(timerContext);
        updateSubmitState();
      }
    };

    submitBtn.addEventListener("click", () => {
      if (published || submitting) return;
      submitMarks();
    });

    const existingMarks = (((roomData0.marking || {})[myRole] || {})[round] || []);
    if (Array.isArray(existingMarks) && existingMarks.length === totalMarks) {
      applyExistingMarks(existingMarks);
      published = true;
      setVerdictsEnabled(false);
      setChipNavigation(false);
      setStatus(waitMessageDefault);
      pauseRoundTimer(timerContext);
      clearRoundTimer(timerContext);
    }

    if (!published) {
      showMark(0);
    } else {
      showMark(0);
      setVerdictsEnabled(false);
      setChipNavigation(false);
      setStatus(waitMessageDefault);
      pauseRoundTimer(timerContext);
      clearRoundTimer(timerContext);
      updateSubmitState();
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
        releaseGuard();
        setTimeout(() => {
          location.hash = `#/countdown?code=${code}&round=${data.round || round}`;
        }, 80);
        return;
      }

      if (stateName === "questions") {
        releaseGuard();
        setTimeout(() => {
          location.hash = `#/questions?code=${code}&round=${data.round || round}`;
        }, 80);
        return;
      }

      if (stateName === "award") {
        releaseGuard();
        setTimeout(() => {
          location.hash = `#/award?code=${code}&round=${data.round || round}`;
        }, 80);
        return;
      }

      if (stateName === "final") {
        releaseGuard();
        setTimeout(() => { location.hash = `#/final?code=${code}`; }, 80);
        return;
      }

      const markingAck = data.markingAck || {};
      const ackMine = Boolean(((markingAck[myRole] || {})[round]));
      const ackOpp = Boolean(((markingAck[oppRole] || {})[round]));

      if (ackMine && !published) {
        const incomingMarks = (((data.marking || {})[myRole] || {})[round] || marks);
        applyExistingMarks(incomingMarks);
        published = true;
        submitting = false;
        setStatus(waitMessageDefault);
        setVerdictsEnabled(false);
        setChipNavigation(false);
        pauseRoundTimer(timerContext);
        clearRoundTimer(timerContext);
        updateSubmitState();
        refreshVerdictStyles();
        updateChips();
      }

      if (myRole === "host" && stateName === "marking" && ackMine && ackOpp) {
        finalizeRound();
      }
    }, (err) => {
      console.warn("[marking] room snapshot error:", err);
    });

    this._cleanup = () => {
      alive = false;
      clearAdvanceTimer();
      try { stopRoomWatch && stopRoomWatch(); } catch {}
      pauseRoundTimer(timerContext);
      if (historySupported) {
        try { window.removeEventListener("popstate", handleBackAttempt); } catch {}
      }
    };
  },

  async unmount() {
    if (typeof this._cleanup === "function") {
      try { this._cleanup(); } catch {}
      this._cleanup = null;
    }
  },
};
