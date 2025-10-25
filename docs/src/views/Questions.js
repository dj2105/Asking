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

    const hue = Math.floor(Math.random() * 360);
    const accentHue = (hue + 180) % 360;
    document.documentElement.style.setProperty("--ink-h", String(hue));
    document.documentElement.style.setProperty("--accent-soft", `hsl(${accentHue}, 68%, 88%)`);
    document.documentElement.style.setProperty("--accent-strong", `hsl(${accentHue}, 52%, 26%)`);

    container.innerHTML = "";

    const root = el("div", { class: "view view-questions stage-center" });
    const panel = el("div", { class: "round-panel" });
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
    content.appendChild(choicesWrap);

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

    const setChoicesVisible = (visible) => {
      choicesWrap.classList.toggle("is-hidden", !visible);
    };

    const setStepsVisible = (visible) => {
      steps.classList.toggle("is-hidden", !visible);
    };

    let idx = 0;
    const chosen = ["", "", ""];
    let triplet = [];
    let published = false;
    let submitting = false;
    let advanceTimer = null;
    let swapTimer = null;
    let waitingMode = false;

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
        btn.setAttribute("aria-label", `Question ${number}`);
      });
    };

    const renderSteps = () => {
      updateStepNumbers();
      stepButtons.forEach((btn, i) => {
        btn.classList.toggle("is-active", i === idx);
        btn.classList.toggle("is-answered", Boolean(chosen[i]));
        btn.disabled = triplet.length === 0 || waitingMode;
      });
    };

    const renderChoices = () => {
      const current = triplet[idx] || {};
      const currentSelection = chosen[idx] || "";
      choiceButtons.forEach((btn, i) => {
        const option = current.options?.[i] || "";
        btn.textContent = option;
        const isSelected = option && currentSelection === option;
        btn.classList.toggle("is-selected", isSelected);
        btn.disabled = !option || published || submitting;
      });
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
      setWaitingMode(false);
      const render = () => {
        const current = triplet[idx] || {};
        const number = getQuestionNumber(idx);
        const label = current.question ? `${number}. ${current.question}` : "";
        setPrompt(label, { status: false });
        setChoicesVisible(true);
        renderChoices();
        renderSteps();
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
      }, 500);
    };

    const rRef = roomRef(code);

    const roomSnap0 = await getDoc(rRef);
    const room0 = roomSnap0.data() || {};
    if (!round) {
      const roomRound = Number(room0.round);
      round = Number.isFinite(roomRound) && roomRound > 0 ? roomRound : 1;
    }

    const rdRef = doc(roundSubColRef(code), String(round));
    const { hostUid, guestUid } = room0.meta || {};
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
      waitingMessage.classList.toggle("is-hidden", !active);
      if (active) {
        setChoicesVisible(false);
      }
      submitBtn.classList.toggle("is-hidden", active);
      renderSteps();
    };

    const setLoadingState = (text) => {
      pauseRoundTimer(timerContext);
      setWaitingMode(false);
      content.classList.remove("is-hidden");
      waitingMessage.classList.add("is-hidden");
      setPrompt(text, { status: true });
      setChoicesVisible(false);
      renderSteps();
      updateSubmitState();
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
      setWaitingMode(true);
      pauseRoundTimer(timerContext);
    } else if (triplet.every((entry) => entry.question && entry.options?.length === 2)) {
      showQuestion(0, { animate: false });
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
        const text = btn.textContent || "";
        const currentIndex = idx;
        if (!text) return;
        choiceButtons.forEach((other) => {
          other.classList.toggle("is-selected", other === btn);
        });
        chosen[currentIndex] = text;
        renderChoices();
        renderSteps();
        updateSubmitState();
        highlightSubmitIfReady();
        scheduleAdvance(currentIndex);
      });
    });

    stepButtons.forEach((btn, i) => {
      btn.addEventListener("click", () => {
        if (triplet.length === 0) return;
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
      submitting = true;
      updateSubmitState();
      submitBtn.textContent = "SUBMITTING…";

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
        setWaitingMode(true);
        clearAdvanceTimer();
        pauseRoundTimer(timerContext);
      } catch (err) {
        console.warn("[questions] publish failed:", err);
        submitting = false;
        submitBtn.textContent = "SUBMIT";
        updateSubmitState();
      }
    });

    const stopWatcherRef = onSnapshot(rRef, async (snap) => {
      const data = snap.data() || {};

      const nextRound = Number(data.round) || round;
      if (nextRound !== round) {
        round = nextRound;
        timerContext.round = round;
        renderSteps();
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
        const myDone = Boolean(((data.submitted || {})[myRole] || {})[round]) || (Array.isArray(((data.answers || {})[myRole] || {})[round]) && (((data.answers || {})[myRole] || {})[round]).length === 3);
        const oppDone = Boolean(((data.submitted || {})[oppRole] || {})[round]) || (Array.isArray(((data.answers || {})[oppRole] || {})[round]) && (((data.answers || {})[oppRole] || {})[round]).length === 3);
        if (myDone && !oppDone) {
          submitBtn.disabled = true;
          submitBtn.textContent = waitingLabel;
          setWaitingMode(true);
        }
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
    };
  },

  async unmount() { /* handled in mount */ },
};
