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
    const root = el("div", { class: "view view-marking stage-center qa-stage" });

    const shell = el("div", { class: "qa-shell" });
    const heading = el("div", { class: "qa-heading mono" }, "Marking");
    const switcher = el("div", { class: "qa-switcher" });
    const questionNode = el("div", { class: "qa-question mono" }, "");
    const answerDetail = el("div", { class: "qa-answer-detail mono" }, "");

    const markChoices = el("div", { class: "mark-choices" });
    const btnRight = el("button", {
      class: "mark-choice mark-choice--right",
      type: "button",
      "data-verdict": VERDICT.RIGHT,
      "aria-pressed": "false",
    }, "✓");
    const btnUnknown = el("button", {
      class: "mark-choice mark-choice--unknown",
      type: "button",
      "data-verdict": VERDICT.UNKNOWN,
      "aria-pressed": "false",
    }, "I dunno");
    const btnWrong = el("button", {
      class: "mark-choice mark-choice--wrong",
      type: "button",
      "data-verdict": VERDICT.WRONG,
      "aria-pressed": "false",
    }, "✕");
    markChoices.appendChild(btnRight);
    markChoices.appendChild(btnUnknown);
    markChoices.appendChild(btnWrong);

    const submitBtn = el("button", { class: "qa-submit", type: "button", disabled: "true" }, "Submit");

    shell.appendChild(heading);
    shell.appendChild(switcher);
    shell.appendChild(questionNode);
    shell.appendChild(answerDetail);
    shell.appendChild(markChoices);
    shell.appendChild(submitBtn);

    root.appendChild(shell);

    const mathsMount = el("div", { class: "jemima-maths-pinned" });
    root.appendChild(mathsMount);

    container.appendChild(root);

    const switchButtons = [0, 1, 2].map((i) => {
      const btn = el("button", {
        class: "qa-switcher__btn",
        type: "button",
        "data-index": String(i),
        "aria-pressed": "false",
      }, String(i + 1));
      switcher.appendChild(btn);
      return btn;
    });

    const verdictButtons = [btnRight, btnUnknown, btnWrong];

    let idx = 0;
    let verdicts = [null, null, null];
    let entries = [];
    let published = false;
    let submitting = false;
    let statusMessage = "Preparing review…";
    let waitMessageDefault = "Waiting…";
    let timerContext = null;

    const clampVerdict = (value) => {
      if (value === VERDICT.RIGHT) return VERDICT.RIGHT;
      if (value === VERDICT.WRONG) return VERDICT.WRONG;
      if (value === VERDICT.UNKNOWN) return VERDICT.UNKNOWN;
      return null;
    };

    function updateSubmitState() {
      const ready = verdicts.every((value) => Boolean(clampVerdict(value)));
      const canSubmit = ready && !submitting && !published;
      submitBtn.disabled = !canSubmit;
      submitBtn.classList.toggle("qa-submit--ready", canSubmit);
      submitBtn.classList.toggle("qa-submit--waiting", submitting || published);
      submitBtn.textContent = published ? waitMessageDefault : submitting ? "Submitting…" : "Submit";
    }

    function updateSwitcherButtons() {
      switchButtons.forEach((btn, buttonIdx) => {
        const isActive = buttonIdx === idx;
        const hasVerdict = Boolean(clampVerdict(verdicts[buttonIdx]));
        btn.classList.toggle("is-active", isActive);
        btn.classList.toggle("is-answered", hasVerdict);
        btn.setAttribute("aria-pressed", isActive ? "true" : "false");
      });
    }

    function refreshVerdictStyles() {
      const selected = clampVerdict(verdicts[idx]);
      verdictButtons.forEach((btn) => {
        const value = btn.getAttribute("data-verdict");
        const isActive = selected && value === selected;
        btn.classList.toggle("selected", Boolean(isActive));
        btn.setAttribute("aria-pressed", isActive ? "true" : "false");
      });
    }

    function renderMark() {
      const hasStatus = Boolean(statusMessage);
      const current = entries[idx] || {};
      questionNode.textContent = hasStatus ? statusMessage : current.question || "";
      const answerLabel = current.answer || "";
      answerDetail.textContent = hasStatus ? "" : answerLabel;
      answerDetail.classList.toggle("qa-answer-detail--hidden", hasStatus || !answerLabel);

      verdictButtons.forEach((btn) => {
        btn.disabled = hasStatus || submitting || published || entries.length === 0;
      });

      if (!hasStatus && timerContext && !published) {
        resumeRoundTimer(timerContext);
      } else if (timerContext) {
        pauseRoundTimer(timerContext);
      }

      refreshVerdictStyles();
      updateSwitcherButtons();
      updateSubmitState();
    }

    function setStatusMessage(message) {
      statusMessage = message || "";
      renderMark();
    }

    function clearStatusMessage() {
      setStatusMessage("");
    }

    function findNextUnmarked(fromIndex) {
      for (let i = fromIndex + 1; i < verdicts.length; i += 1) {
        if (!clampVerdict(verdicts[i])) return i;
      }
      for (let i = 0; i < verdicts.length; i += 1) {
        if (!clampVerdict(verdicts[i])) return i;
      }
      return null;
    }

    function showMark(targetIdx) {
      if (!entries.length) return;
      if (targetIdx < 0) targetIdx = 0;
      if (targetIdx >= entries.length) targetIdx = entries.length - 1;
      idx = targetIdx;
      clearStatusMessage();
      renderMark();
    }

    renderMark();

    switchButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = Number(btn.getAttribute("data-index"));
        if (!Number.isFinite(target)) return;
        showMark(target);
      });
    });

    verdictButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        if (published || submitting) return;
        const value = clampVerdict(btn.getAttribute("data-verdict"));
        if (!value) return;
        verdicts[idx] = value;
        const nextIdx = findNextUnmarked(idx);
        if (nextIdx !== null && nextIdx !== idx) {
          showMark(nextIdx);
        } else {
          renderMark();
        }
      });
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

    waitMessageDefault = `Waiting for ${oppName}…`;
    renderMark();

    timerContext = { code, role: myRole, round };

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

    entries = [0, 1, 2].map((i) => {
      const item = oppItems[i] || {};
      const question = typeof item.question === "string" && item.question.trim()
        ? item.question.trim()
        : "(question unavailable)";
      const answer = oppAnswers[i] && oppAnswers[i].trim()
        ? `Answer: ${oppAnswers[i].trim()}`
        : "Answer: (no answer recorded)";
      return { question, answer };
    });

    const existingMarks = (((roomData0.marking || {})[myRole] || {})[round] || []);
    const ackMineInitial = Boolean((((roomData0.markingAck || {})[myRole] || {})[round]));
    if (Array.isArray(existingMarks) && existingMarks.length === 3) {
      verdicts = existingMarks.map((value, i) => clampVerdict(value) || clampVerdict(verdicts[i]));
      if (ackMineInitial) {
        published = true;
      }
    }

    if (ackMineInitial) {
      pauseRoundTimer(timerContext);
      clearRoundTimer(timerContext);
    }

    if (entries.length) {
      showMark(ackMineInitial ? Math.min(entries.length - 1, 2) : 0);
    } else {
      setStatusMessage("Waiting for round data…");
    }

    async function publishMarks() {
      if (submitting || published) return;
      const safeVerdicts = verdicts.map((value) => clampVerdict(value) || VERDICT.UNKNOWN);
      const ready = safeVerdicts.every((value) => Boolean(value));
      if (!ready) return;

      submitting = true;
      updateSubmitState();
      pauseRoundTimer(timerContext);

      const totalSecondsRaw = getRoundTimerTotal(timerContext) / 1000;
      const totalSeconds = Math.max(0, Math.round(totalSecondsRaw * 100) / 100);

      const patch = {
        [`marking.${myRole}.${round}`]: safeVerdicts,
        [`markingAck.${myRole}.${round}`]: true,
        [`timings.${myRole}.${round}`]: { totalSeconds },
        "timestamps.updatedAt": serverTimestamp(),
      };

      try {
        console.log(`[flow] submit marking | code=${code} round=${round} role=${myRole}`);
        await updateDoc(rRef, patch);
        verdicts = safeVerdicts.slice(0, verdicts.length);
        published = true;
        submitting = false;
        renderMark();
        clearRoundTimer(timerContext);
      } catch (err) {
        console.warn("[marking] submit failed:", err);
        submitting = false;
        renderMark();
      }
    }

    submitBtn.addEventListener("click", publishMarks);

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
        const incomingMarks = (((data.marking || {})[myRole] || {})[round] || verdicts);
        verdicts = new Array(verdicts.length).fill(null).map((_, i) => clampVerdict(incomingMarks[i]) || verdicts[i]);
        published = true;
        submitting = false;
        renderMark();
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
