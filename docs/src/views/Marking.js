// /src/views/Marking.js
//
// Marking phase — award-style panel mirroring the Questions layout.
// • Shows opponent’s three questions one at a time with their submitted answer.
// • Three marking buttons (✓ / ? / ✕) sit below the text, neutral until selected.
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
import { ensureBotMarking } from "../lib/SinglePlayerBot.js";

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

function getRoundMapValue(map = {}, roundNumber) {
  if (!map || typeof map !== "object") return undefined;
  if (map[roundNumber] !== undefined) return map[roundNumber];
  const key = String(roundNumber);
  if (map[key] !== undefined) return map[key];
  return undefined;
}

function normaliseTimingEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const totalSeconds = typeof entry.totalSeconds === "number" ? entry.totalSeconds : null;
  if (totalSeconds !== null && !Number.isNaN(totalSeconds)) return totalSeconds;
  const totalMs = typeof entry.totalMs === "number" ? entry.totalMs : null;
  if (totalMs !== null && !Number.isNaN(totalMs)) return totalMs / 1000;
  const total = typeof entry.total === "number" ? entry.total : null;
  if (total !== null && !Number.isNaN(total)) return total;
  return null;
}

const DEFAULT_HEADING = "MARKING";
const JEMIMA_HEADING = "WHICH YEAR...?";

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

function createPaletteApplier(hue, accentHue) {
  return (roundNumber = 1) => {
    const depth = Math.max(0, Math.min((roundNumber || 1) - 1, 5));
    const inkLight = 12 + depth * 1.3;
    const paperLight = 92 - depth * 1.6;
    const accentSoftLight = 88 - depth * 1.0;
    const accentStrongLight = Math.max(22, 26 - depth * 0.6);
    document.documentElement.style.setProperty("--ink-h", String(hue));
    document.documentElement.style.setProperty("--ink-s", "64%");
    document.documentElement.style.setProperty("--ink-l", `${inkLight.toFixed(1)}%`);
    document.documentElement.style.setProperty("--paper-s", "38%");
    document.documentElement.style.setProperty("--paper-l", `${paperLight.toFixed(1)}%`);
    document.documentElement.style.setProperty(
      "--muted",
      `hsla(${hue}, 24%, ${Math.max(inkLight + 16, 32).toFixed(1)}%, 0.78)`
    );
    document.documentElement.style.setProperty(
      "--soft-line",
      `hsla(${hue}, 32%, ${Math.max(inkLight + 6, 26).toFixed(1)}%, 0.22)`
    );
    document.documentElement.style.setProperty(
      "--card",
      `hsla(${hue}, 30%, ${Math.min(paperLight + 3, 96).toFixed(1)}%, 0.96)`
    );
    document.documentElement.style.setProperty(
      "--accent-soft",
      `hsl(${accentHue}, 68%, ${accentSoftLight.toFixed(1)}%)`
    );
    document.documentElement.style.setProperty(
      "--accent-strong",
      `hsl(${accentHue}, 52%, ${accentStrongLight.toFixed(1)}%)`
    );
  };
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
      const viaEvent = normaliseClue(roomData.maths.events[arrIndex]?.prompt);
      if (viaEvent) return viaEvent;
    }
    if (Array.isArray(roomData.maths?.clues) && arrIndex >= 0) {
      const mathsClue = normaliseClue(roomData.maths.clues[arrIndex]);
      if (mathsClue) return mathsClue;
    }
  }
  if (fallbackMaths && typeof fallbackMaths === "object" && arrIndex >= 0) {
    if (Array.isArray(fallbackMaths.events)) {
      const viaEvent = normaliseClue(fallbackMaths.events[arrIndex]?.prompt);
      if (viaEvent) return viaEvent;
    }
    if (Array.isArray(fallbackMaths.clues)) {
      const fallback = normaliseClue(fallbackMaths.clues[arrIndex]);
      if (fallback) return fallback;
    }
  }
  return "";
};

