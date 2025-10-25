// /src/views/Questions.js
//
// Questions phase — local-only until submission.
// • Shows the player’s three questions from rooms/{code}/rounds/{round}/{role}Items inside a tabbed card.
// • Each tab stores its selection locally so the player can review and adjust freely before submitting.
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
    const root = el("div", { class: "view view-questions stage-center" });

    const card = el("div", { class: "card card--soft card--center question-card question-card--tabbed" });
    const headerRow = el("div", { class: "mono phase-header phase-header--centered" });
    const heading = el("div", { class: "phase-header__title" }, "Questions");
    headerRow.appendChild(heading);

    const tabbedBox = el("div", { class: "tabbed-box" });
    const tabRow = el("div", { class: "tabbed-box__tabs" });
    const body = el("div", { class: "tabbed-box__body" });
    const prompt = el("div", { class: "mono question-card__prompt tabbed-box__prompt" }, "");
    const choiceWrap = el("div", { class: "tabbed-box__choices" });
    const btn1 = el("button", { class: "btn big tabbed-choice-btn", type: "button" }, "");
    const btn2 = el("button", { class: "btn big tabbed-choice-btn", type: "button" }, "");
    choiceWrap.appendChild(btn1);
    choiceWrap.appendChild(btn2);
    body.appendChild(prompt);
    body.appendChild(choiceWrap);
    tabbedBox.appendChild(tabRow);
    tabbedBox.appendChild(body);

    const statusNote = el("div", { class: "mono small wait-note" }, "Waiting…");
    statusNote.style.display = "none";

    const submitRow = el("div", { class: "tabbed-box__submit" });
    const submitBtn = el("button", { class: "btn mark-submit-btn", type: "button", disabled: "disabled" }, "Submit");
    submitRow.appendChild(submitBtn);

    card.appendChild(headerRow);
    card.appendChild(tabbedBox);
    card.appendChild(statusNote);
    card.appendChild(submitRow);

    root.appendChild(card);

    const overlay = el("div", { class: "stage-overlay stage-overlay--hidden" });
    const overlayTitle = el("div", { class: "mono stage-overlay__title" }, "");
    const overlayNote = el("div", { class: "mono small stage-overlay__note" }, "");
    overlay.appendChild(overlayTitle);
    overlay.appendChild(overlayNote);
    root.appendChild(overlay);

    container.appendChild(root);

    const showOverlay = (title, note) => {
      overlayTitle.textContent = title || "";
      overlayNote.textContent = note || "";
      overlay.classList.remove("stage-overlay--hidden");
      card.classList.add("tabbed-card--hidden");
    };

    const hideOverlay = () => {
      overlay.classList.add("stage-overlay--hidden");
      card.classList.remove("tabbed-card--hidden");
    };

    const TAB_PALETTES = [
      { base: "#f5f1ff", accent: "#e2d9ff", strong: "#cdbdff", ink: "#26194b" },
      { base: "#eef7ff", accent: "#cde6ff", strong: "#abd4ff", ink: "#15355a" },
      { base: "#fff5f0", accent: "#ffdacc", strong: "#ffc0a6", ink: "#5a2c18" },
    ];

    const tabButtons = TAB_PALETTES.map((palette, index) => {
      const tab = el("button", {
        class: "tabbed-box__tab",
        type: "button",
        "data-index": String(index),
      }, String(index + 1));
      tab.dataset.base = palette.base;
      tab.dataset.accent = palette.accent;
      tab.dataset.strong = palette.strong;
      tab.dataset.ink = palette.ink;
      tab.style.setProperty("--tab-color", palette.accent);
      tab.style.setProperty("--tab-color-strong", palette.strong);
      tabRow.appendChild(tab);
      return tab;
    });

    let activeTab = 0;
    const chosen = ["", "", ""];
    let published = false;
    let submitting = false;
    let triplet = [];
    let timerContext = null;
    let waitMessageDefault = "Waiting…";

    const setPalette = (index) => {
      const tab = tabButtons[index] || {};
      const base = tab.dataset?.base || TAB_PALETTES[index]?.base || TAB_PALETTES[0].base;
      const accent = tab.dataset?.accent || TAB_PALETTES[index]?.accent || TAB_PALETTES[0].accent;
      const strong = tab.dataset?.strong || TAB_PALETTES[index]?.strong || TAB_PALETTES[0].strong;
      const ink = tab.dataset?.ink || TAB_PALETTES[index]?.ink || TAB_PALETTES[0].ink || "#111";
      tabbedBox.style.setProperty("--tab-base", base);
      tabbedBox.style.setProperty("--tab-accent", accent);
      tabbedBox.style.setProperty("--tab-strong", strong);
      tabbedBox.style.setProperty("--tab-ink", ink);
    };

    const refreshTabs = () => {
      tabButtons.forEach((tab, index) => {
        const answered = Boolean(chosen[index]);
        tab.classList.toggle("is-active", index === activeTab);
        tab.classList.toggle("is-answered", answered);
      });
      setPalette(activeTab);
    };

    const refreshChoiceStyles = () => {
      const current = chosen[activeTab] || "";
      [btn1, btn2].forEach((btn) => {
        const isSelected = Boolean(current) && (btn.textContent || "") === current;
        btn.classList.toggle("is-selected", isSelected);
        btn.setAttribute("aria-pressed", isSelected ? "true" : "false");
        if (!btn.disabled && !published) {
          btn.classList.toggle("throb", !isSelected);
        } else {
          btn.classList.remove("throb");
        }
      });
    };

    const setButtonsEnabled = (enabled) => {
      btn1.disabled = !enabled;
      btn2.disabled = !enabled;
      if (!enabled) {
        btn1.classList.remove("throb");
        btn2.classList.remove("throb");
      }
      refreshChoiceStyles();
    };

    const renderActiveQuestion = () => {
      const entry = triplet[activeTab] || {};
      const [optA = "", optB = ""] = Array.isArray(entry.options) ? entry.options : [];
      prompt.textContent = entry.question || "";
      btn1.textContent = optA;
      btn2.textContent = optB;
      refreshChoiceStyles();
    };

    const updateSubmitState = () => {
      const ready = chosen.every((value) => Boolean(value));
      submitBtn.disabled = !(ready && !published && !submitting);
      submitBtn.classList.toggle("throb", !submitBtn.disabled);
    };

    const showStatus = (text, { disable = false } = {}) => {
      statusNote.textContent = text || waitMessageDefault;
      statusNote.style.display = "";
      if (disable) {
        tabbedBox.classList.add("is-disabled");
        setButtonsEnabled(false);
      } else {
        tabbedBox.classList.remove("is-disabled");
      }
    };

    const hideStatus = () => {
      statusNote.style.display = "none";
      tabbedBox.classList.remove("is-disabled");
    };

    tabButtons.forEach((tab, index) => {
      tab.addEventListener("click", () => {
        activeTab = index;
        refreshTabs();
        renderActiveQuestion();
      });
    });

    let stopWatcher = null;
    let alive = true;
    this.unmount = () => {
      alive = false;
      try { stopWatcher && stopWatcher(); } catch {}
      pauseRoundTimer(timerContext || {});
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
    statusNote.textContent = waitMessageDefault;

    const overlayWaiting = () => `Waiting for ${oppName}`;
    const showWaitingOverlay = (note) => {
      showOverlay(overlayWaiting(), note || "Waiting for opponent");
    };

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
          showStatus("Waiting for round data…", { disable: true });
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

    const tripletReady = triplet.every((entry) =>
      entry.question && entry.options && entry.options.length === 2
    );

    if (!tripletReady) {
      showStatus("Preparing questions…", { disable: true });
      pauseRoundTimer(timerContext);
    } else if (existingAns.length === 3) {
      published = true;
      hideStatus();
      refreshTabs();
      renderActiveQuestion();
      setButtonsEnabled(false);
      updateSubmitState();
      pauseRoundTimer(timerContext);
      showWaitingOverlay();
    } else {
      hideStatus();
      refreshTabs();
      renderActiveQuestion();
      setButtonsEnabled(true);
      updateSubmitState();
      resumeRoundTimer(timerContext);
    }

    const showWaitingState = (text, options = {}) => {
      hideOverlay();
      const disable = options.disable !== undefined ? options.disable : true;
      showStatus(text || waitMessageDefault, { disable });
    };

    async function publishAnswers() {
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
        pauseRoundTimer(timerContext);
        showWaitingOverlay("Waiting for opponent");
      } catch (err) {
        console.warn("[questions] publish failed:", err);
        submitting = false;
        hideOverlay();
        showWaitingState("Retrying…", { disable: false });
        setButtonsEnabled(true);
      }
    }

    const onPick = (text) => {
      if (published || submitting) return;
      chosen[activeTab] = text || "";
      refreshTabs();
      refreshChoiceStyles();
      updateSubmitState();
    };

    btn1.addEventListener("click", () => onPick(btn1.textContent));
    btn2.addEventListener("click", () => onPick(btn2.textContent));

    submitBtn.addEventListener("click", () => {
      if (submitBtn.disabled) return;
      if (!chosen.every((value) => Boolean(value))) return;
      setButtonsEnabled(false);
      updateSubmitState();
      publishAnswers();
    });

    updateSubmitState();

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
          showWaitingOverlay();
        }
      }

      if (!published) {
        const remoteAnswers = (((data.answers || {})[myRole] || {})[round] || []);
        if (remoteAnswers.length === 3) {
          published = true;
          setButtonsEnabled(false);
          updateSubmitState();
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

    // cleanup handled via earlier unmount assignment
  },

  async unmount() { /* instance handles cleanup */ }
};
