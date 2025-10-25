// /src/views/Questions.js
//
// Questions phase — award-style layout with single panel.
// • Presents three questions sequentially with numbered chips for navigation.
// • Selections highlight for 0.5s before automatically moving to the next unanswered question.
// • Submit button becomes active once all three answers are chosen; submission waits for the opponent.

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

function shuffle2(a, b) {
  return Math.random() < 0.5 ? [a, b] : [b, a];
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
    const requestedRound = parseInt(params.get("round") || "", 10);
    let round = Number.isFinite(requestedRound) && requestedRound > 0 ? requestedRound : null;

    const hue = Math.floor(Math.random() * 360);
    setHueVariables(hue);

    container.innerHTML = "";
    const root = el("div", { class: "view view-questions stage-center" });
    const card = el("div", { class: "card round-card" });

    const heading = el("div", { class: "mono round-card__heading" }, "QUESTIONS");
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
    const choices = el("div", { class: "round-card__choices" });
    const optionButtons = [0, 1].map(() => {
      const btn = el("button", {
        class: "round-choice",
        type: "button",
        "aria-pressed": "false",
      }, "");
      choices.appendChild(btn);
      return btn;
    });

    const statusText = el("div", { class: "mono round-card__status round-card__status--hidden" }, "");
    const submitBtn = el("button", {
      class: "btn round-card__submit",
      type: "button",
      disabled: "",
    }, "SUBMIT ROUND");

    card.appendChild(heading);
    card.appendChild(stepRow);
    card.appendChild(prompt);
    card.appendChild(choices);
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

    const timerContext = { code, role: "", round: 1 };

    let idx = 0;
    const chosen = ["", "", ""];
    let published = false;
    let submitting = false;
    let advanceTimer = null;
    let stopWatcher = null;
    let alive = true;
    let waitMessageDefault = "Waiting…";
    let guardActive = true;
    let chipsEnabled = false;

    const historySupported = typeof window !== "undefined" && "addEventListener" in window && window.history;

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

    const setChoicesEnabled = (enabled) => {
      optionButtons.forEach((btn) => {
        btn.disabled = !enabled;
      });
    };

    const setChoicesVisible = (visible) => {
      choices.classList.toggle("round-card__choices--hidden", !visible);
    };

    const setChipNavigation = (enabled) => {
      chipsEnabled = enabled;
      chips.forEach((chip) => {
        chip.disabled = !enabled || published || submitting;
      });
    };

    setChoicesEnabled(false);
    setChipNavigation(false);

    const updateChips = () => {
      chips.forEach((chip, index) => {
        chip.classList.toggle("round-step--active", index === idx);
        chip.classList.toggle("round-step--answered", Boolean(chosen[index]));
        chip.disabled = !chipsEnabled || published || submitting;
      });
    };

    const refreshChoiceStyles = () => {
      const currentSelection = chosen[idx] || "";
      optionButtons.forEach((btn) => {
        const matches = currentSelection && btn.textContent === currentSelection;
        btn.classList.toggle("round-choice--selected", Boolean(matches));
        btn.setAttribute("aria-pressed", matches ? "true" : "false");
      });
    };

    const updateSubmitState = () => {
      const ready = chosen.every((value) => Boolean(value)) && !published && !submitting;
      submitBtn.disabled = !ready;
      submitBtn.classList.toggle("throb", ready);
    };

    const findNextUnanswered = (start) => {
      for (let i = start + 1; i < chosen.length; i += 1) {
        if (!chosen[i]) return i;
      }
      for (let i = 0; i < chosen.length; i += 1) {
        if (!chosen[i]) return i;
      }
      return null;
    };

    const showQuestion = (targetIdx) => {
      clearAdvanceTimer();
      if (!triplet.length) return;
      const clamped = Math.max(0, Math.min(targetIdx, triplet.length - 1));
      idx = clamped;
      const current = triplet[idx] || {};
      prompt.textContent = current.question || "";
      optionButtons.forEach((btn, optionIndex) => {
        const text = current.options?.[optionIndex] || "";
        btn.textContent = text;
        btn.disabled = published || submitting;
      });
      setChoicesVisible(true);
      setStatus("");
      setChoicesEnabled(!published && !submitting);
      setChipNavigation(true);
      updateChips();
      refreshChoiceStyles();
      updateSubmitState();
      resumeRoundTimer(timerContext);
    };

    const handlePick = (text) => {
      if (published || submitting) return;
      if (!text) return;
      const currentIndex = idx;
      chosen[currentIndex] = text;
      refreshChoiceStyles();
      updateChips();
      updateSubmitState();
      clearAdvanceTimer();
      const nextIdx = findNextUnanswered(currentIndex);
      advanceTimer = setTimeout(() => {
        advanceTimer = null;
        if (!alive || published || submitting) return;
        if (nextIdx === null || nextIdx === currentIndex) {
          showQuestion(currentIndex);
        } else {
          showQuestion(nextIdx);
        }
      }, 500);
    };

    optionButtons.forEach((btn) => {
      btn.addEventListener("click", () => handlePick(btn.textContent || ""));
    });

    chips.forEach((chip, index) => {
      chip.addEventListener("click", () => {
        if (!chipsEnabled || published || submitting) return;
        showQuestion(index);
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
          location.hash = `#/questions?code=${code}&round=${round}`;
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

    const publishAnswers = async () => {
      if (submitting || published) return;
      submitting = true;
      updateSubmitState();
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
        setStatus(waitMessageDefault);
        updateSubmitState();
        setChipNavigation(false);
      } catch (err) {
        console.warn("[questions] publish failed:", err);
        submitting = false;
        setStatus("Retrying…");
        setChoicesEnabled(true);
        setChipNavigation(true);
        updateSubmitState();
      }
    };

    submitBtn.addEventListener("click", () => {
      if (published || submitting) return;
      pauseRoundTimer(timerContext);
      setChoicesEnabled(false);
      setChipNavigation(false);
      setStatus("Submitting answers…");
      publishAnswers();
    });

    let triplet = [];

    const rRef = roomRef(code);

    const roomSnap0 = await getDoc(rRef);
    const room0 = roomSnap0.data() || {};
    if (!round) {
      const roomRound = Number(room0.round);
      round = Number.isFinite(roomRound) && roomRound > 0 ? roomRound : 1;
    }
    timerContext.round = round;

    const rdRef = doc(roundSubColRef(code), String(round));
    const { hostUid, guestUid } = room0.meta || {};
    const storedRole = getStoredRole(code);
    const myRole = storedRole === "host" || storedRole === "guest"
      ? storedRole
      : hostUid === me.uid ? "host" : guestUid === me.uid ? "guest" : "guest";
    const oppRole = myRole === "host" ? "guest" : "host";
    const oppName = oppRole === "host" ? "Daniel" : "Jaime";
    timerContext.role = myRole;
    waitMessageDefault = `Waiting for ${oppName}…`;

    const waitForRoundData = async () => {
      let firstWait = true;
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
        if (firstWait) {
          setStatus("Waiting for round data…");
          setChoicesVisible(false);
          setChoicesEnabled(false);
          setChipNavigation(false);
          firstWait = false;
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

    const existingAns = (((room0.answers || {})[myRole] || {})[round] || []);
    const submittedAlready = Boolean(((room0.submitted || {})[myRole] || {})[round]);
    existingAns.forEach((entry, index) => {
      if (entry && typeof entry.chosen === "string") {
        chosen[index] = entry.chosen;
      }
    });

    if (submittedAlready) {
      published = true;
      setChoicesEnabled(false);
      setChipNavigation(false);
      updateSubmitState();
      setStatus(waitMessageDefault);
    }

    const tripletReady = triplet.every((entry) => entry.question && entry.options && entry.options.length === 2);

    if (!tripletReady) {
      setStatus("Preparing questions…");
      setChoicesVisible(false);
      pauseRoundTimer(timerContext);
    } else if (published) {
      setChoicesVisible(false);
      pauseRoundTimer(timerContext);
    } else {
      showQuestion(0);
    }

    stopWatcher = onSnapshot(rRef, async (snap) => {
      const data = snap.data() || {};

      const nextRound = Number(data.round) || round;
      if (nextRound !== round) {
        round = nextRound;
        timerContext.round = round;
      }

      const stateName = (data.state || "").toLowerCase();
      if (stateName === "marking") {
        releaseGuard();
        setTimeout(() => {
          location.hash = `#/marking?code=${code}&round=${round}`;
        }, 80);
        return;
      }

      if (stateName === "countdown") {
        releaseGuard();
        setTimeout(() => {
          location.hash = `#/countdown?code=${code}&round=${data.round || round}`;
        }, 80);
        return;
      }

      if (stateName === "award") {
        releaseGuard();
        setTimeout(() => {
          location.hash = `#/award?code=${code}&round=${round}`;
        }, 80);
        return;
      }

      if (stateName === "final") {
        releaseGuard();
        setTimeout(() => { location.hash = `#/final?code=${code}`; }, 80);
        return;
      }

      if (published && alive) {
        const answersMine = (((data.answers || {})[myRole] || {})[round] || []);
        if (Array.isArray(answersMine) && answersMine.length === 3) {
          answersMine.forEach((entry, index) => {
            if (entry && typeof entry.chosen === "string") {
              chosen[index] = entry.chosen;
            }
          });
          refreshChoiceStyles();
        }
        const myDone = Boolean(((data.submitted || {})[myRole] || {})[round]) || (Array.isArray(answersMine) && answersMine.length === 3);
        const oppDone = Boolean(((data.submitted || {})[oppRole] || {})[round]) || (Array.isArray(((data.answers || {})[oppRole] || {})[round]) && (((data.answers || {})[oppRole] || {})[round]).length === 3);
        if (myDone && !oppDone) {
          setStatus(waitMessageDefault);
        }
      }

      if (myRole === "host" && stateName === "questions") {
        const answersMine = (((data.answers || {})[myRole] || {})[round] || []);
        const answersOpp = (((data.answers || {})[oppRole] || {})[round] || []);
        const myDone = Boolean(((data.submitted || {})[myRole] || {})[round]) || (Array.isArray(answersMine) && answersMine.length === 3);
        const oppDone = Boolean(((data.submitted || {})[oppRole] || {})[round]) || (Array.isArray(answersOpp) && answersOpp.length === 3);
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

    this._cleanup = () => {
      alive = false;
      clearAdvanceTimer();
      try { stopWatcher && stopWatcher(); } catch {}
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
