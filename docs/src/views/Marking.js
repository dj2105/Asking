// /src/views/Marking.js
//
// Marking phase — judge opponent answers while a hidden timer keeps running.
// • Shows opponent questions + chosen answers with ✓/✕/I DUNNO toggles.
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

import * as MathsPaneMod from "../lib/MathsPane.js";
import { resumeRoundTimer, pauseRoundTimer, getRoundTimerTotal, clearRoundTimer } from "../lib/RoundTimer.js";
import { clampCode, getHashParams, getStoredRole } from "../lib/util.js";
const mountMathsPane =
  (typeof MathsPaneMod?.default === "function" ? MathsPaneMod.default :
   typeof MathsPaneMod?.mount === "function" ? MathsPaneMod.mount :
   typeof MathsPaneMod?.default?.mount === "function" ? MathsPaneMod.default.mount :
   null);

const VERDICT = { RIGHT: "right", WRONG: "wrong", UNKNOWN: "unknown" };
const PREVIEW_DELAY_MS = 520;

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

    const card = el("div", { class: "card card--center mark-card" });
    const headerRow = el("div", { class: "mono phase-header phase-header--centered" });
    const heading = el("div", { class: "phase-header__title" }, "MARKING 1/3");
    headerRow.appendChild(heading);

    const list = el("div", { class: "qa-list" });
    const markRow = el("div", { class: "mark-row" });
    const questionNode = el("div", { class: "q mono" }, "");
    markRow.appendChild(questionNode);

    const answerBox = el("div", { class: "a mono mark-answer" });
    const answerLabel = el("div", { class: "mark-answer__label mono small" }, "");
    const answerText = el("div", { class: "mark-answer__text" }, "");
    answerBox.appendChild(answerLabel);
    answerBox.appendChild(answerText);
    markRow.appendChild(answerBox);

    const pair = el("div", { class: "verdict-row" });
    const btnRight = el(
      "button",
      {
        class: "btn verdict-btn verdict-tick",
        type: "button",
        title: "Mark as correct",
        "aria-pressed": "false",
      },
      "✓"
    );
    const btnWrong = el(
      "button",
      {
        class: "btn verdict-btn verdict-cross",
        type: "button",
        title: "Mark as incorrect",
        "aria-pressed": "false",
      },
      "✕"
    );
    const btnUnknown = el(
      "button",
      {
        class: "btn verdict-btn verdict-idk",
        type: "button",
        title: "Mark as unsure",
        "aria-pressed": "false",
      },
      "I DUNNO"
    );
    pair.appendChild(btnRight);
    pair.appendChild(btnWrong);
    pair.appendChild(btnUnknown);
    markRow.appendChild(pair);

    list.appendChild(markRow);

    card.appendChild(headerRow);
    card.appendChild(list);

    root.appendChild(card);

    const mathsMount = el("div", { class: "jemima-maths-pinned" });
    root.appendChild(mathsMount);

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
      overlay.classList.add("stage-overlay--with-maths");
      overlay.appendChild(mathsMount);
      overlay.classList.remove("stage-overlay--hidden");
      card.style.display = "none";
    };

    const hideOverlay = () => {
      overlay.classList.remove("stage-overlay--with-maths");
      overlay.classList.add("stage-overlay--hidden");
      card.style.display = "";
      if (root.contains(overlay)) {
        root.insertBefore(mathsMount, overlay);
      } else {
        root.appendChild(mathsMount);
      }
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

    try {
      if (mountMathsPane && roomData0.maths) {
        mountMathsPane(mathsMount, { maths: roomData0.maths, round, mode: "inline", roomCode: code, userUid: me.uid });
      }
    } catch (err) {
      console.warn("[marking] MathsPane mount failed:", err);
    }

    const rdSnap = await getDoc(rdRef);
    const rd = rdSnap.data() || {};
    const oppItems = (oppRole === "host" ? rd.hostItems : rd.guestItems) || [];
    const oppAnswers = (((roomData0.answers || {})[oppRole] || {})[round] || []).map((a) => a?.chosen || "");
    const totalMarks = Math.max(3, oppItems.length || 0);
    const markingMeta = roomData0.marking || {};

    answerLabel.textContent = `${oppName}’s answer`;

    let idx = 0;
    let marks = new Array(totalMarks).fill(null);
    let published = false;
    let submitting = false;
    let advanceTimer = null;

    const disableFns = [];
    const reflectFns = [];

    const markValue = (value) => {
      if (value === VERDICT.RIGHT) return VERDICT.RIGHT;
      if (value === VERDICT.WRONG) return VERDICT.WRONG;
      return VERDICT.UNKNOWN;
    };

    const showWaitingOverlay = (note) => {
      showOverlay(`Waiting for ${oppName}`, note || "Waiting for opponent");
    };

    const setVerdictsEnabled = (enabled) => {
      btnRight.disabled = !enabled;
      btnWrong.disabled = !enabled;
      btnUnknown.disabled = !enabled;
    };

    const reflect = () => {
      const mark = marks[idx];
      const isRight = mark === VERDICT.RIGHT;
      const isWrong = mark === VERDICT.WRONG;
      const isUnknown = mark === VERDICT.UNKNOWN;
      btnRight.classList.toggle("active", isRight);
      btnWrong.classList.toggle("active", isWrong);
      btnUnknown.classList.toggle("active", isUnknown);
      btnRight.setAttribute("aria-pressed", isRight ? "true" : "false");
      btnWrong.setAttribute("aria-pressed", isWrong ? "true" : "false");
      btnUnknown.setAttribute("aria-pressed", isUnknown ? "true" : "false");
    };

    disableFns.push(() => {
      setVerdictsEnabled(false);
    });
    reflectFns.push(() => { reflect(); });

    const clearAdvanceTimer = () => {
      if (advanceTimer) {
        clearTimeout(advanceTimer);
        advanceTimer = null;
      }
    };

    const showMark = (targetIdx) => {
      clearAdvanceTimer();
      if (targetIdx < 0) targetIdx = 0;
      if (targetIdx >= totalMarks) targetIdx = totalMarks - 1;
      idx = targetIdx;
      const currentItem = oppItems[idx] || {};
      const questionText = currentItem.question || "";
      const chosenAnswer = oppAnswers[idx] || "";
      questionNode.textContent = `${idx + 1}. ${questionText || "(missing question)"}`;
      answerText.textContent = chosenAnswer || "(no answer recorded)";
      heading.textContent = `MARKING ${Math.min(idx + 1, 3)}/3`;
      setVerdictsEnabled(true);
      reflect();
      resumeRoundTimer(timerContext);
      hideOverlay();
    };

    const submitMarks = async () => {
      if (published || submitting) return;
      submitting = true;
      clearAdvanceTimer();
      const safeMarks = marks.map((value) => markValue(value));
      setVerdictsEnabled(false);
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
        marks = safeMarks;
        disableFns.forEach((fn) => { try { fn(); } catch {} });
        showWaitingOverlay("Review submitted");
        clearRoundTimer(timerContext);
      } catch (err) {
        console.warn("[marking] submit failed:", err);
        submitting = false;
        if (!published) {
          hideOverlay();
          resumeRoundTimer(timerContext);
          setVerdictsEnabled(true);
        }
      }
    };

    const scheduleAdvance = (currentIndex, cb) => {
      clearAdvanceTimer();
      advanceTimer = setTimeout(() => {
        advanceTimer = null;
        if (published || submitting) return;
        if (idx !== currentIndex) return;
        cb();
      }, PREVIEW_DELAY_MS);
    };

    const handleVerdict = (value) => {
      if (published || submitting) return;
      const currentIndex = idx;
      marks[currentIndex] = markValue(value);
      reflect();
      if (currentIndex >= totalMarks - 1) {
        scheduleAdvance(currentIndex, () => {
          submitMarks();
        });
      } else {
        scheduleAdvance(currentIndex, () => {
          showMark(currentIndex + 1);
        });
      }
    };

    btnRight.addEventListener("click", () => handleVerdict(VERDICT.RIGHT));
    btnWrong.addEventListener("click", () => handleVerdict(VERDICT.WRONG));
    btnUnknown.addEventListener("click", () => handleVerdict(VERDICT.UNKNOWN));

    const existingMarks = (((roomData0.marking || {})[myRole] || {})[round] || []);
    if (Array.isArray(existingMarks) && existingMarks.length === 3) {
      marks = new Array(totalMarks).fill(null).map((_, i) => markValue(existingMarks[i]));
      published = true;
      reflectFns.forEach((fn) => { try { fn(); } catch {} });
      disableFns.forEach((fn) => { try { fn(); } catch {} });
      showWaitingOverlay("Review submitted");
      pauseRoundTimer(timerContext);
      clearRoundTimer(timerContext);
    } else {
      showMark(0);
    }

    let stopRoomWatch = null;
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
        marks = new Array(totalMarks).fill(null).map((_, i) => markValue(incomingMarks[i]));
        published = true;
        submitting = false;
        reflectFns.forEach((fn) => { try { fn(); } catch {} });
        disableFns.forEach((fn) => { try { fn(); } catch {} });
        showWaitingOverlay(ackOpp ? "Waiting for opponent" : "Review submitted");
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
      clearAdvanceTimer();
    };
  },

  async unmount() { /* instance handles cleanup */ }
};
