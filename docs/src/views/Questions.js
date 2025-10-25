// /src/views/Questions.js
//
// Questions phase — redesigned for award-style continuity.
// • Shows one question at a time with numbered chips and manual submit.
// • Answers auto-advance after a short pause, remaining on the final question.
// • Submission writes answers.{role}.{round} and submitted flag.

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
import NavigationGuard from "../lib/NavigationGuard.js";

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

function setThemeFromHue(hue) {
  const accent = `hsl(${hue}, 28%, 32%)`;
  const accentStrong = `hsl(${hue}, 34%, 24%)`;
  const accentSoft = `hsla(${hue}, 36%, 32%, 0.18)`;
  const complementHue = (hue + 180) % 360;
  const highlight = `hsl(${complementHue}, 74%, 88%)`;
  const highlightText = `hsl(${complementHue}, 46%, 24%)`;
  document.documentElement.style.setProperty("--ink-h", String(hue));
  document.documentElement.style.setProperty("--round-accent", accent);
  document.documentElement.style.setProperty("--round-accent-strong", accentStrong);
  document.documentElement.style.setProperty("--round-accent-soft", accentSoft);
  document.documentElement.style.setProperty("--round-highlight", highlight);
  document.documentElement.style.setProperty("--round-highlight-text", highlightText);
}

function setupLobbyConfirm(root) {
  const overlay = el("div", { class: "round-confirm round-confirm--hidden" });
  const box = el("div", { class: "round-confirm__box" });
  const prompt = el("div", { class: "mono round-confirm__prompt" }, "RETURN TO LOBBY?");
  const actions = el("div", { class: "round-confirm__actions" });
  const yesBtn = el("button", { class: "btn round-confirm__btn" }, "YES");
  const noBtn = el("button", { class: "btn outline round-confirm__btn" }, "NO");
  actions.appendChild(yesBtn);
  actions.appendChild(noBtn);
  box.appendChild(prompt);
  box.appendChild(actions);
  overlay.appendChild(box);
  root.appendChild(overlay);

  let pending = null;

  const close = () => {
    overlay.classList.add("round-confirm--hidden");
    pending = null;
  };

  yesBtn.addEventListener("click", () => {
    if (!pending) return;
    const { onYes } = pending;
    close();
    if (typeof onYes === "function") onYes();
  });

  noBtn.addEventListener("click", () => {
    if (!pending) return;
    const { onNo } = pending;
    close();
    if (typeof onNo === "function") onNo();
  });

  return {
    show(onYes, onNo) {
      pending = { onYes, onNo };
      overlay.classList.remove("round-confirm--hidden");
      requestAnimationFrame(() => { try { yesBtn.focus(); } catch {} });
    },
    destroy() {
      try { root.removeChild(overlay); } catch {}
    },
  };
}

