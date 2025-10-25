// /src/views/Questions.js
//
// Questions phase — local-only until the player taps Submit.
// The layout is a neutral canvas tinted by the per-game hue with a number switcher.

import { ensureAuth, db } from "../lib/firebase.js";
import {
  doc,
  collection,
  getDoc,
  updateDoc,
  onSnapshot,
  serverTimestamp,
} from "firebase/firestore";

import * as MathsPaneMod from "../lib/MathsPane.js";
import { resumeRoundTimer, pauseRoundTimer } from "../lib/RoundTimer.js";
import { clampCode, getHashParams, getStoredRole } from "../lib/util.js";
const mountMathsPane =
  (typeof MathsPaneMod?.default === "function" ? MathsPaneMod.default :
   typeof MathsPaneMod?.mount === "function" ? MathsPaneMod.mount :
   typeof MathsPaneMod?.default?.mount === "function" ? MathsPaneMod.default.mount :
   null);

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
  const n = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (k === "class") n.className = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  (Array.isArray(kids) ? kids : [kids]).forEach((c) =>
    n.appendChild(typeof c === "string" ? document.createTextNode(c) : c)
  );
  return n;
}

function shuffle2(a, b) {
  return Math.random() < 0.5 ? [a, b] : [b, a];
}

const roomRef = (code) => doc(db, "rooms", code);
const roundSubColRef = (code) => collection(roomRef(code), "rounds");
const QUESTION_COUNT = 3;

