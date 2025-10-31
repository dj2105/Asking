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
import { clampCode, getHashParams, getStoredRole } from "../lib/util.js";

const roundTier = (r) => (r <= 1 ? "easy" : r === 2 ? "medium" : "hard");

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

const FALLBACK_WRONG_POOL = FALLBACK_ITEMS.map((item) => item.wrong);
const DIRECTION_ORDER = ["left", "up", "right"];

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

function shuffleArray(list = []) {
  const copy = Array.from(list);
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = copy[i];
    copy[i] = copy[j];
    copy[j] = temp;
  }
  return copy;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function collectOptions(item = {}, fallback = {}, roundNumber = 1) {
  const question = cleanText(item.question) || fallback.question;
  const correct = cleanText(item.correct_answer) || fallback.correct;
  const distractors = item.distractors || {};
  const tier = roundTier(roundNumber);
  const preferredKeys = [tier, "medium", "hard", "easy", "bonus", "extra"];
  const wrongPool = [];
  preferredKeys.forEach((key) => {
    const option = cleanText(distractors[key]);
    if (option && option.toLowerCase() !== correct.toLowerCase()) wrongPool.push(option);
  });
  FALLBACK_WRONG_POOL.forEach((option) => {
    if (option && option.toLowerCase() !== correct.toLowerCase()) wrongPool.push(option);
  });
  const uniqueWrong = Array.from(new Set(wrongPool));
  if (!uniqueWrong.length) uniqueWrong.push(fallback.wrong);
  while (uniqueWrong.length < 2) uniqueWrong.push(uniqueWrong[uniqueWrong.length - 1] || fallback.wrong);
  const options = shuffleArray([correct, uniqueWrong[0], uniqueWrong[1]]);
  return { question, correct, options: options.slice(0, DIRECTION_ORDER.length) };
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

    const hue = Math.floor(Math.random() * 360);
    const accentHue = (hue + 180) % 360;
    const applyPalette = createPaletteApplier(hue, accentHue);
    applyPalette(round || 1);

    container.innerHTML = "";

    const root = el("div", { class: "view view-questions stage-center" });

    const hud = el("div", { class: "flight-hud mono" });
    const hudTop = el("div", { class: "flight-hud__row" });
    const hudRound = el("span", { class: "flight-hud__round" }, "ROUND 1");
    const hudProgress = el("div", { class: "flight-hud__progress" });
    const hudProgressBar = el("span", { class: "flight-hud__progress-bar" });
    hudProgress.appendChild(hudProgressBar);
    const hudControl = el("span", { class: "flight-hud__control" }, "FLY ← ↑ →");
    hudTop.appendChild(hudRound);
    hudTop.appendChild(hudProgress);
    hudTop.appendChild(hudControl);
    const hudHint = el(
      "div",
      { class: "flight-hud__row flight-hud__hint" },
      "Steer towards the glowing question ahead."
    );
    hud.appendChild(hudTop);
    hud.appendChild(hudHint);

    const panel = el("div", { class: "round-panel round-panel--flight" });
    const heading = el("h2", { class: "round-panel__heading mono" }, "QUESTIONS");

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
    const prompt = el("div", { class: "round-panel__question mono" }, "");
    const choicesWrap = el("div", { class: "round-panel__choices" });

    const directionLabels = {
      left: "BANK LEFT",
      up: "ASCEND",
      right: "BANK RIGHT",
    };
    const choiceTextRefs = new Map();
    const choiceButtons = DIRECTION_ORDER.map((direction) => {
      const btn = el("button", {
        class: "flight-choice mono",
        type: "button",
        "data-direction": direction,
      });
      const dirLabel = el("span", { class: "flight-choice__direction" }, directionLabels[direction] || direction.toUpperCase());
      const text = el("span", { class: "flight-choice__text" }, "");
      btn.appendChild(dirLabel);
      btn.appendChild(text);
      choicesWrap.appendChild(btn);
      choiceTextRefs.set(direction, text);
      return btn;
    });
    const directionToButton = new Map();
    choiceButtons.forEach((btn, index) => {
      const direction = DIRECTION_ORDER[index];
      directionToButton.set(direction, btn);
    });

    content.appendChild(prompt);
    content.appendChild(choicesWrap);

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
    panel.appendChild(submitBtn);
    root.appendChild(hud);
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
      const content = status ? String(text || "") : balanceQuestionText(text);
      prompt.textContent = content;
      prompt.classList.toggle("round-panel__question--status", status);
    };

    let idx = 0;
    const chosen = ["", "", ""];
    let triplet = [];
    let published = false;
    let submitting = false;
    let advanceTimer = null;
    let swapTimer = null;
    let focusedDirection = null;

    const effectiveRound = () => {
      return Number.isFinite(round) && round > 0 ? round : 1;
    };

    const questionOffset = () => (effectiveRound() - 1) * 3;

    const refreshStepLabels = () => {
      const base = questionOffset();
      stepButtons.forEach((btn, i) => {
        const number = base + i + 1;
        btn.textContent = String(number);
        btn.setAttribute("aria-label", `Question ${number}`);
      });
    };

    const updateHud = () => {
      const roundNumber = effectiveRound();
      hudRound.textContent = `ROUND ${String(roundNumber).padStart(2, "0")}`;
      const total = triplet.length || DIRECTION_ORDER.length;
      const answeredCount = chosen.filter((value) => value).length;
      const ratio = total > 0 ? answeredCount / total : 0;
      const minScale = total > 0 ? 0.12 : 0.06;
      const clamped = Math.max(minScale, Math.min(1, ratio));
      hudProgressBar.style.transform = `scaleX(${clamped.toFixed(3)})`;
    };

    const setHudHint = (text) => {
      hudHint.textContent = text || "";
    };

    const clearFocusedDirection = () => {
      if (focusedDirection && directionToButton.has(focusedDirection)) {
        const btn = directionToButton.get(focusedDirection);
        if (btn) btn.classList.remove("is-focused");
      }
      focusedDirection = null;
    };

    const focusDirection = (direction) => {
      if (!direction || !directionToButton.has(direction)) {
        clearFocusedDirection();
        return;
      }
      const btn = directionToButton.get(direction);
      if (!btn || btn.disabled) return;
      if (focusedDirection === direction) return;
      clearFocusedDirection();
      btn.classList.add("is-focused");
      focusedDirection = direction;
    };

    const setChoicesVisible = (visible) => {
      choicesWrap.classList.toggle("is-hidden", !visible);
      if (!visible) clearFocusedDirection();
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

    const triggerApproach = () => {
      panel.classList.remove("round-panel--departing");
      panel.classList.remove("round-panel--flight");
      void panel.offsetWidth;
      panel.classList.add("round-panel--flight");
    };

    const animateSwap = (renderFn) => {
      clearSwapTimer();
      panel.classList.add("round-panel--departing");
      content.classList.add("is-leaving");
      swapTimer = setTimeout(() => {
        swapTimer = null;
        renderFn();
        triggerApproach();
        content.classList.remove("is-leaving");
        content.classList.add("is-entering");
        requestAnimationFrame(() => {
          content.classList.remove("is-entering");
        });
      }, 140);
    };

    const renderSteps = () => {
      refreshStepLabels();
      stepButtons.forEach((btn, i) => {
        btn.classList.toggle("is-active", i === idx);
        btn.classList.toggle("is-answered", Boolean(chosen[i]));
        btn.disabled = triplet.length === 0 || published || submitting;
      });
      updateHud();
    };

    const renderChoices = () => {
      const current = triplet[idx] || {};
      const currentSelection = chosen[idx] || "";
      clearFocusedDirection();
      choiceButtons.forEach((btn, i) => {
        const direction = DIRECTION_ORDER[i];
        const option = current.options?.[i] || "";
        const textEl = choiceTextRefs.get(direction);
        if (textEl) textEl.textContent = option || "";
        const isSelected = option && currentSelection === option;
        btn.classList.toggle("is-selected", isSelected);
        btn.disabled = !option || published || submitting;
        if (option) {
          btn.dataset.option = option;
          btn.setAttribute("aria-label", `${directionLabels[direction] || direction} — ${option}`);
        } else {
          btn.dataset.option = "";
          btn.setAttribute("aria-label", `${directionLabels[direction] || direction} — unavailable`);
        }
      });
      updateHud();
    };

    const updateSubmitState = () => {
      const answeredCount = chosen.filter((value) => value).length;
      const allAnswered = triplet.length > 0 && answeredCount >= triplet.length;
      const ready = allAnswered && !published && !submitting;
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
      if (ready && !published) {
        setHudHint("All answers locked — engage SUBMIT to continue.");
      } else if (!published && !submitting) {
        setHudHint("Use ← ↑ → to select an answer.");
      }
      updateHud();
    };

    const highlightSubmitIfReady = () => {
      const answeredCount = chosen.filter((value) => value).length;
      if (triplet.length > 0 && answeredCount >= triplet.length && !published && !submitting) {
        submitBtn.classList.add("round-panel__submit--ready");
        submitBtn.classList.add("throb");
      }
    };

    const showQuestion = (targetIdx, { animate = true } = {}) => {
      if (triplet.length === 0) return;
      if (targetIdx < 0) targetIdx = 0;
      if (targetIdx >= triplet.length) targetIdx = triplet.length - 1;
      idx = targetIdx;
      const render = () => {
        const current = triplet[idx] || {};
        setPrompt(current.question || "", { status: false });
        setChoicesVisible(true);
        choiceButtons.forEach((btn) => btn.classList.remove("is-blinking"));
        renderChoices();
        renderSteps();
        setHudHint("Use ← ↑ → to select an answer.");
        const focusTarget = DIRECTION_ORDER.find((direction, index) => Boolean(current.options?.[index]));
        if (focusTarget) focusDirection(focusTarget);
        highlightSubmitIfReady();
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
      setHudHint("Answer locked — accelerating to next prompt…");
      advanceTimer = setTimeout(() => {
        advanceTimer = null;
        if (!alive || submitting || published) return;
        const next = findNextUnanswered(currentIndex);
        if (next !== null && next !== undefined) {
          showQuestion(next, { animate: true });
        } else if (triplet.length > 0) {
          showQuestion(triplet.length - 1, { animate: true });
        }
        highlightSubmitIfReady();
      }, 700);
    };

    const showWaitingPrompt = () => {
      setPrompt(waitingLabel, { status: true });
      setChoicesVisible(false);
      setHudHint(`Holding for ${oppName.toUpperCase()}`);
      clearAdvanceTimer();
      triggerApproach();
    };

    const rRef = roomRef(code);

    const roomSnap0 = await getDoc(rRef);
    const room0 = roomSnap0.data() || {};
    if (!round) {
      const roomRound = Number(room0.round);
      round = Number.isFinite(roomRound) && roomRound > 0 ? roomRound : 1;
    }

    applyPalette(effectiveRound());

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

    const setLoadingState = (text) => {
      pauseRoundTimer(timerContext);
      setPrompt(text, { status: true });
      setChoicesVisible(false);
      setHudHint(text);
      renderSteps();
      updateSubmitState();
      triggerApproach();
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

    const myItems = (myRole === "host" ? rd.hostItems : rd.guestItems) || [];
    triplet = [0, 1, 2].map((i) => {
      const it = myItems[i] || {};
      const fallback = FALLBACK_ITEMS[i % FALLBACK_ITEMS.length];
      const { question, correct, options } = collectOptions(it, fallback, round || 1);
      return { question, options, correct };
    });

    const submittedAlready = Boolean(((room0.submitted || {})[myRole] || {})[round]);
    if (existingAns.length) {
      for (let i = 0; i < Math.min(existingAns.length, chosen.length); i += 1) {
        const entry = existingAns[i] || {};
        if (entry.chosen) chosen[i] = entry.chosen;
      }
    }

    if (submittedAlready) {
      published = true;
      submitBtn.disabled = true;
      submitBtn.textContent = waitingLabel;
      showWaitingPrompt();
      renderSteps();
      renderChoices();
      pauseRoundTimer(timerContext);
    } else if (triplet.every((entry) => entry.question && (entry.options?.length || 0) >= 2)) {
      showQuestion(0, { animate: false });
      triggerApproach();
      updateSubmitState();
    } else {
      setLoadingState("Preparing questions…");
    }

    renderSteps();
    renderChoices();
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
        const option = btn.dataset.option || "";
        if (!option) return;
        const currentIndex = idx;
        chosen[currentIndex] = option;
        const direction = btn.dataset.direction || "";
        focusDirection(direction);
        choiceButtons.forEach((choiceBtn) => {
          choiceBtn.classList.toggle("is-selected", choiceBtn === btn);
          if (choiceBtn !== btn) choiceBtn.classList.remove("is-blinking");
        });
        btn.classList.add("is-blinking");
        setTimeout(() => {
          btn.classList.remove("is-blinking");
        }, 900);
        renderChoices();
        renderSteps();
        updateSubmitState();
        scheduleAdvance(currentIndex);
      });
    });

    const keyToDirection = (event) => {
      const { key } = event;
      if (key === "ArrowLeft" || key === "a" || key === "A") return "left";
      if (key === "ArrowRight" || key === "d" || key === "D") return "right";
      if (key === "ArrowUp" || key === "w" || key === "W") return "up";
      return null;
    };

    const handleKeyDown = (event) => {
      if (triplet.length === 0) return;
      if (published || submitting) return;
      const direction = keyToDirection(event);
      if (!direction) return;
      const btn = directionToButton.get(direction);
      if (!btn) return;
      event.preventDefault();
      if (btn.disabled) {
        focusDirection(direction);
        return;
      }
      btn.click();
    };

    window.addEventListener("keydown", handleKeyDown);

    stepButtons.forEach((btn, i) => {
      btn.addEventListener("click", () => {
        if (triplet.length === 0) return;
        if (published || submitting) return;
        clearAdvanceTimer();
        showQuestion(i, { animate: true });
        renderChoices();
        renderSteps();
        updateSubmitState();
      });
    });

    submitBtn.addEventListener("click", async () => {
      if (published || submitting) return;
      const answeredCount = chosen.filter((value) => value).length;
      if (answeredCount < triplet.length) return;
      const revertIdx = idx;
      submitting = true;
      updateSubmitState();
      submitBtn.textContent = "SUBMITTING…";
      showWaitingPrompt();
      renderSteps();

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
        published = true;
        submitting = false;
        submitBtn.disabled = true;
        submitBtn.textContent = waitingLabel;
        showWaitingPrompt();
        renderSteps();
        renderChoices();
        updateSubmitState();
        pauseRoundTimer(timerContext);
      } catch (err) {
        console.warn("[questions] publish failed:", err);
        submitting = false;
        submitBtn.textContent = "SUBMIT";
        showQuestion(revertIdx, { animate: false });
        triggerApproach();
        updateSubmitState();
        resumeRoundTimer(timerContext);
      }
    });

    const stopWatcherRef = onSnapshot(rRef, async (snap) => {
      const data = snap.data() || {};

      const nextRound = Number(data.round) || round;
      if (nextRound !== round) {
        round = nextRound;
        timerContext.round = round;
        renderSteps();
        applyPalette(effectiveRound());
      }

      if (data.state === "marking") {
        goTo(`#/marking?code=${code}&round=${round}`);
        return;
      }

      if (data.state === "countdown") {
        goTo(`#/countdown?code=${code}&round=${data.round || round}`);
        return;
      }

      if (data.state === "award") {
        goTo(`#/award?code=${code}&round=${round}`);
        return;
      }

      if (published && alive) {
        showWaitingPrompt();
        renderSteps();
        renderChoices();
        submitBtn.disabled = true;
        submitBtn.textContent = waitingLabel;
      }

      if (myRole === "host" && data.state === "questions") {
        const myDone = Boolean(((data.submitted || {})[myRole] || {})[round]) || (Array.isArray(((data.answers || {})[myRole] || {})[round]) && (((data.answers || {})[myRole] || {})[round]).length === 3);
        const oppDone = Boolean(((data.submitted || {})[oppRole] || {})[round]) || (Array.isArray(((data.answers || {})[oppRole] || {})[round]) && (((data.answers || {})[oppRole] || {})[round]).length === 3);
        if (myDone && oppDone) {
          try {
            console.log(`[flow] questions -> marking | code=${code} round=${round} role=${myRole}`);
            await updateDoc(rRef, {
              state: "marking",
              "timestamps.updatedAt": serverTimestamp(),
            });
          } catch (err) {
            console.warn("[questions] failed to flip to marking:", err);
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
      try { stopWatcher && stopWatcher(); } catch {}
      pauseRoundTimer(timerContext);
      window.removeEventListener("hashchange", handleHashChange);
      window.removeEventListener("keydown", handleKeyDown);
    };
  },

  async unmount() { /* handled in mount */ },
};
