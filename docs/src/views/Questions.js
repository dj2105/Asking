// /src/views/Questions.js
//
// Questions phase — three floating cards in a muted award-inspired layout.
// • Shows exactly the player’s three questions with muted pastel theming.
// • Selecting an option highlights it for 0.5s, then auto-advances to the next unanswered item.
// • Submission is manual; the button arms once all three answers are present.
// • Submissions write answers.{role}.{round} and submitted.{role}.{round} before yielding to Marking.

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

const HOLD_MS = 500;

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

function applyMutedHueTheme(hue) {
  const rootStyle = document.documentElement && document.documentElement.style;
  if (!rootStyle) return;
  rootStyle.setProperty("--ink-h", String(hue));
  rootStyle.setProperty("--ink-s", "34%");
  rootStyle.setProperty("--ink-l", "24%");
  rootStyle.setProperty("--paper", `hsl(${hue}, 28%, 96%)`);
  rootStyle.setProperty("--quiz-panel-fill", `hsla(${hue}, 60%, 96%, 0.94)`);
  rootStyle.setProperty("--quiz-panel-outline", `hsla(${hue}, 30%, 40%, 0.5)`);
  rootStyle.setProperty("--quiz-panel-shadow", `0 26px 52px hsla(${hue}, 42%, 26%, 0.18)`);
  rootStyle.setProperty("--quiz-dot-color", `hsla(${hue}, 32%, 42%, 0.45)`);
  rootStyle.setProperty("--quiz-chip-fill", `hsla(${hue}, 48%, 94%, 0.9)`);
  rootStyle.setProperty("--quiz-chip-active", `hsla(${hue}, 48%, 88%, 0.98)`);
  rootStyle.setProperty("--quiz-chip-outline", `hsla(${hue}, 30%, 44%, 0.58)`);
  rootStyle.setProperty("--quiz-chip-shadow", `0 18px 36px hsla(${hue}, 40%, 28%, 0.2)`);
  rootStyle.setProperty("--quiz-button-outline", `hsla(${hue}, 32%, 40%, 0.48)`);
  rootStyle.setProperty("--quiz-button-hover-bg", `hsla(${hue}, 56%, 94%, 0.55)`);
  rootStyle.setProperty("--quiz-button-shadow", `0 20px 38px hsla(${hue}, 44%, 28%, 0.16)`);
  rootStyle.setProperty("--quiz-text", `hsl(${hue}, 26%, 24%)`);
  rootStyle.setProperty("--quiz-text-muted", `hsla(${hue}, 26%, 36%, 0.74)`);
  rootStyle.setProperty("--quiz-submit-shadow", `0 24px 46px hsla(${hue}, 42%, 24%, 0.22)`);
}