export default {
  async mount(container) {
    const me = await ensureAuth();

    const params = getHashParams();
    const code = clampCode(params.get("code") || "");
    const requestedRound = parseInt(params.get("round") || "", 10);
    let round = Number.isFinite(requestedRound) && requestedRound > 0 ? requestedRound : null;

    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    container.innerHTML = "";
    const root = el("div", { class: "view view-questions" });

    const shell = el("div", { class: "quiz-shell" });
    const heading = el("div", { class: "quiz-heading mono" }, "Questions");
    shell.appendChild(heading);

    const switcher = el("div", { class: "quiz-switcher" });
    const stepButtons = Array.from({ length: QUESTION_COUNT }).map((_, i) => {
      const btn = el("button", { class: "quiz-step", type: "button" }, String(i + 1));
      btn.disabled = true;
      switcher.appendChild(btn);
      return btn;
    });
    shell.appendChild(switcher);

    const prompt = el("div", { class: "quiz-prompt" });
    const questionText = el("div", { class: "quiz-question mono" }, "Preparing questions…");
    prompt.appendChild(questionText);
    shell.appendChild(prompt);

    const answersWrap = el("div", { class: "quiz-answers" });
    const btnA = el("button", { class: "quiz-answer-btn", type: "button", disabled: true }, "");
    const btnB = el("button", { class: "quiz-answer-btn", type: "button", disabled: true }, "");
    answersWrap.appendChild(btnA);
    answersWrap.appendChild(btnB);
    shell.appendChild(answersWrap);

    const submitBtn = el("button", { class: "quiz-submit", type: "button", disabled: true }, "Submit");
    shell.appendChild(submitBtn);

    root.appendChild(shell);

    const mathsMount = el("div", { class: "jemima-maths-pinned" });
    root.appendChild(mathsMount);

    container.appendChild(root);

    let idx = 0;
    let triplet = [];
    let tripletReady = false;
    const chosen = new Array(QUESTION_COUNT).fill("");
    let published = false;
    let submitting = false;
    let advanceTimer = null;
    let stopWatcher = null;
    let alive = true;
    let removePopStateListener = () => {};
    let waitMessageDefault = "Waiting…";

    const setPrompt = (text) => {
      questionText.textContent = text || "";
    };

    const clearAdvanceTimer = () => {
      if (advanceTimer) {
        clearTimeout(advanceTimer);
        advanceTimer = null;
      }
    };

    const refreshStepStates = () => {
      stepButtons.forEach((btn, stepIndex) => {
        btn.classList.toggle("is-active", stepIndex === idx);
        btn.classList.toggle("is-answered", Boolean(chosen[stepIndex]));
      });
    };

    const refreshAnswerSelection = () => {
      const current = chosen[idx] || "";
      const isSelected = (btn) => Boolean(current) && (btn.textContent || "") === current;
      [btnA, btnB].forEach((btn) => {
        btn.classList.toggle("is-selected", isSelected(btn));
      });
    };

    const refreshSubmitState = () => {
      const ready = chosen.every((value) => Boolean(value));
      const allowSubmit = ready && !published && !submitting;
      submitBtn.disabled = !allowSubmit;
      submitBtn.classList.toggle("is-ready", allowSubmit);
      submitBtn.classList.toggle("is-submitted", published);
      submitBtn.textContent = published ? "Submitted" : "Submit";
    };

    const refreshInteractivity = () => {
      const allowStep = tripletReady && !submitting;
      stepButtons.forEach((btn) => {
        btn.disabled = !allowStep;
      });
      const allowAnswer = tripletReady && !submitting && !published;
      [btnA, btnB].forEach((btn) => {
        btn.disabled = !allowAnswer;
      });
    };

    const focusQuestion = (targetIdx, { skipHistory = false, forceReplace = false } = {}) => {
      if (!tripletReady) return;
      if (targetIdx < 0) targetIdx = 0;
      if (targetIdx >= triplet.length) targetIdx = triplet.length - 1;
      idx = targetIdx;
      const current = triplet[idx] || {};
      setPrompt(current?.question || "");
      btnA.textContent = current?.options?.[0] || "";
      btnB.textContent = current?.options?.[1] || "";
      refreshStepStates();
      refreshAnswerSelection();
      refreshSubmitState();
      refreshInteractivity();
      if (!skipHistory) {
        const shouldReplace = historyIndex === null || forceReplace;
        recordHistoryIndex(idx, { replace: shouldReplace });
      } else {
        historyIndex = idx;
      }
      resumeRoundTimer(timerContext);
    };

    const historySupported =
      typeof window !== "undefined" &&
      window.history &&
      typeof window.history.pushState === "function" &&
      typeof window.history.replaceState === "function";
    const historyKey = "jemimaQuestions";
    let historyIndex = null;

    function recordHistoryIndex(nextIndex, { replace = false } = {}) {
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
    }

    const handlePopState = (event) => {
      if (!tripletReady || submitting) return;
      const state = event?.state;
      const payload = state && typeof state === "object" ? state[historyKey] : null;
      if (!payload || payload.code !== code) return;
      const target = Number(payload.idx);
      if (!Number.isFinite(target)) return;
      focusQuestion(target, { skipHistory: true });
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

    stepButtons.forEach((btn, buttonIndex) => {
      btn.addEventListener("click", () => {
        if (!tripletReady) return;
        clearAdvanceTimer();
        focusQuestion(buttonIndex);
      });
    });

    const nextUnansweredIndex = (fromIndex) => {
      for (let i = fromIndex + 1; i < chosen.length; i += 1) {
        if (!chosen[i]) return i;
      }
      for (let i = 0; i < chosen.length; i += 1) {
        if (!chosen[i]) return i;
      }
      return -1;
    };

    const handlePick = (value) => {
      if (!tripletReady || published || submitting) return;
      const currentIndex = idx;
      clearAdvanceTimer();
      chosen[currentIndex] = value;
      refreshStepStates();
      refreshAnswerSelection();
      refreshSubmitState();
      const nextIdx = nextUnansweredIndex(currentIndex);
      if (nextIdx !== -1) {
        advanceTimer = setTimeout(() => {
          advanceTimer = null;
          if (!alive || submitting || published) return;
          focusQuestion(nextIdx);
        }, 280);
      } else {
        refreshSubmitState();
      }
    };

    btnA.addEventListener("click", () => handlePick(btnA.textContent));
    btnB.addEventListener("click", () => handlePick(btnB.textContent));

    const timerContext = { code, role: "guest", round: round || 1 };

    const rRef = roomRef(code);

    const roomSnap0 = await getDoc(rRef);
    const room0 = roomSnap0.data() || {};
    if (!round) {
      const roomRound = Number(room0.round);
      round = Number.isFinite(roomRound) && roomRound > 0 ? roomRound : 1;
      timerContext.round = round;
    }

    const rdRef = doc(roundSubColRef(code), String(round));
    const { hostUid, guestUid } = room0.meta || {};
    const storedRole = getStoredRole(code);
    const myRole = storedRole === "host" || storedRole === "guest"
      ? storedRole
      : hostUid === me.uid ? "host" : guestUid === me.uid ? "guest" : "guest";
    timerContext.role = myRole;

    const oppRole = myRole === "host" ? "guest" : "host";
    const oppName = oppRole === "host" ? "Daniel" : "Jaime";
    waitMessageDefault = `Waiting for ${oppName}…`;

    const applyWaitingPrompt = (text) => {
      setPrompt(text || waitMessageDefault);
      refreshInteractivity();
      refreshSubmitState();
    };

    try {
      if (mountMathsPane && room0.maths) {
        mountMathsPane(mathsMount, { maths: room0.maths, round, mode: "inline", roomCode: code, userUid: me.uid });
      }
    } catch (err) {
      console.warn("[questions] MathsPane mount failed:", err);
    }

    const existingAns = (((room0.answers || {})[myRole] || {})[round] || []);

    const waitForRoundData = async () => {
      let attempts = 0;
      while (alive) {
        attempts += 1;
        try {
          const snap = await getDoc(rdRef);
          if (snap.exists()) return snap.data() || {};
        } catch (err) {
          console.warn("[questions] failed to load round doc:", err);
        }
        if (attempts >= 8) break;
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      return {};
    };

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

    tripletReady = triplet.every((entry) =>
      entry.question && Array.isArray(entry.options) && entry.options.length === 2
    );

    refreshInteractivity();

    if (!tripletReady) {
      applyWaitingPrompt("Preparing questions…");
      pauseRoundTimer(timerContext);
    } else if (existingAns.length === QUESTION_COUNT) {
      existingAns.forEach((ans, i) => {
        chosen[i] = ans?.chosen || "";
      });
      published = true;
      idx = Math.min(QUESTION_COUNT - 1, Math.max(0, existingAns.length - 1));
      focusQuestion(idx, { forceReplace: true });
      applyWaitingPrompt(waitMessageDefault);
      pauseRoundTimer(timerContext);
    } else {
      focusQuestion(0, { forceReplace: true });
    }

    const publishAnswers = async () => {
      if (published || submitting) return;
      submitting = true;
      refreshInteractivity();
      refreshSubmitState();
      pauseRoundTimer(timerContext);
      applyWaitingPrompt("Submitting…");

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
        published = true;
        submitting = false;
        applyWaitingPrompt(waitMessageDefault);
        refreshInteractivity();
        refreshSubmitState();
      } catch (err) {
        console.warn("[questions] publish failed:", err);
        submitting = false;
        refreshInteractivity();
        refreshSubmitState();
        focusQuestion(idx, { forceReplace: true });
      }
    };

    submitBtn.addEventListener("click", () => {
      if (submitBtn.disabled || submitting || published) return;
      publishAnswers();
    });

    const stopRoomWatcherCleanup = onSnapshot(rRef, async (snap) => {
      const data = snap.data() || {};

      const nextRound = Number(data.round) || round;
      if (nextRound !== round) {
        round = nextRound;
        timerContext.round = round;
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

      if (published && alive) {
        const answersNode = data.answers || {};
        const submittedNode = data.submitted || {};
        const myAnswers = ((answersNode[myRole] || {})[round] || []);
        const oppAnswers = ((answersNode[oppRole] || {})[round] || []);
        const myDone = Boolean(((submittedNode[myRole] || {})[round])) || (Array.isArray(myAnswers) && myAnswers.length === QUESTION_COUNT);
        const oppDone = Boolean(((submittedNode[oppRole] || {})[round])) || (Array.isArray(oppAnswers) && oppAnswers.length === QUESTION_COUNT);
        if (myDone && !oppDone) {
          applyWaitingPrompt(waitMessageDefault);
        }
      }

      if (myRole === "host" && stateName === "questions") {
        const answersNode = data.answers || {};
        const submittedNode = data.submitted || {};
        const myAnswers = ((answersNode[myRole] || {})[round] || []);
        const oppAnswers = ((answersNode[oppRole] || {})[round] || []);
        const myDone = Boolean(((submittedNode[myRole] || {})[round])) || (Array.isArray(myAnswers) && myAnswers.length === QUESTION_COUNT);
        const oppDone = Boolean(((submittedNode[oppRole] || {})[round])) || (Array.isArray(oppAnswers) && oppAnswers.length === QUESTION_COUNT);
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

    stopWatcher = () => {
      try { stopRoomWatcherCleanup && stopRoomWatcherCleanup(); } catch {}
    };

    this.unmount = () => {
      alive = false;
      clearAdvanceTimer();
      try { stopWatcher && stopWatcher(); } catch {}
      pauseRoundTimer(timerContext);
      try { removePopStateListener(); } catch {}
    };
  },

  async unmount() { /* instance handles cleanup */ }
};
