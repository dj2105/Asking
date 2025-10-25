// /src/views/Marking.js
//
// Marking phase — judge opponent answers while a hidden timer keeps running.
// • Shows opponent questions + chosen answers with ✓/✕/? toggles.
// • Players can jump between questions freely via coloured tabs.
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

const TAB_THEMES = [
  { bg: "#f2f5ff", accent: "#d6e2ff", strong: "#aebfff", border: "rgba(62, 92, 160, 0.26)" },
  { bg: "#fff1f8", accent: "#fbd3e8", strong: "#f5a9d1", border: "rgba(162, 66, 130, 0.26)" },
  { bg: "#fff7ec", accent: "#ffe1b8", strong: "#f6c48a", border: "rgba(186, 110, 42, 0.26)" },
];

const VERDICT = { RIGHT: "right", WRONG: "wrong", UNKNOWN: "unknown" };

function el(tag, attrs = {}, kids = []) {
  const node = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (k === "class") node.className = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
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

    const card = el("div", { class: "card card--center tabbed-card tabbed-card--marking" });
    const title = el("h1", { class: "view-heading" }, "Marking");
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
    const counter = el("div", { class: "tabbed-card__counter mono small" }, "Question 1");
    const questionNode = el("div", { class: "tabbed-card__question tabbed-card__question--marking" }, "");
    const answerBox = el("div", { class: "tabbed-card__answer" });
    const answerLabel = el("div", { class: "tabbed-card__answer-label mono small" }, "");
    const answerText = el("div", { class: "tabbed-card__answer-text" }, "");
    answerBox.appendChild(answerLabel);
    answerBox.appendChild(answerText);

    const verdictRow = el("div", { class: "tabbed-card__verdicts" });
    const btnRight = el(
      "button",
      {
        class: "btn outline verdict-button",
        type: "button",
        title: "Mark as correct",
        "aria-pressed": "false",
      },
      "✓"
    );
    const btnUnknown = el(
      "button",
      {
        class: "btn outline verdict-button",
        type: "button",
        title: "Mark as unsure",
        "aria-pressed": "false",
      },
      "?"
    );
    const btnWrong = el(
      "button",
      {
        class: "btn outline verdict-button",
        type: "button",
        title: "Mark as incorrect",
        "aria-pressed": "false",
      },
      "✕"
    );
    verdictRow.appendChild(btnRight);
    verdictRow.appendChild(btnUnknown);
    verdictRow.appendChild(btnWrong);

    const statusNote = el("div", { class: "tabbed-card__status mono small" }, "Preparing review…");

    body.appendChild(counter);
    body.appendChild(questionNode);
    body.appendChild(answerBox);
    body.appendChild(verdictRow);
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
      "Submit Review"
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
    let answers = [];
    let tripletReady = false;
    let marks = [null, null, null];
    let published = false;
    let submitting = false;
    let stopRoomWatch = null;

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

    const markValue = (value) => {
      if (value === VERDICT.RIGHT) return VERDICT.RIGHT;
      if (value === VERDICT.WRONG) return VERDICT.WRONG;
      return VERDICT.UNKNOWN;
    };

    const reflectTabs = () => {
      tabs.forEach((tab, i) => {
        const isActive = i === idx;
        const mark = marks[i];
        tab.classList.toggle("round-tab--active", isActive);
        tab.classList.toggle("round-tab--answered", mark !== null && mark !== undefined && mark !== "");
        tab.classList.toggle("round-tab--verdict-right", mark === VERDICT.RIGHT);
        tab.classList.toggle("round-tab--verdict-wrong", mark === VERDICT.WRONG);
        tab.classList.toggle("round-tab--verdict-unknown", mark === VERDICT.UNKNOWN);
        tab.setAttribute("aria-pressed", isActive ? "true" : "false");
        tab.disabled = !tripletReady;
      });
    };

    const updateVerdictButtons = () => {
      const mark = marks[idx];
      const isRight = mark === VERDICT.RIGHT;
      const isWrong = mark === VERDICT.WRONG;
      const isUnknown = mark === VERDICT.UNKNOWN;
      btnRight.classList.toggle("verdict-button--active", isRight);
      btnWrong.classList.toggle("verdict-button--active", isWrong);
      btnUnknown.classList.toggle("verdict-button--active", isUnknown);
      btnRight.setAttribute("aria-pressed", isRight ? "true" : "false");
      btnWrong.setAttribute("aria-pressed", isWrong ? "true" : "false");
      btnUnknown.setAttribute("aria-pressed", isUnknown ? "true" : "false");
    };

    const updateVerdictDisabled = () => {
      const disabled = !tripletReady || published || submitting;
      btnRight.disabled = disabled;
      btnWrong.disabled = disabled;
      btnUnknown.disabled = disabled;
    };

    const updateSubmitState = () => {
      const allMarked = marks.every((value) => value === VERDICT.RIGHT || value === VERDICT.WRONG || value === VERDICT.UNKNOWN);
      submitBtn.disabled = !allMarked || published || submitting;
      submitBtn.classList.toggle("throb", allMarked && !published && !submitting);
      if (published) {
        submitBtn.textContent = "Submitted";
      } else if (submitting) {
        submitBtn.textContent = "Submitting…";
      } else {
        submitBtn.textContent = "Submit Review";
      }
      submitRow.style.display = published ? "none" : "flex";
    };

    const updateContent = () => {
      const currentItem = triplet[idx] || {};
      const questionText = currentItem.question || "(missing question)";
      const answerTextRaw = answers[idx] || "";
      counter.textContent = `Question ${idx + 1}`;
      questionNode.textContent = questionText;
      answerText.textContent = answerTextRaw || "(no answer recorded)";
      updateVerdictButtons();
      updateVerdictDisabled();
    };

    const showMark = (targetIdx) => {
      if (!Number.isFinite(targetIdx)) return;
      if (targetIdx < 0) targetIdx = 0;
      if (targetIdx >= triplet.length) targetIdx = triplet.length - 1;
      idx = targetIdx;
      applyTheme(idx);
      reflectTabs();
      updateContent();
      if (!published) {
        resumeRoundTimer(timerContext);
      }
    };

    tabs.forEach((tab, i) => {
      tab.addEventListener("click", () => {
        if (!tripletReady) return;
        showMark(i);
      });
    });

    const setMark = (value) => {
      if (published || submitting) return;
      if (!tripletReady) return;
      marks[idx] = markValue(value);
      reflectTabs();
      updateVerdictButtons();
      updateSubmitState();
      setStatus("Adjust any verdict before submitting.");
    };

    btnRight.addEventListener("click", () => setMark(VERDICT.RIGHT));
    btnWrong.addEventListener("click", () => setMark(VERDICT.WRONG));
    btnUnknown.addEventListener("click", () => setMark(VERDICT.UNKNOWN));

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

    const timerContext = { code, role: myRole, round };

    answerLabel.textContent = `${oppName}’s answer`;

    const rdSnap = await getDoc(rdRef);
    const rd = rdSnap.data() || {};
    const oppItemsRaw = (oppRole === "host" ? rd.hostItems : rd.guestItems) || [];
    triplet = [0, 1, 2].map((i) => oppItemsRaw[i] || {});
    answers = (((roomData0.answers || {})[oppRole] || {})[round] || []).map((a) => a?.chosen || "");
    tripletReady = triplet.length === 3;

    const existingMarks = (((roomData0.marking || {})[myRole] || {})[round] || []);
    if (Array.isArray(existingMarks) && existingMarks.length === 3) {
      marks = existingMarks.map((value) => markValue(value));
    }

    published = Boolean(((roomData0.markingAck || {})[myRole] || {})[round]);

    if (tripletReady) {
      body.style.display = "flex";
      const firstUnmarked = marks.findIndex((value) => value === null);
      const initialIndex = firstUnmarked >= 0 ? firstUnmarked : 0;
      showMark(initialIndex);
      setStatus("Review each answer, then submit.");
    } else {
      body.style.display = "none";
      setStatus("Preparing review…");
    }

    reflectTabs();
    updateContent();
    updateSubmitState();

    if (published) {
      pauseRoundTimer(timerContext);
      setStatus("Review submitted. Waiting for opponent…");
      showOverlay(`Waiting for ${oppName}`, "Review locked");
    }

    const submitMarks = async () => {
      if (published || submitting) return;
      const allMarked = marks.every((value) => value === VERDICT.RIGHT || value === VERDICT.WRONG || value === VERDICT.UNKNOWN);
      if (!allMarked) return;
      submitting = true;
      updateVerdictDisabled();
      updateSubmitState();
      setStatus("Submitting review…");

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
        console.log(`[flow] submit marking | code=${code} round=${round} role=${myRole}`);
        showOverlay("Submitting…", "Sending your review");
        await updateDoc(rRef, patch);
        marks = safeMarks;
        submitting = false;
        published = true;
        setStatus("Review submitted. Waiting for opponent…");
        showOverlay(`Waiting for ${oppName}`, "Review locked");
        pauseRoundTimer(timerContext);
        clearRoundTimer(timerContext);
      } catch (err) {
        console.warn("[marking] submit failed:", err);
        submitting = false;
        hideOverlay();
        updateVerdictDisabled();
        updateSubmitState();
        if (!published) {
          resumeRoundTimer(timerContext);
        }
      }
    };

    submitBtn.addEventListener("click", () => {
      if (submitBtn.disabled) return;
      submitMarks();
    });

    let finalizing = false;

    const showWaitingOverlay = (note) => {
      showOverlay(`Waiting for ${oppName}`, note || "Waiting for opponent");
    };

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
        marks = [0, 1, 2].map((i) => markValue(incomingMarks[i]));
        published = true;
        submitting = false;
        reflectTabs();
        updateVerdictButtons();
        updateVerdictDisabled();
        updateSubmitState();
        setStatus(ackOpp ? "Waiting for opponent…" : "Review submitted.");
        showWaitingOverlay(ackOpp ? "Waiting for opponent" : "Review locked");
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
