// /src/views/Questions.js
//
// Questions phase — redesigned floating panel with auto-advance per selection.
// • Shows exactly three questions for the player’s role.
// • Muted pastel hue is applied per mount; answers auto-advance after 0.5s hold.
// • Third selection no longer auto-submits — Submit activates once all chosen.
// • Submission writes answers.{role}.{round} = [{ chosen }, …] and timestamps.updatedAt.
// • Host watches both submissions and flips state → "marking".
// • Local UI keeps selections in memory only; Firestore only written on submission.

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
  const n = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
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

export default {
  async mount(container) {
    const me = await ensureAuth();

    const params = getHashParams();
    const code = clampCode(params.get("code") || "");
    const requestedRound = parseInt(params.get("round") || "", 10);
    let round = Number.isFinite(requestedRound) && requestedRound > 0 ? requestedRound : null;

    const hue = Math.floor(Math.random() * 360);
    const rootEl = document.documentElement;
    const computed = getComputedStyle(rootEl);
    const prevInkH = computed.getPropertyValue("--ink-h").trim();
    const prevInkS = computed.getPropertyValue("--ink-s").trim();
    const prevInkL = computed.getPropertyValue("--ink-l").trim();
    rootEl.style.setProperty("--ink-h", String(hue));
    rootEl.style.setProperty("--ink-s", "30%");
    rootEl.style.setProperty("--ink-l", "32%");

    container.innerHTML = "";
    const root = el("div", { class: "view stage-center view-questions" });

    const heading = el("h1", { class: "mono phase-title" }, "Questions");
    root.appendChild(heading);

    const chipRow = el("div", { class: "phase-chips" });
    root.appendChild(chipRow);

    const panel = el("div", { class: "phase-panel phase-panel--questions" });
    const prompt = el("div", { class: "mono phase-panel__prompt" }, "");
    panel.appendChild(prompt);

    const dividerTop = el("div", { class: "phase-divider phase-divider--hidden" });
    panel.appendChild(dividerTop);

    const optionsWrap = el("div", { class: "phase-options phase-options--hidden" });
    panel.appendChild(optionsWrap);

    const dividerBottom = el("div", { class: "phase-divider phase-divider--hidden" });
    panel.appendChild(dividerBottom);

    root.appendChild(panel);

    const submitRow = el("div", { class: "phase-submit-row" });
    const submitBtn = el("button", {
      class: "phase-submit",
      type: "button",
      disabled: "disabled",
    }, "Submit");
    submitRow.appendChild(submitBtn);
    root.appendChild(submitRow);

    container.appendChild(root);

    const chips = [];
    for (let i = 0; i < 3; i += 1) {
      const chip = el("button", {
        class: "phase-chip",
        type: "button",
      }, String(i + 1));
      chip.addEventListener("click", () => {
        if (!tripletReady) return;
        if (submitting || published) return;
        showQuestion(i);
      });
      chips.push(chip);
      chipRow.appendChild(chip);
    }

    const choiceButtons = [0, 1].map(() => {
      const button = el("button", {
        class: "phase-choice",
        type: "button",
        "aria-pressed": "false",
      });
      optionsWrap.appendChild(button);
      return button;
    });

    const rRef = roomRef(code);

    let idx = 0;
    let triplet = [];
    let tripletReady = false;
    const chosen = ["", "", ""];
    let published = false;
    let submitting = false;
    let advanceTimer = null;
    let stopWatcher = null;
    let alive = true;
    let removePopStateListener = () => {};

    const timerContext = { code, role: "guest", round: 1 };
    let oppName = "Opponent";

    const setOptionsVisible = (visible) => {
      optionsWrap.classList.toggle("phase-options--hidden", !visible);
      dividerTop.classList.toggle("phase-divider--hidden", !visible);
      dividerBottom.classList.toggle("phase-divider--hidden", !visible);
    };

    const setButtonsEnabled = (enabled) => {
      choiceButtons.forEach((btn) => {
        btn.disabled = !enabled;
        if (!enabled) btn.classList.remove("phase-choice--hovered");
      });
    };

    const updateChipStates = () => {
      chips.forEach((chip, index) => {
        const answered = Boolean(chosen[index]);
        chip.classList.toggle("phase-chip--answered", answered);
        chip.classList.toggle("phase-chip--active", index === idx && tripletReady);
        chip.disabled = !tripletReady || submitting || published;
      });
    };

    const updateSubmitState = () => {
      const allAnswered = tripletReady && chosen.every((value) => Boolean(value));
      const ready = allAnswered && !published && !submitting;
      submitBtn.disabled = !ready;
      submitBtn.classList.toggle("phase-submit--ready", ready);
      submitBtn.classList.toggle("phase-submit--busy", submitting);
      submitBtn.classList.toggle("phase-submit--waiting", published);
      if (submitting) {
        submitBtn.textContent = "Submitting…";
      } else if (published) {
        submitBtn.textContent = oppName ? `Waiting for ${oppName}…` : "Submitted";
      } else {
        submitBtn.textContent = "Submit";
      }
    };

    const refreshChoiceStyles = () => {
      const current = chosen[idx] || "";
      choiceButtons.forEach((btn) => {
        const text = btn.textContent || "";
        const isSelected = Boolean(current) && text === current;
        btn.classList.toggle("phase-choice--selected", isSelected);
        btn.setAttribute("aria-pressed", isSelected ? "true" : "false");
      });
    };

    const clearAdvanceTimer = () => {
      if (advanceTimer) {
        clearTimeout(advanceTimer);
        advanceTimer = null;
      }
    };

    const findNextUnanswered = (startIndex) => {
      if (!tripletReady) return null;
      for (let i = startIndex + 1; i < triplet.length; i += 1) {
        if (!chosen[i]) return i;
      }
      for (let i = 0; i < triplet.length; i += 1) {
        if (!chosen[i]) return i;
      }
      return null;
    };

    const historySupported =
      typeof window !== "undefined" &&
      window.history &&
      typeof window.history.pushState === "function" &&
      typeof window.history.replaceState === "function";
    const historyKey = "jemimaQuestions";
    let historyIndex = null;

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

    const showQuestion = (targetIdx, options = {}) => {
      if (!tripletReady) return;
      clearAdvanceTimer();
      if (targetIdx < 0) targetIdx = 0;
      if (targetIdx >= triplet.length) targetIdx = triplet.length - 1;
      idx = targetIdx;
      const current = triplet[idx] || {};
      prompt.textContent = current.question || "";
      choiceButtons[0].textContent = current.options?.[0] || "";
      choiceButtons[1].textContent = current.options?.[1] || "";
      setOptionsVisible(true);
      if (!published && !submitting) {
        setButtonsEnabled(true);
        resumeRoundTimer(timerContext);
      } else {
        setButtonsEnabled(false);
      }
      refreshChoiceStyles();
      updateChipStates();
      updateSubmitState();
      if (!options.skipHistory) {
        const shouldReplace = historyIndex === null || options.forceReplace;
        recordHistoryIndex(idx, { replace: shouldReplace });
      } else {
        historyIndex = idx;
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

    const clearUIForLoading = (text) => {
      prompt.textContent = text;
      setOptionsVisible(false);
      setButtonsEnabled(false);
      updateChipStates();
      updateSubmitState();
      pauseRoundTimer(timerContext);
    };

    const publishAnswers = async () => {
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
        pauseRoundTimer(timerContext);
        setButtonsEnabled(false);
        updateChipStates();
        updateSubmitState();
      } catch (err) {
        console.warn("[questions] publish failed:", err);
        submitting = false;
        updateSubmitState();
        if (!published) {
          setButtonsEnabled(true);
        }
      }
    };

    const finishRound = () => {
      if (submitting || published) return;
      const allAnswered = tripletReady && chosen.every((value) => Boolean(value));
      if (!allAnswered) return;
      submitting = true;
      setButtonsEnabled(false);
      updateSubmitState();
      pauseRoundTimer(timerContext);
      publishAnswers();
    };

    const onPick = (text) => {
      if (published || submitting) return;
      if (!tripletReady) return;
      const currentIndex = idx;
      clearAdvanceTimer();
      chosen[currentIndex] = text;
      refreshChoiceStyles();
      updateChipStates();
      updateSubmitState();
      advanceTimer = setTimeout(() => {
        advanceTimer = null;
        if (published || submitting || !alive) return;
        const next = findNextUnanswered(currentIndex);
        if (next === null) {
          updateSubmitState();
        } else {
          showQuestion(next);
        }
      }, 500);
    };

    choiceButtons[0].addEventListener("click", () => onPick(choiceButtons[0].textContent || ""));
    choiceButtons[1].addEventListener("click", () => onPick(choiceButtons[1].textContent || ""));

    submitBtn.addEventListener("click", () => {
      if (submitBtn.disabled) return;
      finishRound();
    });

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
    timerContext.role = myRole;
    timerContext.round = round;

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

    clearUIForLoading("Preparing questions…");
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

    tripletReady = triplet.every((entry) => entry.question && entry.options && entry.options.length === 2);

    const existingAns = (((room0.answers || {})[myRole] || {})[round] || []);
    if (!tripletReady) {
      clearUIForLoading("Preparing questions…");
    } else if (Array.isArray(existingAns) && existingAns.length === 3) {
      for (let i = 0; i < 3; i += 1) {
        chosen[i] = existingAns[i]?.chosen || "";
      }
      published = true;
      setButtonsEnabled(false);
      const answeredIndices = chosen
        .map((value, index) => (value ? index : -1))
        .filter((value) => value >= 0);
      const targetIndex = answeredIndices.length ? answeredIndices[answeredIndices.length - 1] : 0;
      showQuestion(targetIndex, { skipHistory: true, forceReplace: true });
      pauseRoundTimer(timerContext);
    } else {
      tripletReady = true;
      showQuestion(0, { forceReplace: true });
    }

    updateChipStates();
    updateSubmitState();

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
          location.hash = `#/marking?code=${code}&round=${round}`;
        }, 80);
        return;
      }

      if (state === "countdown") {
        setTimeout(() => {
          location.hash = `#/countdown?code=${code}&round=${data.round || round}`;
        }, 80);
        return;
      }

      if (state === "award") {
        setTimeout(() => {
          location.hash = `#/award?code=${code}&round=${round}`;
        }, 80);
        return;
      }

      if (published && alive) {
        const myAnswers = (((data.answers || {})[myRole] || {})[round] || []);
        const oppAnswers = (((data.answers || {})[oppRole] || {})[round] || []);
        const myDone = Array.isArray(myAnswers) && myAnswers.length === 3;
        const oppDone = Array.isArray(oppAnswers) && oppAnswers.length === 3;
        if (myDone) {
          published = true;
          setButtonsEnabled(false);
          updateChipStates();
          updateSubmitState();
        }
        if (myDone && !oppDone) {
          updateSubmitState();
        }
      }

      if (myRole === "host" && state === "questions") {
        const answersHost = (((data.answers || {}).host || {})[round] || []);
        const answersGuest = (((data.answers || {}).guest || {})[round] || []);
        const myDone = Array.isArray(answersHost) && answersHost.length === 3;
        const oppDone = Array.isArray(answersGuest) && answersGuest.length === 3;
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
      pauseRoundTimer(timerContext);
      try { removePopStateListener(); } catch {}
      rootEl.style.setProperty("--ink-h", prevInkH || "210");
      rootEl.style.setProperty("--ink-s", prevInkS || "62%");
      rootEl.style.setProperty("--ink-l", prevInkL || "18%");
    };
  },

  async unmount() { /* handled per-instance */ }
};