export default {
  async mount(container) {
    const me = await ensureAuth();

    const params = getHashParams();
    const code = clampCode(params.get("code") || "");
    const requestedRound = parseInt(params.get("round") || "", 10);
    let round = Number.isFinite(requestedRound) && requestedRound > 0 ? requestedRound : null;

    const hue = Math.floor(Math.random() * 360);
    setThemeFromHue(hue);

    container.innerHTML = "";
    const root = el("div", { class: "view view-questions stage-center view-round" });

    const panel = el("div", { class: "card round-panel" });
    const heading = el("div", { class: "mono round-heading" }, "QUESTIONS");
    const stepsRow = el("div", { class: "round-steps" });
    const stepButtons = [1, 2, 3].map((num) => {
      const btn = el("button", { class: "round-step", type: "button" }, String(num));
      stepsRow.appendChild(btn);
      return btn;
    });

    const body = el("div", { class: "round-panel__body" });
    const questionText = el("div", { class: "mono round-question" }, "");
    const answersRow = el("div", { class: "round-answers" });
    const answerButtons = [0, 1].map(() => {
      const btn = el("button", { class: "btn outline round-answer", type: "button" }, "");
      answersRow.appendChild(btn);
      return btn;
    });

    body.appendChild(questionText);
    body.appendChild(answersRow);

    const submitBtn = el(
      "button",
      { class: "btn round-submit", type: "button", disabled: "disabled" },
      "SUBMIT ANSWERS"
    );

    panel.appendChild(heading);
    panel.appendChild(stepsRow);
    panel.appendChild(body);
    panel.appendChild(submitBtn);

    root.appendChild(panel);
    container.appendChild(root);

    const confirmOverlay = setupLobbyConfirm(root);

    let allowNavigation = false;
    const guardControl = {
      shouldBlock() {
        if (allowNavigation) {
          allowNavigation = false;
          return false;
        }
        return true;
      },
      confirm(_target, proceed, stay) {
      confirmOverlay.show(
        () => {
          allowNavigation = true;
          NavigationGuard.clearGuard(guardControl);
          proceed("#/lobby");
          allowNavigation = false;
        },
        () => {
          stay();
        }
      );
      },
    };
    NavigationGuard.setGuard(guardControl);

    const permitNavigation = (fn) => {
      allowNavigation = true;
      try {
        fn();
      } catch (err) {
        allowNavigation = false;
        throw err;
      } finally {
        setTimeout(() => { allowNavigation = false; }, 0);
      }
    };

    let idx = 0;
    let triplet = [];
    let chosen = ["", "", ""];
    let published = false;
    let submitting = false;
    let advanceTimer = null;
    let dataReady = false;
    let oppName = "opponent";

    const timerContext = { code, role: "", round: 0 };

    const clearAdvanceTimer = () => {
      if (advanceTimer) {
        clearTimeout(advanceTimer);
        advanceTimer = null;
      }
    };

    const animateSwap = (fn) => {
      body.classList.add("round-panel__body--fading");
      setTimeout(() => {
        fn();
        body.classList.remove("round-panel__body--fading");
      }, 160);
    };

    const updateStepStates = () => {
      stepButtons.forEach((btn, i) => {
        const done = Boolean(chosen[i]);
        const active = i === idx;
        btn.classList.toggle("round-step--active", active);
        btn.classList.toggle("round-step--done", done);
      });
    };

    const refreshAnswerStyles = () => {
      const currentChoice = chosen[idx] || "";
      answerButtons.forEach((btn) => {
        const text = btn.dataset.option || btn.textContent || "";
        const isSelected = Boolean(currentChoice) && text === currentChoice;
        if (isSelected) {
          btn.classList.add("round-answer--selected");
        } else {
          btn.classList.remove("round-answer--selected");
        }
      });
    };

    const setAnswersEnabled = (enabled) => {
      answerButtons.forEach((btn) => {
        btn.disabled = !enabled;
        btn.classList.toggle("round-answer--locked", !enabled);
      });
    };

    const submitLabelDefault = "SUBMIT ANSWERS";
    let submitWaitingLabel = "WAITING";

    const updateSubmitState = () => {
      const allAnswered = chosen.every((entry) => Boolean(entry));
      const canSubmit = dataReady && allAnswered && !published && !submitting;
      submitBtn.disabled = !canSubmit;
      submitBtn.classList.toggle("throb", canSubmit);
      submitBtn.textContent = published ? submitWaitingLabel : submitLabelDefault;
    };

    const showQuestion = (targetIdx, { immediate = false } = {}) => {
      if (!dataReady || triplet.length === 0) return;
      let nextIdx = targetIdx;
      if (nextIdx < 0) nextIdx = 0;
      if (nextIdx >= triplet.length) nextIdx = triplet.length - 1;
      const apply = () => {
        idx = nextIdx;
        const current = triplet[idx] || {};
        const prompt = current.question || "";
        questionText.textContent = `${idx + 1}. ${prompt}`;
        answerButtons.forEach((btn, i) => {
          const optionText = current.options?.[i] || "";
          btn.textContent = optionText;
          btn.dataset.option = optionText;
          btn.classList.remove("round-answer--selected");
        });
        refreshAnswerStyles();
        updateStepStates();
        if (!published && !submitting) {
          setAnswersEnabled(true);
          resumeRoundTimer(timerContext);
        }
      };
      if (immediate) {
        apply();
      } else {
        animateSwap(apply);
      }
    };

    const showPreparing = () => {
      questionText.textContent = "Preparing questions…";
      answersRow.classList.add("round-answers--hidden");
      setAnswersEnabled(false);
      updateStepStates();
      pauseRoundTimer(timerContext);
    };

    const enterWaitingState = () => {
      published = true;
      clearAdvanceTimer();
      pauseRoundTimer(timerContext);
      setAnswersEnabled(false);
      submitBtn.classList.remove("throb");
      submitBtn.disabled = true;
      submitBtn.textContent = submitWaitingLabel;
    };

    const publishAnswers = async () => {
      if (submitting || published) return;
      submitting = true;
      submitBtn.classList.remove("throb");
      submitBtn.disabled = true;
      submitBtn.textContent = "SUBMITTING…";
      setAnswersEnabled(false);
      clearAdvanceTimer();
      pauseRoundTimer(timerContext);

      const payload = triplet.map((entry, index) => ({
        question: entry.question || "",
        chosen: chosen[index] || "",
        correct: entry.correct || "",
      }));
      const patch = {
        [`answers.${timerContext.role}.${round}`]: payload,
        [`submitted.${timerContext.role}.${round}`]: true,
        "timestamps.updatedAt": serverTimestamp(),
      };

      try {
        console.log(`[flow] submit answers | code=${code} round=${round} role=${timerContext.role}`);
        await updateDoc(roomRef(code), patch);
        submitting = false;
        enterWaitingState();
      } catch (err) {
        console.warn("[questions] publish failed:", err);
        submitting = false;
        published = false;
        submitBtn.textContent = submitLabelDefault;
        updateSubmitState();
        setAnswersEnabled(true);
        resumeRoundTimer(timerContext);
      }
    };

    submitBtn.addEventListener("click", () => {
      if (!published && !submitting) publishAnswers();
    });

    answerButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        if (published || submitting || !dataReady) return;
        const currentIndex = idx;
        const text = btn.dataset.option || btn.textContent || "";
        if (!text) return;
        clearAdvanceTimer();
        chosen[currentIndex] = text;
        refreshAnswerStyles();
        updateStepStates();
        updateSubmitState();
        advanceTimer = setTimeout(() => {
          advanceTimer = null;
          if (published || submitting) return;
          const remainingIndex = chosen.findIndex((entry) => !entry);
          if (remainingIndex === -1) {
            showQuestion(currentIndex, { immediate: true });
            submitBtn.focus?.();
          } else if (remainingIndex !== currentIndex) {
            showQuestion(remainingIndex);
          } else if (currentIndex < triplet.length - 1) {
            showQuestion(currentIndex + 1);
          }
        }, 500);
      });
    });

    stepButtons.forEach((btn, i) => {
      btn.addEventListener("click", () => {
        if (!dataReady) return;
        clearAdvanceTimer();
        showQuestion(i);
      });
    });

    let stopWatcher = null;
    let alive = true;

    this.unmount = () => {
      alive = false;
      clearAdvanceTimer();
      try { stopWatcher && stopWatcher(); } catch {}
      pauseRoundTimer(timerContext);
      NavigationGuard.clearGuard(guardControl);
      confirmOverlay.destroy();
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
    oppName = oppRole === "host" ? "Daniel" : "Jaime";
    submitWaitingLabel = `WAITING FOR ${oppName.toUpperCase()}`;

    timerContext.code = code;
    timerContext.role = myRole;
    timerContext.round = round;

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

    showPreparing();
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

    dataReady = triplet.every((entry) => entry.question && entry.options && entry.options.length === 2);

    if (!dataReady) {
      questionText.textContent = "Preparing questions…";
      pauseRoundTimer(timerContext);
    } else {
      answersRow.classList.remove("round-answers--hidden");
      chosen = [0, 1, 2].map((i) => existingAns[i]?.chosen || "");
      const unansweredIdx = chosen.findIndex((entry) => !entry);
      const startIdx = unansweredIdx === -1 ? triplet.length - 1 : unansweredIdx;
      showQuestion(startIdx, { immediate: true });
      updateSubmitState();
      if (unansweredIdx === -1 && existingAns.length === triplet.length) {
        enterWaitingState();
      }
    }

    stopWatcher = onSnapshot(rRef, async (snap) => {
      const data = snap.data() || {};
      const nextRound = Number(data.round) || round;
      if (nextRound !== round) {
        round = nextRound;
        timerContext.round = round;
      }

      const state = (data.state || "").toLowerCase();
      if (state === "marking") {
        setTimeout(() => {
          permitNavigation(() => {
            window.location.hash = `#/marking?code=${code}&round=${round}`;
          });
        }, 80);
        return;
      }
      if (state === "countdown") {
        setTimeout(() => {
          permitNavigation(() => {
            window.location.hash = `#/countdown?code=${code}&round=${data.round || round}`;
          });
        }, 80);
        return;
      }
      if (state === "award") {
        setTimeout(() => {
          permitNavigation(() => {
            window.location.hash = `#/award?code=${code}&round=${round}`;
          });
        }, 80);
      }

      if (published) {
        const myDone = Boolean(((data.submitted || {})[myRole] || {})[round]) || (Array.isArray(((data.answers || {})[myRole] || {})[round]) && (((data.answers || {})[myRole] || {})[round]).length === triplet.length);
        const oppDone = Boolean(((data.submitted || {})[oppRole] || {})[round]) || (Array.isArray(((data.answers || {})[oppRole] || {})[round]) && (((data.answers || {})[oppRole] || {})[round]).length === triplet.length);
        if (myDone && !oppDone) {
          submitBtn.textContent = submitWaitingLabel;
        }
      }

      if (myRole === "host" && state === "questions") {
        const myDone = Boolean(((data.submitted || {})[myRole] || {})[round]) || (Array.isArray(((data.answers || {})[myRole] || {})[round]) && (((data.answers || {})[myRole] || {})[round]).length === triplet.length);
        const oppDone = Boolean(((data.submitted || {})[oppRole] || {})[round]) || (Array.isArray(((data.answers || {})[oppRole] || {})[round]) && (((data.answers || {})[oppRole] || {})[round]).length === triplet.length);
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
  },

  async unmount() { /* instance handles cleanup */ }
};
