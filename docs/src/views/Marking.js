// /src/views/Marking.js
//
// Marking phase — award-inspired floating panel with three muted verdict buttons.
// • Displays opponent question + answer, three verdict buttons, and a submit control.
// • Selecting a verdict highlights it for 0.5s, then advances to the next unanswered mark.
// • Submission is manual; the button activates once all three verdicts are chosen.
// • Results write marking.{role}.{round}, timings, and acknowledgement before host advances to Award.

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
const HOLD_MS = 500;

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

function applyMutedHueTheme(hue) {
  const rootStyle = document.documentElement && document.documentElement.style;
  if (!rootStyle) return;
  rootStyle.setProperty("--ink-h", String(hue));
  rootStyle.setProperty("--ink-s", "34%");
  rootStyle.setProperty("--ink-l", "24%");
  rootStyle.setProperty("--paper", `hsl(${hue}, 28%, 96%)`);
  rootStyle.setProperty("--quiz-panel-fill", `hsla(${hue}, 60%, 96%, 0.94)`);
  rootStyle.setProperty("--quiz-panel-outline", `hsla(${hue}, 30%, 40%, 0.5)`);
  rootStyle.setProperty("--quiz-panel-shadow", `0 26px 52px hsla(${hue}, 42%, 26%, 0.18)`);
  rootStyle.setProperty("--quiz-dot-color", `hsla(${hue}, 32%, 42%, 0.45)`);
  rootStyle.setProperty("--quiz-chip-fill", `hsla(${hue}, 48%, 94%, 0.9)`);
  rootStyle.setProperty("--quiz-chip-active", `hsla(${hue}, 48%, 88%, 0.98)`);
  rootStyle.setProperty("--quiz-chip-outline", `hsla(${hue}, 30%, 44%, 0.58)`);
  rootStyle.setProperty("--quiz-chip-shadow", `0 18px 36px hsla(${hue}, 40%, 28%, 0.2)`);
  rootStyle.setProperty("--quiz-button-outline", `hsla(${hue}, 32%, 40%, 0.48)`);
  rootStyle.setProperty("--quiz-button-hover-bg", `hsla(${hue}, 56%, 94%, 0.55)`);
  rootStyle.setProperty("--quiz-button-shadow", `0 20px 38px hsla(${hue}, 44%, 28%, 0.16)`);
  rootStyle.setProperty("--quiz-text", `hsl(${hue}, 26%, 24%)`);
  rootStyle.setProperty("--quiz-text-muted", `hsla(${hue}, 26%, 36%, 0.74)`);
  rootStyle.setProperty("--quiz-submit-shadow", `0 24px 46px hsla(${hue}, 42%, 24%, 0.22)`);
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

function markValue(value) {
  if (value === VERDICT.RIGHT) return VERDICT.RIGHT;
  if (value === VERDICT.WRONG) return VERDICT.WRONG;
  return VERDICT.UNKNOWN;
}

function normaliseMark(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  return markValue(raw);
}

function findNextPending(marks, currentIdx) {
  const total = marks.length;
  for (let offset = 1; offset <= total; offset += 1) {
    const target = (currentIdx + offset) % total;
    if (!marks[target]) return target;
  }
  return null;
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
    applyMutedHueTheme(hue);

    container.innerHTML = "";
    const root = el("div", { class: "view view-marking stage-center stage-center--solo quiz-stage" });

    const heading = el("h1", { class: "quiz-heading mono" }, "Marking");
    const chipsWrap = el("div", { class: "quiz-chips" });
    const chips = [0, 1, 2].map((index) => {
      const chip = el("button", { class: "quiz-chip", type: "button" }, String(index + 1));
      chip.disabled = true;
      chipsWrap.appendChild(chip);
      return chip;
    });

    const panel = el("div", { class: "quiz-panel" });
    const panelContent = el("div", { class: "quiz-panel__content" });
    const promptNode = el("div", { class: "quiz-prompt mono" }, "Preparing review…");
    const dividerTop = el("div", { class: "quiz-panel__divider" });
    const answerNode = el("div", { class: "quiz-answer-review mono" }, "");
    const dividerBottom = el("div", { class: "quiz-panel__divider" });

    const verdictRow = el("div", { class: "marking-actions" });
    const btnRight = el("button", { class: "marking-btn", type: "button", "data-mark": VERDICT.RIGHT }, "✓");
    const btnUnknown = el("button", { class: "marking-btn", type: "button", "data-mark": VERDICT.UNKNOWN }, "I DUNNO");
    const btnWrong = el("button", { class: "marking-btn", type: "button", "data-mark": VERDICT.WRONG }, "✕");
    verdictRow.appendChild(btnRight);
    verdictRow.appendChild(btnUnknown);
    verdictRow.appendChild(btnWrong);

    panelContent.appendChild(promptNode);
    panelContent.appendChild(dividerTop);
    panelContent.appendChild(answerNode);
    panelContent.appendChild(dividerBottom);
    panelContent.appendChild(verdictRow);
    panel.appendChild(panelContent);
    panel.classList.add("is-disabled");

    const submitBtn = el("button", { class: "quiz-submit", type: "button", disabled: "true" }, "SUBMIT");

    root.appendChild(heading);
    root.appendChild(chipsWrap);
    root.appendChild(panel);
    root.appendChild(submitBtn);

    container.appendChild(root);

    const verdictButtons = [btnRight, btnUnknown, btnWrong];

    let idx = 0;
    let marks = new Array(3).fill(null);
    let triplet = [];
    let answers = [];
    let published = false;
    let submitting = false;
    let advanceTimer = null;
    let alive = true;
    let stopRoomWatch = null;
    let removePopStateListener = () => {};
    let oppName = "opponent";
    let myRole = "guest";
    let oppRole = "host";
    let timerContext = null;

    const lockPanel = (locked) => {
      panel.classList.toggle("is-disabled", locked);
      verdictButtons.forEach((btn) => {
        btn.disabled = locked;
      });
    };

    const refreshChipStates = () => {
      chips.forEach((chip, index) => {
        chip.classList.toggle("is-active", index === idx);
        chip.classList.toggle("is-complete", Boolean(marks[index]));
        const hasQuestion = Boolean(triplet[index]);
        const shouldDisable = !hasQuestion || submitting || published;
        chip.disabled = shouldDisable;
      });
    };

    const refreshVerdictStyles = () => {
      const current = marks[idx];
      verdictButtons.forEach((btn) => {
        const value = btn.getAttribute("data-mark");
        const isSelected = current === value;
        btn.classList.toggle("is-selected", isSelected);
        btn.setAttribute("aria-pressed", isSelected ? "true" : "false");
      });
    };

    const updateSubmitState = () => {
      const allMarked = marks.every((value) => Boolean(value));
      submitBtn.classList.remove("quiz-submit--ready", "quiz-submit--waiting");
      if (published) {
        submitBtn.textContent = `WAITING FOR ${oppName.toUpperCase()}`;
        submitBtn.disabled = true;
        submitBtn.classList.add("quiz-submit--waiting");
        return;
      }
      if (submitting) {
        submitBtn.textContent = "SUBMITTING…";
        submitBtn.disabled = true;
        submitBtn.classList.add("quiz-submit--waiting");
        return;
      }
      submitBtn.textContent = "SUBMIT";
      submitBtn.disabled = !allMarked;
      if (allMarked) submitBtn.classList.add("quiz-submit--ready");
    };

    const clearAdvanceTimer = () => {
      if (advanceTimer) {
        clearTimeout(advanceTimer);
        advanceTimer = null;
      }
    };

    const showMark = (targetIdx, options = {}) => {
      clearAdvanceTimer();
      if (triplet.length === 0) return;
      if (targetIdx < 0) targetIdx = 0;
      if (targetIdx >= triplet.length) targetIdx = triplet.length - 1;
      idx = targetIdx;
      const item = triplet[idx] || {};
      const answerText = answers[idx] || "";
      const hasAnswer = Boolean(answerText);
      promptNode.textContent = `${idx + 1}. ${item.question || "(missing question)"}`;
      answerNode.textContent = hasAnswer ? `“${answerText}”` : "(no answer recorded)";
      answerNode.classList.toggle("quiz-answer-review--empty", !hasAnswer);

      if (published || submitting) {
        lockPanel(true);
        if (timerContext) pauseRoundTimer(timerContext);
      } else {
        lockPanel(false);
        if (timerContext) resumeRoundTimer(timerContext);
      }

      refreshVerdictStyles();
      refreshChipStates();

      if (!options.skipHistory) {
        const shouldReplace = historyIndex === null || options.forceReplace;
        recordHistoryIndex(idx, { replace: shouldReplace });
      } else {
        historyIndex = idx;
      }
    };

    const applyVerdict = (value) => {
      if (published || submitting) return;
      const currentIndex = idx;
      clearAdvanceTimer();
      marks[currentIndex] = markValue(value);
      refreshVerdictStyles();
      refreshChipStates();
      updateSubmitState();

      advanceTimer = setTimeout(() => {
        advanceTimer = null;
        if (!alive || published || submitting) return;
        const nextIdx = findNextPending(marks, currentIndex);
        if (nextIdx !== null && nextIdx !== currentIndex) {
          showMark(nextIdx);
        }
      }, HOLD_MS);
    };

    verdictButtons.forEach((btn) => {
      btn.addEventListener("click", () => applyVerdict(btn.getAttribute("data-mark")));
    });

    chips.forEach((chip, index) => {
      chip.addEventListener("click", () => {
        if (!alive) return;
        if (!triplet[index]) return;
        showMark(index);
      });
    });

    let historyIndex = null;
    const historySupported =
      typeof window !== "undefined" &&
      window.history &&
      typeof window.history.pushState === "function" &&
      typeof window.history.replaceState === "function";
    const historyKey = "jemimaMarking";

    const recordHistoryIndex = (nextIndex, { replace = false } = {}) => {
      historyIndex = nextIndex;
      if (!historySupported) return;
      const baseState = window.history.state && typeof window.history.state === "object"
        ? { ...window.history.state }
        : {};
      baseState[historyKey] = { idx: nextIndex, code };
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

    const handlePopState = (event) => {
      if (published || submitting) return;
      const state = event?.state;
      const payload = state && typeof state === "object" ? state[historyKey] : null;
      if (!payload || payload.code !== code) return;
      const target = Number(payload.idx);
      if (!Number.isFinite(target)) return;
      showMark(target, { skipHistory: true });
    };

    if (historySupported) {
      window.addEventListener("popstate", handlePopState);
      removePopStateListener = () => {
        try {
          window.removeEventListener("popstate", handlePopState);
        } catch {}
        removePopStateListener = () => {};
      };
    }

    const rRef = roomRef(code);
    const rdRef = doc(roundSubColRef(code), String(round));

    const roomSnap = await getDoc(rRef);
    const roomData0 = roomSnap.data() || {};
    const { hostUid, guestUid } = roomData0.meta || {};
    const storedRole = getStoredRole(code);
    myRole = storedRole === "host" || storedRole === "guest"
      ? storedRole
      : hostUid === me.uid ? "host" : guestUid === me.uid ? "guest" : "guest";
    oppRole = myRole === "host" ? "guest" : "host";
    oppName = oppRole === "host" ? "Daniel" : "Jaime";
    timerContext = { code, role: myRole, round };

    const rdSnap = await getDoc(rdRef);
    const rd = rdSnap.data() || {};
    const oppItemsRaw = (oppRole === "host" ? rd.hostItems : rd.guestItems) || [];
    const oppAnswersRaw = (((roomData0.answers || {})[oppRole] || {})[round] || []).map((a) => a?.chosen || "");
    const totalMarks = 3;
    marks = new Array(totalMarks).fill(null);
    triplet = [0, 1, 2].map((i) => {
      const item = oppItemsRaw[i] || {};
      return { question: item.question || "" };
    });
    answers = [0, 1, 2].map((i) => oppAnswersRaw[i] || "");

    const existingMarks = (((roomData0.marking || {})[myRole] || {})[round] || []);
    if (Array.isArray(existingMarks) && existingMarks.length) {
      marks = marks.map((_, i) => normaliseMark(existingMarks[i]));
    }

    refreshChipStates();
    refreshVerdictStyles();
    updateSubmitState();

    const alreadyAck = Boolean(((roomData0.markingAck || {})[myRole] || {})[round]);

    if (alreadyAck && marks.every(Boolean)) {
      published = true;
      lockPanel(true);
      if (timerContext) {
        pauseRoundTimer(timerContext);
        clearRoundTimer(timerContext);
      }
      idx = Math.min(marks.length - 1, 2);
      showMark(idx, { forceReplace: true });
      updateSubmitState();
    } else {
      showMark(0, { forceReplace: true });
    }

    submitBtn.addEventListener("click", async () => {
      if (published || submitting) return;
      if (!marks.every((value) => Boolean(value))) return;

      submitting = true;
      updateSubmitState();
      lockPanel(true);
      if (timerContext) pauseRoundTimer(timerContext);

      const safeMarks = marks.map((value) => markValue(value));
      const totalSecondsRaw = timerContext ? getRoundTimerTotal(timerContext) / 1000 : 0;
      const totalSeconds = Math.max(0, Math.round(totalSecondsRaw * 100) / 100);

      const patch = {
        [`marking.${myRole}.${round}`]: safeMarks,
        [`markingAck.${myRole}.${round}`]: true,
        [`timings.${myRole}.${round}`]: { totalSeconds },
        "timestamps.updatedAt": serverTimestamp(),
      };

      try {
        await updateDoc(rRef, patch);
        submitting = false;
        published = true;
        marks = safeMarks;
        updateSubmitState();
        refreshChipStates();
        refreshVerdictStyles();
        if (timerContext) clearRoundTimer(timerContext);
      } catch (err) {
        console.warn("[marking] submit failed:", err);
        submitting = false;
        if (!published) {
          lockPanel(false);
          if (timerContext) resumeRoundTimer(timerContext);
        }
        updateSubmitState();
        refreshChipStates();
      }
    });

    let finalizing = false;

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
          if (timerContext) timerContext.round = round;
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
        marks = marks.map((_, i) => normaliseMark(incomingMarks[i]));
        published = true;
        submitting = false;
        updateSubmitState();
        refreshChipStates();
        refreshVerdictStyles();
        lockPanel(true);
        if (timerContext) {
          pauseRoundTimer(timerContext);
          clearRoundTimer(timerContext);
        }
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
      if (timerContext) pauseRoundTimer(timerContext);
      try { removePopStateListener(); } catch {}
    };
  },

  async unmount() { /* instance handles cleanup */ },
};
