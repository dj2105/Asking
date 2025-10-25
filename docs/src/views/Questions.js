// /src/views/Questions.js
//
// Questions phase — local-only until the 3rd selection.
// • Shows exactly the player’s three questions from rooms/{code}/rounds/{round}/{role}Items.
// • Players can jump between questions freely via coloured tabs.
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

const TAB_THEMES = [
  { bg: "#f2f5ff", accent: "#d6e2ff", strong: "#aebfff", border: "rgba(62, 92, 160, 0.26)" },
  { bg: "#fff1f8", accent: "#fbd3e8", strong: "#f5a9d1", border: "rgba(162, 66, 130, 0.26)" },
  { bg: "#fff7ec", accent: "#ffe1b8", strong: "#f6c48a", border: "rgba(186, 110, 42, 0.26)" },
];

function el(tag, attrs = {}, kids = []) {
  const n = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (k === "class") n.className = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) n.setAttribute(k, v);
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
    const root = el("div", { class: "view view-questions stage-center" });

    const card = el("div", { class: "card card--soft tabbed-card tabbed-card--questions" });
    const title = el("h1", { class: "view-heading" }, "Questions");
    const tabsRow = el("div", { class: "tabbed-card__tabs" });
    const tabs = [0, 1, 2].map((i) => {
      const btn = el(
        "button",
        {
          class: "round-tab",
          type: "button",
          "aria-pressed": "false",
        },
        String(i + 1)
      );
      tabsRow.appendChild(btn);
      return btn;
    });

    const body = el("div", { class: "tabbed-card__body" });
    const questionNode = el("div", { class: "tabbed-card__question" }, "");
    const choiceWrap = el("div", { class: "tabbed-card__choices" });
    const choiceButtons = [0, 1].map(() =>
      el(
        "button",
        {
          class: "btn big outline choice-button",
          type: "button",
          "aria-pressed": "false",
        },
        ""
      )
    );
    choiceButtons.forEach((btn) => choiceWrap.appendChild(btn));
    const statusNote = el("div", { class: "tabbed-card__status mono small" }, "Preparing questions…");

    body.appendChild(questionNode);
    body.appendChild(choiceWrap);
    body.appendChild(statusNote);

    card.appendChild(title);
    card.appendChild(tabsRow);
    card.appendChild(body);

    const submitRow = el("div", { class: "mark-submit-row" });
    const submitBtn = el(
      "button",
      {
        class: "btn big mark-submit-btn",
        type: "button",
        disabled: "disabled",
      },
      "Submit Answers"
    );
    submitRow.appendChild(submitBtn);

    const overlay = el("div", { class: "stage-overlay stage-overlay--hidden" });
    const overlayTitle = el("div", { class: "mono stage-overlay__title" }, "");
    const overlayNote = el("div", { class: "mono small stage-overlay__note" }, "");
    overlay.appendChild(overlayTitle);
    overlay.appendChild(overlayNote);

    root.appendChild(card);
    root.appendChild(submitRow);
    root.appendChild(overlay);

    container.appendChild(root);

    let idx = 0;
    let triplet = [];
    let tripletReady = false;
    const chosen = ["", "", ""];
    let published = false;
    let submitting = false;
    let stopWatcher = null;
    let alive = true;

    const applyTheme = (index) => {
      const theme = TAB_THEMES[index] || TAB_THEMES[0];
      card.style.setProperty("--tab-bg", theme.bg);
      card.style.setProperty("--tab-accent", theme.accent);
      card.style.setProperty("--tab-strong", theme.strong);
      card.style.setProperty("--tab-border", theme.border);
    };
    applyTheme(0);

    const setStatus = (text) => {
      statusNote.textContent = text || "";
      statusNote.style.display = text ? "" : "none";
    };

    const updateTabs = () => {
      tabs.forEach((tab, i) => {
        const isActive = i === idx;
        const answered = Boolean(chosen[i]);
        tab.classList.toggle("round-tab--active", isActive);
        tab.classList.toggle("round-tab--answered", answered);
        tab.setAttribute("aria-pressed", isActive ? "true" : "false");
        tab.disabled = !tripletReady;
      });
    };

    const refreshChoiceStyles = () => {
      const current = chosen[idx] || "";
      choiceButtons.forEach((btn) => {
        const label = btn.textContent || "";
        const selected = Boolean(current) && label === current;
        btn.classList.toggle("choice-button--selected", selected);
        btn.setAttribute("aria-pressed", selected ? "true" : "false");
      });
    };

    const updateChoiceDisabledState = () => {
      const current = triplet[idx] || {};
      const options = Array.isArray(current.options) ? current.options : [];
      const baseEnabled = tripletReady && !published && !submitting;
      choiceButtons.forEach((btn, i) => {
        const label = options[i] || "";
        btn.disabled = !baseEnabled || !label;
      });
    };

    const updateSubmitState = () => {
      const complete = chosen.every((value) => Boolean(value));
      submitBtn.disabled = !complete || published || submitting;
      submitBtn.classList.toggle("throb", complete && !published && !submitting);
      if (published) {
        submitBtn.textContent = "Submitted";
      } else if (submitting) {
        submitBtn.textContent = "Submitting…";
      } else {
        submitBtn.textContent = "Submit Answers";
      }
      submitRow.style.display = published ? "none" : "flex";
    };

    const updateContent = () => {
      const current = triplet[idx] || {};
      questionNode.textContent = current.question || "";
      choiceButtons.forEach((btn, i) => {
        const label = current.options?.[i] || "";
        btn.textContent = label;
      });
      refreshChoiceStyles();
      updateChoiceDisabledState();
    };

    const showTab = (targetIdx) => {
      if (!Number.isFinite(targetIdx)) return;
      if (targetIdx < 0) targetIdx = 0;
      if (targetIdx >= triplet.length) targetIdx = triplet.length - 1;
      idx = targetIdx;
      applyTheme(idx);
      updateTabs();
      updateContent();
      if (!published) {
        resumeRoundTimer(timerContext);
      }
    };

    tabs.forEach((tab, i) => {
      tab.addEventListener("click", () => {
        if (!tripletReady) return;
        showTab(i);
      });
    });

    choiceButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        if (published || submitting) return;
        if (!tripletReady) return;
        const text = btn.textContent || "";
        if (!text) return;
        chosen[idx] = text;
        refreshChoiceStyles();
        updateTabs();
        updateSubmitState();
        setStatus("Switch tabs any time — answers stay saved until you submit.");
      });
    });

    const timerContext = { code, role: "guest", round: 1 };

    const showOverlay = (title, note) => {
      overlayTitle.textContent = title || "";
      overlayNote.textContent = note || "";
      overlay.classList.remove("stage-overlay--hidden");
      card.style.visibility = "hidden";
      submitRow.style.display = "none";
    };

    const hideOverlay = () => {
      overlay.classList.add("stage-overlay--hidden");
      card.style.visibility = "";
      updateSubmitState();
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

    timerContext.role = myRole;
    timerContext.round = round;

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
          body.style.display = "none";
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

    tripletReady = triplet.every(
      (entry) => entry.question && Array.isArray(entry.options) && entry.options.length === 2 && entry.options.every((opt) => Boolean(opt))
    );

    const existingAns = (((room0.answers || {})[myRole] || {})[round] || []);
    existingAns.forEach((ans, i) => {
      if (ans && typeof ans.chosen === "string" && ans.chosen.trim()) {
        chosen[i] = ans.chosen;
      }
    });

    const alreadySubmitted = Boolean(((room0.submitted || {})[myRole] || {})[round]);
    published = alreadySubmitted;
    submitting = false;

    if (tripletReady) {
      body.style.display = "flex";
      const firstUnanswered = chosen.findIndex((value) => !value);
      const initialIndex = firstUnanswered >= 0 ? firstUnanswered : 0;
      showTab(initialIndex);
      setStatus("Pick an answer on each tab, then submit.");
    } else {
      body.style.display = "none";
      setStatus("Preparing questions…");
    }

    updateTabs();
    updateContent();
    updateSubmitState();

    if (published) {
      pauseRoundTimer(timerContext);
      setStatus("Answers submitted. Waiting for opponent…");
      showOverlay(`Waiting for ${oppName}`, "Answers locked");
    }

    async function publishAnswers() {
      if (submitting || published) return;
      submitting = true;
      updateChoiceDisabledState();
      updateSubmitState();
      setStatus("Submitting answers…");

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
        showOverlay("Submitting…", "Sending your answers");
        await updateDoc(rRef, patch);
        published = true;
        submitting = false;
        pauseRoundTimer(timerContext);
        setStatus("Answers submitted. Waiting for opponent…");
        showOverlay(`Waiting for ${oppName}`, "Answers locked");
      } catch (err) {
        console.warn("[questions] publish failed:", err);
        submitting = false;
        hideOverlay();
        setStatus("Retrying…");
        updateChoiceDisabledState();
        updateSubmitState();
        if (!published) {
          resumeRoundTimer(timerContext);
        }
      }
    }

    const finishRound = () => {
      if (published || submitting) return;
      const complete = chosen.every((value) => Boolean(value));
      if (!complete) return;
      publishAnswers();
    };

    submitBtn.addEventListener("click", () => {
      if (submitBtn.disabled) return;
      finishRound();
    });

    const showWaitingOverlay = (note) => {
      showOverlay(`Waiting for ${oppName}`, note || "Waiting for opponent");
    };

    stopWatcher = onSnapshot(rRef, async (snap) => {
      const data = snap.data() || {};

      const nextRound = Number(data.round) || round;
      if (nextRound !== round) {
        round = nextRound;
        timerContext.round = round;
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
          showWaitingOverlay();
        }
      }

      if (myRole === "host" && data.state === "questions") {
        const myDone = Boolean(((data.submitted || {})[myRole] || {})[round]) || (Array.isArray(((data.answers || {})[myRole] || {})[round]) && (((data.answers || {})[myRole] || {})[round]).length === 3);
        const oppDone = Boolean(((data.submitted || {})[oppRole] || {})[round]) || (Array.isArray(((data.answers || {})[oppRole] || {})[round]) && (((data.answers || {})[oppRole] || {})[round]).length === 3);
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
      try { stopWatcher && stopWatcher(); } catch {}
      pauseRoundTimer(timerContext);
    };
  },

  async unmount() { /* instance handles cleanup */ }
};
