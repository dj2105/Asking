// /src/views/Questions.js
//
// Questions phase — redesigned tab layout with free navigation across the three prompts.
// • Shows exactly the player’s three questions from rooms/{code}/rounds/{round}/{role}Items.
// • Choices are colour-coded per tab; answers remain editable until Submit.
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

const TAB_COLOURS = [
  {
    base: "#f4efff",
    active: "#ece3ff",
    selected: "#d2c2ff",
    ink: "#352c6b",
    selectedInk: "#261d55",
    border: "rgba(53,44,107,0.18)",
  },
  {
    base: "#ecf8ff",
    active: "#dbf1ff",
    selected: "#bfe4ff",
    ink: "#1d546d",
    selectedInk: "#12384a",
    border: "rgba(29,84,109,0.18)",
  },
  {
    base: "#fff4ec",
    active: "#ffe7d6",
    selected: "#ffd1b3",
    ink: "#6f3b18",
    selectedInk: "#4c280f",
    border: "rgba(111,59,24,0.18)",
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

function applyPalette(node, palette) {
  if (!node) return;
  node.style.setProperty("--tab-color", palette.base);
  node.style.setProperty("--tab-active", palette.active);
  node.style.setProperty("--tab-selected", palette.selected);
  node.style.setProperty("--tab-ink", palette.ink);
  node.style.setProperty("--tab-selected-ink", palette.selectedInk || palette.ink);
  node.style.setProperty("--tab-selected-border", palette.border || "rgba(0,0,0,0.12)");
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

    const card = el("div", { class: "card card--soft question-card question-card--tabs" });
    const headerRow = el("div", { class: "mono phase-header phase-header--centered" });
    const heading = el("div", { class: "phase-header__title" }, "Questions");
    headerRow.appendChild(heading);

    const tabShell = el("div", { class: "round-tab-shell" });
    const tabBar = el("div", { class: "round-tabs" });
    const panelWrap = el("div", { class: "round-tab-panels" });

    tabShell.appendChild(tabBar);
    tabShell.appendChild(panelWrap);

    const statusNote = el("div", { class: "mono small wait-note round-status-note" }, "");
    statusNote.style.display = "none";

    const submitRow = el("div", { class: "round-submit-row" });
    const submitBtn = el(
      "button",
      { class: "btn big primary round-submit-btn", type: "button", disabled: "disabled" },
      "Submit"
    );
    submitRow.appendChild(submitBtn);

    card.appendChild(headerRow);
    card.appendChild(tabShell);
    card.appendChild(statusNote);
    card.appendChild(submitRow);

    root.appendChild(card);
    container.appendChild(root);

    const showStatus = (text = "") => {
      const trimmed = String(text || "").trim();
      statusNote.textContent = trimmed;
      statusNote.style.display = trimmed ? "" : "none";
    };

    const disableSubmit = () => {
      submitBtn.disabled = true;
      submitBtn.classList.remove("throb");
    };

    const enableSubmit = () => {
      submitBtn.disabled = false;
      submitBtn.classList.add("throb");
    };

    const tabButtons = [];
    const panels = [];
    const optionButtons = [];
    const promptNodes = [];

    for (let i = 0; i < 3; i += 1) {
      const palette = TAB_COLOURS[i % TAB_COLOURS.length];
      const tab = el("button", {
        class: "btn round-tab",
        type: "button",
        "data-index": String(i),
        disabled: "disabled",
      }, String(i + 1));
      applyPalette(tab, palette);
      tab.addEventListener("click", () => {
        if (tab.disabled) return;
        setActiveTab(i);
      });
      tabBar.appendChild(tab);

      const panel = el("div", { class: "round-tab-panel" });
      applyPalette(panel, palette);
      const badge = el("div", { class: "mono small round-panel__badge" }, `Question ${i + 1}`);
      const prompt = el("div", { class: "mono round-panel__prompt" }, "");
      const choicesRow = el("div", { class: "round-choice-row" });
      const choiceA = el("button", { class: "btn round-choice" }, "");
      const choiceB = el("button", { class: "btn round-choice" }, "");
      choicesRow.appendChild(choiceA);
      choicesRow.appendChild(choiceB);

      panel.appendChild(badge);
      panel.appendChild(prompt);
      panel.appendChild(choicesRow);
      panelWrap.appendChild(panel);

      tabButtons.push(tab);
      panels.push(panel);
      promptNodes.push(prompt);
      optionButtons.push([choiceA, choiceB]);
    }

    let idx = 0;
    let chosen = ["", "", ""];
    let published = false;
    let submitting = false;
    let alive = true;
    let stopWatcher = null;

    const timerContext = { code, role: "guest", round: 1 };

    const setActiveTab = (targetIdx) => {
      if (targetIdx < 0 || targetIdx >= tabButtons.length) return;
      idx = targetIdx;
      tabButtons.forEach((tab, i) => {
        const active = i === idx;
        tab.classList.toggle("round-tab--active", active);
        panels[i].classList.toggle("round-tab-panel--active", active);
      });
      if (!published && !submitting) resumeRoundTimer(timerContext);
    };

    const setOptionButtonsEnabled = (enabled) => {
      optionButtons.forEach((row) => {
        row.forEach((btn) => {
          btn.disabled = !enabled;
          if (!enabled) btn.classList.remove("throb");
        });
      });
    };

    const reflectTabState = (targetIdx) => {
      const answered = Boolean(chosen[targetIdx]);
      tabButtons[targetIdx].classList.toggle("round-tab--answered", answered);
      panels[targetIdx].classList.toggle("round-tab-panel--answered", answered);
    };

    const refreshChoiceStyles = (targetIdx) => {
      const current = chosen[targetIdx] || "";
      optionButtons[targetIdx].forEach((btn) => {
        const matches = Boolean(current) && (btn.textContent || "") === current;
        btn.classList.toggle("selected", matches);
      });
    };

    const refreshAllStyles = () => {
      for (let i = 0; i < optionButtons.length; i += 1) {
        reflectTabState(i);
        refreshChoiceStyles(i);
      }
    };

    const updateSubmitState = () => {
      if (published) {
        disableSubmit();
        submitBtn.textContent = "Submitted";
        return;
      }
      const ready = chosen.every((value) => Boolean(String(value || "").trim()));
      submitBtn.textContent = "Submit";
      if (ready && !submitting) enableSubmit();
      else disableSubmit();
    };

    const tabsReady = () => {
      tabButtons.forEach((tab) => { tab.disabled = false; });
      setActiveTab(idx);
    };

    const showWaitingState = (text) => {
      showStatus(text || "Waiting…");
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

    const waitMessageForOpponent = () => `Waiting for ${oppName}…`;

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
          showWaitingState("Waiting for round data…");
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

    const existingAns = (((room0.answers || {})[myRole] || {})[round] || []);

    triplet.forEach((entry, i) => {
      promptNodes[i].textContent = entry?.question || "";
      const [optA, optB] = entry.options || ["", ""];
      optionButtons[i][0].textContent = optA || "";
      optionButtons[i][1].textContent = optB || "";
    });

    optionButtons.forEach((row, rowIdx) => {
      row.forEach((btn) => {
        btn.addEventListener("click", () => {
          if (published || submitting) return;
          const text = btn.textContent || "";
          chosen[rowIdx] = text;
          refreshChoiceStyles(rowIdx);
          reflectTabState(rowIdx);
          updateSubmitState();
        });
      });
    });

    const finishRound = () => {
      if (published || submitting) return;
      submitting = true;
      pauseRoundTimer(timerContext);
      setOptionButtonsEnabled(false);
      disableSubmit();
      showStatus("Submitting…");
      publishAnswers();
    };

    submitBtn.addEventListener("click", finishRound);

    const publishAnswers = async () => {
      const payload = triplet.map((entry, idx2) => ({
        question: entry.question || "",
        chosen: chosen[idx2] || "",
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
        showStatus(waitMessageForOpponent());
        disableSubmit();
        submitBtn.textContent = "Submitted";
        setOptionButtonsEnabled(false);
      } catch (err) {
        console.warn("[questions] publish failed:", err);
        submitting = false;
        if (!published) {
          setOptionButtonsEnabled(true);
          updateSubmitState();
          showStatus("Retrying…");
          resumeRoundTimer(timerContext);
        }
      }
    };

    const tripletReady = triplet.every((entry) =>
      entry.question && entry.options && entry.options.length === 2
    );

    if (!tripletReady) {
      setOptionButtonsEnabled(false);
      showWaitingState("Preparing questions…");
      pauseRoundTimer(timerContext);
    } else if (existingAns.length === 3) {
      chosen = existingAns.map((entry) => entry?.chosen || "");
      published = true;
      submitting = false;
      refreshAllStyles();
      tabsReady();
      setOptionButtonsEnabled(false);
      showStatus(waitMessageForOpponent());
      disableSubmit();
      submitBtn.textContent = "Submitted";
      pauseRoundTimer(timerContext);
    } else {
      tabsReady();
      setOptionButtonsEnabled(true);
      refreshAllStyles();
      updateSubmitState();
      showStatus("");
      setActiveTab(0);
    }

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
          showStatus(waitMessageForOpponent());
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
