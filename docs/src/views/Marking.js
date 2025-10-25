// /src/views/Marking.js
//
// Marking phase — judge opponent answers while a hidden timer keeps running.
// • Shows opponent questions + chosen answers with ✓/✕/I DUNNO toggles.
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
  Object.entries(attrs || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  });
  (Array.isArray(kids) ? kids : [kids]).forEach((child) => {
    if (child === null || child === undefined) return;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  });
  return node;
}

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
    setThemeFromHue(hue);

    container.innerHTML = "";
    const root = el("div", { class: "view view-marking stage-center" });

    const panel = el("div", { class: "card round-panel" });
    const heading = el("h1", { class: "round-heading mono" }, "MARKING");
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
    const answerNode = el("div", { class: "marking-answer mono" }, "");
    const optionsRow = el("div", { class: "marking-options" });

    const optionRight = el("button", {
      class: "marking-option mono",
      type: "button",
      "data-tone": "right",
    }, [el("span", { class: "marking-option__icon" }, "✓"), "RIGHT"]);
    const optionUnknown = el("button", {
      class: "marking-option mono",
      type: "button",
      "data-tone": "unknown",
    }, "I DUNNO");
    const optionWrong = el("button", {
      class: "marking-option mono",
      type: "button",
      "data-tone": "wrong",
    }, [el("span", { class: "marking-option__icon" }, "✕"), "WRONG"]);

    optionsRow.appendChild(optionRight);
    optionsRow.appendChild(optionUnknown);
    optionsRow.appendChild(optionWrong);

    content.appendChild(questionNode);
    content.appendChild(answerNode);
    content.appendChild(optionsRow);
    panel.appendChild(content);

    const footer = el("div", { class: "round-panel__footer" });
    const statusLine = el("div", { class: "round-status mono" }, "");
    const submitBtn = el("button", {
      class: "btn round-submit",
      type: "button",
      disabled: "",
    }, "SUBMIT MARKING");
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

    const options = [optionRight, optionUnknown, optionWrong];

    const marks = [null, null, null];
    let oppItems = [];
    let oppAnswers = [];
    let totalMarks = 3;
    let idx = 0;
    let published = false;
    let submitting = false;
    let advanceTimer = null;
    let stopRoomWatch = null;
    let alive = true;
    let removePopStateListener = () => {};
    let confirmVisible = false;

    const historySupported =
      typeof window !== "undefined" &&
      window.history &&
      typeof window.history.pushState === "function" &&
      typeof window.history.replaceState === "function";
    const historyKey = "jemimaMarking";
    const guardKey = "jemimaMarkingGuard";
    let historyIndex = null;

    const SUBMIT_LABEL = "SUBMIT MARKING";
    const WAIT_LABEL = "WAITING…";

    const setStatus = (text = "") => {
      statusLine.textContent = text ? String(text).toUpperCase() : "";
    };

    const setSubmitLabel = (text) => {
      submitBtn.textContent = text || SUBMIT_LABEL;
    };

    const setOptionsEnabled = (enabled) => {
      options.forEach((btn) => {
        btn.disabled = !enabled;
      });
    };

    const clearAdvanceTimer = () => {
      if (advanceTimer) {
        clearTimeout(advanceTimer);
        advanceTimer = null;
      }
    };

    const updateStepStates = () => {
      stepButtons.forEach((btn, i) => {
        const answered = Boolean(marks[i]);
        btn.classList.toggle("is-active", i === idx);
        btn.classList.toggle("is-answered", answered);
      });
    };

    const reflectSelection = () => {
      const mark = marks[idx];
      options.forEach((btn) => {
        const tone = btn.dataset.tone || "";
        const selected = mark === tone;
        btn.classList.toggle("is-selected", selected);
        btn.setAttribute("aria-pressed", selected ? "true" : "false");
      });
    };

    const updateSubmitState = () => {
      const ready = marks.every((value) => value === VERDICT.RIGHT || value === VERDICT.WRONG || value === VERDICT.UNKNOWN);
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
      void content.offsetWidth;
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
        console.warn("[marking] history state update failed:", err);
      }
    };

    const historyHandler = (event) => {
      const state = event?.state;
      const payload = state && typeof state === "object" ? state[historyKey] : null;
      if (payload && payload.code === code && Number.isFinite(Number(payload.idx))) {
        const target = Number(payload.idx);
        showMark(target, { skipHistory: true });
        return;
      }
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

    const findNextUnmarked = (currentIndex) => {
      for (let i = currentIndex + 1; i < marks.length; i += 1) {
        if (!marks[i]) return i;
      }
      for (let i = 0; i < marks.length; i += 1) {
        if (!marks[i]) return i;
      }
      return null;
    };

    const showMark = (targetIdx, optionsParam = {}) => {
      clearAdvanceTimer();
      if (targetIdx < 0) targetIdx = 0;
      if (targetIdx >= totalMarks) targetIdx = totalMarks - 1;
      idx = targetIdx;
      setStatus("");
      const currentItem = oppItems[idx] || {};
      const questionText = currentItem.question || "";
      const chosenAnswer = oppAnswers[idx] || "";
      questionNode.textContent = questionText || "";
      answerNode.textContent = chosenAnswer ? `ANSWERED: ${chosenAnswer}` : "NO ANSWER RECORDED";
      animateContent();
      updateStepStates();
      reflectSelection();
      setOptionsEnabled(!published && !submitting);
      if (!optionsParam.skipHistory) {
        const shouldReplace = historyIndex === null || optionsParam.forceReplace;
        recordHistoryIndex(idx, { replace: shouldReplace });
      } else {
        historyIndex = idx;
      }
      resumeRoundTimer(timerContext);
      updateSubmitState();
    };

    stepButtons.forEach((btn, i) => {
      btn.addEventListener("click", () => {
        showMark(i);
      });
    });

    const finishIfReady = () => {
      const ready = marks.every((value) => value === VERDICT.RIGHT || value === VERDICT.WRONG || value === VERDICT.UNKNOWN);
      if (!ready) return;
      const lastIdx = totalMarks - 1;
      if (idx !== lastIdx) showMark(lastIdx);
      updateSubmitState();
    };

    options.forEach((btn) => {
      btn.addEventListener("click", () => {
        if (published || submitting) return;
        const tone = btn.dataset.tone || "";
        if (!tone) return;
        clearAdvanceTimer();
        marks[idx] = tone;
        reflectSelection();
        updateStepStates();
        updateSubmitState();
        advanceTimer = setTimeout(() => {
          advanceTimer = null;
          if (published || submitting || !alive) return;
          const nextIdx = findNextUnmarked(idx);
          if (nextIdx === null) {
            finishIfReady();
          } else if (nextIdx !== idx) {
            showMark(nextIdx);
          }
        }, 500);
      });
    });

    submitBtn.addEventListener("click", () => {
      if (submitBtn.disabled || published || submitting) return;
      submitMarks();
    });

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

    const rdSnap = await getDoc(rdRef);
    const rd = rdSnap.data() || {};
    oppItems = (oppRole === "host" ? rd.hostItems : rd.guestItems) || [];
    const oppAnswersRaw = (((roomData0.answers || {})[oppRole] || {})[round] || []);
    oppAnswers = oppAnswersRaw.map((a) => a?.chosen || "");
    totalMarks = Math.max(3, oppItems.length || 0);

    const waitMessageDefault = `Waiting for ${oppName}`;

    const markValue = (value) => {
      if (value === VERDICT.RIGHT) return VERDICT.RIGHT;
      if (value === VERDICT.WRONG) return VERDICT.WRONG;
      return VERDICT.UNKNOWN;
    };

    const submitMarks = async () => {
      if (published || submitting) return;
      const ready = marks.every((value) => value === VERDICT.RIGHT || value === VERDICT.WRONG || value === VERDICT.UNKNOWN);
      if (!ready) return;
      submitting = true;
      updateSubmitState();
      clearAdvanceTimer();
      setOptionsEnabled(false);
      pauseRoundTimer(timerContext);
      const totalSecondsRaw = getRoundTimerTotal(timerContext) / 1000;
      const totalSeconds = Math.max(0, Math.round(totalSecondsRaw * 100) / 100);
      const safeMarks = marks.map((value) => markValue(value));
      const patch = {
        [`marking.${myRole}.${round}`]: safeMarks,
        [`markingAck.${myRole}.${round}`]: true,
        [`timings.${myRole}.${round}`]: { totalSeconds },
        "timestamps.updatedAt": serverTimestamp(),
      };

      try {
        setStatus("SUBMITTING REVIEW");
        await updateDoc(rRef, patch);
        published = true;
        submitting = false;
        safeMarks.forEach((value, i) => { marks[i] = value; });
        setStatus(waitMessageDefault);
        updateSubmitState();
        clearRoundTimer(timerContext);
      } catch (err) {
        console.warn("[marking] submit failed:", err);
        submitting = false;
        setStatus("RETRYING");
        setOptionsEnabled(true);
        resumeRoundTimer(timerContext);
        updateSubmitState();
      }
    };

    const finalizeRound = async () => {
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
      }
    };

    const existingMarks = (((roomData0.marking || {})[myRole] || {})[round] || []);
    if (Array.isArray(existingMarks) && existingMarks.length === 3) {
      existingMarks.slice(0, 3).forEach((value, i) => {
        marks[i] = markValue(value);
      });
      published = true;
      setOptionsEnabled(false);
      setStatus(waitMessageDefault);
      updateStepStates();
      reflectSelection();
      updateSubmitState();
      pauseRoundTimer(timerContext);
      clearRoundTimer(timerContext);
    } else {
      showMark(0, { forceReplace: true });
      finishIfReady();
    }

    updateSubmitState();

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

      const markingAck = data.markingAck || {};
      const ackMine = Boolean(((markingAck[myRole] || {})[round]));
      const ackOpp = Boolean(((markingAck[oppRole] || {})[round]));

      if (ackMine && !published) {
        const incomingMarks = (((data.marking || {})[myRole] || {})[round] || marks);
        incomingMarks.slice(0, 3).forEach((value, i) => {
          marks[i] = markValue(value);
        });
        published = true;
        submitting = false;
        setOptionsEnabled(false);
        setStatus(ackOpp ? waitMessageDefault : "REVIEW SUBMITTED");
        updateStepStates();
        reflectSelection();
        updateSubmitState();
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
      alive = false;
      clearAdvanceTimer();
      try { stopRoomWatch && stopRoomWatch(); } catch {}
      pauseRoundTimer(timerContext);
      try { removePopStateListener(); } catch {}
    };
  },

  async unmount() { /* instance handles cleanup */ }
};
