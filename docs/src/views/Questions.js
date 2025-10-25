// /src/views/Questions.js
//
// Questions phase — local-only until submission.
// • Shows exactly the player’s three questions from rooms/{code}/rounds/{round}/{role}Items.
// • Tabbed layout lets the player jump freely between the three questions.
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

const TAB_PALETTES = [
  { base: "hsl(272, 68%, 94%)", muted: "hsl(272, 68%, 97%)", strong: "hsl(272, 58%, 80%)" },
  { base: "hsl(204, 72%, 93%)", muted: "hsl(204, 72%, 97%)", strong: "hsl(204, 62%, 79%)" },
  { base: "hsl(44, 86%, 94%)", muted: "hsl(44, 86%, 97%)", strong: "hsl(44, 76%, 82%)" },
];

function el(tag, attrs = {}, kids = []) {
  const n = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (k === "class") n.className = v;
    else if (k === "style" && v && typeof v === "object") {
      for (const sk in v) n.style[sk] = v[sk];
    } else if (k.startsWith("on") && typeof v === "function") {
      n.addEventListener(k.slice(2), v);
    } else {
      n.setAttribute(k, v);
    }
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

    const heading = el("h1", { class: "view-heading" }, "Questions");
    root.appendChild(heading);

    const roundShell = el("div", { class: "round-shell" });

    const card = el("div", { class: "card round-card question-card" });
    const cardSurface = el("div", { class: "round-card__surface" });
    card.appendChild(cardSurface);

    const tabRow = el("div", { class: "round-tabs" });
    const panelWrap = el("div", { class: "round-panels" });

    cardSurface.appendChild(tabRow);
    cardSurface.appendChild(panelWrap);

    roundShell.appendChild(card);

    const submitBtn = el("button", {
      class: "btn big round-submit-btn",
      type: "button",
    }, "Submit answers");
    submitBtn.disabled = true;

    const submitRow = el("div", { class: "round-submit-row" }, submitBtn);
    roundShell.appendChild(submitRow);

    let waitMessageDefault = "Waiting…";
    const waitMsg = el("div", { class: "mono small wait-note" }, waitMessageDefault);
    waitMsg.style.display = "none";
    roundShell.appendChild(waitMsg);

    root.appendChild(roundShell);

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
      roundShell.style.visibility = "hidden";
    };

    const hideOverlay = () => {
      overlay.classList.add("stage-overlay--hidden");
      roundShell.style.visibility = "";
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
    waitMsg.textContent = waitMessageDefault;

    const overlayWaiting = () => `Waiting for ${oppName}`;
    const showWaitingOverlay = (note) => {
      showOverlay(overlayWaiting(), note || "Waiting for opponent");
    };

    const waitForRoundData = async () => {
      let firstWait = true;
      let attempts = 0;
      const MAX_ATTEMPTS = 8;
      while (true) {
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
          firstWait = false;
        }
        if (attempts >= MAX_ATTEMPTS) break;
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      return {};
    };

    const rd = await waitForRoundData();

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

    const chosen = ["", "", ""];
    let activeIndex = 0;
    let published = false;
    let submitting = false;
    let alive = true;
    let stopWatcher = null;

    const tabButtons = [];
    const panelNodes = [];
    const optionButtons = [];

    function applyPalette(index) {
      const palette = TAB_PALETTES[index % TAB_PALETTES.length];
      cardSurface.style.setProperty("--round-card-color", palette.base);
      cardSurface.style.setProperty("--round-card-strong", palette.strong);
    }

    function updateSubmitState() {
      const ready = chosen.every((value) => value);
      const disable = !ready || submitting || published;
      submitBtn.disabled = disable;
      submitBtn.classList.toggle("throb", ready && !submitting && !published);
    }

    function updateTabStates() {
      tabButtons.forEach((btn, idx) => {
        btn.classList.toggle("is-active", idx === activeIndex);
        btn.classList.toggle("is-answered", Boolean(chosen[idx]));
      });
      panelNodes.forEach((panel, idx) => {
        panel.classList.toggle("is-active", idx === activeIndex);
      });
    }

    function updateChoiceStyles(index) {
      const answer = chosen[index] || "";
      (optionButtons[index] || []).forEach((btn) => {
        const text = btn.textContent || "";
        btn.classList.toggle("is-selected", Boolean(answer) && text === answer);
      });
    }

    function refreshAllChoices() {
      optionButtons.forEach((_, idx) => updateChoiceStyles(idx));
    }

    function setInteractionEnabled(enabled) {
      tabButtons.forEach((btn) => {
        btn.disabled = !enabled;
      });
      optionButtons.forEach((list) => {
        list.forEach((btn) => {
          btn.disabled = !enabled;
        });
      });
      if (enabled) {
        updateSubmitState();
      } else {
        submitBtn.disabled = true;
        submitBtn.classList.remove("throb");
      }
    }

    function setActiveTab(index) {
      if (index < 0) index = 0;
      if (index >= triplet.length) index = triplet.length - 1;
      activeIndex = index;
      applyPalette(index);
      updateTabStates();
      updateChoiceStyles(index);
    }

    function hideWaitingState() {
      waitMsg.style.display = "none";
    }

    function showWaitingState(text) {
      waitMsg.textContent = text || waitMessageDefault;
      waitMsg.style.display = "";
    }

    function onPick(questionIndex, text) {
      if (published || submitting) return;
      hideWaitingState();
      chosen[questionIndex] = text;
      updateChoiceStyles(questionIndex);
      updateTabStates();
      updateSubmitState();
    }

    triplet.forEach((entry, idx) => {
      const palette = TAB_PALETTES[idx % TAB_PALETTES.length];
      const tab = el("button", {
        class: "round-tab",
        type: "button",
      }, String(idx + 1));
      tab.style.setProperty("--tab-color-base", palette.base);
      tab.style.setProperty("--tab-color-muted", palette.muted);
      tabRow.appendChild(tab);
      tabButtons.push(tab);

      const panel = el("div", { class: "round-panel" });
      panel.style.setProperty("--tab-color-base", palette.base);
      panel.style.setProperty("--round-panel-strong", palette.strong);
      panelNodes.push(panel);

      const prompt = el("div", { class: "round-panel__prompt mono" }, entry?.question || "");
      panel.appendChild(prompt);

      const choiceGroup = el("div", { class: "choice-grid" });
      const optionRefs = [];
      (entry?.options || []).forEach((opt) => {
        const btn = el("button", { class: "round-option", type: "button" }, opt || "");
        btn.addEventListener("click", () => {
          setActiveTab(idx);
          onPick(idx, opt || "");
        });
        choiceGroup.appendChild(btn);
        optionRefs.push(btn);
      });
      optionButtons.push(optionRefs);
      panel.appendChild(choiceGroup);

      panelWrap.appendChild(panel);

      tab.addEventListener("click", () => {
        if (submitting || published) return;
        setActiveTab(idx);
      });
    });

    hideWaitingState();
    setActiveTab(0);
    refreshAllChoices();

    const existingAns = (((room0.answers || {})[myRole] || {})[round] || []);
    if (Array.isArray(existingAns) && existingAns.length === 3) {
      existingAns.forEach((entry, idx) => {
        if (idx < chosen.length) {
          chosen[idx] = entry?.chosen || "";
        }
      });
      refreshAllChoices();
      updateTabStates();
      updateSubmitState();
      published = true;
      setInteractionEnabled(false);
      pauseRoundTimer(timerContext);
      showWaitingOverlay("Review submitted");
    } else {
      setInteractionEnabled(true);
      resumeRoundTimer(timerContext);
    }

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
        "timestamps.updatedAt": serverTimestamp(),
      };

      showOverlay("Submitting", "Saving your answers…");

      try {
        console.log(`[flow] submit answers | code=${code} round=${round} role=${myRole}`);
        await updateDoc(rRef, patch);
        published = true;
        submitting = false;
        pauseRoundTimer(timerContext);
        showWaitingOverlay();
      } catch (err) {
        console.warn("[questions] publish failed:", err);
        submitting = false;
        hideOverlay();
        showWaitingState("Retrying…");
        setInteractionEnabled(true);
        resumeRoundTimer(timerContext);
      }
    }

    function finishRound() {
      if (submitting || published) return;
      hideOverlay();
      waitMsg.style.display = "none";
      setInteractionEnabled(false);
      pauseRoundTimer(timerContext);
      publishAnswers();
    }

    submitBtn.addEventListener("click", () => {
      if (submitBtn.disabled) return;
      finishRound();
    });

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
        return;
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
