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

    const hue = Math.floor(Math.random() * 360);
    const saturation = (24 + Math.random() * 8).toFixed(1);
    const lightness = (30 + Math.random() * 6).toFixed(1);
    const rootStyle = document.documentElement.style;
    rootStyle.setProperty("--ink-h", String(hue));
    rootStyle.setProperty("--ink-s", `${saturation}%`);
    rootStyle.setProperty("--ink-l", `${lightness}%`);

    container.innerHTML = "";
    const root = el("div", { class: "view view-questions stage-center phase-shell" });

    const title = el("h1", { class: "mono phase-title" }, "Questions");
    const chipRow = el("div", { class: "phase-chips" });
    const chips = [1, 2, 3].map((n) => {
      const chip = el("button", { class: "phase-chip", type: "button" }, String(n));
      chip.setAttribute("aria-current", "false");
      chipRow.appendChild(chip);
      return chip;
    });

    const panel = el("div", { class: "phase-panel" });
    const qText = el("div", { class: "mono phase-panel__prompt" }, "");
    const panelDivider = el("div", { class: "phase-panel__divider" });
    const answersWrap = el("div", { class: "phase-panel__answers" });
    const btn1 = el("button", { class: "btn phase-choice", type: "button" }, "");
    const btn2 = el("button", { class: "btn phase-choice", type: "button" }, "");
    answersWrap.appendChild(btn1);
    answersWrap.appendChild(btn2);
    panel.appendChild(qText);
    panel.appendChild(panelDivider);
    panel.appendChild(answersWrap);

    const submitBtn = el(
      "button",
      { class: "btn phase-submit", type: "button", disabled: "disabled" },
      "Submit"
    );

    root.appendChild(title);
    root.appendChild(chipRow);
    root.appendChild(panel);
    root.appendChild(submitBtn);

    container.appendChild(root);

    let idx = 0;
    const chosen = ["", "", ""];
    let published = false;
    let submitting = false;
    let advanceTimer = null;
    let tripletReady = false;
    let waitingForOpponent = false;


    chips.forEach((chip, index) => {
      chip.addEventListener("click", () => {
        if (published || submitting || !tripletReady) return;
        showQuestion(index);
      });
    });

    const updateChips = () => {
      const canNavigate = tripletReady && !published && !submitting;
      chips.forEach((chip, index) => {
        const isCurrent = index === idx;
        const isComplete = Boolean(chosen[index]);
        chip.classList.toggle("is-active", isCurrent);
        chip.classList.toggle("is-complete", isComplete);
        chip.disabled = !canNavigate;
        chip.setAttribute("aria-current", isCurrent ? "step" : "false");
      });
    };

    const setButtonsEnabled = (enabled) => {
      const allow = Boolean(enabled) && tripletReady && !published && !submitting;
      btn1.disabled = !allow;
      btn2.disabled = !allow;
    };

    const applyChoiceStyles = () => {
      const current = chosen[idx] || "";
      [btn1, btn2].forEach((button) => {
        const value = button.dataset.optionValue || button.textContent || "";
        const isSelected = Boolean(current) && value === current;
        button.classList.toggle("is-selected", isSelected);
        button.classList.toggle("is-answered", Boolean(chosen[idx]));
      });
    };

    const updateSubmitState = () => {
      if (submitting) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Submitting…";
        submitBtn.classList.add("is-busy");
        submitBtn.classList.remove("is-ready");
        submitBtn.classList.remove("is-submitted");
        return;
      }

      submitBtn.classList.remove("is-busy");

      if (published) {
        submitBtn.disabled = true;
        submitBtn.textContent = waitingForOpponent ? "Waiting…" : "Submitted";
        submitBtn.classList.remove("is-ready");
        submitBtn.classList.add("is-submitted");
        return;
      }

      const ready = tripletReady && chosen.every((value) => Boolean(value));
      submitBtn.disabled = !ready;
      submitBtn.textContent = "Submit";
      submitBtn.classList.toggle("is-ready", ready);
      submitBtn.classList.remove("is-submitted");
    };

    const setWaitingState = (_message) => {
      waitingForOpponent = true;
      panel.classList.add("is-locked", "is-waiting");
      setButtonsEnabled(false);
      updateChips();
      updateSubmitState();
    };

    const setLoadingState = (message) => {
      panel.classList.add("is-locked", "is-waiting");
      qText.textContent = message || "Loading…";
      answersWrap.classList.add("is-hidden");
      setButtonsEnabled(false);
      updateChips();
      updateSubmitState();
    };

    const clearLoadingState = () => {
      answersWrap.classList.remove("is-hidden");
      panel.classList.remove("is-waiting");
      if (!published) panel.classList.remove("is-locked");
    };

    setLoadingState("Preparing questions…");

    let stopWatcher = null;
    let alive = true;
    let removePopStateListener = () => {};
    this.unmount = () => {
      alive = false;
      try { stopWatcher && stopWatcher(); } catch {}
      try { removePopStateListener(); } catch {}
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

    const existingAns = (((room0.answers || {})[myRole] || {})[round] || []);

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
          setLoadingState("Waiting for round data…");
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

    const tier = roundTier(round);
    const triplet = [0, 1, 2].map((i) => {
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

    const timerContext = { code, role: myRole, round };

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

    const clearAdvanceTimer = () => {
      if (advanceTimer) {
        clearTimeout(advanceTimer);
        advanceTimer = null;
      }
    };

    const findNextUnanswered = (fromIndex) => {
      if (!tripletReady) return null;
      const total = triplet.length;
      for (let offset = 1; offset <= total; offset += 1) {
        const target = (fromIndex + offset) % total;
        if (!chosen[target]) return target;
      }
      return null;
    };

    function showQuestion(targetIdx, options = {}) {
      clearAdvanceTimer();
      if (triplet.length === 0) return;
      if (targetIdx < 0) targetIdx = 0;
      if (targetIdx >= triplet.length) targetIdx = triplet.length - 1;
      idx = targetIdx;
      const cur = triplet[idx] || {};
      clearLoadingState();
      if (!published) {
        panel.classList.remove("is-locked");
      }
      waitingForOpponent = false;
      const optA = cur.options?.[0] || "";
      const optB = cur.options?.[1] || "";
      qText.textContent = cur.question || "";
      btn1.textContent = optA;
      btn1.dataset.optionValue = optA;
      btn2.textContent = optB;
      btn2.dataset.optionValue = optB;
      setButtonsEnabled(true);
      applyChoiceStyles();
      updateChips();
      if (!options.skipHistory) {
        const shouldReplace = historyIndex === null || options.forceReplace;
        recordHistoryIndex(idx, { replace: shouldReplace });
      } else {
        historyIndex = idx;
      }
      resumeRoundTimer(timerContext);
      updateSubmitState();
    }

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

    async function publishAnswers() {
      if (submitting || published) return;
      if (!tripletReady || !chosen.every((value) => Boolean(value))) return;
      submitting = true;
      waitingForOpponent = false;
      clearAdvanceTimer();
      setButtonsEnabled(false);
      panel.classList.add("is-locked");
      updateSubmitState();

      const payload = triplet.map((entry, idx) => ({
        question: entry.question || "",
        chosen: chosen[idx] || "",
        correct: entry.correct || "",
      }));
      const patch = {
        [`answers.${myRole}.${round}`]: payload,
        [`submitted.${myRole}.${round}`]: true,
        "timestamps.updatedAt": serverTimestamp()
      };

      try {
        console.log(`[flow] submit answers | code=${code} round=${round} role=${myRole}`);
        await updateDoc(rRef, patch);
        published = true;
        submitting = false;
        pauseRoundTimer(timerContext);
        setWaitingState();
      } catch (err) {
        console.warn("[questions] publish failed:", err);
        submitting = false;
        if (!published) {
          panel.classList.remove("is-waiting");
          panel.classList.remove("is-locked");
          waitingForOpponent = false;
          updateSubmitState();
          setButtonsEnabled(true);
          updateChips();
          resumeRoundTimer(timerContext);
        }
      }
    }

    function onPick(text) {
      if (published || submitting) return;
      const currentIndex = idx;
      clearAdvanceTimer();
      chosen[currentIndex] = text;
      applyChoiceStyles();
      updateChips();
      updateSubmitState();
      advanceTimer = setTimeout(() => {
        advanceTimer = null;
        if (published || submitting || !alive) return;
        const nextIdx = findNextUnanswered(currentIndex);
        if (nextIdx === null) {
          updateChips();
          updateSubmitState();
        } else {
          showQuestion(nextIdx);
        }
      }, 500);
    }

    btn1.addEventListener("click", () => onPick(btn1.dataset.optionValue || btn1.textContent || ""));
    btn2.addEventListener("click", () => onPick(btn2.dataset.optionValue || btn2.textContent || ""));

    submitBtn.addEventListener("click", () => {
      if (submitting || published) return;
      publishAnswers();
    });

    tripletReady = triplet.every((entry) =>
      entry.question && entry.options && entry.options.length === 2
    );

    if (!tripletReady) {
      setLoadingState("Preparing questions…");
      pauseRoundTimer(timerContext);
    } else {
      clearLoadingState();
      if (existingAns.length) {
        for (let i = 0; i < chosen.length; i += 1) {
          chosen[i] = (existingAns[i] && existingAns[i].chosen) || "";
        }
        if (existingAns.length >= 3 && chosen.every((value) => Boolean(value))) {
          published = true;
          waitingForOpponent = true;
          const lastAnsweredIndex = chosen.reduce((acc, value, index) =>
            value ? index : acc
          , 0);
          showQuestion(lastAnsweredIndex, { skipHistory: true, forceReplace: true });
          setButtonsEnabled(false);
          pauseRoundTimer(timerContext);
          setWaitingState();
        } else {
          const firstOpen = chosen.findIndex((value) => !value);
          const startIndex = firstOpen >= 0 ? firstOpen : 0;
          showQuestion(startIndex, { forceReplace: true });
        }
      } else {
        showQuestion(0, { forceReplace: true });
      }
      updateChips();
      updateSubmitState();
    }

    stopWatcher = onSnapshot(rRef, async (snap) => {
      const data = snap.data() || {};

      const nextRound = Number(data.round) || round;
      if (nextRound !== round) {
        round = nextRound;
      }

      if (data.state === "marking") {
        setTimeout(() => {
          location.hash = `#/marking?code=${code}&round=${round}`;
        }, 80);
        return;
      }

      if (data.state === "countdown") {
        setTimeout(() => {
          location.hash = `#/countdown?code=${code}&round=${data.round || round}`;
        }, 80);
        return;
      }

      if (data.state === "award") {
        setTimeout(() => {
          location.hash = `#/award?code=${code}&round=${round}`;
        }, 80);
      }

      if (published && alive) {
        const myDone = Boolean(((data.submitted || {})[myRole] || {})[round]) || (Array.isArray(((data.answers || {})[myRole] || {})[round]) && (((data.answers || {})[myRole] || {})[round]).length === 3);
        const oppDone = Boolean(((data.submitted || {})[oppRole] || {})[round]) || (Array.isArray(((data.answers || {})[oppRole] || {})[round]) && (((data.answers || {})[oppRole] || {})[round]).length === 3);
        if (myDone && !oppDone) {
          setWaitingState();
        }
      }

      // Host monitors opponent completion to flip state (idempotent)
      if (myRole === "host" && data.state === "questions") {
        const myDone = Boolean(((data.submitted || {})[myRole] || {})[round]) || (Array.isArray(((data.answers || {})[myRole] || {})[round]) && (((data.answers || {})[myRole] || {})[round]).length === 3);
        const oppDone = Boolean(((data.submitted || {})[oppRole] || {})[round]) || (Array.isArray(((data.answers || {})[oppRole] || {})[round]) && (((data.answers || {})[oppRole] || {})[round]).length === 3);
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
      try { removePopStateListener(); } catch {}
    };
  },

  async unmount() { /* instance handles cleanup */ }
};
