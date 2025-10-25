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
    const root = el("div", { class: "view view-questions stage-center qa-stage" });

    const shell = el("div", { class: "qa-shell" });
    const heading = el("div", { class: "qa-heading mono" }, "Questions");
    const switcher = el("div", { class: "qa-switcher" });
    const questionText = el("div", { class: "qa-question mono" }, "");
    const answersWrap = el("div", { class: "qa-answers" });
    const btn1 = el("button", { class: "qa-answer", type: "button" }, "");
    const btn2 = el("button", { class: "qa-answer", type: "button" }, "");
    answersWrap.appendChild(btn1);
    answersWrap.appendChild(btn2);
    const submitBtn = el("button", { class: "qa-submit", type: "button", disabled: "true" }, "Submit");

    shell.appendChild(heading);
    shell.appendChild(switcher);
    shell.appendChild(questionText);
    shell.appendChild(answersWrap);
    shell.appendChild(submitBtn);

    root.appendChild(shell);

    const mathsMount = el("div", { class: "jemima-maths-pinned" });
    root.appendChild(mathsMount);

    container.appendChild(root);

    const switchButtons = [0, 1, 2].map((i) => {
      const btn = el("button", {
        class: "qa-switcher__btn",
        type: "button",
        "data-index": String(i),
        "aria-pressed": "false",
      }, String(i + 1));
      switcher.appendChild(btn);
      return btn;
    });

    let idx = 0;
    const chosen = ["", "", ""];
    let published = false;
    let submitting = false;
    let statusMessage = "Preparing questions…";
    let waitMessageDefault = "Waiting…";
    let timerContext = null;
    let triplet = [];

    const answerButtons = [btn1, btn2];

    function updateSubmitState() {
      const ready = chosen.every((value) => Boolean(value));
      const canSubmit = ready && !submitting && !published;
      submitBtn.disabled = !canSubmit;
      submitBtn.classList.toggle("qa-submit--ready", canSubmit);
      submitBtn.classList.toggle("qa-submit--waiting", submitting || published);
      submitBtn.textContent = published ? waitMessageDefault : submitting ? "Submitting…" : "Submit";
    }

    function refreshChoiceStyles() {
      const currentSelection = chosen[idx] || "";
      answerButtons.forEach((btn) => {
        const match = Boolean(currentSelection) && (btn.textContent || "") === currentSelection;
        btn.classList.toggle("selected", match);
        btn.setAttribute("aria-pressed", match ? "true" : "false");
      });
    }

    function updateSwitcherButtons() {
      switchButtons.forEach((btn, buttonIdx) => {
        const isActive = buttonIdx === idx;
        const isAnswered = Boolean(chosen[buttonIdx]);
        btn.classList.toggle("is-active", isActive);
        btn.classList.toggle("is-answered", isAnswered);
        btn.setAttribute("aria-pressed", isActive ? "true" : "false");
      });
    }

    function renderQuestion() {
      const hasStatus = Boolean(statusMessage);
      const current = triplet[idx] || {};
      const options = Array.isArray(current.options) ? current.options : [];
      const showOptions = !hasStatus && options.length === 2;

      questionText.textContent = hasStatus ? statusMessage : current.question || "";

      answerButtons.forEach((btn, optionIdx) => {
        const label = showOptions ? options[optionIdx] || "" : "";
        btn.textContent = label;
        btn.disabled = !showOptions || submitting || published;
        btn.classList.toggle("is-empty", !label);
      });

      if (!hasStatus && timerContext && !published) {
        resumeRoundTimer(timerContext);
      } else if (timerContext) {
        pauseRoundTimer(timerContext);
      }

      refreshChoiceStyles();
      updateSwitcherButtons();
      updateSubmitState();
    }

    function setStatusMessage(message) {
      statusMessage = message || "";
      renderQuestion();
    }

    function clearStatusMessage() {
      setStatusMessage("");
    }

    function findNextUnanswered(fromIndex) {
      for (let i = fromIndex + 1; i < triplet.length; i += 1) {
        if (!chosen[i]) return i;
      }
      for (let i = 0; i < triplet.length; i += 1) {
        if (!chosen[i]) return i;
      }
      return null;
    }

    renderQuestion();

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

    try {
      if (mountMathsPane && room0.maths) {
        mountMathsPane(mathsMount, { maths: room0.maths, round, mode: "inline", roomCode: code, userUid: me.uid });
      }
    } catch (err) {
      console.warn("[questions] MathsPane mount failed:", err);
    }

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
          setStatusMessage("Waiting for round data…");
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

    timerContext = { code, role: myRole, round };

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

    function showQuestion(targetIdx, options = {}) {
      if (triplet.length === 0) return;
      if (targetIdx < 0) targetIdx = 0;
      if (targetIdx >= triplet.length) targetIdx = triplet.length - 1;
      idx = targetIdx;
      clearStatusMessage();
      if (!options.skipHistory) {
        const shouldReplace = historyIndex === null || options.forceReplace;
        recordHistoryIndex(idx, { replace: shouldReplace });
      } else {
        historyIndex = idx;
      }
      renderQuestion();
    }

    switchButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = Number(btn.getAttribute("data-index"));
        if (!Number.isFinite(target)) return;
        showQuestion(target);
      });
    });

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
      submitting = true;
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
        renderQuestion();
      } catch (err) {
        console.warn("[questions] publish failed:", err);
        submitting = false;
        renderQuestion();
      }
    }

    function onPick(text) {
      if (published || submitting) return;
      const currentIndex = idx;
      chosen[currentIndex] = text;
      const nextIdx = findNextUnanswered(currentIndex);
      if (nextIdx !== null && nextIdx !== currentIndex) {
        showQuestion(nextIdx);
      } else {
        renderQuestion();
      }
    }

    btn1.addEventListener("click", () => onPick(btn1.textContent));
    btn2.addEventListener("click", () => onPick(btn2.textContent));

    const tripletReady = triplet.every((entry) =>
      entry.question && entry.options && entry.options.length === 2
    );

    if (!tripletReady) {
      setStatusMessage("Preparing questions…");
      pauseRoundTimer(timerContext);
    } else if (existingAns.length === 3) {
      published = true;
      chosen[0] = existingAns[0]?.chosen || "";
      chosen[1] = existingAns[1]?.chosen || "";
      chosen[2] = existingAns[2]?.chosen || "";
      idx = 2;
      pauseRoundTimer(timerContext);
      clearStatusMessage();
      renderQuestion();
    } else {
      showQuestion(0);
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
          published = true;
          renderQuestion();
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

    submitBtn.addEventListener("click", publishAnswers);

    this.unmount = () => {
      alive = false;
      try { stopWatcher && stopWatcher(); } catch {}
      pauseRoundTimer(timerContext);
      try { removePopStateListener(); } catch {}
    };
  },

  async unmount() { /* instance handles cleanup */ }
};
