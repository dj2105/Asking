// /src/views/Questions.js
//
// Questions phase — local-only until the 3rd selection.
// • Shows exactly the player’s three questions from rooms/{code}/rounds/{round}/{role}Items.
// • Two large buttons per question. Selecting the 3rd answer prepares submission.
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
    if (v === undefined || v === null) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (k === "text") n.textContent = v;
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
  const complement = (hue + 180) % 360;
  document.documentElement.style.setProperty("--ink-h", String(hue));
  document.documentElement.style.setProperty("--round-accent", `hsl(${hue}, 32%, 28%)`);
  document.documentElement.style.setProperty("--round-accent-soft", `hsla(${hue}, 32%, 28%, 0.16)`);
  document.documentElement.style.setProperty("--round-accent-strong", `hsl(${hue}, 34%, 20%)`);
  document.documentElement.style.setProperty("--round-chip-active-bg", `hsla(${hue}, 32%, 92%, 0.94)`);
  document.documentElement.style.setProperty("--round-chip-active-border", `hsla(${hue}, 32%, 40%, 0.42)`);
  document.documentElement.style.setProperty("--round-choice-hover", `hsla(${hue}, 32%, 86%, 0.24)`);
  document.documentElement.style.setProperty("--choice-selected-bg", `hsl(${complement}, 68%, 92%)`);
  document.documentElement.style.setProperty("--choice-selected-fg", `hsl(${complement}, 44%, 30%)`);
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
    const root = el("div", { class: "view view-questions stage-center" });

    const panel = el("div", { class: "card round-panel" });
    const heading = el("h1", { class: "round-heading mono" }, "QUESTIONS");
    panel.appendChild(heading);

    const stepRow = el("div", { class: "round-steps" });
    const stepButtons = [0, 1, 2].map((idx) => {
      const btn = el("button", {
        class: "round-step mono",
        type: "button",
      }, String(idx + 1));
      stepRow.appendChild(btn);
      return btn;
    });
    panel.appendChild(stepRow);

    const content = el("div", { class: "round-panel__content" });
    const questionNode = el("div", { class: "round-question mono" }, "");
    const choicesWrap = el("div", { class: "round-choices" });
    const optionButtons = [0, 1].map(() => {
      const btn = el("button", { class: "choice-btn mono", type: "button" }, "");
      choicesWrap.appendChild(btn);
      return btn;
    });
    content.appendChild(questionNode);
    content.appendChild(choicesWrap);
    panel.appendChild(content);

    const footer = el("div", { class: "round-panel__footer" });
    const statusLine = el("div", { class: "round-status mono" }, "");
    const submitBtn = el("button", {
      class: "btn round-submit",
      type: "button",
      disabled: "",
    }, "SUBMIT ANSWERS");
    footer.appendChild(statusLine);
    footer.appendChild(submitBtn);
    panel.appendChild(footer);

    const confirmOverlay = el("div", { class: "round-confirm round-confirm--hidden" });
    const confirmTitle = el("div", { class: "round-confirm__title mono" }, "RETURN TO LOBBY?");
    const confirmActions = el("div", { class: "round-confirm__actions" });
    const confirmYes = el("button", { class: "btn", type: "button" }, "YES");
    const confirmNo = el("button", { class: "btn outline", type: "button" }, "NO");
    confirmActions.appendChild(confirmYes);
    confirmActions.appendChild(confirmNo);
    confirmOverlay.appendChild(confirmTitle);
    confirmOverlay.appendChild(confirmActions);
    panel.appendChild(confirmOverlay);

    root.appendChild(panel);
    container.appendChild(root);

    const chosen = ["", "", ""];
    let triplet = [];
    let idx = 0;
    let published = false;
    let submitting = false;
    let advanceTimer = null;
    let stopWatcher = null;
    let alive = true;
    let removePopStateListener = () => {};
    let confirmVisible = false;

    const historySupported =
      typeof window !== "undefined" &&
      window.history &&
      typeof window.history.pushState === "function" &&
      typeof window.history.replaceState === "function";
    const historyKey = "jemimaQuestions";
    const guardKey = "jemimaQuestionsGuard";
    let historyIndex = null;

    const SUBMIT_LABEL = "SUBMIT ANSWERS";
    const WAIT_LABEL = "WAITING…";

    const setStatus = (text = "") => {
      statusLine.textContent = text ? String(text).toUpperCase() : "";
    };

    const setSubmitLabel = (text) => {
      submitBtn.textContent = text || SUBMIT_LABEL;
    };

    const clearAdvanceTimer = () => {
      if (advanceTimer) {
        clearTimeout(advanceTimer);
        advanceTimer = null;
      }
    };

    const setChoicesEnabled = (enabled) => {
      optionButtons.forEach((btn) => {
        btn.disabled = !enabled;
      });
    };

    const updateStepStates = () => {
      stepButtons.forEach((btn, i) => {
        const answered = Boolean(chosen[i]);
        btn.classList.toggle("is-active", i === idx);
        btn.classList.toggle("is-answered", answered);
      });
    };

    const reflectChoices = () => {
      const current = chosen[idx] || "";
      optionButtons.forEach((btn) => {
        const value = btn.dataset.value || "";
        const selected = current && value === current;
        btn.classList.toggle("is-selected", selected);
      });
    };

    const updateSubmitState = () => {
      const ready = triplet.length === 3 && chosen.every((value) => Boolean(value));
      const waiting = published || submitting;
      if (waiting) {
        submitBtn.disabled = true;
        submitBtn.classList.remove("is-ready", "throb-soft");
        submitBtn.classList.add("waiting");
        setSubmitLabel(WAIT_LABEL);
      } else {
        submitBtn.classList.remove("waiting");
        setSubmitLabel(SUBMIT_LABEL);
        submitBtn.disabled = !ready;
        submitBtn.classList.toggle("is-ready", ready);
        submitBtn.classList.toggle("throb-soft", ready);
      }
    };

    const animateContent = () => {
      content.classList.remove("round-content--transition");
      void content.offsetWidth; // force reflow
      content.classList.add("round-content--transition");
    };

    const showConfirm = () => {
      if (confirmVisible) return;
      confirmVisible = true;
      confirmOverlay.classList.remove("round-confirm--hidden");
    };

    const hideConfirm = () => {
      if (!confirmVisible) return;
      confirmVisible = false;
      confirmOverlay.classList.add("round-confirm--hidden");
    };

    const recordHistoryIndex = (nextIndex, { replace = false } = {}) => {
      historyIndex = nextIndex;
      if (!historySupported) return;
      const baseState = window.history.state && typeof window.history.state === "object"
        ? { ...window.history.state }
        : {};
      baseState[historyKey] = { idx: nextIndex, code };
      baseState[guardKey] = { code };
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

    const historyHandler = (event) => {
      const state = event?.state;
      const payload = state && typeof state === "object" ? state[historyKey] : null;
      if (payload && payload.code === code && Number.isFinite(Number(payload.idx))) {
        const target = Number(payload.idx);
        showQuestion(target, { skipHistory: true });
        return;
      }
      // guard against leaving
      recordHistoryIndex(idx, { replace: true });
      showConfirm();
    };

    if (historySupported) {
      window.addEventListener("popstate", historyHandler);
      removePopStateListener = () => {
        try {
          window.removeEventListener("popstate", historyHandler);
        } catch {}
        removePopStateListener = () => {};
      };
    }

    confirmYes.addEventListener("click", () => {
      hideConfirm();
      location.hash = "#/lobby";
    });
    confirmNo.addEventListener("click", () => {
      hideConfirm();
      recordHistoryIndex(idx, { replace: true });
    });

    const findNextUnanswered = (currentIndex) => {
      for (let i = currentIndex + 1; i < chosen.length; i += 1) {
        if (!chosen[i]) return i;
      }
      for (let i = 0; i < chosen.length; i += 1) {
        if (!chosen[i]) return i;
      }
      return null;
    };

    const showQuestion = (targetIdx, options = {}) => {
      clearAdvanceTimer();
      if (!triplet.length) return;
      if (targetIdx < 0) targetIdx = 0;
      if (targetIdx >= triplet.length) targetIdx = triplet.length - 1;
      idx = targetIdx;
      const current = triplet[idx] || {};
      setStatus("");
      questionNode.textContent = current.question || "";
      optionButtons.forEach((btn, i) => {
        const text = current.options?.[i] || "";
        btn.textContent = text;
        btn.dataset.value = text;
      });
      animateContent();
      reflectChoices();
      updateStepStates();
      setChoicesEnabled(!published && !submitting);
      if (!options.skipHistory) {
        const shouldReplace = historyIndex === null || options.forceReplace;
        recordHistoryIndex(idx, { replace: shouldReplace });
      } else {
        historyIndex = idx;
      }
      resumeRoundTimer(timerContext);
      updateSubmitState();
    };

    stepButtons.forEach((btn, i) => {
      btn.addEventListener("click", () => {
        if (!triplet.length) return;
        showQuestion(i);
      });
    });

    const finishIfReady = () => {
      const ready = triplet.length === 3 && chosen.every((value) => Boolean(value));
      if (!ready) return;
      const lastIndex = triplet.length - 1;
      if (idx !== lastIndex) {
        showQuestion(lastIndex);
      }
      updateSubmitState();
    };

    const onPick = (value) => {
      if (!value || published || submitting) return;
      const currentIndex = idx;
      const current = triplet[currentIndex] || {};
      const exists = current.options?.some((opt) => opt === value);
      if (!exists) return;
      clearAdvanceTimer();
      chosen[currentIndex] = value;
      reflectChoices();
      updateStepStates();
      updateSubmitState();
      advanceTimer = setTimeout(() => {
        advanceTimer = null;
        if (published || submitting || !alive) return;
        const nextIdx = findNextUnanswered(currentIndex);
        if (nextIdx === null) {
          finishIfReady();
        } else if (nextIdx !== currentIndex) {
          showQuestion(nextIdx);
        }
      }, 500);
    };

    optionButtons.forEach((btn) => {
      btn.addEventListener("click", () => onPick(btn.dataset.value || ""));
    });

    submitBtn.addEventListener("click", () => {
      if (submitBtn.disabled || published || submitting) return;
      publishAnswers();
    });

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
    const waitMessageDefault = `Waiting for ${oppName}`;

    const timerContext = { code, role: myRole, round };

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
        setStatus("PREPARING QUESTIONS");
        setChoicesEnabled(false);
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
      const tier = roundTier(round);
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
    if (Array.isArray(existingAns)) {
      existingAns.slice(0, 3).forEach((entry, i) => {
        if (entry && typeof entry.chosen === "string" && entry.chosen) {
          chosen[i] = entry.chosen;
        }
      });
    }

    const alreadySubmitted = Boolean(((room0.submitted || {})[myRole] || {})[round]);

    if (triplet.every((entry) => entry.question && entry.options?.length === 2)) {
      if (alreadySubmitted || existingAns.length === 3) {
        published = true;
        chosen.forEach((value, i) => {
          if (!value && existingAns[i]?.chosen) {
            chosen[i] = existingAns[i].chosen;
          }
        });
        reflectChoices();
        updateStepStates();
        updateSubmitState();
        setStatus(waitMessageDefault);
        setChoicesEnabled(false);
        pauseRoundTimer(timerContext);
      } else {
        showQuestion(0, { forceReplace: true });
        reflectChoices();
        updateStepStates();
        finishIfReady();
      }
    } else {
      setStatus("PREPARING QUESTIONS");
      setChoicesEnabled(false);
    }

    updateSubmitState();

    const publishAnswers = async () => {
      if (published || submitting) return;
      const ready = triplet.length === 3 && chosen.every((value) => Boolean(value));
      if (!ready) return;
      submitting = true;
      updateSubmitState();
      pauseRoundTimer(timerContext);
      const payload = triplet.map((entry, i) => ({
        question: entry.question || "",
        chosen: chosen[i] || "",
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
        setStatus(waitMessageDefault);
        updateSubmitState();
        setChoicesEnabled(false);
      } catch (err) {
        console.warn("[questions] publish failed:", err);
        submitting = false;
        setStatus("RETRYING");
        setChoicesEnabled(true);
        updateSubmitState();
      }
    };

    const handleRoomSnapshot = async (snap) => {
      const data = snap.data() || {};
      const nextRound = Number(data.round) || round;
      if (nextRound !== round) {
        round = nextRound;
        timerContext.round = round;
      }

      const stateName = String(data.state || "").toLowerCase();

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
      }

      if (published && alive) {
        const myDone = Boolean(((data.submitted || {})[myRole] || {})[round]) ||
          (Array.isArray(((data.answers || {})[myRole] || {})[round]) && (((data.answers || {})[myRole] || {})[round]).length === 3);
        const oppDone = Boolean(((data.submitted || {})[oppRole] || {})[round]) ||
          (Array.isArray(((data.answers || {})[oppRole] || {})[round]) && (((data.answers || {})[oppRole] || {})[round]).length === 3);
        if (myDone && !oppDone) {
          setStatus(waitMessageDefault);
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
    };

    stopWatcher = onSnapshot(rRef, handleRoomSnapshot, (err) => {
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
