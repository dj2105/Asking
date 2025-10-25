// /src/views/Marking.js
//
// Marking phase — award-style panel mirroring the Questions layout.
// • Shows opponent’s three questions one at a time with their submitted answer.
// • Three marking buttons (✓ / I DUNNO / ✕) sit below the text, neutral until selected.
// • Selections hold for 0.5s before auto-advancing to the next unanswered mark.
// • Once all three verdicts are set, the Submit button activates (Award-style primary).
// • Submission writes marking.{role}.{round}, timings.{role}.{round}, markingAck.{role}.{round} = true.
// • Back button presses prompt a RETURN TO LOBBY? confirmation.

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

import {
  resumeRoundTimer,
  pauseRoundTimer,
  getRoundTimerTotal,
  clearRoundTimer,
} from "../lib/RoundTimer.js";
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

const markValue = (value) => {
  if (value === VERDICT.RIGHT) return VERDICT.RIGHT;
  if (value === VERDICT.WRONG) return VERDICT.WRONG;
  return VERDICT.UNKNOWN;
};

export default {
  async mount(container) {
    const me = await ensureAuth();

    const params = getHashParams();
    const code = clampCode(params.get("code") || "");
    let round = parseInt(params.get("round") || "1", 10) || 1;

    const hue = Math.floor(Math.random() * 360);
    const accentHue = (hue + 180) % 360;
    document.documentElement.style.setProperty("--ink-h", String(hue));
    document.documentElement.style.setProperty("--accent-soft", `hsl(${accentHue}, 68%, 88%)`);
    document.documentElement.style.setProperty("--accent-strong", `hsl(${accentHue}, 52%, 26%)`);

    container.innerHTML = "";

    const root = el("div", { class: "view view-marking stage-center" });
    const panel = el("div", { class: "round-panel" });
    const heading = el("h2", { class: "round-panel__heading mono" }, "MARKING");

    const steps = el("div", { class: "round-panel__steps" });
    const stepButtons = [0, 1, 2].map((i) => {
      const btn = el(
        "button",
        {
          class: "round-panel__step mono",
          type: "button",
          "aria-label": `Mark ${i + 1}`,
        },
        String(i + 1)
      );
      steps.appendChild(btn);
      return btn;
    });

    const content = el("div", { class: "round-panel__content" });
    const prompt = el("div", { class: "round-panel__question mono" }, "");

    const answerBox = el("div", { class: "round-panel__answer" });
    const answerLabel = el("div", { class: "round-panel__answer-label mono" }, "");
    const answerValue = el("div", { class: "round-panel__answer-value mono" }, "");
    answerBox.appendChild(answerLabel);
    answerBox.appendChild(answerValue);

    const verdictRow = el("div", { class: "marking-buttons" });
    const btnRight = el(
      "button",
      {
        class: "marking-button marking-button--tick mono",
        type: "button",
        "aria-pressed": "false",
      },
      "✓"
    );
    const btnUnknown = el(
      "button",
      {
        class: "marking-button marking-button--unknown mono",
        type: "button",
        "aria-pressed": "false",
      },
      "I DUNNO"
    );
    const btnWrong = el(
      "button",
      {
        class: "marking-button marking-button--cross mono",
        type: "button",
        "aria-pressed": "false",
      },
      "✕"
    );
    verdictRow.appendChild(btnRight);
    verdictRow.appendChild(btnUnknown);
    verdictRow.appendChild(btnWrong);

    content.appendChild(prompt);
    content.appendChild(answerBox);
    content.appendChild(verdictRow);

    const waitingMessage = el("div", { class: "round-panel__waiting mono is-hidden" }, "");

    const submitBtn = el(
      "button",
      {
        class: "btn round-panel__submit mono",
        type: "button",
        disabled: "disabled",
      },
      "SUBMIT"
    );

    panel.appendChild(heading);
    panel.appendChild(steps);
    panel.appendChild(content);
    panel.appendChild(waitingMessage);
    panel.appendChild(submitBtn);
    root.appendChild(panel);

    const backOverlay = el("div", { class: "back-confirm" });
    const backPanel = el("div", { class: "back-confirm__panel mono" });
    const backTitle = el("div", { class: "back-confirm__title" }, "RETURN TO LOBBY?");
    const backActions = el("div", { class: "back-confirm__actions" });
    const backYes = el(
      "button",
      { class: "btn back-confirm__btn mono", type: "button" },
      "YES"
    );
    const backNo = el(
      "button",
      { class: "btn outline back-confirm__btn mono", type: "button" },
      "NO"
    );
    backActions.appendChild(backYes);
    backActions.appendChild(backNo);
    backPanel.appendChild(backTitle);
    backPanel.appendChild(backActions);
    backOverlay.appendChild(backPanel);

    root.appendChild(backOverlay);
    container.appendChild(root);

    const setPrompt = (text, { status = false } = {}) => {
      prompt.textContent = text || "";
      prompt.classList.toggle("round-panel__question--status", status);
    };

    const setMarkingVisible = (visible) => {
      answerBox.classList.toggle("is-hidden", !visible);
      verdictRow.classList.toggle("is-hidden", !visible);
    };

    const setStepsVisible = (visible) => {
      steps.classList.toggle("is-hidden", !visible);
    };

    let idx = 0;
    let marks = [null, null, null];
    let triplet = [];
    let answers = [];
    let published = false;
    let submitting = false;
    let advanceTimer = null;
    let swapTimer = null;
    let waitingMode = false;

    let alive = true;
    let stopRoomWatch = null;
    let guardAllowNavigation = false;
    let guardReverting = false;
    const lockedHash = location.hash;

    const clearAdvanceTimer = () => {
      if (advanceTimer) {
        clearTimeout(advanceTimer);
        advanceTimer = null;
      }
    };

    const clearSwapTimer = () => {
      if (swapTimer) {
        clearTimeout(swapTimer);
        swapTimer = null;
      }
    };

    const animateSwap = (renderFn) => {
      clearSwapTimer();
      content.classList.add("is-leaving");
      swapTimer = setTimeout(() => {
        swapTimer = null;
        renderFn();
        content.classList.remove("is-leaving");
        content.classList.add("is-entering");
        requestAnimationFrame(() => {
          content.classList.remove("is-entering");
        });
      }, 140);
    };

    const getQuestionNumber = (localIndex) => {
      const roundNumber = Number.isFinite(round) && round > 0 ? round : 1;
      const base = (roundNumber - 1) * 3;
      return base + localIndex + 1;
    };

    const updateStepNumbers = () => {
      stepButtons.forEach((btn, i) => {
        const number = getQuestionNumber(i);
        btn.textContent = String(number);
        btn.setAttribute("aria-label", `Mark ${number}`);
      });
    };

    const renderSteps = () => {
      updateStepNumbers();
      stepButtons.forEach((btn, i) => {
        btn.classList.toggle("is-active", i === idx);
        btn.classList.toggle("is-answered", marks[i] !== null);
        btn.disabled = triplet.length === 0 || waitingMode;
      });
    };

    const reflectVerdicts = () => {
      const current = marks[idx];
      const isRight = current === VERDICT.RIGHT;
      const isWrong = current === VERDICT.WRONG;
      const isUnknown = current === VERDICT.UNKNOWN;
      btnRight.classList.toggle("is-selected", isRight);
      btnWrong.classList.toggle("is-selected", isWrong);
      btnUnknown.classList.toggle("is-selected", isUnknown);
      btnRight.setAttribute("aria-pressed", isRight ? "true" : "false");
      btnWrong.setAttribute("aria-pressed", isWrong ? "true" : "false");
      btnUnknown.setAttribute("aria-pressed", isUnknown ? "true" : "false");
    };

    const setVerdictsEnabled = (enabled) => {
      btnRight.disabled = !enabled;
      btnWrong.disabled = !enabled;
      btnUnknown.disabled = !enabled;
    };

    const updateSubmitState = () => {
      const ready = marks.every((value) => value !== null) && !published && !submitting;
      submitBtn.disabled = !ready;
      submitBtn.classList.toggle("round-panel__submit--ready", ready);
      submitBtn.classList.toggle("throb", ready);
      if (!ready) {
        submitBtn.classList.remove("round-panel__submit--ready");
        submitBtn.classList.remove("throb");
      }
      if (!published) {
        submitBtn.textContent = "SUBMIT";
      }
    };

    const highlightSubmitIfReady = () => {
      if (marks.every((value) => value !== null) && !published && !submitting) {
        submitBtn.classList.add("round-panel__submit--ready");
        submitBtn.classList.add("throb");
      }
    };

    const showMark = (targetIdx, { animate = true } = {}) => {
      if (triplet.length === 0) return;
      if (targetIdx < 0) targetIdx = 0;
      if (targetIdx >= triplet.length) targetIdx = triplet.length - 1;
      idx = targetIdx;
      setWaitingMode(false);
      const render = () => {
        const current = triplet[idx] || {};
        const questionText = current.question || "(missing question)";
        const answerText = answers[idx] || "(no answer recorded)";
        const number = getQuestionNumber(idx);
        setPrompt(`${number}. ${questionText}`, { status: false });
        answerValue.textContent = answerText;
        renderSteps();
        reflectVerdicts();
        highlightSubmitIfReady();
        setMarkingVisible(true);
      };
      if (animate) animateSwap(render);
      else render();
      if (!published && !submitting) resumeRoundTimer(timerContext);
    };

    const findNextPending = (fromIndex) => {
      for (let i = fromIndex + 1; i < marks.length; i += 1) {
        if (marks[i] === null) return i;
      }
      for (let i = 0; i < marks.length; i += 1) {
        if (marks[i] === null) return i;
      }
      return null;
    };

    const scheduleAdvance = (currentIndex) => {
      clearAdvanceTimer();
      advanceTimer = setTimeout(() => {
        advanceTimer = null;
        if (!alive || submitting || published) return;
        const next = findNextPending(currentIndex);
        if (next !== null && next !== undefined) {
          showMark(next, { animate: true });
        } else {
          showMark(marks.length - 1, { animate: true });
        }
        highlightSubmitIfReady();
      }, 500);
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
    let waitingLabel = `WAITING FOR ${oppName.toUpperCase()}`;

    const timerContext = { code, role: myRole, round };

    const setWaitingMode = (active) => {
      waitingMode = active;
      if (active) {
        waitingMessage.textContent = waitingLabel;
      }
      setStepsVisible(!active);
      content.classList.toggle("is-hidden", active);
      setMarkingVisible(!active);
      waitingMessage.classList.toggle("is-hidden", !active);
      submitBtn.classList.toggle("is-hidden", active);
      if (active) {
        setVerdictsEnabled(false);
      } else {
        setVerdictsEnabled(!published && !submitting);
      }
      renderSteps();
    };

    const setLoadingState = (text) => {
      pauseRoundTimer(timerContext);
      waitingMode = false;
      waitingMessage.classList.add("is-hidden");
      submitBtn.classList.remove("is-hidden");
      setStepsVisible(true);
      content.classList.remove("is-hidden");
      setPrompt(text, { status: true });
      setMarkingVisible(false);
      setVerdictsEnabled(false);
      renderSteps();
      updateSubmitState();
    };

    setLoadingState("Preparing responses…");

    const rdSnap = await getDoc(rdRef);
    const rdData = rdSnap.data() || {};
    const oppItems = (oppRole === "host" ? rdData.hostItems : rdData.guestItems) || [];
    const oppAnswers = (((roomData0.answers || {})[oppRole] || {})[round] || []).map((a) => a?.chosen || "");
    triplet = [0, 1, 2].map((i) => oppItems[i] || {});
    answers = [0, 1, 2].map((i) => oppAnswers[i] || "");

    marks = new Array(3).fill(null);
    const existingMarks = (((roomData0.marking || {})[myRole] || {})[round] || []);
    for (let i = 0; i < Math.min(existingMarks.length, marks.length); i += 1) {
      const entry = existingMarks[i];
      if (entry !== null && entry !== undefined) marks[i] = markValue(entry);
    }

    answerLabel.textContent = `${oppName.toUpperCase()}’S ANSWER`;

    const alreadyAck = Boolean(((roomData0.markingAck || {})[myRole] || {})[round]);
    if (alreadyAck && marks.every((value) => value !== null)) {
      published = true;
      submitBtn.disabled = true;
      submitBtn.textContent = waitingLabel;
      setWaitingMode(true);
      clearRoundTimer(timerContext);
    } else {
      showMark(0, { animate: false });
      updateSubmitState();
    }

    renderSteps();
    reflectVerdicts();
    updateSubmitState();

    const showBackConfirm = () => {
      backOverlay.classList.add("is-visible");
      try { backYes.focus(); } catch {}
    };

    const hideBackConfirm = () => {
      backOverlay.classList.remove("is-visible");
    };

    const handleHashChange = () => {
      if (!alive) return;
      if (guardAllowNavigation) return;
      if (guardReverting) return;
      guardReverting = true;
      try { location.hash = lockedHash; } catch {}
      guardReverting = false;
      showBackConfirm();
    };

    window.addEventListener("hashchange", handleHashChange);

    backNo.addEventListener("click", () => {
      hideBackConfirm();
      guardAllowNavigation = false;
    });

    backYes.addEventListener("click", () => {
      guardAllowNavigation = true;
      hideBackConfirm();
      pauseRoundTimer(timerContext);
      location.hash = "#/lobby";
    });

    const goTo = (hash) => {
      guardAllowNavigation = true;
      pauseRoundTimer(timerContext);
      location.hash = hash;
    };

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

    const submitMarks = async () => {
      if (published || submitting) return;
      if (!marks.every((value) => value !== null)) return;
      submitting = true;
      updateSubmitState();
      submitBtn.textContent = "SUBMITTING…";
      clearAdvanceTimer();
      setVerdictsEnabled(false);
      pauseRoundTimer(timerContext);
      const totalSecondsRaw = getRoundTimerTotal(timerContext) / 1000;
      const totalSeconds = Math.max(0, Math.round(totalSecondsRaw * 100) / 100);
      const payload = marks.map((value) => markValue(value));

      const patch = {
        [`marking.${myRole}.${round}`]: payload,
        [`markingAck.${myRole}.${round}`]: true,
        [`timings.${myRole}.${round}`]: { totalSeconds },
        "timestamps.updatedAt": serverTimestamp(),
      };

      try {
        await updateDoc(rRef, patch);
        published = true;
        submitting = false;
        submitBtn.disabled = true;
        submitBtn.textContent = waitingLabel;
        setWaitingMode(true);
        reflectVerdicts();
        clearRoundTimer(timerContext);
      } catch (err) {
        console.warn("[marking] submit failed:", err);
        submitting = false;
        updateSubmitState();
        setVerdictsEnabled(true);
        resumeRoundTimer(timerContext);
      }
    };

    const handleVerdict = (value) => {
      if (published || submitting) return;
      const normalized = markValue(value);
      marks[idx] = normalized;
      btnRight.classList.toggle("is-selected", normalized === VERDICT.RIGHT);
      btnWrong.classList.toggle("is-selected", normalized === VERDICT.WRONG);
      btnUnknown.classList.toggle("is-selected", normalized === VERDICT.UNKNOWN);
      btnRight.setAttribute("aria-pressed", normalized === VERDICT.RIGHT ? "true" : "false");
      btnWrong.setAttribute("aria-pressed", normalized === VERDICT.WRONG ? "true" : "false");
      btnUnknown.setAttribute("aria-pressed", normalized === VERDICT.UNKNOWN ? "true" : "false");
      reflectVerdicts();
      updateSubmitState();
      scheduleAdvance(idx);
    };

    btnRight.addEventListener("click", () => handleVerdict(VERDICT.RIGHT));
    btnWrong.addEventListener("click", () => handleVerdict(VERDICT.WRONG));
    btnUnknown.addEventListener("click", () => handleVerdict(VERDICT.UNKNOWN));

    stepButtons.forEach((btn, i) => {
      btn.addEventListener("click", () => {
        if (triplet.length === 0) return;
        clearAdvanceTimer();
        showMark(i, { animate: true });
        reflectVerdicts();
        updateSubmitState();
      });
    });

    submitBtn.addEventListener("click", submitMarks);

    const unsubscribeRoom = onSnapshot(rRef, (snap) => {
      const data = snap.data() || {};
      const stateName = (data.state || "").toLowerCase();

      if (Number.isFinite(Number(data.round))) {
        const nextRound = Number(data.round);
        if (nextRound !== round) {
          round = nextRound;
          timerContext.round = round;
          renderSteps();
        }
      }

      if (stateName === "countdown") {
        goTo(`#/countdown?code=${code}&round=${data.round || round}`);
        return;
      }

      if (stateName === "questions") {
        goTo(`#/questions?code=${code}&round=${data.round || round}`);
        return;
      }

      if (stateName === "award") {
        goTo(`#/award?code=${code}&round=${data.round || round}`);
        return;
      }

      if (stateName === "maths") {
        goTo(`#/maths?code=${code}`);
        return;
      }

      const markingAck = data.markingAck || {};
      const ackMine = Boolean(((markingAck[myRole] || {})[round]));
      const ackOpp = Boolean(((markingAck[oppRole] || {})[round]));

      if (ackMine && !published) {
        const incoming = (((data.marking || {})[myRole] || {})[round] || marks);
        marks = marks.map((_, i) => markValue(incoming[i]));
        published = true;
        submitting = false;
        reflectVerdicts();
        updateSubmitState();
        submitBtn.disabled = true;
        submitBtn.textContent = waitingLabel;
        setWaitingMode(true);
        clearRoundTimer(timerContext);
      }

      if (myRole === "host" && stateName === "marking" && ackMine && ackOpp) {
        finalizeRound();
      }
    }, (err) => {
      console.warn("[marking] room snapshot error:", err);
    });

    stopRoomWatch = unsubscribeRoom;

    this.unmount = () => {
      alive = false;
      clearAdvanceTimer();
      clearSwapTimer();
      try { stopRoomWatch && stopRoomWatch(); } catch {}
      pauseRoundTimer(timerContext);
      window.removeEventListener("hashchange", handleHashChange);
    };
  },

  async unmount() { /* handled in mount */ },
};
