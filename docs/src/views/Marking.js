// /src/views/Marking.js
//
// Marking phase — redesigned with a tabbed layout for reviewing opponent answers.
// • Shows opponent questions + chosen answers with ✓ / ? / ✕ toggles per tab.
// • Choices are colour-coded per tab and stay editable until Submit.
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

function applyPalette(node, palette) {
  if (!node) return;
  node.style.setProperty("--tab-color", palette.base);
  node.style.setProperty("--tab-active", palette.active);
  node.style.setProperty("--tab-selected", palette.selected);
  node.style.setProperty("--tab-ink", palette.ink);
  node.style.setProperty("--tab-selected-ink", palette.selectedInk || palette.ink);
  node.style.setProperty("--tab-selected-border", palette.border || "rgba(0,0,0,0.12)");
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

    const card = el("div", { class: "card card--soft mark-card mark-card--tabs" });
    const headerRow = el("div", { class: "mono phase-header phase-header--centered" });
    const heading = el("div", { class: "phase-header__title" }, "Marking");
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
    const questionNodes = [];
    const answerNodes = [];
    const verdictButtons = [];

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
      const answerCard = el("div", { class: "round-panel__answer-card" });
      const answerLabel = el("div", { class: "mono small round-panel__answer-label" }, "");
      const answerText = el("div", { class: "round-panel__answer-text" }, "");
      answerCard.appendChild(answerLabel);
      answerCard.appendChild(answerText);

      const verdictRow = el("div", { class: "round-verdict-row" });
      const btnRight = el("button", {
        class: "btn round-verdict-btn round-verdict-btn--right",
        type: "button",
        title: "Mark as correct",
      }, "✓");
      const btnUnknown = el("button", {
        class: "btn round-verdict-btn round-verdict-btn--unknown",
        type: "button",
        title: "Mark as unsure",
      }, "?");
      const btnWrong = el("button", {
        class: "btn round-verdict-btn round-verdict-btn--wrong",
        type: "button",
        title: "Mark as incorrect",
      }, "✕");
      verdictRow.appendChild(btnRight);
      verdictRow.appendChild(btnUnknown);
      verdictRow.appendChild(btnWrong);

      panel.appendChild(badge);
      panel.appendChild(prompt);
      panel.appendChild(answerCard);
      panel.appendChild(verdictRow);
      panelWrap.appendChild(panel);

      tabButtons.push(tab);
      panels.push(panel);
      questionNodes.push(prompt);
      answerNodes.push({ label: answerLabel, text: answerText });
      verdictButtons.push([btnRight, btnUnknown, btnWrong]);
    }

    let idx = 0;
    let marks = [null, null, null];
    let published = false;
    let submitting = false;
    let stopRoomWatch = null;
    let finalizing = false;

    const timerContext = { code, role: "guest", round };

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

    const setVerdictsEnabled = (enabled) => {
      verdictButtons.forEach((row) => {
        row.forEach((btn) => { btn.disabled = !enabled; });
      });
    };

    const markValue = (value) => {
      if (value === VERDICT.RIGHT) return VERDICT.RIGHT;
      if (value === VERDICT.WRONG) return VERDICT.WRONG;
      return VERDICT.UNKNOWN;
    };

    const reflectTabState = (targetIdx) => {
      const answered = marks[targetIdx] !== null && marks[targetIdx] !== undefined;
      tabButtons[targetIdx].classList.toggle("round-tab--answered", answered);
      panels[targetIdx].classList.toggle("round-tab-panel--answered", answered);
    };

    const refreshVerdictStyles = (targetIdx) => {
      const value = marks[targetIdx];
      const row = verdictButtons[targetIdx] || [];
      row.forEach((btn) => {
        const symbol = btn.textContent || "";
        const matches =
          (symbol === "✓" && value === VERDICT.RIGHT) ||
          (symbol === "✕" && value === VERDICT.WRONG) ||
          (symbol === "?" && value === VERDICT.UNKNOWN);
        btn.classList.toggle("selected", matches);
      });
    };

    const refreshAllStyles = () => {
      for (let i = 0; i < verdictButtons.length; i += 1) {
        reflectTabState(i);
        refreshVerdictStyles(i);
      }
    };

    const updateSubmitState = () => {
      if (published) {
        disableSubmit();
        submitBtn.textContent = "Submitted";
        return;
      }
      const ready = marks.every((value) => value === VERDICT.RIGHT || value === VERDICT.WRONG || value === VERDICT.UNKNOWN);
      submitBtn.textContent = "Submit";
      if (ready && !submitting) enableSubmit();
      else disableSubmit();
    };

    const tabsReady = () => {
      tabButtons.forEach((tab) => { tab.disabled = false; });
      setActiveTab(idx);
    };

    const roomSnap = await getDoc(roomRef(code));
    const roomData0 = roomSnap.data() || {};
    const { hostUid, guestUid } = roomData0.meta || {};
    const storedRole = getStoredRole(code);
    const myRole = storedRole === "host" || storedRole === "guest"
      ? storedRole
      : hostUid === me.uid ? "host" : guestUid === me.uid ? "guest" : "guest";
    const oppRole = myRole === "host" ? "guest" : "host";
    const oppName = oppRole === "host" ? "Daniel" : "Jaime";

    timerContext.role = myRole;

    const rRef = roomRef(code);
    const rdRef = doc(roundSubColRef(code), String(round));

    const rdSnap = await getDoc(rdRef);
    const rd = rdSnap.data() || {};

    const oppItems = (oppRole === "host" ? rd.hostItems : rd.guestItems) || [];
    const oppAnswers = (((roomData0.answers || {})[oppRole] || {})[round] || []).map((a) => a?.chosen || "");
    const totalMarks = 3;
    marks = new Array(totalMarks).fill(null);

    for (let i = 0; i < 3; i += 1) {
      const answerNode = answerNodes[i];
      if (answerNode) {
        answerNode.label.textContent = `${oppName}’s answer`;
        answerNode.text.textContent = oppAnswers[i] || "(no answer recorded)";
      }
      if (questionNodes[i]) {
        const q = oppItems[i] || {};
        const questionText = typeof q.question === "string" && q.question.trim()
          ? q.question
          : "(missing question)";
        questionNodes[i].textContent = questionText;
      }
    }

    verdictButtons.forEach((row, rowIdx) => {
      const [btnRight, btnUnknown, btnWrong] = row;
      btnRight?.addEventListener("click", () => {
        if (published || submitting) return;
        marks[rowIdx] = markValue(VERDICT.RIGHT);
        refreshVerdictStyles(rowIdx);
        reflectTabState(rowIdx);
        updateSubmitState();
      });
      btnUnknown?.addEventListener("click", () => {
        if (published || submitting) return;
        marks[rowIdx] = markValue(VERDICT.UNKNOWN);
        refreshVerdictStyles(rowIdx);
        reflectTabState(rowIdx);
        updateSubmitState();
      });
      btnWrong?.addEventListener("click", () => {
        if (published || submitting) return;
        marks[rowIdx] = markValue(VERDICT.WRONG);
        refreshVerdictStyles(rowIdx);
        reflectTabState(rowIdx);
        updateSubmitState();
      });
    });

    const submitMarks = async () => {
      if (published || submitting) return;
      const ready = marks.every((value) => value === VERDICT.RIGHT || value === VERDICT.WRONG || value === VERDICT.UNKNOWN);
      if (!ready) return;
      submitting = true;
      disableSubmit();
      setVerdictsEnabled(false);
      pauseRoundTimer(timerContext);
      showStatus("Submitting review…");

      const safeMarks = marks.map((value) => markValue(value));
      const totalSecondsRaw = getRoundTimerTotal(timerContext) / 1000;
      const totalSeconds = Math.max(0, Math.round(totalSecondsRaw * 100) / 100);
      const patch = {
        [`marking.${myRole}.${round}`]: safeMarks,
        [`markingAck.${myRole}.${round}`]: true,
        [`timings.${myRole}.${round}`]: { totalSeconds },
        "timestamps.updatedAt": serverTimestamp(),
      };

      try {
        await updateDoc(rRef, patch);
        published = true;
        submitting = false;
        marks = safeMarks;
        showStatus(`Waiting for ${oppName}…`);
        submitBtn.textContent = "Submitted";
        clearRoundTimer(timerContext);
      } catch (err) {
        console.warn("[marking] submit failed:", err);
        submitting = false;
        if (!published) {
          setVerdictsEnabled(true);
          updateSubmitState();
          showStatus("Retrying…");
          resumeRoundTimer(timerContext);
        }
      }
    };

    submitBtn.addEventListener("click", submitMarks);

    const existingMarks = (((roomData0.marking || {})[myRole] || {})[round] || []);
    if (Array.isArray(existingMarks) && existingMarks.length >= totalMarks) {
      marks = new Array(totalMarks).fill(null).map((_, i) => markValue(existingMarks[i]));
      published = true;
      submitting = false;
      refreshAllStyles();
      tabsReady();
      setVerdictsEnabled(false);
      disableSubmit();
      submitBtn.textContent = "Submitted";
      showStatus(`Waiting for ${oppName}…`);
      pauseRoundTimer(timerContext);
      clearRoundTimer(timerContext);
    } else {
      refreshAllStyles();
      tabsReady();
      setVerdictsEnabled(true);
      updateSubmitState();
      showStatus("");
      setActiveTab(0);
    }

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
        const incomingMarks = (((data.marking || {})[myRole] || {})[round] || marks);
        marks = new Array(marks.length).fill(null).map((_, i) => markValue(incomingMarks[i]));
        published = true;
        submitting = false;
        refreshAllStyles();
        setVerdictsEnabled(false);
        disableSubmit();
        submitBtn.textContent = "Submitted";
        showStatus(ackOpp ? `Waiting for ${oppName}…` : "Review submitted");
        pauseRoundTimer(timerContext);
        clearRoundTimer(timerContext);
      }

      if (myRole === "host" && stateName === "marking" && ackMine && ackOpp) {
        finalizeRound();
      }
    }, (err) => {
      console.warn("[marking] room snapshot error:", err);
    });

    this.unmount = () => {
      try { stopRoomWatch && stopRoomWatch(); } catch {}
      pauseRoundTimer(timerContext);
    };
  },

  async unmount() { /* instance handles cleanup */ }
};
