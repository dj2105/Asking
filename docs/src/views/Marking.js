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
    const heading = el("div", { class: "phase-header__title" }, "MARKING");
    headerRow.appendChild(heading);
    const clueBox = el("div", { class: "mono mark-card__clue" }, "");

    const list = el("div", { class: "qa-list" });

    card.appendChild(headerRow);
    card.appendChild(clueBox);
    card.appendChild(list);
    const submitBtn = el("button", {
      class: "btn outline mark-submit-btn",
      type: "button",
      disabled: "",
    }, "SUBMIT MARKING");
    const submitWrap = el("div", { class: "mark-submit-row" });
    submitWrap.appendChild(submitBtn);
    card.appendChild(submitWrap);

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

    const setStageVisible = (visible) => {
      card.style.display = visible ? "" : "none";
      mathsMount.style.display = visible ? "" : "none";
    };

    const showOverlay = (title, note) => {
      overlayTitle.textContent = title || "";
      overlayNote.textContent = note || "";
      overlay.classList.remove("stage-overlay--hidden");
      setStageVisible(false);
    };

    const hideOverlay = () => {
      overlay.classList.add("stage-overlay--hidden");
      setStageVisible(true);
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

    let clueMap = roomData0.clues || {};
    const resolveClue = (r) =>
      (clueMap && typeof clueMap[r] === "string" && clueMap[r]) || "";
    const updateClue = () => {
      const text = resolveClue(round);
      clueBox.textContent = text || "";
      clueBox.classList.toggle("mark-card__clue--empty", !text);
    };
    updateClue();

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
    const markingMeta = roomData0.marking || {};

    let marks = [null, null, null];
    let published = false;
    let submitting = false;

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

    const updateDoneState = () => {
      if (published) {
        submitBtn.disabled = true;
        submitBtn.classList.remove("throb");
        return;
      }
      const ready = marks.every((v) =>
        v === VERDICT.RIGHT || v === VERDICT.WRONG || v === VERDICT.UNKNOWN
      );
      submitBtn.disabled = !(ready && !submitting);
      submitBtn.classList.toggle("throb", ready && !submitting);
    };

    const submitMarks = async () => {
      if (published || submitting) return;
      submitting = true;
      const safeMarks = marks.map((value) => markValue(value));
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
        await updateDoc(rRef, patch);
        published = true;
        marks = safeMarks;
        disableFns.forEach((fn) => { try { fn(); } catch {} });
        submitBtn.disabled = true;
        submitBtn.classList.remove("throb");
        showWaitingOverlay("Review submitted");
        clearRoundTimer(timerContext);
      } catch (err) {
        console.warn("[marking] submit failed:", err);
        submitting = false;
        if (!published) {
          resumeRoundTimer(timerContext);
          updateDoneState();
          hideOverlay();
        }
      }
    };

    const buildRow = (idx, question, chosen) => {
      const row = el("div", { class: "mark-row" });
      row.appendChild(el("div", { class: "q mono" }, `${idx + 1}. ${question || "(missing question)"}`));

      const answerBox = el("div", { class: "a mono mark-answer" });
      answerBox.appendChild(
        el(
          "div",
          { class: "mark-answer__label mono small" },
          `${oppName}’s answer`
        )
      );
      answerBox.appendChild(
        el(
          "div",
          { class: "mark-answer__text" },
          chosen || "(no answer recorded)"
        )
      );
      row.appendChild(answerBox);

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

      btnRight.addEventListener("click", () => {
        if (published || submitting) return;
        marks[idx] = VERDICT.RIGHT;
        reflect();
        updateDoneState();
      });
      btnWrong.addEventListener("click", () => {
        if (published || submitting) return;
        marks[idx] = VERDICT.WRONG;
        reflect();
        updateDoneState();
      });
      btnUnknown.addEventListener("click", () => {
        if (published || submitting) return;
        marks[idx] = VERDICT.UNKNOWN;
        reflect();
        updateDoneState();
      });

      pair.appendChild(btnRight);
      pair.appendChild(btnWrong);
      pair.appendChild(btnUnknown);
      row.appendChild(pair);

      disableFns.push(() => {
        btnRight.disabled = true;
        btnWrong.disabled = true;
        btnUnknown.disabled = true;
        btnRight.classList.remove("throb");
        btnWrong.classList.remove("throb");
        btnUnknown.classList.remove("throb");
      });
      reflectFns.push(reflect);
      reflect();

      return row;
    };

    list.innerHTML = "";
    for (let i = 0; i < 3; i += 1) {
      const q = oppItems[i]?.question || "";
      const chosen = oppAnswers[i] || "";
      list.appendChild(buildRow(i, q, chosen));
    }

    const existingMarks = (((roomData0.marking || {})[myRole] || {})[round] || []);
    if (Array.isArray(existingMarks) && existingMarks.length === 3) {
      marks = existingMarks.map((v) => markValue(v));
      published = true;
      reflectFns.forEach((fn) => { try { fn(); } catch {} });
      disableFns.forEach((fn) => { try { fn(); } catch {} });
      showWaitingOverlay("Review submitted");
      pauseRoundTimer(timerContext);
      clearRoundTimer(timerContext);
    } else {
      resumeRoundTimer(timerContext);
      hideOverlay();
    }

    updateDoneState();

    submitBtn.addEventListener("click", () => {
      submitMarks();
    });

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

      if (data.clues && typeof data.clues === "object") {
        clueMap = data.clues;
      }
      if (Number.isFinite(Number(data.round))) {
        const nextRound = Number(data.round);
        if (nextRound !== round) {
          round = nextRound;
          timerContext.round = round;
        }
      }
      updateClue();

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
        marks = (((data.marking || {})[myRole] || {})[round] || marks).map((v) => markValue(v));
        published = true;
        reflectFns.forEach((fn) => { try { fn(); } catch {} });
        disableFns.forEach((fn) => { try { fn(); } catch {} });
        showWaitingOverlay(ackOpp ? "Waiting for opponent" : "Review submitted");
        submitBtn.disabled = true;
        submitBtn.classList.remove("throb");
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
