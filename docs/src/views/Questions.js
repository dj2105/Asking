// /src/views/Questions.js
//
// Questions phase — floating award-style card with stepped navigation.
// • Shows player’s three questions one at a time inside a centred panel.
// • Selecting an option holds the highlight for 0.5s, then auto-advances to the next unanswered question.
// • Once all three are answered the Submit button activates (styled like Award continue button).
// • Submission writes answers.{role}.{round} = [{ chosen }, …] and timestamps.updatedAt.
// • Back navigation is guarded; attempting to leave prompts a Return to Lobby confirmation.

import { ensureAuth, db } from "../lib/firebase.js";
import {
  doc,
  collection,
  getDoc,
  updateDoc,
  onSnapshot,
  serverTimestamp,
} from "firebase/firestore";

import { resumeRoundTimer, pauseRoundTimer } from "../lib/RoundTimer.js";
import { clampCode, getHashParams, getStoredRole, timeUntil } from "../lib/util.js";
import {
  BOT_ACTION_DELAY_MS,
  ensureBotGuestAnswers,
  getBotSectionStartFromData,
  hasBot,
} from "../lib/SinglePlayerBot.js";
import { applyStageTheme } from "../lib/theme.js";
import "../../styles/questions-retro.css";

const roundTier = (r) => (r <= 1 ? "easy" : r === 2 ? "medium" : "hard");

const DEFAULT_HEADING = "QUESTIONS";
const JEMIMA_HEADING = "WHICH YEAR...?";
const MARKING_READY_GRACE_MS = 10_000;