function findNextUnanswered(answers, currentIdx) {
  const total = answers.length;
  for (let offset = 1; offset <= total; offset += 1) {
    const target = (currentIdx + offset) % total;
    if (!answers[target]) return target;
  }
  return null;
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
    applyMutedHueTheme(hue);

    container.innerHTML = "";
    const root = el("div", { class: "view view-questions stage-center stage-center--solo quiz-stage" });

    const heading = el("h1", { class: "quiz-heading mono" }, "Questions");
    const chipsWrap = el("div", { class: "quiz-chips" });
    const chips = [0, 1, 2].map((index) => {
      const chip = el("button", { class: "quiz-chip", type: "button" }, String(index + 1));
      chip.disabled = true;
      chipsWrap.appendChild(chip);
      return chip;
    });

    const panel = el("div", { class: "quiz-panel" });
    const panelContent = el("div", { class: "quiz-panel__content" });
    const promptNode = el("div", { class: "quiz-prompt mono" }, "Preparing questions…");
    const dividerTop = el("div", { class: "quiz-panel__divider" });
    const answersWrap = el("div", { class: "quiz-answers" });
    const btnA = el("button", { class: "quiz-answer", type: "button" }, "");
    const btnB = el("button", { class: "quiz-answer", type: "button" }, "");
    btnA.disabled = true;
    btnB.disabled = true;
    answersWrap.appendChild(btnA);
    answersWrap.appendChild(btnB);
    const dividerBottom = el("div", { class: "quiz-panel__divider" });

    panelContent.appendChild(promptNode);
    panelContent.appendChild(dividerTop);
    panelContent.appendChild(answersWrap);
    panelContent.appendChild(dividerBottom);
    panel.appendChild(panelContent);
    panel.classList.add("is-disabled");

    const submitBtn = el("button", { class: "quiz-submit", type: "button", disabled: "true" }, "SUBMIT");

    root.appendChild(heading);
    root.appendChild(chipsWrap);
    root.appendChild(panel);
    root.appendChild(submitBtn);

    container.appendChild(root);

    const answerButtons = [btnA, btnB];

    let idx = 0;
    const chosen = ["", "", ""];
    let triplet = [];
    let published = false;
    let submitting = false;
    let advanceTimer = null;
    let alive = true;
    let stopWatcher = null;
    let removePopStateListener = () => {};
    let oppName = "opponent";
    let myRole = "guest";
    let oppRole = "host";
    let timerContext = null;

    const lockPanel = (locked) => {
      panel.classList.toggle("is-disabled", locked);
      answerButtons.forEach((btn) => {
        btn.disabled = locked;
      });
    };

    const refreshChoiceStyles = () => {
      const currentAnswer = chosen[idx] || "";
      answerButtons.forEach((btn) => {
        const isSelected = Boolean(currentAnswer) && (btn.textContent || "") === currentAnswer;
        btn.classList.toggle("is-selected", isSelected);
        btn.setAttribute("aria-pressed", isSelected ? "true" : "false");
      });
    };

    const refreshChipStates = () => {
      chips.forEach((chip, index) => {
        chip.classList.toggle("is-active", index === idx);
        chip.classList.toggle("is-complete", Boolean(chosen[index]));
        const hasQuestion = Boolean(triplet[index]);
        const shouldDisable = !hasQuestion || submitting || published;
        chip.disabled = shouldDisable;
      });
    };

    const updateSubmitState = () => {
      const allAnswered = chosen.every((value) => Boolean(value));
      submitBtn.classList.remove("quiz-submit--ready", "quiz-submit--waiting");
      if (published) {
        submitBtn.textContent = `WAITING FOR ${oppName.toUpperCase()}`;
        submitBtn.disabled = true;
        submitBtn.classList.add("quiz-submit--waiting");
        return;
      }
      if (submitting) {
        submitBtn.textContent = "SUBMITTING…";
        submitBtn.disabled = true;
        submitBtn.classList.add("quiz-submit--waiting");
        return;
      }
      submitBtn.textContent = "SUBMIT";
      submitBtn.disabled = !allAnswered;
      if (allAnswered) submitBtn.classList.add("quiz-submit--ready");
    };

    const clearAdvanceTimer = () => {
      if (advanceTimer) {
        clearTimeout(advanceTimer);
        advanceTimer = null;
      }
    };

    const rRef = roomRef(code);

    const showQuestion = (targetIdx, options = {}) => {
      clearAdvanceTimer();
      if (triplet.length === 0) return;
      if (targetIdx < 0) targetIdx = 0;
      if (targetIdx >= triplet.length) targetIdx = triplet.length - 1;
      idx = targetIdx;
      const cur = triplet[idx] || {};
      promptNode.textContent = cur.question || "";
      btnA.textContent = cur.options?.[0] || "";
      btnB.textContent = cur.options?.[1] || "";

      if (published || submitting) {
        lockPanel(true);
        if (timerContext) pauseRoundTimer(timerContext);
      } else {
        lockPanel(false);
        if (timerContext) resumeRoundTimer(timerContext);
      }

      refreshChoiceStyles();
      refreshChipStates();

      if (!options.skipHistory) {
        const shouldReplace = historyIndex === null || options.forceReplace;
        recordHistoryIndex(idx, { replace: shouldReplace });
      } else {
        historyIndex = idx;
      }
    };

    const onPick = (text) => {
      if (published || submitting) return;
      const currentIndex = idx;
      clearAdvanceTimer();
      chosen[currentIndex] = text;
      refreshChoiceStyles();
      refreshChipStates();
      updateSubmitState();

      const willBeComplete = chosen.every((value) => Boolean(value));
      advanceTimer = setTimeout(() => {
        advanceTimer = null;
        if (!alive || published || submitting) return;
        if (willBeComplete) return;
        const nextIdx = findNextUnanswered(chosen, currentIndex);
        if (nextIdx !== null && nextIdx !== currentIndex) {
          showQuestion(nextIdx);
        }
      }, HOLD_MS);
    };

    btnA.addEventListener("click", () => onPick(btnA.textContent));
    btnB.addEventListener("click", () => onPick(btnB.textContent));

    chips.forEach((chip, index) => {
      chip.addEventListener("click", () => {
        if (!alive) return;
        if (!triplet[index]) return;
        if (submitting || published) {
          showQuestion(index, { skipHistory: false });
        } else {
          showQuestion(index);
        }
      });
    });

    let historyIndex = null;
    const historySupported =
      typeof window !== "undefined" &&
      window.history &&
      typeof window.history.pushState === "function" &&
      typeof window.history.replaceState === "function";
    const historyKey = "jemimaQuestions";

    const recordHistoryIndex = (nextIndex, { replace = false } = {}) => {
      historyIndex = nextIndex;
      if (!historySupported) return;
      const baseState = window.history.state && typeof window.history.state === "object"
        ? { ...window.history.state }
        : {};
      baseState[historyKey] = { idx: nextIndex, code };
      try {
        if (replace) {
          window.history.replaceState(baseState, document.title);
        } else {
          window.history.pushState(baseState, document.title);
        }
      } catch (err) {
        console.warn("[questions] history state update failed:", err);
      }
    };

    const handlePopState = (event) => {
      if (published || submitting) return;
      const state = event?.state;
      const payload = state && typeof state === "object" ? state[historyKey] : null;
      if (!payload || payload.code !== code) return;
      const target = Number(payload.idx);
      if (!Number.isFinite(target)) return;
      showQuestion(target, { skipHistory: true });
    };

    if (historySupported) {
      window.addEventListener("popstate", handlePopState);
      removePopStateListener = () => {
        try {
          window.removeEventListener("popstate", handlePopState);
        } catch {}
        removePopStateListener = () => {};
      };
    }

    const roomSnap0 = await getDoc(rRef);
    const room0 = roomSnap0.data() || {};
    if (!round) {
      const roomRound = Number(room0.round);
      round = Number.isFinite(roomRound) && roomRound > 0 ? roomRound : 1;
    }

    const rdRef = doc(roundSubColRef(code), String(round));
    const { hostUid, guestUid } = room0.meta || {};
    const storedRole = getStoredRole(code);
    myRole = storedRole === "host" || storedRole === "guest"
      ? storedRole
      : hostUid === me.uid ? "host" : guestUid === me.uid ? "guest" : "guest";
    oppRole = myRole === "host" ? "guest" : "host";
    oppName = oppRole === "host" ? "Daniel" : "Jaime";
    timerContext = { code, role: myRole, round };

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

    const rd = await waitForRoundData();
    if (!alive) return;

    const myItems = (myRole === "host" ? rd.hostItems : rd.guestItems) || [];
    const roundTier = (r) => (r <= 1 ? "easy" : r === 2 ? "medium" : "hard");
    const tier = roundTier(round);
    triplet = [0, 1, 2].map((i) => {
      const it = myItems[i] || {};
      const fallback = FALLBACK_ITEMS[i % FALLBACK_ITEMS.length];
      const rawQuestion = typeof it.question === "string" ? it.question.trim() : "";
      const rawCorrect = typeof it.correct_answer === "string" ? it.correct_answer.trim() : "";
      const distractors = it.distractors || {};
      const rawWrong = [
        distractors[tier],
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

    const existingAnsRaw = (((room0.answers || {})[myRole] || {})[round] || []);
    if (Array.isArray(existingAnsRaw) && existingAnsRaw.length) {
      for (let i = 0; i < chosen.length; i += 1) {
        chosen[i] = existingAnsRaw[i]?.chosen || "";
      }
    }

    const alreadySubmitted = Boolean(((room0.submitted || {})[myRole] || {})[round]);

    refreshChipStates();
    refreshChoiceStyles();
    updateSubmitState();

    if (alreadySubmitted) {
      published = true;
      lockPanel(true);
      if (timerContext) pauseRoundTimer(timerContext);
      idx = Math.min(2, triplet.length - 1);
      showQuestion(idx, { forceReplace: true });
      updateSubmitState();
    } else {
      showQuestion(0, { forceReplace: true });
    }

    submitBtn.addEventListener("click", async () => {
      if (published || submitting) return;
      if (!chosen.every((value) => Boolean(value))) return;

      submitting = true;
      updateSubmitState();
      lockPanel(true);
      if (timerContext) pauseRoundTimer(timerContext);

      const payload = triplet.map((entry, index) => ({
        question: entry.question || "",
        chosen: chosen[index] || "",
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
        published = true;
        updateSubmitState();
        refreshChipStates();
      } catch (err) {
        console.warn("[questions] publish failed:", err);
        submitting = false;
        if (!published) {
          lockPanel(false);
          if (timerContext) resumeRoundTimer(timerContext);
        }
        updateSubmitState();
        refreshChipStates();
      }
    });

    stopWatcher = onSnapshot(rRef, async (snap) => {
      const data = snap.data() || {};

      const nextRound = Number(data.round) || round;
      if (nextRound !== round) {
        round = nextRound;
        if (timerContext) timerContext.round = round;
      }

      const stateName = (data.state || "").toLowerCase();
      if (stateName === "marking") {
        setTimeout(() => {
          location.hash = `#/marking?code=${code}&round=${round}`;
        }, 80);
        return;
      }

      if (stateName === "countdown") {
        setTimeout(() => {
          location.hash = `#/countdown?code=${code}&round=${data.round || round}`;
        }, 80);
        return;
      }

      if (stateName === "award") {
        setTimeout(() => {
          location.hash = `#/award?code=${code}&round=${round}`;
        }, 80);
        return;
      }

      if (published) {
        const myDone = Boolean(((data.submitted || {})[myRole] || {})[round]) ||
          (Array.isArray(((data.answers || {})[myRole] || {})[round]) && (((data.answers || {})[myRole] || {})[round]).length === 3);
        const oppDone = Boolean(((data.submitted || {})[oppRole] || {})[round]) ||
          (Array.isArray(((data.answers || {})[oppRole] || {})[round]) && (((data.answers || {})[oppRole] || {})[round]).length === 3);
        if (myDone && !oppDone) {
          submitBtn.textContent = `WAITING FOR ${oppName.toUpperCase()}`;
          submitBtn.classList.add("quiz-submit--waiting");
          submitBtn.disabled = true;
        }
      }

      if (myRole === "host" && stateName === "questions") {
        const myDone = Boolean(((data.submitted || {})[myRole] || {})[round]) ||
          (Array.isArray(((data.answers || {})[myRole] || {})[round]) && (((data.answers || {})[myRole] || {})[round]).length === 3);
        const oppDone = Boolean(((data.submitted || {})[oppRole] || {})[round]) ||
          (Array.isArray(((data.answers || {})[oppRole] || {})[round]) && (((data.answers || {})[oppRole] || {})[round]).length === 3);
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

    this.unmount = () => {
      alive = false;
      clearAdvanceTimer();
      try { stopWatcher && stopWatcher(); } catch {}
      if (timerContext) pauseRoundTimer(timerContext);
      try { removePopStateListener(); } catch {}
    };
  },

  async unmount() { /* instance handles cleanup */ },
};
