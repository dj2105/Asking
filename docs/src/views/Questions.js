// /src/views/Questions.js
//
// Questions phase — local-only until submission.
// • Shows exactly the player’s three questions from rooms/{code}/rounds/{round}/{role}Items.
// • Two large buttons per question. Each pick auto-focuses the next unanswered question.
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
    const root = el("div", { class: "view view-questions stage-center questions-neutral" });

    const heading = el("div", { class: "mono qm-heading" }, "Questions");
    const switcher = el("div", { class: "qm-switcher" });
    const chips = [];
    for (let i = 0; i < 3; i += 1) {
      const chip = el(
        "button",
        {
          class: "mono qm-chip",
          type: "button",
          "data-index": String(i),
        },
        String(i + 1)
      );
      chips.push(chip);
      switcher.appendChild(chip);
    }

    const prompt = el("div", { class: "mono qm-question" }, "");
    const answersWrap = el("div", { class: "qm-answers" });
    const answerButtons = [0, 1].map(() =>
      el(
        "button",
        {
          class: "mono qm-answer-btn",
          type: "button",
          disabled: "disabled",
        },
        ""
      )
    );
    answerButtons.forEach((btn) => answersWrap.appendChild(btn));

    const submitBtn = el(
      "button",
      {
        class: "mono qm-submit",
        type: "button",
        disabled: "disabled",
      },
      "Submit"
    );

    root.appendChild(heading);
    root.appendChild(switcher);
    root.appendChild(prompt);
    root.appendChild(answersWrap);
    root.appendChild(submitBtn);

    container.appendChild(root);

    let idx = 0;
    const chosen = ["", "", ""];
    let published = false;
    let submitting = false;

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
    }

    const rdRef = doc(roundSubColRef(code), String(round));
    const { hostUid, guestUid } = room0.meta || {};
    const storedRole = getStoredRole(code);
    const myRole = storedRole === "host" || storedRole === "guest"
      ? storedRole
      : hostUid === me.uid ? "host" : guestUid === me.uid ? "guest" : "guest";
    const oppRole = myRole === "host" ? "guest" : "host";
    const oppName = oppRole === "host" ? "Daniel" : "Jaime";

    const totalQuestions = 3;
    const timerContext = { code, role: myRole, round };
    let questionsReady = false;
    let triplet = new Array(totalQuestions).fill(null);

    const existingAns = (((room0.answers || {})[myRole] || {})[round] || []);

    const updateChips = () => {
      chips.forEach((chip, chipIndex) => {
        const answered = Boolean(chosen[chipIndex]);
        chip.classList.toggle("is-active", chipIndex === idx);
        chip.classList.toggle("is-answered", answered);
        chip.disabled = !questionsReady;
      });
    };

    const updateAnswerButtons = () => {
      if (!questionsReady) return;
      const current = triplet[idx] || {};
      const options = current.options || [];
      answersWrap.classList.remove("qm-answers--hidden");
      answerButtons.forEach((btn, btnIndex) => {
        const text = options[btnIndex] || "";
        btn.textContent = text;
        const isSelected = Boolean(text) && chosen[idx] === text;
        btn.classList.toggle("is-selected", isSelected);
        btn.disabled = !text || published || submitting;
      });
    };

    const showMessage = (text) => {
      questionsReady = false;
      prompt.textContent = text;
      answersWrap.classList.add("qm-answers--hidden");
      answerButtons.forEach((btn) => {
        btn.textContent = "";
        btn.classList.remove("is-selected");
        btn.disabled = true;
      });
      updateChips();
      updateSubmitState();
      pauseRoundTimer(timerContext);
    };

    const setActive = (targetIdx, { fromAuto = false } = {}) => {
      if (!questionsReady) return;
      if (!Number.isFinite(targetIdx)) targetIdx = 0;
      if (targetIdx < 0) targetIdx = 0;
      if (targetIdx >= totalQuestions) targetIdx = totalQuestions - 1;
      idx = targetIdx;
      const current = triplet[idx] || {};
      prompt.textContent = current.question || "";
      updateChips();
      updateAnswerButtons();
      updateSubmitState();
      if (!fromAuto && !published) resumeRoundTimer(timerContext);
    };

    const updateSubmitState = () => {
      const ready = chosen.every((val) => Boolean(val));
      let label = "Submit";
      if (submitting) label = "Submitting…";
      else if (published) label = `Waiting for ${oppName}…`;
      submitBtn.textContent = label;
      submitBtn.disabled = !ready || published || submitting;
      submitBtn.classList.toggle("is-ready", ready && !published && !submitting);
      submitBtn.classList.toggle("is-submitted", published);
      submitBtn.classList.toggle("is-busy", submitting);
    };

    const focusNext = (fromIndex) => {
      if (!questionsReady) return;
      const allAnswered = chosen.every((val) => Boolean(val));
      if (allAnswered) {
        setActive(fromIndex, { fromAuto: true });
        return;
      }
      for (let i = fromIndex + 1; i < totalQuestions; i += 1) {
        if (!chosen[i]) {
          setActive(i, { fromAuto: true });
          return;
        }
      }
      for (let i = 0; i < totalQuestions; i += 1) {
        if (!chosen[i]) {
          setActive(i, { fromAuto: true });
          return;
        }
      }
      setActive(fromIndex, { fromAuto: true });
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
          showMessage("Waiting for round data…");
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

    async function publishAnswers() {
      if (submitting || published) return;
      const ready = chosen.every((val) => Boolean(val));
      if (!ready) return;
      submitting = true;
      updateSubmitState();
      updateAnswerButtons();

      const payload = triplet.map((entry, entryIndex) => ({
        question: entry.question || "",
        chosen: chosen[entryIndex] || "",
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
        updateAnswerButtons();
        updateSubmitState();
      } catch (err) {
        console.warn("[questions] publish failed:", err);
        submitting = false;
        updateAnswerButtons();
        updateSubmitState();
      }
    }

    const handleAnswer = (text) => {
      if (!questionsReady || published || submitting) return;
      if (!text) return;
      const currentIndex = idx;
      chosen[currentIndex] = text;
      updateAnswerButtons();
      updateChips();
      updateSubmitState();
      focusNext(currentIndex);
    };

    answerButtons.forEach((btn) => {
      btn.addEventListener("click", () => handleAnswer(btn.textContent || ""));
    });

    const applyExistingAnswers = () => {
      existingAns.forEach((entry, entryIndex) => {
        if (entryIndex >= totalQuestions) return;
        const value = typeof entry === "string" ? entry : entry?.chosen;
        if (value) chosen[entryIndex] = value;
      });
      updateChips();
      updateSubmitState();
    };

    chips.forEach((chip, chipIndex) => {
      chip.addEventListener("click", () => {
        if (!questionsReady) return;
        setActive(chipIndex);
      });
    });

    submitBtn.addEventListener("click", () => {
      if (submitBtn.disabled) return;
      publishAnswers();
    });

    showMessage("Loading questions…");

    const tripletReady = triplet.every((entry) =>
      entry && entry.question && Array.isArray(entry.options) && entry.options.length === 2
    );

    const submittedFlag = Boolean(((room0.submitted || {})[myRole] || {})[round]);

    if (!tripletReady) {
      showMessage("Preparing questions…");
    } else {
      questionsReady = true;
      applyExistingAnswers();
      const firstUnanswered = chosen.findIndex((val) => !val);
      const startIndex = firstUnanswered === -1 ? totalQuestions - 1 : firstUnanswered;
      if (submittedFlag || (existingAns.length >= totalQuestions && chosen.every((val) => Boolean(val)))) {
        published = true;
        setActive(startIndex);
        pauseRoundTimer(timerContext);
        updateAnswerButtons();
        updateSubmitState();
      } else {
        setActive(startIndex);
      }
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

      const myDone = Boolean(((data.submitted || {})[myRole] || {})[round]) || (Array.isArray(((data.answers || {})[myRole] || {})[round]) && (((data.answers || {})[myRole] || {})[round]).length === totalQuestions);
      const oppDone = Boolean(((data.submitted || {})[oppRole] || {})[round]) || (Array.isArray(((data.answers || {})[oppRole] || {})[round]) && (((data.answers || {})[oppRole] || {})[round]).length === totalQuestions);

      if (myDone && !published) {
        published = true;
        submitting = false;
        pauseRoundTimer(timerContext);
        updateAnswerButtons();
        updateSubmitState();
      }

      if (published && !oppDone) {
        updateSubmitState();
      }

      // Host monitors opponent completion to flip state (idempotent)
      if (myRole === "host" && data.state === "questions") {
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
      pauseRoundTimer(timerContext);
    };
  },

  async unmount() { /* instance handles cleanup */ }
};