function balanceQuestionText(input = "") {
  const raw = String(input || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  const words = raw.split(" ");
  if (words.length < 4) return raw;
  const firstCount = Math.ceil(words.length / 2);
  const secondCount = words.length - firstCount;
  if (secondCount <= 1) return raw;
  const firstLine = words.slice(0, firstCount).join(" ");
  const secondLine = words.slice(firstCount).join(" ");
  if (!secondLine || secondLine.split(" ").length <= 1) return raw;
  return `${firstLine}\n${secondLine}`;
}

const normaliseClue = (value) => {
  if (typeof value === "string") return value.trim();
  return "";
};

const resolveClue = (roomData = {}, fallbackMaths = {}, round = 1) => {
  const roundNumber = Number(round) || 1;
  const arrIndex = roundNumber - 1;
  if (roomData && typeof roomData === "object") {
    const direct = normaliseClue(roomData.clues?.[roundNumber]);
    if (direct) return direct;
    if (Array.isArray(roomData.maths?.events) && arrIndex >= 0) {
      const eventPrompt = normaliseClue(roomData.maths.events[arrIndex]?.prompt);
      if (eventPrompt) return eventPrompt;
    }
    if (Array.isArray(roomData.maths?.clues) && arrIndex >= 0) {
      const mathsClue = normaliseClue(roomData.maths.clues[arrIndex]);
      if (mathsClue) return mathsClue;
    }
  }
  if (fallbackMaths && typeof fallbackMaths === "object" && arrIndex >= 0) {
    if (Array.isArray(fallbackMaths.events)) {
      const eventPrompt = normaliseClue(fallbackMaths.events[arrIndex]?.prompt);
      if (eventPrompt) return eventPrompt;
    }
    if (Array.isArray(fallbackMaths.clues)) {
      const fallback = normaliseClue(fallbackMaths.clues[arrIndex]);
      if (fallback) return fallback;
    }
  }
  return "";
};

const FALLBACK_ITEMS = [
  {
    question: "In the sentence “She sang happily”, which part of speech is “happily”?",
    correct: "Adverb",
    wrong: "Gerund",
  },
  {
    question: "Which planet is nicknamed the Red Planet?",
    correct: "Mars",
    wrong: "Jupiter",
  },
  {
    question: "What is the value of 9 × 7?",
    correct: "63",
    wrong: "56",
  },
];

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

function shuffle2(a, b) {
  return Math.random() < 0.5 ? [a, b] : [b, a];
}

const roomRef = (code) => doc(db, "rooms", code);
const roundSubColRef = (code) => collection(roomRef(code), "rounds");

export default {
  async mount(container) {
    const me = await ensureAuth();

    const params = getHashParams();
    const code = clampCode(params.get("code") || "");
    const requestedRound = parseInt(params.get("round") || "", 10);
    let round = Number.isFinite(requestedRound) && requestedRound > 0 ? requestedRound : null;

    applyStageTheme("questions", round || 1);

    container.innerHTML = "";

    try {
      window.scrollTo({ top: 0, behavior: "instant" });
    } catch {}

    const root = el("div", { class: "view view-questions stage-center" });
    const panel = el("div", { class: "round-panel" });
    const heading = el("h2", { class: "round-panel__heading mono" }, DEFAULT_HEADING);

    const steps = el("div", { class: "round-panel__steps" });
    const stepButtons = [0, 1, 2].map((i) => {
      const btn = el(
        "button",
        {
          class: "round-panel__step mono",
          type: "button",
          "aria-label": `Question ${i + 1}`,
        },
        String(i + 1)
      );
      steps.appendChild(btn);
      return btn;
    });

    const content = el("div", { class: "round-panel__content" });
    const promptText = el("span", { class: "round-panel__question-text" }, "");
    const prompt = el("div", { class: "round-panel__question mono" }, [
      promptText,
      el("span", { class: "typing-dots", "aria-hidden": "true" }, [
        el("span", { class: "typing-dots__dot" }, ""),
        el("span", { class: "typing-dots__dot" }, ""),
        el("span", { class: "typing-dots__dot" }, ""),
      ]),
    ]);
    const statusNote = el(
      "div",
      { class: "round-panel__status-note mono is-hidden" },
      ""
    );
    const choicesWrap = el("div", { class: "round-panel__choices" });
    const choiceButtons = [0, 1].map(() => {
      const btn = el(
        "button",
        { class: "round-panel__choice mono", type: "button" },
        ""
      );
      choicesWrap.appendChild(btn);
      return btn;
    });

    content.appendChild(prompt);
    content.appendChild(statusNote);
    content.appendChild(choicesWrap);

    const readyBtn = el(
      "button",
      {
        class: "btn round-panel__submit mono btn-ready",
        type: "button",
      },
      "SUBMIT"
    );
    readyBtn.style.display = "none";

    const toMarkingBtn = el(
      "button",
      {
        class: "btn round-panel__submit mono btn-ready round-panel__nav",
        type: "button",
      },
      "GO TO MARKING"
    );
    toMarkingBtn.style.display = "none";

    panel.appendChild(heading);
    panel.appendChild(steps);
    panel.appendChild(content);
    panel.appendChild(readyBtn);
    panel.appendChild(toMarkingBtn);
    root.appendChild(panel);

    const markingCountdownOverlay = el("div", { class: "marking-countdown-overlay is-hidden" });
    const markingCountdownValue = el("div", { class: "mono countdown-big" }, "3");
    markingCountdownOverlay.appendChild(markingCountdownValue);
    root.appendChild(markingCountdownOverlay);

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

    const setPrompt = (text, { status = false, variant = "question", showDots = false } = {}) => {
      const displayText = status ? String(text || "") : balanceQuestionText(text);
      promptText.textContent = displayText;
      const isClue = !status && variant === "clue";
      prompt.classList.toggle("round-panel__question--status", status);
      prompt.classList.toggle("round-panel__question--clue", isClue);
      content.classList.toggle("round-panel__content--status", status);
      content.classList.toggle("round-panel__content--comment", isClue);
      prompt.classList.toggle("has-typing-dots", Boolean(showDots));
      const dots = prompt.querySelector(".typing-dots");
      if (dots) dots.style.display = showDots ? "inline-flex" : "none";
    };

    const showStatusNote = (text) => {
      statusNote.textContent = text || "";
      statusNote.classList.remove("is-hidden");
    };

    const hideStatusNote = () => {
      statusNote.textContent = "";
      if (!statusNote.classList.contains("is-hidden")) {
        statusNote.classList.add("is-hidden");
      }
    };

    const setHeading = (value = DEFAULT_HEADING) => {
      heading.textContent = value;
    };

    const setChoicesVisible = (visible) => {
      choicesWrap.classList.toggle("is-hidden", !visible);
    };

    const setPromptVisible = (visible) => {
      prompt.style.display = visible ? "" : "none";
    };

    const applySubmitReadyLayout = (active, { forceChoicesVisible = null } = {}) => {
      const hideQa = active && !published && !submitting;
      const choicesVisible =
        typeof forceChoicesVisible === "boolean" ? forceChoicesVisible : !hideQa;
      setPromptVisible(!hideQa);
      setChoicesVisible(choicesVisible);
      const hideContent = hideQa && !choicesVisible;
      content.classList.toggle("round-panel__content--submit-ready", hideQa);
      content.style.display = hideContent ? "none" : "";
    };

    let idx = 0;
    const chosen = ["", "", ""];
    let triplet = [];
    let published = false;
    let submitting = false;
    let readyPreviewMode = false;
    let advanceTimer = null;
    let swapTimer = null;
    let stepLabelsLocked = false;
    let stepLabelTimer = null;
    let showingClue = false;
    let fallbackMaths = {};
    let latestRoomData = {};
    let timerStarted = false;
    let submittedAlready = false;
    let oppSubmitted = false;
    let myMarkingReady = false;
    let oppMarkingReady = false;
    let goToMarkingClicked = false;
    let markingCountdownStartAt = null;
    let countdownTimer = null;
    let markingFlipInFlight = false;
    let bothMarkingReadySince = null;
    let fallbackTriggeredAt = null;
    let mathsClueVisible = false;
    let submissionRank = null;
    let submittedScreen = null;
    let botQuestionsStartAt = null;
    let goToMarkingUnlocked = false;
    let waitingForOpponentAfterClick = false;

    const effectiveRound = () => {
      return Number.isFinite(round) && round > 0 ? round : 1;
    };

    const questionOffset = () => (effectiveRound() - 1) * 3;

    const optionLetter = (index) => String.fromCharCode(65 + index);

    const resolveAnswerLetter = (questionIndex) => {
      const selection = chosen[questionIndex] || "";
      if (!selection) return "";
      const entry = triplet[questionIndex] || {};
      const options = Array.isArray(entry.options) ? entry.options : [];
      const idxFound = options.findIndex((opt) => opt === selection);
      if (idxFound < 0) return "";
      return optionLetter(idxFound);
    };

    const refreshStepLabels = () => {
      const base = questionOffset();
      stepButtons.forEach((btn, i) => {
        const number = base + i + 1;
        const letter = resolveAnswerLetter(i);
        const labelText = letter || String(number);
        btn.textContent = labelText;
        const aria = letter
          ? `Question ${number} answered option ${letter}`
          : `Question ${number}`;
        btn.setAttribute("aria-label", aria);
      });
    };

    let stopWatcher = null;
    let alive = true;
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

    const clearStepLabelTimer = () => {
      if (stepLabelTimer) {
        clearTimeout(stepLabelTimer);
        stepLabelTimer = null;
      }
    };

    const applyStepLabels = () => {
      if (!stepLabelsLocked) {
        refreshStepLabels();
      }
    };

    const lockStepLabels = (ms) => {
      clearStepLabelTimer();
      if (ms && ms > 0) {
        stepLabelsLocked = true;
        stepLabelTimer = setTimeout(() => {
          stepLabelTimer = null;
          stepLabelsLocked = false;
          refreshStepLabels();
        }, ms);
      } else {
        stepLabelsLocked = false;
        refreshStepLabels();
      }
    };

    const unlockStepLabels = () => {
      lockStepLabels(0);
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

    const renderSteps = () => {
      applyStepLabels();
      const inSubmitReady = readyPreviewMode && !published && !submitting;
      steps.classList.toggle("is-hidden", published || submitting);
      steps.classList.toggle("is-complete", isRoundComplete());
      const dormant = published || submitting;
      steps.classList.toggle("is-dormant", dormant);
      steps.classList.toggle("is-submit-ready", inSubmitReady);
      const allowActive = !(published || submitting || showingClue || readyPreviewMode);
      const allowAnswered = !readyPreviewMode;
      stepButtons.forEach((btn, i) => {
        const isActive = allowActive && i === idx && !inSubmitReady;
        btn.classList.toggle("is-active", isActive);
        btn.classList.toggle("is-answered", allowAnswered && Boolean(chosen[i]));
        btn.disabled = triplet.length === 0 || published || submitting;
      });
    };

    const renderChoices = () => {
      const current = triplet[idx] || {};
      const currentSelection = chosen[idx] || "";
      const inReadyPreview = readyPreviewMode && !published && !submitting;
      choiceButtons.forEach((btn, i) => {
        const option = current.options?.[i] || "";
        btn.textContent = option;
        const isSelected = option && currentSelection === option && !inReadyPreview;
        btn.classList.toggle("is-selected", isSelected);
        btn.classList.toggle("is-ready-preview", inReadyPreview);
        if (!isSelected) {
          btn.classList.remove("is-blinking");
          btn.classList.remove("is-blinking-fast");
        }
        btn.disabled = !option || published || submitting;
      });
    };

    const isRoundComplete = () => triplet.length > 0 && chosen.every((value) => Boolean(value));

    const hideReadyPrompt = () => {
      showingClue = false;
      readyPreviewMode = false;
      panel.classList.remove("round-panel--ready-preview");
      content.classList.remove("round-panel__content--ready-preview");
      readyBtn.style.display = "none";
      readyBtn.disabled = false;
      readyBtn.textContent = "SUBMIT";
      readyBtn.classList.remove("round-panel__submit--ready");
      readyBtn.classList.remove("round-panel__submit--waiting");
      if (!readyBtn.classList.contains("btn-ready")) {
        readyBtn.classList.add("btn-ready");
      }
      readyBtn.classList.remove("throb");
      hideStatusNote();
      setHeading(DEFAULT_HEADING);
      heading.style.display = "";
      applySubmitReadyLayout(false);
    };

    const getClueText = () => {
      const text = resolveClue(latestRoomData, fallbackMaths, effectiveRound());
      return text || "Jemima’s clue is on its way…";
    };

    const showReadyPrompt = ({ animate = true } = {}) => {
      if (published || submitting) return;
      showingClue = false;
      readyPreviewMode = true;
      panel.classList.add("round-panel--ready-preview");
      content.classList.add("round-panel__content--ready-preview");
      const render = () => {
        setHeading(DEFAULT_HEADING);
        setPrompt("", { status: false });
        setChoicesVisible(true);
        hideStatusNote();
        applySubmitReadyLayout(true, { forceChoicesVisible: true });
        readyBtn.style.display = "";
        readyBtn.disabled = false;
        readyBtn.textContent = "SUBMIT";
        readyBtn.classList.add("btn-ready");
        readyBtn.classList.add("round-panel__submit--ready");
        readyBtn.classList.remove("round-panel__submit--waiting");
        readyBtn.classList.add("throb");
      };
      if (animate) animateSwap(render);
      else render();
      renderSteps();
    };

    const clearCountdownTimer = () => {
      if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
      }
    };

    const attemptMarkingFlip = async (reason = "tick") => {
      if (!markingCountdownStartAt) return;
      if (myRole !== "host") return;
      const ms = timeUntil(markingCountdownStartAt);
      if (ms > 0) return;
      if (markingFlipInFlight) return;
      markingFlipInFlight = true;
      console.debug(
        "[questions] attempting marking flip (%s) — round=%s startAt=%s",
        reason,
        round,
        markingCountdownStartAt
      );
      try {
        await updateDoc(rRef, {
          state: "marking",
          "markingCountdown.startAt": null,
          "markingCountdown.round": null,
          "timestamps.updatedAt": serverTimestamp(),
        });
        console.debug("[questions] marking flip succeeded (round %s)", round);
      } catch (err) {
        console.warn("[questions] failed to flip to marking (%s):", reason, err);
      } finally {
        markingFlipInFlight = false;
      }
    };

    const renderMarkingCountdown = () => {
      if (!markingCountdownStartAt) return;
      const ms = timeUntil(markingCountdownStartAt);
      const secs = Math.max(0, Math.ceil(ms / 1000));
      hideStatusNote();
      markingCountdownValue.textContent = String(secs);
      markingCountdownOverlay.classList.remove("is-hidden");
      toMarkingBtn.style.display = "none";
      if (myRole === "host" && ms <= 0) {
        attemptMarkingFlip("countdown-tick");
      }
    };

    const hideMarkingCountdown = () => {
      markingCountdownOverlay.classList.add("is-hidden");
    };

    const applySubmittedFrame = () => {
      published = true;
      showingClue = false;
      readyPreviewMode = false;
      panel.classList.remove("round-panel--ready-preview");
      content.classList.remove("round-panel__content--ready-preview");
      heading.style.display = "";
      steps.classList.add("is-hidden");
      setPromptVisible(true);
      content.classList.remove("round-panel__content--submit-ready");
      panel.classList.remove("round-panel--submit-ready");
      panel.classList.remove("round-panel--maths-clue");
      setChoicesVisible(false);
      readyBtn.style.display = "none";
      pauseRoundTimer(timerContext);
      hideMarkingCountdown();
    };

    const renderFirstSubmitButton = () => {
      if (submittedScreen !== "first") return;
      if (markingCountdownStartAt) {
        renderMarkingCountdown();
        return;
      }
      const waitingForOpponent = !oppSubmitted;
      const awaitingMarkingStart = myMarkingReady || goToMarkingClicked;
      if (waitingForOpponentAfterClick && !waitingForOpponent) {
        waitingForOpponentAfterClick = false;
      }
      toMarkingBtn.style.display = "";
      if (awaitingMarkingStart) {
        goToMarkingUnlocked = false;
        toMarkingBtn.disabled = true;
        toMarkingBtn.textContent = waitingLabel;
        toMarkingBtn.classList.add("round-panel__submit--waiting");
        toMarkingBtn.classList.remove("round-panel__submit--ready");
        toMarkingBtn.classList.remove("throb");
        return;
      }
      if (waitingForOpponentAfterClick && waitingForOpponent) {
        toMarkingBtn.disabled = true;
        toMarkingBtn.textContent = waitingLabel;
        toMarkingBtn.classList.add("round-panel__submit--waiting");
        toMarkingBtn.classList.remove("round-panel__submit--ready");
        toMarkingBtn.classList.remove("throb");
        return;
      }
      hideStatusNote();
      toMarkingBtn.disabled = false;
      toMarkingBtn.textContent = "GO TO MARKING";
      toMarkingBtn.classList.remove("round-panel__submit--waiting");
      toMarkingBtn.classList.add("round-panel__submit--ready");
      toMarkingBtn.classList.add("throb");
      if (!goToMarkingUnlocked) {
        console.debug("[questions] go-to-marking unlocked");
        goToMarkingUnlocked = true;
      }
    };

    const showFirstSubmissionHold = () => {
      mathsClueVisible = true;
      setSubmissionRank("first", "ui:first-submission");
      if (submittedScreen === "first") {
        renderFirstSubmitButton();
        return;
      }
      submittedScreen = "first";
      applySubmittedFrame();
      panel.classList.add("round-panel--maths-clue");
      setHeading("WHICH YEAR?");
      heading.style.display = "";
      setPrompt(getClueText(), { status: false, variant: "clue" });
      hideStatusNote();
      renderFirstSubmitButton();
    };

    const showSecondSubmissionWaiting = () => {
      mathsClueVisible = false;
      setSubmissionRank("second", "ui:second-submission");
      submittedScreen = "second";
      applySubmittedFrame();
      panel.classList.remove("round-panel--maths-clue");
      heading.style.display = "none";
      setPrompt(`Waiting for ${oppName}.`, { status: true, showDots: true });
      hideStatusNote();
      toMarkingBtn.style.display = "none";
    };

    const showQuestion = (targetIdx, { animate = true } = {}) => {
      if (triplet.length === 0) return;
      if (targetIdx < 0) targetIdx = 0;
      if (targetIdx >= triplet.length) targetIdx = triplet.length - 1;
      idx = targetIdx;
      hideReadyPrompt();
      const render = () => {
        const current = triplet[idx] || {};
        setHeading(DEFAULT_HEADING);
        setPrompt(current.question || "", { status: false, variant: "question" });
        setChoicesVisible(true);
        hideStatusNote();
        applySubmitReadyLayout(false, { forceChoicesVisible: true });
        choiceButtons.forEach((btn) => {
          btn.classList.remove("is-blinking");
          btn.classList.remove("is-blinking-fast");
        });
        renderChoices();
        renderSteps();
      };
      if (animate) animateSwap(render);
      else render();
      if (!published && !submitting) resumeRoundTimer(timerContext);
    };

    const findNextUnanswered = (fromIndex) => {
      for (let i = fromIndex + 1; i < triplet.length; i += 1) {
        if (!chosen[i]) return i;
      }
      for (let i = 0; i < triplet.length; i += 1) {
        if (!chosen[i]) return i;
      }
      return null;
    };

    const scheduleAdvance = (currentIndex) => {
      clearAdvanceTimer();
      advanceTimer = setTimeout(() => {
        advanceTimer = null;
        if (!alive || submitting || published) return;
        const next = findNextUnanswered(currentIndex);
        if (next !== null && next !== undefined) {
          showQuestion(next, { animate: true });
        } else if (isRoundComplete()) {
          showReadyPrompt({ animate: true });
        } else if (triplet.length > 0) {
          showQuestion(triplet.length - 1, { animate: true });
        }
      }, 420);
    };

    const rRef = roomRef(code);

    const roomSnap0 = await getDoc(rRef);
    const room0 = roomSnap0.data() || {};
    latestRoomData = room0;
    fallbackMaths = room0.maths || {};
    botQuestionsStartAt = getBotSectionStartFromData(room0, "questions", round) || botQuestionsStartAt;
    if (!round) {
      const roomRound = Number(room0.round);
      round = Number.isFinite(roomRound) && roomRound > 0 ? roomRound : 1;
    }

    applyStageTheme("questions", effectiveRound());

    renderSteps();

    const rdRef = doc(roundSubColRef(code), String(round));
    const { hostUid, guestUid } = room0.meta || {};
    const storedRole = getStoredRole(code);
    const myRole = storedRole === "host" || storedRole === "guest"
      ? storedRole
      : hostUid === me.uid ? "host" : guestUid === me.uid ? "guest" : "guest";
    const oppRole = myRole === "host" ? "guest" : "host";
    const oppName = oppRole === "host" ? "Daniel" : "Jaime";
    const waitingLabel = `WAITING FOR ${oppName.toUpperCase()}`;

    const timerContext = { code, role: myRole, round };

    const startRoundTimer = () => {
      if (timerStarted) return;
      resumeRoundTimer(timerContext);
      timerStarted = true;
    };

    const getBotDueAt = () => {
      if (!hasBot(latestRoomData)) return null;
      const startFromData = getBotSectionStartFromData(latestRoomData, "questions", round);
      if (startFromData && !botQuestionsStartAt) botQuestionsStartAt = startFromData;
      const start = botQuestionsStartAt || startFromData;
      if (!start) return null;
      return start + BOT_ACTION_DELAY_MS;
    };

    const isBotPastCutoff = () => {
      const dueAt = getBotDueAt();
      if (!dueAt) return false;
      return Date.now() >= dueAt;
    };

    const setSubmissionRank = (rank, reason = "") => {
      if (!rank) return null;
      if (submissionRank !== rank) {
        const suffix = reason ? ` via ${reason}` : "";
        console.debug(`[questions] submission rank decided: ${rank}${suffix}`);
      }
      submissionRank = rank;
      return submissionRank;
    };

    const inferSubmissionRank = (reason = "snapshot") => {
      if (!submittedAlready) return null;
      if (!oppSubmitted) {
        if (isBotPastCutoff()) return setSubmissionRank("second", reason);
        return setSubmissionRank("first", reason);
      }
      if (submissionRank) return submissionRank;
      if (!myMarkingReady && oppMarkingReady) return setSubmissionRank("first", reason);
      if (myMarkingReady && !oppMarkingReady) return setSubmissionRank("second", reason);
      if (!myMarkingReady && !oppMarkingReady) return setSubmissionRank("first", reason);
      return setSubmissionRank("second", reason);
    };

    const renderMarkingButton = () => {
      if (submittedScreen === "first") {
        renderFirstSubmitButton();
        return;
      }
      toMarkingBtn.style.display = "none";
    };

    const setLoadingState = (text) => {
      hideReadyPrompt();
      startRoundTimer();
      setHeading(DEFAULT_HEADING);
      setPrompt(text, { status: true, showDots: true });
      hideStatusNote();
      applySubmitReadyLayout(false, { forceChoicesVisible: false });
      setChoicesVisible(false);
      renderSteps();
    };

    const existingAns = (((room0.answers || {})[myRole] || {})[round] || []);

    const waitForRoundData = async () => {
      let attempts = 0;
      const MAX_ATTEMPTS = 8;
      while (alive) {
        attempts += 1;
        try {
          const snap = await getDoc(rdRef);
          if (snap.exists()) return snap.data() || {};
        } catch (err) {
          console.warn("[questions] failed to load round doc:", err);
        }
        if (attempts >= MAX_ATTEMPTS) break;
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      return {};
    };

    setLoadingState("Preparing questions…");
    const rd = await waitForRoundData();
    if (!alive) return;

    if (myRole === "host") {
      const startAt = await ensureBotGuestAnswers({ code, round, roomData: latestRoomData, roundData: rd });
      if (startAt) botQuestionsStartAt = startAt;
    }

    const myItems = (myRole === "host" ? rd.hostItems : rd.guestItems) || [];
    triplet = [0, 1, 2].map((i) => {
      const it = myItems[i] || {};
      const fallback = FALLBACK_ITEMS[i % FALLBACK_ITEMS.length];
      const rawQuestion = typeof it.question === "string" ? it.question.trim() : "";
      const rawCorrect = typeof it.correct_answer === "string" ? it.correct_answer.trim() : "";
      const distractors = it.distractors || {};
      const rawWrong = [
        distractors[roundTier(round)],
        distractors.medium,
        distractors.easy,
        distractors.hard,
      ].find((opt) => typeof opt === "string" && opt.trim()) || "";

      const hasFullSet = rawQuestion && rawCorrect && rawWrong;
      const question = hasFullSet ? rawQuestion : fallback.question;
      const correct = hasFullSet ? rawCorrect : fallback.correct;
      const wrong = hasFullSet ? rawWrong : fallback.wrong;
      const [optA, optB] = shuffle2(correct, wrong);
      return { question, options: [optA, optB], correct };
    });

    submittedAlready = Boolean(((room0.submitted || {})[myRole] || {})[round]);
    oppSubmitted = Boolean(((room0.submitted || {})[oppRole] || {})[round]);
    myMarkingReady = Boolean(((room0.markingReady || {})[myRole] || {})[round]);
    oppMarkingReady = Boolean(((room0.markingReady || {})[oppRole] || {})[round]);
    if (myMarkingReady) {
      goToMarkingClicked = true;
    }
    if (existingAns.length) {
      for (let i = 0; i < Math.min(existingAns.length, chosen.length); i += 1) {
        const entry = existingAns[i] || {};
        if (entry.chosen) chosen[i] = entry.chosen;
      }
    }

    const prefilledComplete = isRoundComplete();

    if (!submittedAlready) {
      startRoundTimer();
    }

    const initialSubmissionRank = inferSubmissionRank("initial-state");

    if (submittedAlready) {
      if (initialSubmissionRank === "first") {
        showFirstSubmissionHold();
      } else if (initialSubmissionRank === "second") {
        if (!myMarkingReady) {
          await signalMarkingReady({ silent: true });
        }
        showSecondSubmissionWaiting();
      }
    } else if (triplet.every((entry) => entry.question && entry.options?.length === 2)) {
      if (prefilledComplete) {
        showReadyPrompt({ animate: false });
      } else {
        const firstIncomplete = chosen.findIndex((value) => !value);
        const startIdx = firstIncomplete === -1 ? 0 : firstIncomplete;
        showQuestion(startIdx, { animate: false });
      }
    } else {
      setLoadingState("Preparing questions…");
    }

    unlockStepLabels();
    renderSteps();
    renderChoices();

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
      try {
        location.hash = lockedHash;
      } catch {}
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

    choiceButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        if (triplet.length === 0) return;
        if (published || submitting) return;
        const text = btn.textContent || "";
        const currentIndex = idx;
        if (!text) return;
        const alreadySelected = chosen[currentIndex] === text;
        if (alreadySelected) {
          chosen[currentIndex] = "";
          btn.classList.remove("is-blinking");
          btn.classList.remove("is-blinking-fast");
          unlockStepLabels();
          renderChoices();
          renderSteps();
          return;
        }
        chosen[currentIndex] = text;
        choiceButtons.forEach((choiceBtn) => {
          choiceBtn.classList.toggle("is-selected", choiceBtn === btn);
          if (choiceBtn !== btn) {
            choiceBtn.classList.remove("is-blinking");
            choiceBtn.classList.remove("is-blinking-fast");
          }
        });
        btn.classList.add("is-blinking");
        btn.classList.add("is-blinking-fast");
        const flashDuration = 260;
        lockStepLabels(flashDuration);
        setTimeout(() => {
          btn.classList.remove("is-blinking");
          btn.classList.remove("is-blinking-fast");
        }, flashDuration);
        renderChoices();
        renderSteps();
        scheduleAdvance(currentIndex);
      });
    });

    stepButtons.forEach((btn, i) => {
      btn.addEventListener("click", () => {
        if (triplet.length === 0) return;
        if (published || submitting) return;
        clearAdvanceTimer();
        showQuestion(i, { animate: true });
        renderChoices();
        renderSteps();
      });
    });

    const signalMarkingReady = async ({ silent = false } = {}) => {
      if (myMarkingReady || goToMarkingClicked) return true;
      goToMarkingClicked = true;
      if (!silent) {
        toMarkingBtn.disabled = true;
        toMarkingBtn.classList.remove("throb");
      }
      try {
        console.debug(
          "[questions] signalling marking ready (silent=%s) — round=%s",
          silent,
          round
        );
        await updateDoc(rRef, {
          [`markingReady.${myRole}.${round}`]: true,
          "timestamps.updatedAt": serverTimestamp(),
        });
        myMarkingReady = true;
        return true;
      } catch (err) {
        console.warn("[questions] failed to signal marking ready:", err);
        goToMarkingClicked = false;
        if (!silent) {
          toMarkingBtn.disabled = false;
        }
        return false;
      }
    };

    const handleGoToMarkingClick = async () => {
      const opponentDone = oppSubmitted;
      if (!opponentDone) {
        waitingForOpponentAfterClick = true;
        toMarkingBtn.disabled = true;
        toMarkingBtn.textContent = waitingLabel;
        toMarkingBtn.classList.add("round-panel__submit--waiting");
        toMarkingBtn.classList.remove("round-panel__submit--ready");
        toMarkingBtn.classList.remove("throb");
      }
      const ok = await signalMarkingReady();
      if (!ok) {
        renderFirstSubmitButton();
        return;
      }
      if (!opponentDone) {
        renderFirstSubmitButton();
        return;
      }
      renderFirstSubmitButton();
    };

    toMarkingBtn.addEventListener("click", handleGoToMarkingClick);

    readyBtn.addEventListener("click", async () => {
        if (published || submitting) return;
        if (!isRoundComplete()) return;
        submitting = true;
        clearAdvanceTimer();
        readyBtn.disabled = true;
        readyBtn.classList.remove("throb");
        renderSteps();
        setPrompt("Submitting answers…", { status: true, showDots: true });
        hideStatusNote();
        setChoicesVisible(false);

        const opponentAlreadySubmitted = oppSubmitted;
        const pastBotCutoff = isBotPastCutoff();
        const payload = triplet.map((entry, i) => ({
          question: entry.question || "",
          chosen: chosen[i] || "",
          correct: entry.correct || "",
        }));

        const patch = {
          [`answers.${myRole}.${round}`]: payload,
          [`submitted.${myRole}.${round}`]: true,
          "timestamps.updatedAt": serverTimestamp(),
        };

        try {
          console.log(`[flow] submit answers | code=${code} round=${round} role=${myRole}`);
          await updateDoc(rRef, patch);
          submitting = false;
          oppSubmitted = Boolean((((latestRoomData.submitted || {})[oppRole] || {})[round]));
          const iAmSecond = opponentAlreadySubmitted || oppSubmitted || pastBotCutoff;
          console.debug(
            "[questions] submit pressed — opponentSubmitted=%s cutoffPassed=%s → %s",
            opponentAlreadySubmitted,
            pastBotCutoff,
            iAmSecond ? "second" : "first"
          );
          setSubmissionRank(iAmSecond ? "second" : "first", "submit");
          if (iAmSecond) {
            await signalMarkingReady({ silent: true });
            showSecondSubmissionWaiting();
          } else {
            showFirstSubmissionHold();
          }
        } catch (err) {
          console.warn("[questions] publish failed:", err);
          submitting = false;
          readyBtn.disabled = false;
          readyBtn.textContent = "SUBMIT";
          resumeRoundTimer(timerContext);
          renderSteps();
          showReadyPrompt({ animate: false });
        }
      });

    const stopWatcherRef = onSnapshot(rRef, async (snap) => {
      const data = snap.data() || {};
      latestRoomData = data;
      botQuestionsStartAt = getBotSectionStartFromData(data, "questions", round) || botQuestionsStartAt;

      const nextRound = Number(data.round) || round;
      if (nextRound !== round) {
        round = nextRound;
        timerContext.round = round;
        unlockStepLabels();
        renderSteps();
        applyStageTheme("questions", effectiveRound());
      }

      if (data.state === "countdown") {
        goTo(`#/countdown?code=${code}&round=${data.round || round}`);
        return;
      }

      if (data.state === "award") {
        goTo(`#/award?code=${code}&round=${round}`);
        return;
      }

      if (data.state === "marking") {
        renderMarkingButton();
        goTo(`#/marking?code=${code}&round=${round}`);
        return;
      }

      const answersForMe = (((data.answers || {})[myRole] || {})[round]) || [];
      const answersForOpp = (((data.answers || {})[oppRole] || {})[round]) || [];
      const myServerDone = Boolean(((data.submitted || {})[myRole] || {})[round]) || (Array.isArray(answersForMe) && answersForMe.length >= 3);
      const oppServerDone = Boolean(((data.submitted || {})[oppRole] || {})[round]) || (Array.isArray(answersForOpp) && answersForOpp.length >= 3);
      oppSubmitted = oppServerDone;
      submittedAlready = myServerDone;

      const markingReadyMap = data.markingReady || {};
      myMarkingReady = Boolean(((markingReadyMap[myRole] || {})[round]));
      oppMarkingReady = Boolean(((markingReadyMap[oppRole] || {})[round]));
      if (myMarkingReady) goToMarkingClicked = true;
      if (myMarkingReady && oppMarkingReady) {
        if (!bothMarkingReadySince) {
          bothMarkingReadySince = Date.now();
          console.debug("[questions] both players ready for marking (round %s)", round);
        }
      } else {
        bothMarkingReadySince = null;
        fallbackTriggeredAt = null;
      }

      const countdownData = data.markingCountdown || {};
      const countdownRound = Number(countdownData.round);
      const incomingCountdown = countdownRound === round ? Number(countdownData.startAt) || null : null;
      if (incomingCountdown && incomingCountdown !== markingCountdownStartAt) {
        markingCountdownStartAt = incomingCountdown;
        renderMarkingCountdown();
        if (!countdownTimer) {
          countdownTimer = setInterval(renderMarkingCountdown, 320);
        }
      } else if (!incomingCountdown && markingCountdownStartAt) {
        markingCountdownStartAt = null;
        clearCountdownTimer();
        hideStatusNote();
        hideMarkingCountdown();
      }

      const inferredRank = inferSubmissionRank("snapshot");
      if (inferredRank) submissionRank = inferredRank;

      if (myServerDone && !published) {
        if (inferredRank === "first") {
          showFirstSubmissionHold();
        } else if (inferredRank === "second") {
          if (!myMarkingReady) {
            await signalMarkingReady({ silent: true });
          }
          showSecondSubmissionWaiting();
        }
      } else if (!myServerDone && showingClue && !submitting) {
        showReadyPrompt({ animate: false });
      }

      if (published && alive) {
        renderMarkingButton();
      }

      if (myRole === "host" && data.state === "questions") {
        if (myMarkingReady && oppMarkingReady && !incomingCountdown) {
          console.debug(
            "[questions] host arming marking countdown — my=%s opp=%s incoming=%s round=%s",
            myMarkingReady,
            oppMarkingReady,
            incomingCountdown,
            round
          );
          try {
            const startAt = Date.now() + 3000;
            markingCountdownStartAt = startAt;
            renderMarkingCountdown();
            if (!countdownTimer) {
              countdownTimer = setInterval(renderMarkingCountdown, 320);
            }
            await updateDoc(rRef, {
              "markingCountdown.startAt": startAt,
              "markingCountdown.round": round,
              "timestamps.updatedAt": serverTimestamp(),
            });
            console.debug("[questions] marking countdown armed for round %s", round);
          } catch (err) {
            console.warn("[questions] failed to arm marking countdown:", err);
          }
        }

        if (markingCountdownStartAt && timeUntil(markingCountdownStartAt) <= 0) {
          await attemptMarkingFlip("snapshot");
        }
      }

      if (bothMarkingReadySince && data.state === "questions") {
        const elapsed = Date.now() - bothMarkingReadySince;
        if (elapsed > MARKING_READY_GRACE_MS) {
          const now = Date.now();
          if (!fallbackTriggeredAt || now - fallbackTriggeredAt > 4000) {
            fallbackTriggeredAt = now;
            if (myRole === "host") {
              console.warn(
                "[questions] forcing marking state after grace period — elapsed=%sms round=%s",
                elapsed,
                round
              );
              try {
                await updateDoc(rRef, {
                  state: "marking",
                  "markingCountdown.startAt": null,
                  "markingCountdown.round": null,
                  "timestamps.updatedAt": serverTimestamp(),
                });
              } catch (err) {
                console.warn("[questions] fallback marking flip failed:", err);
              }
            } else {
              console.warn(
                "[questions] waiting for host to flip to marking — ready for %sms",
                elapsed
              );
            }
          }
        }
      }
    }, (err) => {
      console.warn("[questions] snapshot error:", err);
    });

    stopWatcher = stopWatcherRef;

    this.unmount = () => {
      alive = false;
      clearAdvanceTimer();
      clearSwapTimer();
      clearStepLabelTimer();
      clearCountdownTimer();
      try { stopWatcher && stopWatcher(); } catch {}
      pauseRoundTimer(timerContext);
      window.removeEventListener("hashchange", handleHashChange);
    };
  },

  async unmount() { /* handled in mount */ },
};
