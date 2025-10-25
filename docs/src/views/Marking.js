// /src/views/Marking.js
//
// Marking phase — judge opponent answers while a hidden timer keeps running.
// • Presents the opponent’s three answers inside a tabbed card with ✓ / ? / ✕ verdict buttons.
// • No visible countdown; the round timer resumes when marking begins and stops on submission.
// • Submission writes marking.{role}.{round}, timings.{role}.{round}, markingAck.{role}.{round} = true.
// • Host advances to Award once both acknowledgements are present.

import { ensureAuth, db } from "../lib/firebase.js";
import {
  doc,
  collection,
  getDoc,
  onSnapshot,
  updateDoc,
  serverTimestamp,
  runTransaction,
} from "firebase/firestore";

import { resumeRoundTimer, pauseRoundTimer, getRoundTimerTotal, clearRoundTimer } from "../lib/RoundTimer.js";
import { clampCode, getHashParams, getStoredRole } from "../lib/util.js";
const VERDICT = { RIGHT: "right", WRONG: "wrong", UNKNOWN: "unknown" };

function el(tag, attrs = {}, kids = []) {
  const node = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (k === "class") node.className = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  (Array.isArray(kids) ? kids : [kids]).forEach((child) =>
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child)
  );
  return node;
}

function same(a, b) {
  return String(a || "").trim() === String(b || "").trim();
}

function resolveCorrectAnswer(answer = {}, fallbackItem = {}) {
  if (answer.correct) return answer.correct;
  if (fallbackItem.correct_answer) return fallbackItem.correct_answer;
  return "";
}

function countCorrectAnswers(answers = [], items = []) {
  let total = 0;
  for (let i = 0; i < answers.length; i += 1) {
    const answer = answers[i] || {};
    const chosen = answer.chosen || "";
    if (!chosen) continue;
    const correct = resolveCorrectAnswer(answer, items[i] || {});
    if (correct && same(chosen, correct)) total += 1;
  }
  return total;
}

const roomRef = (code) => doc(db, "rooms", code);
const roundSubColRef = (code) => collection(roomRef(code), "rounds");

