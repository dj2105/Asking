// /src/views/Questions.js
//
// Questions phase — local-only until the 3rd selection.
// • Shows exactly the player’s three questions from rooms/{code}/rounds/{round}/{role}Items.
// • Two large buttons per question. Selecting the 3rd answer auto-submits once.
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
import { applyPastelTheme } from "../lib/palette.js";

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

export default {

  async mount(container) {
    const me = await ensureAuth();

    const params = getHashParams();
    const code = clampCode(params.get("code") || "");
    const requestedRound = parseInt(params.get("round") || "", 10);
    let round = Number.isFinite(requestedRound) && requestedRound > 0 ? requestedRound : null;

    const resetTheme = applyPastelTheme();

    container.innerHTML = "";

    let idx = 0;
    let triplet = [];
    const chosen = ["", "", ""];
    let published = false;
    let submitting = false;
    let waitingForOpponent = false;
    let advanceTimer = null;

    const root = el("div", { class: "view view-questions qa-stage" });
    const title = el("h1", { class: "qa-title mono" }, "Questions");
    const chipRow = el("div", { class: "qa-chip-row" });
    const panel = el("div", { class: "qa-panel" });
    const qText = el("div", { class: "mono qa-panel__prompt" }, "Loading…");
    const divider = el("div", { class: "qa-divider" });
    const answersWrap = el("div", { class: "qa-answers" });
    const btn1 = el("button", { class: "qa-answer", type: "button" }, "");
    const btn2 = el("button", { class: "qa-answer", type: "button" }, "");
    answersWrap.appendChild(btn1);
    answersWrap.appendChild(btn2);
    panel.appendChild(qText);
    panel.appendChild(divider);
    panel.appendChild(answersWrap);

    const submitRow = el("div", { class: "qa-submit" });
    const submitBtn = el(
      "button",
      { class: "qa-submit-btn", type: "button", disabled: "disabled" },
      "Submit Answers"
    );
    submitRow.appendChild(submitBtn);

    root.appendChild(title);
    root.appendChild(chipRow);
    root.appendChild(panel);
    root.appendChild(submitRow);

    container.appendChild(root);

    const chipButtons = [0, 1, 2].map((position) => {
      const chip = el(
        "button",
        {
          class: "qa-chip",
          type: "button",
          "aria-label": `Question ${position + 1}`,
          "aria-pressed": "false",
        },
        String(position + 1)
      );
      chip.addEventListener("click", () => {
        if (submitting || published) return;
        showQuestion(position);
      });
      chipRow.appendChild(chip);
      return chip;
    });

    const setPanelLoading = (loading) => {
      panel.classList.toggle("qa-panel--loading", loading);
    };

    const applySelectionStyles = () => {
      const currentValue = chosen[idx] || "";
      [btn1, btn2].forEach((button) => {
        const text = button.textContent || "";
        const isSelected = currentValue && text === currentValue;
        button.classList.toggle("qa-answer--selected", Boolean(isSelected));
      });
    };

    const setButtonsEnabled = (enabled) => {
      btn1.disabled = !enabled;
      btn2.disabled = !enabled;
      panel.classList.toggle("qa-panel--locked", !enabled);
      applySelectionStyles();
    };

    const setChipsEnabled = (enabled) => {
      chipButtons.forEach((chip) => {
        chip.disabled = !enabled;
      });
    };

    const clearAdvanceTimer = () => {
      if (advanceTimer) {
        clearTimeout(advanceTimer);
        advanceTimer = null;
      }
    };

    const updateChipStates = () => {
      chipButtons.forEach((chip, position) => {
        const isActive = position === idx;
        const isDone = Boolean(chosen[position]);
        chip.classList.toggle("qa-chip--active", isActive);
        chip.classList.toggle("qa-chip--done", isDone);
        chip.setAttribute("aria-pressed", isActive ? "true" : "false");
      });
    };

    const refreshSubmitState = () => {
      const ready = chosen.every((value) => Boolean(value));
      let label = "Submit Answers";
      let disabled = false;
      const isReady = ready && !published && !submitting;
      if (submitting) {
        label = "Submitting…";
        disabled = true;
      } else if (published) {
        disabled = true;
        label = waitingForOpponent ? "Submitted — waiting…" : "Submitted";
      } else if (!ready) {
        disabled = true;
      }
      submitBtn.disabled = disabled;
      submitBtn.classList.toggle("is-ready", isReady);
      submitBtn.textContent = label;
    };

    const nextUnanswered = (fromIndex) => {
      for (let i = fromIndex + 1; i < triplet.length; i += 1) {
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

    let timerContext = { code, role: "guest", round: round || 1 };

    const recordHistoryIndex = (nextIndex, { replace = false } = {}) => {
      historyIndex = nextIndex;
      if (!historySupported) return;
      const baseState =
        window.history.state && typeof window.history.state === "object"
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
      clearAdvanceTimer();
      if (triplet.length === 0) return;
      if (targetIdx < 0) targetIdx = 0;
      if (targetIdx >= triplet.length) targetIdx = triplet.length - 1;
      idx = targetIdx;
      const current = triplet[idx] || {};
      qText.textContent = current.question || "";
      btn1.textContent = current.options?.[0] || "";
      btn2.textContent = current.options?.[1] || "";
      applySelectionStyles();
      updateChipStates();
      if (!options.skipHistory) {
        const shouldReplace = historyIndex === null || options.forceReplace;
        recordHistoryIndex(idx, { replace: shouldReplace });
      } else {
        historyIndex = idx;
      }
      if (!published && !submitting) {
        setButtonsEnabled(true);
        setChipsEnabled(true);
        setPanelLoading(false);
        resumeRoundTimer(timerContext);
      } else {
        pauseRoundTimer(timerContext);
      }
      refreshSubmitState();
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

    let removePopStateListener = () => {};
    if (historySupported) {
      window.addEventListener("popstate", handlePopState);
      removePopStateListener = () => {
        try {
          window.removeEventListener("popstate", handlePopState);
        } catch {}
        removePopStateListener = () => {};
      };
    }

    let stopWatcher = null;
    let alive = true;

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
    const myRole =
      storedRole === "host" || storedRole === "guest"
        ? storedRole
        : hostUid === me.uid
          ? "host"
          : guestUid === me.uid
            ? "guest"
            : "guest";
    const oppRole = myRole === "host" ? "guest" : "host";
    timerContext.role = myRole;

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
          setPanelLoading(true);
          setButtonsEnabled(false);
          setChipsEnabled(false);
          qText.textContent = "Waiting for round data…";
          btn1.textContent = "";
          btn2.textContent = "";
          refreshSubmitState();
          firstWait = false;
        }
        if (attempts >= MAX_ATTEMPTS) break;
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      return {};
    };

    const rd = await waitForRoundData();
    if (!alive) {
      resetTheme();
      removePopStateListener();
      return;
    }

    const myItems = (myRole === "host" ? rd.hostItems : rd.guestItems) || [];

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
    for (let i = 0; i < chosen.length; i += 1) {
      const entry = existingAns[i] || {};
      chosen[i] = typeof entry.chosen === "string" ? entry.chosen : "";
    }

    updateChipStates();

    const submittedData = room0.submitted || {};
    const mySubmittedInitial = Boolean((submittedData[myRole] || {})[round]);
    const oppSubmittedInitial = Boolean((submittedData[oppRole] || {})[round]) ||
      (Array.isArray((((room0.answers || {})[oppRole] || {})[round])) &&
        (((room0.answers || {})[oppRole] || {})[round]).length === 3);

    if (mySubmittedInitial && existingAns.length === 3) {
      published = true;
      waitingForOpponent = !oppSubmittedInitial;
      setButtonsEnabled(false);
      setChipsEnabled(false);
      pauseRoundTimer(timerContext);
    }

    const tripletReady = triplet.every((entry) =>
      entry.question && entry.options && entry.options.length === 2
    );

    const firstUnanswered = nextUnanswered(-1);
    if (!tripletReady) {
      setPanelLoading(true);
      setButtonsEnabled(false);
      setChipsEnabled(false);
      qText.textContent = "Preparing questions…";
      btn1.textContent = "";
      btn2.textContent = "";
      pauseRoundTimer(timerContext);
    } else if (published) {
      const targetIndex = Math.min(triplet.length - 1, 2);
      showQuestion(targetIndex, { forceReplace: true });
      setChipsEnabled(false);
      setButtonsEnabled(false);
    } else {
      const targetIndex = firstUnanswered !== null ? firstUnanswered : 0;
      showQuestion(targetIndex, { forceReplace: true });
      setChipsEnabled(true);
      setButtonsEnabled(true);
    }

    refreshSubmitState();

    const onPick = (text) => {
      if (published || submitting) return;
      const currentIndex = idx;
      clearAdvanceTimer();
      chosen[currentIndex] = text;
      applySelectionStyles();
      updateChipStates();
      refreshSubmitState();
      advanceTimer = setTimeout(() => {
        advanceTimer = null;
        if (published || submitting || !alive) return;
        const nextIndex = nextUnanswered(currentIndex);
        if (nextIndex === null) return;
        showQuestion(nextIndex);
      }, 500);
    };

    btn1.addEventListener("click", () => {
      if (!btn1.textContent) return;
      onPick(btn1.textContent);
    });
    btn2.addEventListener("click", () => {
      if (!btn2.textContent) return;
      onPick(btn2.textContent);
    });

    const publishAnswers = async () => {
      if (submitting || published) return;
      if (!tripletReady) return;
      const ready = chosen.every((value) => Boolean(value));
      if (!ready) return;

      submitting = true;
      setButtonsEnabled(false);
      setChipsEnabled(false);
      pauseRoundTimer(timerContext);
      refreshSubmitState();

      const payload = triplet.map((entry, pos) => ({
        question: entry.question || "",
        chosen: chosen[pos] || "",
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
        waitingForOpponent = true;
        refreshSubmitState();
      } catch (err) {
        console.warn("[questions] publish failed:", err);
        submitting = false;
        published = false;
        setButtonsEnabled(true);
        setChipsEnabled(true);
        resumeRoundTimer(timerContext);
        refreshSubmitState();
      }
    };

    submitBtn.addEventListener("click", () => {
      if (submitBtn.disabled) return;
      publishAnswers();
    });

    stopWatcher = onSnapshot(rRef, async (snap) => {
      const data = snap.data() || {};

      const nextRound = Number(data.round);
      if (Number.isFinite(nextRound) && nextRound !== round) {
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
        const submittedInfo = data.submitted || {};
        const answersInfo = data.answers || {};
        const myDone = Boolean((submittedInfo[myRole] || {})[round]) ||
          (Array.isArray((answersInfo[myRole] || {})[round]) && ((answersInfo[myRole] || {})[round]).length === 3);
        const oppDone = Boolean((submittedInfo[oppRole] || {})[round]) ||
          (Array.isArray((answersInfo[oppRole] || {})[round]) && ((answersInfo[oppRole] || {})[round]).length === 3);
        waitingForOpponent = myDone && !oppDone;
        refreshSubmitState();
      }

      if (myRole === "host" && stateName === "questions") {
        const submittedInfo = data.submitted || {};
        const answersInfo = data.answers || {};
        const myDone = Boolean((submittedInfo[myRole] || {})[round]) ||
          (Array.isArray((answersInfo[myRole] || {})[round]) && ((answersInfo[myRole] || {})[round]).length === 3);
        const oppDone = Boolean((submittedInfo[oppRole] || {})[round]) ||
          (Array.isArray((answersInfo[oppRole] || {})[round]) && ((answersInfo[oppRole] || {})[round]).length === 3);
        if (myDone && oppDone) {
          try {
            console.log(`[flow] questions -> marking | code=${code} round=${round} role=${myRole}`);
            await updateDoc(rRef, {
              state: "marking",
              "timestamps.updatedAt": serverTimestamp()
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
      removePopStateListener();
      resetTheme();
    };
  },
  async unmount() { /* instance handles cleanup */ }
};