export default {
  async mount(container) {
    const me = await ensureAuth();

    const params = getHashParams();
    const code = clampCode(params.get("code") || "");
    let round = parseInt(params.get("round") || "1", 10) || 1;

    const hue = Math.floor(Math.random() * 360);
    const accentHue = (hue + 180) % 360;
    const applyPalette = createPaletteApplier(hue, accentHue);
    applyPalette(round || 1);

    container.innerHTML = "";

    try {
      window.scrollTo({ top: 0, behavior: "instant" });
    } catch {}

    const root = el("div", { class: "view view-marking stage-center" });
    const panel = el("div", { class: "round-panel" });
    const heading = el("h2", { class: "round-panel__heading mono" }, DEFAULT_HEADING);

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
    const statusNote = el(
      "div",
      { class: "round-panel__status-note mono is-hidden" },
      ""
    );

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
        "aria-label": "Mark correct",
      },
      "✓"
    );
    const btnUnknown = el(
      "button",
      {
        class: "marking-button marking-button--unknown mono",
        type: "button",
        "aria-pressed": "false",
        "aria-label": "Mark unsure",
      },
      "?"
    );
    const btnWrong = el(
      "button",
      {
        class: "marking-button marking-button--cross mono",
        type: "button",
        "aria-pressed": "false",
        "aria-label": "Mark incorrect",
      },
      "✕"
    );
    verdictRow.appendChild(btnRight);
    verdictRow.appendChild(btnUnknown);
    verdictRow.appendChild(btnWrong);

    content.appendChild(prompt);
    content.appendChild(statusNote);
    content.appendChild(answerBox);
    content.appendChild(verdictRow);

    const yearWrap = el("div", { class: "marking-year is-hidden" });
    const yearInput = el("input", {
      class: "marking-year__input mono",
      type: "text",
      inputmode: "numeric",
      pattern: "[0-9]*",
      maxlength: "4",
      placeholder: "",
    });
    const yearSubmit = el(
      "button",
      { class: "btn btn-ready marking-year__submit", type: "button", disabled: "" },
      "SUBMIT"
    );
    yearWrap.appendChild(yearInput);
    yearWrap.appendChild(yearSubmit);
    content.appendChild(yearWrap);

    const readyBtn = el(
      "button",
      {
        class: "btn round-panel__submit mono btn-ready",
        type: "button",
      },
      "SUBMIT"
    );
    readyBtn.style.display = "none";

    panel.appendChild(heading);
    panel.appendChild(steps);
    panel.appendChild(content);
    panel.appendChild(readyBtn);
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

    const setPrompt = (text, { status = false, variant = "question" } = {}) => {
      const displayText = status ? String(text || "") : balanceQuestionText(text);
      prompt.textContent = displayText;
      const isClue = !status && variant === "clue";
      prompt.classList.toggle("round-panel__question--status", status);
      prompt.classList.toggle("round-panel__question--clue", isClue);
      content.classList.toggle("round-panel__content--status", status);
      content.classList.toggle("round-panel__content--comment", isClue);
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

    const setMarkingVisible = (visible) => {
      answerBox.classList.toggle("is-hidden", !visible);
      verdictRow.classList.toggle("is-hidden", !visible);
      if (visible) setYearVisible(false);
    };

    let idx = 0;
    let marks = [null, null, null];
    let triplet = [];
    let answers = [];
    let published = false;
    let submitting = false;
    let advanceTimer = null;
    let swapTimer = null;
    let stepLabelsLocked = false;
    let stepLabelTimer = null;
    let showingClue = false;
    let fallbackMaths = {};
    let latestRoomData = {};
    let markingComplete = false;
    let yearDraft = "";
    let yearSubmitted = false;
    let yearSubmitting = false;

    let alive = true;
    let stopRoomWatch = null;
    let guardAllowNavigation = false;
    let guardReverting = false;
    const lockedHash = location.hash;
    let timerStarted = false;

    const effectiveRound = () => {
      return Number.isFinite(round) && round > 0 ? round : 1;
    };

    const markOffset = () => (effectiveRound() - 1) * 3;

    const stepColorClasses = [
      "round-panel__step--tick",
      "round-panel__step--unknown",
      "round-panel__step--cross",
    ];

    const markSymbol = (value) => {
      if (value === VERDICT.RIGHT) return "✓";
      if (value === VERDICT.WRONG) return "✕";
      if (value === VERDICT.UNKNOWN) return "?";
      return "";
    };

    const markClass = (value) => {
      if (value === VERDICT.RIGHT) return "round-panel__step--tick";
      if (value === VERDICT.WRONG) return "round-panel__step--cross";
      if (value === VERDICT.UNKNOWN) return "round-panel__step--unknown";
      return "";
    };

    const markDescriptor = (value) => {
      if (value === VERDICT.RIGHT) return "correct";
      if (value === VERDICT.WRONG) return "incorrect";
      if (value === VERDICT.UNKNOWN) return "unsure";
      return "pending";
    };

    const refreshStepLabels = () => {
      const base = markOffset();
      stepButtons.forEach((btn, i) => {
        const number = base + i + 1;
        const verdict = marks[i];
        const symbol = markSymbol(verdict);
        const labelText = symbol || String(number);
        btn.textContent = labelText;
        const aria = verdict
          ? `Mark ${number} marked ${markDescriptor(verdict)}`
          : `Mark ${number}`;
        btn.setAttribute("aria-label", aria);
        stepColorClasses.forEach((cls) => btn.classList.remove(cls));
        const colourClass = markClass(verdict);
        if (colourClass) btn.classList.add(colourClass);
      });
    };

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
      steps.classList.toggle("is-hidden", published || submitting);
      steps.classList.toggle("is-complete", isFullyMarked());
      const allowActive = !(published || submitting || showingClue);
      stepButtons.forEach((btn, i) => {
        btn.classList.toggle("is-active", allowActive && i === idx);
        btn.classList.toggle("is-answered", marks[i] !== null);
        btn.disabled = triplet.length === 0 || published || submitting;
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

    const isFullyMarked = () => marks.every((value) => value !== null);

    const hideReadyPrompt = () => {
      showingClue = false;
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
    };

    const getClueText = () => {
      const text = resolveClue(latestRoomData, fallbackMaths, effectiveRound());
      return text || "Jemima’s clue is on its way…";
    };

    const showReadyPrompt = ({ animate = true } = {}) => {
      if (published || submitting) return;
      showingClue = false;
      const render = () => {
        setHeading(DEFAULT_HEADING);
        setPrompt("", { status: false });
        hideStatusNote();
        setMarkingVisible(false);
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

    const setYearVisible = (visible) => {
      yearWrap.classList.toggle("is-hidden", !visible);
    };

    const clampYearDraft = (value = "") => {
      const cleaned = String(value || "")
        .replace(/[^0-9]/g, "")
        .slice(0, 4);
      yearDraft = cleaned;
      return yearDraft;
    };

    const isYearValid = (value) => {
      const num = Number(value);
      return Number.isInteger(num) && num >= 1 && num <= 2026;
    };

    const refreshYearForm = () => {
      yearInput.value = yearDraft;
      const valid = isYearValid(yearDraft);
      yearSubmit.disabled = yearSubmitting || !valid;
      yearSubmit.classList.toggle("marking-year__submit--visible", valid && !yearSubmitting);
    };

    const showYearEntry = ({ animate = true } = {}) => {
      const clueText = getClueText();
      const render = () => {
        setHeading(JEMIMA_HEADING);
        setPrompt(clueText, { status: false, variant: "clue" });
        hideStatusNote();
        readyBtn.style.display = "none";
        readyBtn.classList.remove("round-panel__submit--ready");
        readyBtn.classList.remove("round-panel__submit--waiting");
        readyBtn.classList.remove("throb");
        setMarkingVisible(false);
        setVerdictsEnabled(false);
        setYearVisible(true);
        refreshYearForm();
      };
      if (animate) animateSwap(render);
      else render();
      startRoundTimer();
      resumeRoundTimer(timerContext);
    };

    const enterWaitingState = ({ afterYear = false } = {}) => {
      published = true;
      showingClue = false;
      steps.classList.add("is-hidden");
      setMarkingVisible(false);
      setVerdictsEnabled(false);
      if (afterYear) {
        setYearVisible(false);
        pauseRoundTimer(timerContext);
        clearRoundTimer(timerContext);
      }
      showWaitingPrompt();
      renderSteps();
      reflectVerdicts();
    };

    const showMark = (targetIdx, { animate = true } = {}) => {
      if (triplet.length === 0) return;
      if (targetIdx < 0) targetIdx = 0;
      if (targetIdx >= triplet.length) targetIdx = triplet.length - 1;
      idx = targetIdx;
      setVerdictsEnabled(!published && !submitting);
      hideReadyPrompt();
      setYearVisible(false);
      const render = () => {
        const current = triplet[idx] || {};
        const questionText = current.question || "(missing question)";
        const answerText = answers[idx] || "(no answer recorded)";
        setHeading(DEFAULT_HEADING);
        setPrompt(questionText, { status: false, variant: "question" });
        hideStatusNote();
        answerValue.textContent = answerText;
        renderSteps();
        [btnRight, btnUnknown, btnWrong].forEach((btn) => {
          btn.classList.remove("is-blinking");
          btn.classList.remove("is-blinking-fast");
        });
        reflectVerdicts();
        setMarkingVisible(true);
      };
      if (animate) animateSwap(render);
      else render();
      if (!published && !submitting) {
        startRoundTimer();
        resumeRoundTimer(timerContext);
      }
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
        } else if (isFullyMarked()) {
          showReadyPrompt({ animate: true });
        } else {
          showMark(marks.length - 1, { animate: true });
        }
      }, 420);
    };

    const showWaitingPrompt = () => {
      showingClue = false;
      const clueText = getClueText();
      setHeading(JEMIMA_HEADING);
      setPrompt(clueText, { status: false, variant: "clue" });
      showStatusNote(waitingLabel);
      setMarkingVisible(false);
      readyBtn.style.display = "none";
      readyBtn.disabled = true;
      readyBtn.textContent = waitingLabel;
      readyBtn.classList.remove("btn-ready");
      readyBtn.classList.remove("round-panel__submit--ready");
      readyBtn.classList.remove("throb");
      readyBtn.classList.add("round-panel__submit--waiting");
      clearAdvanceTimer();
    };

    const rRef = roomRef(code);
    const rdRef = doc(roundSubColRef(code), String(round));

    const roomSnap = await getDoc(rRef);
    const roomData0 = roomSnap.data() || {};
    latestRoomData = roomData0;
    fallbackMaths = roomData0.maths || {};
    const { hostUid, guestUid } = roomData0.meta || {};
    const storedRole = getStoredRole(code);
    const myRole = storedRole === "host" || storedRole === "guest"
      ? storedRole
      : hostUid === me.uid ? "host" : guestUid === me.uid ? "guest" : "guest";
    const oppRole = myRole === "host" ? "guest" : "host";
    const oppName = oppRole === "host" ? "Daniel" : "Jaime";
    const waitingLabel = `WAITING FOR ${oppName.toUpperCase()}`;

    const timerContext = { code, role: myRole, round };

    const startRoundTimer = () => {
      if (timerStarted || yearSubmitted) return;
      resumeRoundTimer(timerContext);
      timerStarted = true;
    };

    const preloadGuess = getRoundMapValue(((roomData0.mathsGuesses || {})[myRole] || {}), round);
    if (Number.isInteger(preloadGuess)) {
      yearDraft = String(preloadGuess);
      yearSubmitted = true;
    }

    const setLoadingState = (text) => {
      hideReadyPrompt();
      startRoundTimer();
      setHeading(DEFAULT_HEADING);
      setPrompt(text, { status: true });
      hideStatusNote();
      setMarkingVisible(false);
      setVerdictsEnabled(false);
      renderSteps();
    };

    setLoadingState("Preparing responses…");

    const rdSnap = await getDoc(rdRef);
    const rdData = rdSnap.data() || {};
    if (myRole === "host") {
      await ensureBotMarking({ code, round, roomData: roomData0, roundData: rdData });
    }
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
    const marksComplete = isFullyMarked();

    if (yearSubmitted) {
      setVerdictsEnabled(false);
      enterWaitingState({ afterYear: true });
    } else if (alreadyAck && marksComplete) {
      markingComplete = true;
      published = true;
      showYearEntry({ animate: false });
    } else if (marksComplete) {
      showReadyPrompt({ animate: false });
    } else {
      const firstPending = marks.findIndex((value) => value === null);
      const startIdx = firstPending === -1 ? 0 : firstPending;
      showMark(startIdx, { animate: false });
    }

    unlockStepLabels();
    renderSteps();
    reflectVerdicts();

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

          const guessHost = getRoundMapValue((roomData.mathsGuesses || {}).host || {}, round);
          const guessGuest = getRoundMapValue((roomData.mathsGuesses || {}).guest || {}, round);
          if (!Number.isInteger(guessHost) || !Number.isInteger(guessGuest)) return;

          const roundSnapCur = await tx.get(rdRef);
          const roundData = roundSnapCur.exists() ? (roundSnapCur.data() || {}) : {};
          const answersHost = (((roomData.answers || {}).host || {})[round] || []);
          const answersGuest = (((roomData.answers || {}).guest || {})[round] || []);
          const hostItems = roundData.hostItems || [];
          const guestItems = roundData.guestItems || [];

          const roundHostScore = countCorrectAnswers(answersHost, hostItems);
          const roundGuestScore = countCorrectAnswers(answersGuest, guestItems);
          const currentRound = Number(roomData.round) || round;

          const timings = roomData.timings || {};
          const hostTime = normaliseTimingEntry(getRoundMapValue(timings.host || {}, round));
          const guestTime = normaliseTimingEntry(getRoundMapValue(timings.guest || {}, round));
          let hostBonus = 0;
          let guestBonus = 0;
          if (hostTime !== null && guestTime !== null) {
            const epsilon = 0.01;
            if (hostTime + epsilon < guestTime) hostBonus = 1;
            else if (guestTime + epsilon < hostTime) guestBonus = 1;
          }

          tx.update(rRef, {
            state: "award",
            round: currentRound,
            [`scores.host.${currentRound}`]: roundHostScore,
            [`scores.guest.${currentRound}`]: roundGuestScore,
            [`speedBonuses.host.${currentRound}`]: hostBonus,
            [`speedBonuses.guest.${currentRound}`]: guestBonus,
            "timestamps.updatedAt": serverTimestamp(),
          });
        });
      } catch (err) {
        console.warn("[marking] finalize failed:", err);
      }
    };

    const submitMarks = async () => {
      if (published || submitting) return;
      if (!isFullyMarked()) return;
      submitting = true;
      clearAdvanceTimer();
      readyBtn.disabled = true;
      readyBtn.classList.remove("throb");
      renderSteps();
      setVerdictsEnabled(false);
      reflectVerdicts();
      const payload = marks.map((value) => markValue(value));

      const patch = {
        [`marking.${myRole}.${round}`]: payload,
        [`markingAck.${myRole}.${round}`]: true,
        "timestamps.updatedAt": serverTimestamp(),
      };

      try {
        await updateDoc(rRef, patch);
        submitting = false;
        markingComplete = true;
        published = true;
        showYearEntry({ animate: false });
      } catch (err) {
        console.warn("[marking] submit failed:", err);
        submitting = false;
        readyBtn.disabled = false;
        readyBtn.textContent = "SUBMIT";
        setVerdictsEnabled(true);
        startRoundTimer();
        resumeRoundTimer(timerContext);
        renderSteps();
        showReadyPrompt({ animate: false });
      }
    };

    const submitYear = async () => {
      if (yearSubmitting || yearSubmitted) return;
      const parsed = parseInt(yearDraft || "", 10);
      if (!isYearValid(parsed)) return;
      yearSubmitting = true;
      refreshYearForm();
      pauseRoundTimer(timerContext);
      const totalSecondsRaw = getRoundTimerTotal(timerContext) / 1000;
      const totalSeconds = Math.max(0, Math.round(totalSecondsRaw * 100) / 100);

      const patch = {
        [`mathsGuesses.${myRole}.${round}`]: parsed,
        [`timings.${myRole}.${round}`]: { totalSeconds },
        "timestamps.updatedAt": serverTimestamp(),
      };

      try {
        await updateDoc(rRef, patch);
        yearSubmitted = true;
        yearSubmitting = false;
        enterWaitingState({ afterYear: true });
      } catch (err) {
        console.warn("[marking] failed to submit year:", err);
        yearSubmitting = false;
        startRoundTimer();
        resumeRoundTimer(timerContext);
        refreshYearForm();
      }
    };

    const handleVerdict = (value, sourceBtn) => {
      if (published || submitting) return;
      const canonical = markValue(value);
      if (marks[idx] === canonical) {
        marks[idx] = null;
        if (sourceBtn) {
          sourceBtn.classList.remove("is-blinking");
          sourceBtn.classList.remove("is-blinking-fast");
        }
        unlockStepLabels();
        renderSteps();
        reflectVerdicts();
        return;
      }
      marks[idx] = canonical;
      const flashDuration = 260;
      lockStepLabels(flashDuration);
      if (sourceBtn) {
        [btnRight, btnUnknown, btnWrong].forEach((btn) => {
          if (btn !== sourceBtn) {
            btn.classList.remove("is-blinking");
            btn.classList.remove("is-blinking-fast");
          }
        });
        sourceBtn.classList.add("is-blinking");
        sourceBtn.classList.add("is-blinking-fast");
        setTimeout(() => {
          sourceBtn.classList.remove("is-blinking");
          sourceBtn.classList.remove("is-blinking-fast");
        }, flashDuration);
      }
      renderSteps();
      reflectVerdicts();
      scheduleAdvance(idx);
    };

    btnRight.addEventListener("click", () => handleVerdict(VERDICT.RIGHT, btnRight));
    btnWrong.addEventListener("click", () => handleVerdict(VERDICT.WRONG, btnWrong));
    btnUnknown.addEventListener("click", () => handleVerdict(VERDICT.UNKNOWN, btnUnknown));

    yearInput.addEventListener("input", () => {
      clampYearDraft(yearInput.value);
      refreshYearForm();
    });
    yearSubmit.addEventListener("click", submitYear);

    stepButtons.forEach((btn, i) => {
      btn.addEventListener("click", () => {
        if (triplet.length === 0) return;
        if (published || submitting) return;
        clearAdvanceTimer();
        showMark(i, { animate: true });
        reflectVerdicts();
      });
    });

    readyBtn.addEventListener("click", submitMarks);

    const unsubscribeRoom = onSnapshot(rRef, (snap) => {
      const data = snap.data() || {};
      latestRoomData = data;
      const stateName = (data.state || "").toLowerCase();

      if (Number.isFinite(Number(data.round))) {
        const nextRound = Number(data.round);
        if (nextRound !== round) {
          round = nextRound;
          timerContext.round = round;
          unlockStepLabels();
          renderSteps();
          applyPalette(effectiveRound());
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
      const guessesMap = data.mathsGuesses || {};
      const myGuessValue = getRoundMapValue((guessesMap[myRole] || {}), round);
      const oppGuessValue = getRoundMapValue((guessesMap[oppRole] || {}), round);
      const marksCompleteNow = isFullyMarked();

      if (ackMine) {
        markingComplete = true;
        published = true;
      }

      if (Number.isInteger(myGuessValue) && !yearSubmitted) {
        yearDraft = String(myGuessValue);
        yearSubmitted = true;
        enterWaitingState({ afterYear: true });
      } else if (ackMine && !yearSubmitted && marksCompleteNow) {
        const incoming = (((data.marking || {})[myRole] || {})[round] || marks);
        marks = marks.map((_, i) => markValue(incoming[i]));
        submitting = false;
        showYearEntry({ animate: false });
      } else if (!ackMine && showingClue && !submitting && marksCompleteNow) {
        showReadyPrompt({ animate: false });
      }

      if (yearSubmitted && alive) {
        showWaitingPrompt();
      }

      if (
        myRole === "host" &&
        stateName === "marking" &&
        ackMine &&
        ackOpp &&
        Number.isInteger(myGuessValue) &&
        Number.isInteger(oppGuessValue)
      ) {
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
      clearStepLabelTimer();
      try { stopRoomWatch && stopRoomWatch(); } catch {}
      pauseRoundTimer(timerContext);
      window.removeEventListener("hashchange", handleHashChange);
    };
  },

  async unmount() { /* handled in mount */ },
};