export default {
  async mount(container) {
    const me = await ensureAuth();

    const params = getHashParams();
    const code = clampCode(params.get("code") || "");
    let round = parseInt(params.get("round") || "1", 10) || 1;

    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    container.innerHTML = "";
    const root = el("div", { class: "view view-marking stage-center" });

    const card = el("div", { class: "card card--center mark-card mark-card--tabbed" });
    const headerRow = el("div", { class: "mono phase-header phase-header--centered" });
    const heading = el("div", { class: "phase-header__title" }, "Marking");
    headerRow.appendChild(heading);

    const tabbedBox = el("div", { class: "tabbed-box" });
    const tabRow = el("div", { class: "tabbed-box__tabs" });
    const body = el("div", { class: "tabbed-box__body" });
    const prompt = el("div", { class: "mono mark-card__prompt" }, "");
    const answerBox = el("div", { class: "mark-answer mono" });
    const answerLabel = el("div", { class: "mark-answer__label mono small" }, "");
    const answerText = el("div", { class: "mark-answer__text" }, "");
    answerBox.appendChild(answerLabel);
    answerBox.appendChild(answerText);

    const verdictWrap = el("div", { class: "tabbed-verdicts" });
    const btnRight = el("button", {
      class: "btn verdict-btn tabbed-verdict-btn",
      type: "button",
      title: "Mark as correct",
      "aria-pressed": "false",
    }, "✓");
    const btnUnknown = el("button", {
      class: "btn verdict-btn tabbed-verdict-btn",
      type: "button",
      title: "Mark as unsure",
      "aria-pressed": "false",
    }, "?");
    const btnWrong = el("button", {
      class: "btn verdict-btn tabbed-verdict-btn",
      type: "button",
      title: "Mark as incorrect",
      "aria-pressed": "false",
    }, "✕");
    verdictWrap.appendChild(btnRight);
    verdictWrap.appendChild(btnUnknown);
    verdictWrap.appendChild(btnWrong);

    body.appendChild(prompt);
    body.appendChild(answerBox);
    body.appendChild(verdictWrap);
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

    const markValue = (value) => {
      if (value === VERDICT.RIGHT) return VERDICT.RIGHT;
      if (value === VERDICT.WRONG) return VERDICT.WRONG;
      return VERDICT.UNKNOWN;
    };

    let activeTab = 0;
    const verdicts = [null, null, null];
    let published = false;
    let submitting = false;
    let markingItems = [];
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
        const answered = Boolean(verdicts[index]);
        tab.classList.toggle("is-active", index === activeTab);
        tab.classList.toggle("is-answered", answered);
      });
      setPalette(activeTab);
    };

    const verdictButtons = [btnRight, btnUnknown, btnWrong];

    const refreshVerdicts = () => {
      const current = verdicts[activeTab] || "";
      verdictButtons.forEach((btn) => {
        const value = btn === btnRight ? VERDICT.RIGHT : btn === btnWrong ? VERDICT.WRONG : VERDICT.UNKNOWN;
        const isSelected = current === value;
        btn.classList.toggle("is-selected", isSelected);
        btn.setAttribute("aria-pressed", isSelected ? "true" : "false");
        if (!btn.disabled && !published) {
          btn.classList.toggle("throb", !isSelected);
        } else {
          btn.classList.remove("throb");
        }
      });
    };

    const setVerdictButtonsEnabled = (enabled) => {
      verdictButtons.forEach((btn) => {
        btn.disabled = !enabled;
        if (!enabled) btn.classList.remove("throb");
      });
      refreshVerdicts();
    };

    const renderActiveTab = () => {
      const entry = markingItems[activeTab] || {};
      const questionText = entry.question || "";
      const answerTextValue = entry.answer || "";
      prompt.textContent = `${activeTab + 1}. ${questionText || "(missing question)"}`;
      answerText.textContent = answerTextValue || "(no answer recorded)";
      refreshVerdicts();
    };

    const updateSubmitState = () => {
      const ready = verdicts.every((value) => value === VERDICT.RIGHT || value === VERDICT.WRONG || value === VERDICT.UNKNOWN);
      submitBtn.disabled = !(ready && !published && !submitting);
      submitBtn.classList.toggle("throb", !submitBtn.disabled);
    };

    const showStatus = (text, { disable = false } = {}) => {
      statusNote.textContent = text || waitMessageDefault;
      statusNote.style.display = "";
      if (disable) {
        tabbedBox.classList.add("is-disabled");
        setVerdictButtonsEnabled(false);
      } else {
        tabbedBox.classList.remove("is-disabled");
      }
    };

    const hideStatus = () => {
      statusNote.style.display = "none";
      tabbedBox.classList.remove("is-disabled");
    };

    let waitingTitle = "Waiting";

    const showWaitingOverlay = (note) => {
      showOverlay(waitingTitle, note || waitMessageDefault);
    };

    const showWaitingState = (text, { disable = true } = {}) => {
      hideOverlay();
      showStatus(text || waitMessageDefault, { disable });
    };

    tabButtons.forEach((tab, index) => {
      tab.addEventListener("click", () => {
        activeTab = index;
        refreshTabs();
        renderActiveTab();
      });
    });

    verdictButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.disabled) return;
        const value = btn === btnRight ? VERDICT.RIGHT : btn === btnWrong ? VERDICT.WRONG : VERDICT.UNKNOWN;
        if (published || submitting) return;
        verdicts[activeTab] = markValue(value);
        refreshTabs();
        refreshVerdicts();
        updateSubmitState();
      });
    });

    let stopRoomWatch = null;
    let finalizing = false;
    let alive = true;

    this.unmount = () => {
      alive = false;
      try { stopRoomWatch && stopRoomWatch(); } catch {}
      pauseRoundTimer(timerContext || {});
    };

    const rRef = roomRef(code);
    const rdRef = doc(roundSubColRef(code), String(round));

    const roomSnap = await getDoc(rRef);
    const roomData0 = roomSnap.data() || {};
    const { hostUid, guestUid } = roomData0.meta || {};
    const storedRole = getStoredRole(code);
    const myRole = storedRole === "host" || storedRole === "guest"
      ? storedRole
      : hostUid === me.uid ? "host" : guestUid === me.uid ? "guest" : "guest";
    const oppRole = myRole === "host" ? "guest" : "host";
    const oppName = oppRole === "host" ? "Daniel" : "Jaime";

    waitMessageDefault = `Waiting for ${oppName}…`;
    waitingTitle = `Waiting for ${oppName}`;
    statusNote.textContent = waitMessageDefault;
    answerLabel.textContent = `${oppName}’s answer`;

    timerContext = { code, role: myRole, round };

    const rdSnap = await getDoc(rdRef);
    const rd = rdSnap.data() || {};
    const oppItems = (oppRole === "host" ? rd.hostItems : rd.guestItems) || [];
    const oppAnswers = (((roomData0.answers || {})[oppRole] || {})[round] || []).map((a) => a?.chosen || "");

    markingItems = [0, 1, 2].map((i) => {
      const item = oppItems[i] || {};
      const question = typeof item.question === "string" ? item.question.trim() : "";
      const answer = typeof oppAnswers[i] === "string" ? oppAnswers[i].trim() : "";
      return {
        question: question || "(missing question)",
        answer: answer || "(no answer recorded)",
      };
    });

    if (!markingItems.length) {
      showStatus("Preparing review…", { disable: true });
    } else {
      hideStatus();
      refreshTabs();
      renderActiveTab();
    }

    const existingMarks = (((roomData0.marking || {})[myRole] || {})[round] || []);

    if (Array.isArray(existingMarks) && existingMarks.length === 3) {
      for (let i = 0; i < verdicts.length; i += 1) {
        verdicts[i] = markValue(existingMarks[i]);
      }
      published = true;
      refreshTabs();
      renderActiveTab();
      setVerdictButtonsEnabled(false);
      updateSubmitState();
      pauseRoundTimer(timerContext);
      clearRoundTimer(timerContext);
      showWaitingOverlay("Review submitted");
    } else {
      setVerdictButtonsEnabled(true);
      updateSubmitState();
      resumeRoundTimer(timerContext);
    }

    const submitMarks = async () => {
      if (published || submitting) return;
      const ready = verdicts.every((value) => value === VERDICT.RIGHT || value === VERDICT.WRONG || value === VERDICT.UNKNOWN);
      if (!ready) return;
      submitting = true;
      const safeMarks = verdicts.map((value) => markValue(value));
      setVerdictButtonsEnabled(false);
      updateSubmitState();
      pauseRoundTimer(timerContext);
      const totalSecondsRaw = getRoundTimerTotal(timerContext) / 1000;
      const totalSeconds = Math.max(0, Math.round(totalSecondsRaw * 100) / 100);
      const patch = {
        [`marking.${myRole}.${round}`]: safeMarks,
        [`markingAck.${myRole}.${round}`]: true,
        [`timings.${myRole}.${round}`]: { totalSeconds },
        "timestamps.updatedAt": serverTimestamp(),
      };

      try {
        showWaitingOverlay("Submitting review…");
        await updateDoc(rRef, patch);
        published = true;
        submitting = false;
        showWaitingOverlay("Review submitted");
        clearRoundTimer(timerContext);
      } catch (err) {
        console.warn("[marking] submit failed:", err);
        submitting = false;
        if (!published) {
          hideOverlay();
          showWaitingState("Retrying…", { disable: false });
          setVerdictButtonsEnabled(true);
          updateSubmitState();
          resumeRoundTimer(timerContext);
        }
      }
    };

    submitBtn.addEventListener("click", () => {
      if (submitBtn.disabled) return;
      submitMarks();
    });

    updateSubmitState();

    const finalizeRound = async () => {
      if (finalizing) return;
      finalizing = true;
      try {
        await runTransaction(db, async (tx) => {
          const roomSnapCur = await tx.get(rRef);
          if (!roomSnapCur.exists()) return;
          const roomData = roomSnapCur.data() || {};
          if ((roomData.state || "").toLowerCase() !== "marking") return;

          const ackHost = Boolean(((roomData.markingAck || {}).host || {})[round]);
          const ackGuest = Boolean(((roomData.markingAck || {}).guest || {})[round]);
          if (!(ackHost && ackGuest)) return;

          const roundSnapCur = await tx.get(rdRef);
          const roundData = roundSnapCur.exists() ? (roundSnapCur.data() || {}) : {};
          const answersHost = (((roomData.answers || {}).host || {})[round] || []);
          const answersGuest = (((roomData.answers || {}).guest || {})[round] || []);
          const hostItems = roundData.hostItems || [];
          const guestItems = roundData.guestItems || [];

          const roundHostScore = countCorrectAnswers(answersHost, hostItems);
          const roundGuestScore = countCorrectAnswers(answersGuest, guestItems);
          const currentRound = Number(roomData.round) || round;

          tx.update(rRef, {
            state: "award",
            round: currentRound,
            [`scores.host.${currentRound}`]: roundHostScore,
            [`scores.guest.${currentRound}`]: roundGuestScore,
            "timestamps.updatedAt": serverTimestamp(),
          });
        });
      } catch (err) {
        console.warn("[marking] finalize failed:", err);
      } finally {
        finalizing = false;
      }
    };

    stopRoomWatch = onSnapshot(rRef, (snap) => {
      const data = snap.data() || {};
      const stateName = (data.state || "").toLowerCase();

      if (Number.isFinite(Number(data.round))) {
        const nextRound = Number(data.round);
        if (nextRound !== round) {
          round = nextRound;
          timerContext.round = round;
        }
      }

      if (stateName === "countdown") {
        setTimeout(() => {
          location.hash = `#/countdown?code=${code}&round=${data.round || round}`;
        }, 80);
        return;
      }

      if (stateName === "questions") {
        setTimeout(() => {
          location.hash = `#/questions?code=${code}&round=${data.round || round}`;
        }, 80);
        return;
      }

      if (stateName === "award") {
        setTimeout(() => {
          location.hash = `#/award?code=${code}&round=${data.round || round}`;
        }, 80);
        return;
      }

      if (stateName === "maths") {
        setTimeout(() => { location.hash = `#/maths?code=${code}`; }, 80);
        return;
      }

      const markingAck = data.markingAck || {};
      const ackMine = Boolean(((markingAck[myRole] || {})[round]));
      const ackOpp = Boolean(((markingAck[oppRole] || {})[round]));

      if (ackMine && !published) {
        const incomingMarks = (((data.marking || {})[myRole] || {})[round] || []);
        if (incomingMarks.length === 3) {
          for (let i = 0; i < verdicts.length; i += 1) {
            verdicts[i] = markValue(incomingMarks[i]);
          }
          published = true;
          submitting = false;
          refreshTabs();
          refreshVerdicts();
          setVerdictButtonsEnabled(false);
          updateSubmitState();
          pauseRoundTimer(timerContext);
          clearRoundTimer(timerContext);
          showWaitingOverlay(ackOpp ? "Review submitted" : waitMessageDefault);
        }
      }

      if (published && ackOpp && ackMine) {
        showWaitingOverlay("Review submitted");
      }

      if (myRole === "host" && stateName === "marking" && ackMine && ackOpp) {
        finalizeRound();
      }
    }, (err) => {
      console.warn("[marking] room snapshot error:", err);
    });
  },

  async unmount() { /* instance handles cleanup */ }
};
