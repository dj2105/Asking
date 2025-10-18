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
import { clampCode, getHashParams, getStoredRole } from "../lib/util.js";
import { applyTheme } from "../lib/theme.js";
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

    applyTheme({ phase: "questions", round: round || 1 });

    container.innerHTML = "";
    const root = el("div", { class: "view view-questions stage-center" });

    const card = el("div", { class: "card card--soft card--center question-card" });
    const headerRow = el("div", { class: "mono phase-header" });
    const heading = el("div", { class: "phase-header__title" }, "QUESTION 1/3");
    const timerDisplay = el("div", {
      class: "phase-header__timer phase-header__timer--hidden",
      role: "timer",
      "aria-live": "off",
    }, "");
    headerRow.appendChild(heading);
    headerRow.appendChild(timerDisplay);
    const qText = el("div", { class: "mono question-card__prompt" }, "");

    card.appendChild(headerRow);
    card.appendChild(qText);

    const btnWrap = el("div", { class: "choice-row" });
    const btn1 = el("button", { class: "btn big outline" }, "");
    const btn2 = el("button", { class: "btn big outline" }, "");
    btnWrap.appendChild(btn1);
    btnWrap.appendChild(btn2);
    card.appendChild(btnWrap);

    let waitMessageDefault = "Waiting…";
    const waitMsg = el("div", { class: "mono small wait-note" }, waitMessageDefault);
    waitMsg.style.display = "none";
    card.appendChild(waitMsg);

    root.appendChild(card);

    const mathsMount = el("div", { class: "jemima-maths-pinned" });
    root.appendChild(mathsMount);

    const overlay = el("div", { class: "stage-overlay stage-overlay--hidden" });
    const overlayTitle = el("div", { class: "mono stage-overlay__title" }, "");
    const overlayNote = el("div", { class: "mono small stage-overlay__note" }, "");
    overlay.appendChild(overlayTitle);
    overlay.appendChild(overlayNote);
    root.appendChild(overlay);

    container.appendChild(root);

    const setStageVisible = (visible) => {
      card.style.display = visible ? "" : "none";
      mathsMount.style.display = visible ? "" : "none";
    };

    const showOverlay = (title, note) => {
      hideTimerValue();
      overlayTitle.textContent = title || "";
      overlayNote.textContent = note || "";
      overlay.classList.remove("stage-overlay--hidden");
      setStageVisible(false);
    };

    const hideOverlay = () => {
      overlay.classList.add("stage-overlay--hidden");
      setStageVisible(true);
    };

    let stopWatcher = null;
    let alive = true;
    this.unmount = () => {
      alive = false;
      try { stopWatcher && stopWatcher(); } catch {}
    };

    const rRef = roomRef(code);

    const roomSnap0 = await getDoc(rRef);
    const room0 = roomSnap0.data() || {};
    if (!round) {
      const roomRound = Number(room0.round);
      round = Number.isFinite(roomRound) && roomRound > 0 ? roomRound : 1;
      applyTheme({ phase: "questions", round });
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
    waitMsg.textContent = waitMessageDefault;

    const overlayWaiting = () => `Waiting for ${oppName}`;
    const showWaitingOverlay = (note) => {
      showOverlay(overlayWaiting(), note || "Waiting for opponent");
    };

    try {
      if (mountMathsPane && room0.maths) {
        mountMathsPane(mathsMount, { maths: room0.maths, round, mode: "inline", roomCode: code, userUid: me.uid });
      }
    } catch (err) {
      console.warn("[questions] MathsPane mount failed:", err);
    }

    const existingAns = (((room0.answers || {})[myRole] || {})[round] || []);
    const QUESTION_LIMIT_SECONDS = 10;
    const QUESTION_LIMIT_MS = QUESTION_LIMIT_SECONDS * 1000;
    function formatSeconds(value) {
      const safe = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
      return safe < 10 ? `0${safe}`.slice(-2) : String(safe);
    }
    function showTimerValue(seconds) {
      timerDisplay.textContent = formatSeconds(seconds);
      timerDisplay.classList.remove("phase-header__timer--hidden");
    }
    function hideTimerValue() {
      timerDisplay.textContent = "";
      timerDisplay.classList.add("phase-header__timer--hidden");
    }
    hideTimerValue();
    let timerDeadline = null;
    let timerInterval = null;

    const setButtonsEnabled = (enabled) => {
      btn1.disabled = !enabled;
      btn2.disabled = !enabled;
      btn1.classList.toggle("throb", enabled);
      btn2.classList.toggle("throb", enabled);
    };

    const updateTimerDisplay = () => {
      if (!timerDeadline) return;
      const remainingMs = timerDeadline - Date.now();
      const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
      showTimerValue(remainingSeconds);
      if (remainingSeconds <= 0) {
        stopTimer();
        handleTimeout();
      }
    };

    const startQuestionTimer = () => {
      stopTimer();
      timerDeadline = Date.now() + QUESTION_LIMIT_MS;
      showTimerValue(QUESTION_LIMIT_SECONDS);
      updateTimerDisplay();
      timerInterval = setInterval(updateTimerDisplay, 200);
    };

    const stopTimer = () => {
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
      timerDeadline = null;
    };

    const handleTimeout = () => {
      if (published || submitting) return;
      stopTimer();
      if (idx >= triplet.length) {
        finishRound(true);
        return;
      }
      if (typeof chosen[idx] !== "string") {
        chosen[idx] = "";
      }
      idx += 1;
      if (idx >= triplet.length) {
        finishRound(true);
      } else {
        presentQuestion();
      }
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
          waitMsg.textContent = "Waiting for round data…";
          waitMsg.style.display = "";
          btnWrap.style.display = "none";
          setButtonsEnabled(false);
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

    let idx = 0;
    const chosen = [];
    let published = false;
    let submitting = false;

    function renderIndex() {
      const cur = triplet[idx];
      heading.textContent = `QUESTION ${Math.min(idx + 1, 3)}/3`;
      qText.textContent = cur?.question || "";
      btn1.textContent = cur?.options?.[0] || "";
      btn2.textContent = cur?.options?.[1] || "";
    }

    const presentQuestion = () => {
      if (idx >= triplet.length) return;
      btnWrap.style.display = "flex";
      waitMsg.style.display = "none";
      setButtonsEnabled(true);
      renderIndex();
      showTimerValue(QUESTION_LIMIT_SECONDS);
      startQuestionTimer();
    };

    const finishRound = (timedOut) => {
      setButtonsEnabled(false);
      waitMsg.style.display = "none";
      hideTimerValue();
      showWaitingOverlay(timedOut ? "Time's up" : undefined);
      publishAnswers(Boolean(timedOut));
    };

    const showWaitingState = (text) => {
      hideOverlay();
      btnWrap.style.display = "none";
      waitMsg.textContent = text || waitMessageDefault;
      waitMsg.style.display = "";
      setButtonsEnabled(false);
      hideTimerValue();
    };

    async function publishAnswers(timedOut = false) {
      if (submitting || published) return;
      submitting = true;

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
        stopTimer();
        const note = timedOut ? "Time's up" : "Waiting for opponent";
        showWaitingOverlay(note);
      } catch (err) {
        console.warn("[questions] publish failed:", err);
        submitting = false;
        hideOverlay();
        showWaitingState("Retrying…");
        setButtonsEnabled(true);
      }
    }

    function onPick(text) {
      if (published || submitting) return;
      stopTimer();
      chosen[idx] = text;
      idx += 1;
      if (idx >= 3) {
        finishRound(false);
      } else {
        presentQuestion();
      }
    }

    btn1.addEventListener("click", () => onPick(btn1.textContent));
    btn2.addEventListener("click", () => onPick(btn2.textContent));

    const tripletReady = triplet.every((entry) =>
      entry.question && entry.options && entry.options.length === 2
    );

    if (!tripletReady) {
      stopTimer();
      btnWrap.style.display = "none";
      waitMsg.textContent = "Preparing questions…";
      waitMsg.style.display = "";
      hideTimerValue();
    } else if (existingAns.length === 3) {
      published = true;
      idx = 3;
      btnWrap.style.display = "none";
      waitMsg.style.display = "none";
      stopTimer();
      hideTimerValue();
      showWaitingOverlay();
    } else {
      presentQuestion();
    }

    stopWatcher = onSnapshot(rRef, async (snap) => {
      const data = snap.data() || {};

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
          showWaitingOverlay();
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
      try { stopWatcher && stopWatcher(); } catch {}
      stopTimer();
      hideTimerValue();
    };
  },

  async unmount() { /* instance handles cleanup */ }
};
