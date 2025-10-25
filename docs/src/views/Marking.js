// /src/views/Marking.js
//
// Marking phase — floating award-style panel for ✓ / I DUNNO / ✕ with auto advance.
// • Three verdict chips share pastel hue; submit unlocks once all marks chosen.
// • Maths panel removed per redesign brief.
// • Submission writes marking.{role}.{round}, timings.{role}.{round}, markingAck.{role}.{round}.
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
    else if (k === "text") node.textContent = v;
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
    const rootEl = document.documentElement;
    const computed = getComputedStyle(rootEl);
    const prevInkH = computed.getPropertyValue("--ink-h").trim();
    const prevInkS = computed.getPropertyValue("--ink-s").trim();
    const prevInkL = computed.getPropertyValue("--ink-l").trim();
    rootEl.style.setProperty("--ink-h", String(hue));
    rootEl.style.setProperty("--ink-s", "30%");
    rootEl.style.setProperty("--ink-l", "32%");

    container.innerHTML = "";
    const root = el("div", { class: "view stage-center view-marking" });

    const heading = el("h1", { class: "mono phase-title" }, "Marking");
    root.appendChild(heading);

    const chipRow = el("div", { class: "phase-chips" });
    root.appendChild(chipRow);

    const panel = el("div", { class: "phase-panel phase-panel--marking" });
    const questionNode = el("div", { class: "mono phase-panel__prompt" }, "");
    panel.appendChild(questionNode);

    const dividerTop = el("div", { class: "phase-divider phase-divider--hidden" });
    panel.appendChild(dividerTop);

    const answerBox = el("div", { class: "phase-answer" });
    const answerLabel = el("div", { class: "phase-answer__label mono" });
    const answerText = el("div", { class: "phase-answer__text mono" });
    answerBox.appendChild(answerLabel);
    answerBox.appendChild(answerText);
    panel.appendChild(answerBox);

    const dividerBottom = el("div", { class: "phase-divider phase-divider--hidden" });
    panel.appendChild(dividerBottom);

    const verdictWrap = el("div", { class: "phase-options phase-options--marking phase-options--hidden" });
    panel.appendChild(verdictWrap);

    root.appendChild(panel);

    const submitRow = el("div", { class: "phase-submit-row" });
    const submitBtn = el("button", {
      class: "phase-submit",
      type: "button",
      disabled: "disabled",
    }, "Submit");
    submitRow.appendChild(submitBtn);
    root.appendChild(submitRow);

    container.appendChild(root);

    const chips = [];
    for (let i = 0; i < 3; i += 1) {
      const chip = el("button", { class: "phase-chip", type: "button" }, String(i + 1));
      chips.push(chip);
      chipRow.appendChild(chip);
    }

    const btnRight = el("button", {
      class: "phase-choice phase-choice--mark phase-choice--tick",
      type: "button",
      "aria-pressed": "false",
    }, "✓");
    const btnUnknown = el("button", {
      class: "phase-choice phase-choice--mark phase-choice--unknown",
      type: "button",
      "aria-pressed": "false",
    }, "I DUNNO");
    const btnWrong = el("button", {
      class: "phase-choice phase-choice--mark phase-choice--cross",
      type: "button",
      "aria-pressed": "false",
    }, "✕");

    verdictWrap.appendChild(btnRight);
    verdictWrap.appendChild(btnUnknown);
    verdictWrap.appendChild(btnWrong);

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

    let idx = 0;
    let marks = new Array(3).fill(null);
    let published = false;
    let submitting = false;
    let tripletReady = false;
    let advanceTimer = null;
    let stopRoomWatch = null;
    let finalizing = false;

    const rdSnap = await getDoc(rdRef);
    const rd = rdSnap.data() || {};
    const oppItems = (oppRole === "host" ? rd.hostItems : rd.guestItems) || [];
    const oppAnswersRaw = (((roomData0.answers || {})[oppRole] || {})[round] || []);
    const oppAnswers = oppAnswersRaw.map((a) => a?.chosen || "");
    const totalMarks = Math.max(3, oppItems.length || 0);
    marks = new Array(totalMarks).fill(null);

    const disableVerdicts = (enabled) => {
      btnRight.disabled = !enabled;
      btnWrong.disabled = !enabled;
      btnUnknown.disabled = !enabled;
    };

    const updateChipStates = () => {
      chips.forEach((chip, index) => {
        const answered = marks[index] !== null && marks[index] !== undefined;
        chip.classList.toggle("phase-chip--answered", answered);
        chip.classList.toggle("phase-chip--active", index === idx && tripletReady);
        chip.disabled = !tripletReady || submitting || published;
      });
    };

    const allMarked = () => marks.every((value) => value === VERDICT.RIGHT || value === VERDICT.WRONG || value === VERDICT.UNKNOWN);

    const updateSubmitState = () => {
      const ready = tripletReady && allMarked() && !published && !submitting;
      submitBtn.disabled = !ready;
      submitBtn.classList.toggle("phase-submit--ready", ready);
      submitBtn.classList.toggle("phase-submit--busy", submitting);
      submitBtn.classList.toggle("phase-submit--waiting", published);
      if (submitting) {
        submitBtn.textContent = "Submitting…";
      } else if (published) {
        submitBtn.textContent = `Waiting for ${oppName}…`;
      } else {
        submitBtn.textContent = "Submit";
      }
    };

    const reflect = () => {
      const mark = marks[idx];
      const isRight = mark === VERDICT.RIGHT;
      const isWrong = mark === VERDICT.WRONG;
      const isUnknown = mark === VERDICT.UNKNOWN;
      btnRight.classList.toggle("is-active", isRight);
      btnWrong.classList.toggle("is-active", isWrong);
      btnUnknown.classList.toggle("is-active", isUnknown);
      btnRight.setAttribute("aria-pressed", isRight ? "true" : "false");
      btnWrong.setAttribute("aria-pressed", isWrong ? "true" : "false");
      btnUnknown.setAttribute("aria-pressed", isUnknown ? "true" : "false");
    };

    const clearAdvanceTimer = () => {
      if (advanceTimer) {
        clearTimeout(advanceTimer);
        advanceTimer = null;
      }
    };

    const setPanelForQuestion = (targetIdx) => {
      const item = oppItems[targetIdx] || {};
      const questionText = item.question || "(missing question)";
      const chosen = oppAnswers[targetIdx] || "";
      questionNode.textContent = `${targetIdx + 1}. ${questionText}`;
      answerText.textContent = chosen || "(no answer recorded)";
    };

    const showMark = (targetIdx) => {
      if (!tripletReady) return;
      clearAdvanceTimer();
      if (targetIdx < 0) targetIdx = 0;
      if (targetIdx >= totalMarks) targetIdx = totalMarks - 1;
      idx = targetIdx;
      setPanelForQuestion(idx);
      verdictWrap.classList.remove("phase-options--hidden");
      dividerTop.classList.remove("phase-divider--hidden");
      dividerBottom.classList.remove("phase-divider--hidden");
      if (!published && !submitting) {
        disableVerdicts(true);
        resumeRoundTimer(timerContext);
      } else {
        disableVerdicts(false);
      }
      reflect();
      updateChipStates();
      updateSubmitState();
    };

    const findNextPending = (startIndex) => {
      if (!tripletReady) return null;
      for (let i = startIndex + 1; i < totalMarks; i += 1) {
        if (!(marks[i] === VERDICT.RIGHT || marks[i] === VERDICT.WRONG || marks[i] === VERDICT.UNKNOWN)) {
          return i;
        }
      }
      for (let i = 0; i < totalMarks; i += 1) {
        if (!(marks[i] === VERDICT.RIGHT || marks[i] === VERDICT.WRONG || marks[i] === VERDICT.UNKNOWN)) {
          return i;
        }
      }
      return null;
    };

    const handleVerdict = (value) => {
      if (published || submitting || !tripletReady) return;
      const normalized = value === VERDICT.RIGHT ? VERDICT.RIGHT
        : value === VERDICT.WRONG ? VERDICT.WRONG
        : VERDICT.UNKNOWN;
      clearAdvanceTimer();
      marks[idx] = normalized;
      reflect();
      updateChipStates();
      updateSubmitState();
      advanceTimer = setTimeout(() => {
        advanceTimer = null;
        if (published || submitting) return;
        const next = findNextPending(idx);
        if (next === null) {
          updateSubmitState();
        } else {
          showMark(next);
        }
      }, 500);
    };

    btnRight.addEventListener("click", () => handleVerdict(VERDICT.RIGHT));
    btnWrong.addEventListener("click", () => handleVerdict(VERDICT.WRONG));
    btnUnknown.addEventListener("click", () => handleVerdict(VERDICT.UNKNOWN));

    chips.forEach((chip, index) => {
      chip.addEventListener("click", () => {
        if (!tripletReady) return;
        if (published || submitting) return;
        showMark(index);
      });
    });

    const existingMarks = (((roomData0.marking || {})[myRole] || {})[round] || []);
    if (Array.isArray(existingMarks) && existingMarks.length >= 3) {
      marks = new Array(totalMarks).fill(null).map((_, i) => {
        const value = existingMarks[i];
        if (value === VERDICT.RIGHT || value === VERDICT.WRONG || value === VERDICT.UNKNOWN) return value;
        return VERDICT.UNKNOWN;
      });
      published = true;
      tripletReady = true;
      showMark(Math.min(totalMarks - 1, 2));
      disableVerdicts(false);
      pauseRoundTimer(timerContext);
      clearRoundTimer(timerContext);
    } else {
      marks = new Array(totalMarks).fill(null);
      tripletReady = true;
      showMark(0);
    }

    const submitMarks = async () => {
      if (published || submitting) return;
      if (!allMarked()) return;
      submitting = true;
      disableVerdicts(false);
      updateSubmitState();
      clearAdvanceTimer();
      pauseRoundTimer(timerContext);
      const safeMarks = marks.map((value) => {
        if (value === VERDICT.RIGHT || value === VERDICT.WRONG || value === VERDICT.UNKNOWN) {
          return value;
        }
        return VERDICT.UNKNOWN;
      });
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
        marks = safeMarks;
        published = true;
        submitting = false;
        disableVerdicts(false);
        reflect();
        updateChipStates();
        updateSubmitState();
        pauseRoundTimer(timerContext);
        clearRoundTimer(timerContext);
      } catch (err) {
        console.warn("[marking] submit failed:", err);
        submitting = false;
        updateSubmitState();
        if (!published) {
          disableVerdicts(true);
          resumeRoundTimer(timerContext);
        }
      }
    };

    submitBtn.addEventListener("click", () => {
      if (submitBtn.disabled) return;
      submitMarks();
    });

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
        marks = new Array(totalMarks).fill(null).map((_, i) => {
          const value = incomingMarks[i];
          if (value === VERDICT.RIGHT || value === VERDICT.WRONG || value === VERDICT.UNKNOWN) return value;
          return VERDICT.UNKNOWN;
        });
        published = true;
        submitting = false;
        disableVerdicts(false);
        reflect();
        updateChipStates();
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
      clearAdvanceTimer();
      try { stopRoomWatch && stopRoomWatch(); } catch {}
      pauseRoundTimer(timerContext);
      rootEl.style.setProperty("--ink-h", prevInkH || "210");
      rootEl.style.setProperty("--ink-s", prevInkS || "62%");
      rootEl.style.setProperty("--ink-l", prevInkL || "18%");
    };
  },

  async unmount() { /* handled per-instance */ }
};
