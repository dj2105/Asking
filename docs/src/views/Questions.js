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
    document.documentElement.style.setProperty("--ink-h", String(hue));

    container.innerHTML = "";
    const root = el("div", { class: "view view-questions stage-center qa-shell" });

    const heading = el("div", { class: "qa-heading mono" }, "Questions");
    const switcher = el("div", { class: "qa-switcher" });
    const chips = [0, 1, 2].map((i) => {
      const chip = el(
        "button",
        {
          class: "qa-chip",
          type: "button",
          "aria-label": `Question ${i + 1}`,
        },
        String(i + 1)
      );
      switcher.appendChild(chip);
      return chip;
    });

    const questionBlock = el("div", { class: "qa-question" });
    const qText = el("div", { class: "qa-question__text" }, "Preparing questions…");
    questionBlock.appendChild(qText);

    const answersWrap = el("div", { class: "qa-answers" });
    const btn1 = el(
      "button",
      { class: "qa-answer", type: "button" },
      ""
    );
    const btn2 = el(
      "button",
      { class: "qa-answer", type: "button" },
      ""
    );
    answersWrap.appendChild(btn1);
    answersWrap.appendChild(btn2);

    btn1.disabled = true;
    btn2.disabled = true;
    answersWrap.classList.add("qa-answers--hidden");

    const submitBtn = el(
      "button",
      { class: "qa-submit", type: "button", disabled: "disabled" },
      "Submit"
    );
    const defaultSubmitLabel = "Submit";
    let customSubmitLabel = null;
    const setSubmitLabel = (text) => {
      customSubmitLabel = typeof text === "string" && text.trim() ? text : null;
      submitBtn.textContent = customSubmitLabel || defaultSubmitLabel;
    };
    setSubmitLabel();

    root.appendChild(heading);
    root.appendChild(switcher);
    root.appendChild(questionBlock);
    root.appendChild(answersWrap);
    root.appendChild(submitBtn);

    container.appendChild(root);

    let idx = 0;
    const chosen = ["", "", ""];
    let published = false;
    let submitting = false;
    let advanceTimer = null;

    let waitMessageDefault = "Waiting…";

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
    waitMessageDefault = `Waiting for ${oppName}…`;

    const existingAns = (((room0.answers || {})[myRole] || {})[round] || []);

    const setQuestionText = (text) => {
      qText.textContent = text || "";
    };

    const setAnswersVisible = (visible) => {
      answersWrap.classList.toggle("qa-answers--hidden", !visible);
    };

    function refreshChoiceStyles() {
      const current = chosen[idx] || "";
      const matches = (btn) => Boolean(current) && (btn.textContent || "") === current;
      [btn1, btn2].forEach((btn) => {
        const selected = matches(btn);
        btn.classList.toggle("qa-answer--selected", selected);
      });
    }

    const setButtonsEnabled = (enabled) => {
      [btn1, btn2].forEach((btn) => {
        btn.disabled = !enabled;
        btn.classList.toggle("qa-answer--disabled", !enabled);
      });
      refreshChoiceStyles();
    };

    const updateSubmitState = () => {
      const complete = chosen.every((value) => Boolean(value));
      submitBtn.disabled = !complete || submitting || published;
      submitBtn.classList.toggle(
        "qa-submit--ready",
        complete && !submitting && !published
      );
      if (!published && !submitting && customSubmitLabel !== null) {
        setSubmitLabel(null);
      }
    };

    const updateChipStates = () => {
      chips.forEach((chip, chipIdx) => {
        const answered = Boolean(chosen[chipIdx]);
        chip.classList.toggle("qa-chip--active", chipIdx === idx);
        chip.classList.toggle("qa-chip--answered", answered);
        chip.disabled = submitting;
      });
    };

    const showStatus = (text, { hideAnswers = true } = {}) => {
      setQuestionText(text || "");
      setAnswersVisible(!hideAnswers);
      setButtonsEnabled(false);
      updateChipStates();
      updateSubmitState();
    };

    const findNextUnanswered = (fromIndex) => {
      for (let i = fromIndex + 1; i < triplet.length; i += 1) {
        if (!chosen[i]) return i;
      }
      for (let i = 0; i < triplet.length; i += 1) {
        if (!chosen[i]) return i;
      }
      return fromIndex;
    };

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
          showStatus("Waiting for round data…");
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

    function showQuestion(targetIdx, options = {}) {
      clearAdvanceTimer();
      if (triplet.length === 0) return;
      if (targetIdx < 0) targetIdx = 0;
      if (targetIdx >= triplet.length) targetIdx = triplet.length - 1;
      idx = targetIdx;
      const cur = triplet[idx];
      const prompt = cur?.question || "";
      setQuestionText(`${idx + 1}. ${prompt}`.trim());
      btn1.textContent = cur?.options?.[0] || "";
      btn2.textContent = cur?.options?.[1] || "";
      setAnswersVisible(true);
      setButtonsEnabled(!(published || submitting));
      refreshChoiceStyles();
      updateChipStates();
      updateSubmitState();
      if (!options.skipHistory) {
        const shouldReplace = historyIndex === null || options.forceReplace;
        recordHistoryIndex(idx, { replace: shouldReplace });
      } else {
        historyIndex = idx;
      }
      if (!(published || submitting)) {
        resumeRoundTimer(timerContext);
      }
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

    chips.forEach((chip, chipIdx) => {
      chip.addEventListener("click", () => {
        if (submitting) return;
        showQuestion(chipIdx);
      });
    });

    const showWaitingState = (text) => {
      const label = text || waitMessageDefault;
      if (triplet.length > 0) {
        const safeIdx = Math.min(Math.max(idx, 0), triplet.length - 1);
        showQuestion(safeIdx, { skipHistory: true, forceReplace: true });
      }
      setButtonsEnabled(false);
      setAnswersVisible(true);
      updateChipStates();
      updateSubmitState();
      setSubmitLabel(label);
      pauseRoundTimer(timerContext);
    };

    async function publishAnswers() {
      if (submitting || published) return;
      submitting = true;
      clearAdvanceTimer();
      setButtonsEnabled(false);
      updateSubmitState();
      updateChipStates();
      setSubmitLabel("Submitting…");
      showStatus("Submitting answers…", { hideAnswers: false });

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
        showWaitingState();
      } catch (err) {
        console.warn("[questions] publish failed:", err);
        submitting = false;
        setButtonsEnabled(true);
        updateSubmitState();
        updateChipStates();
        showQuestion(idx, { skipHistory: true, forceReplace: true });
        setSubmitLabel(null);
      }
    }

    function onPick(text) {
      if (published || submitting) return;
      const currentIndex = idx;
      clearAdvanceTimer();
      chosen[currentIndex] = text;
      refreshChoiceStyles();
      updateSubmitState();
      updateChipStates();
      const targetIdx = findNextUnanswered(currentIndex);
      advanceTimer = setTimeout(() => {
        advanceTimer = null;
        if (published || submitting || !alive) return;
        if (targetIdx !== currentIndex) {
          showQuestion(targetIdx);
        } else {
          updateChipStates();
        }
      }, 240);
    }

    btn1.addEventListener("click", () => onPick(btn1.textContent));
    btn2.addEventListener("click", () => onPick(btn2.textContent));
    submitBtn.addEventListener("click", () => publishAnswers());

    const tripletReady = triplet.every((entry) =>
      entry.question && entry.options && entry.options.length === 2
    );

    if (!tripletReady) {
      showStatus("Preparing questions…");
      pauseRoundTimer(timerContext);
    } else if (existingAns.length === 3) {
      for (let i = 0; i < Math.min(existingAns.length, chosen.length); i += 1) {
        const prev = existingAns[i] || {};
        chosen[i] = typeof prev.chosen === "string" ? prev.chosen : "";
      }
      published = true;
      updateSubmitState();
      updateChipStates();
      showWaitingState();
    } else {
      showQuestion(0, { forceReplace: true });
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
          showWaitingState();
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
