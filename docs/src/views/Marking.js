// /src/views/Marking.js
//
// Marking phase — award-style layout with manual submit.
// • Shows opponent answers one by one with verdict chips.
// • Verdict buttons auto-advance after a short hold but require submit.

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
import NavigationGuard from "../lib/NavigationGuard.js";

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

const roomRef = (code) => doc(db, "rooms", code);
const roundSubColRef = (code) => collection(roomRef(code), "rounds");

function setThemeFromHue(hue) {
  const accent = `hsl(${hue}, 28%, 32%)`;
  const accentStrong = `hsl(${hue}, 34%, 24%)`;
  const accentSoft = `hsla(${hue}, 36%, 32%, 0.18)`;
  const complementHue = (hue + 180) % 360;
  const highlight = `hsl(${complementHue}, 74%, 88%)`;
  const highlightText = `hsl(${complementHue}, 46%, 24%)`;
  document.documentElement.style.setProperty("--ink-h", String(hue));
  document.documentElement.style.setProperty("--round-accent", accent);
  document.documentElement.style.setProperty("--round-accent-strong", accentStrong);
  document.documentElement.style.setProperty("--round-accent-soft", accentSoft);
  document.documentElement.style.setProperty("--round-highlight", highlight);
  document.documentElement.style.setProperty("--round-highlight-text", highlightText);
}

function setupLobbyConfirm(root) {
  const overlay = el("div", { class: "round-confirm round-confirm--hidden" });
  const box = el("div", { class: "round-confirm__box" });
  const prompt = el("div", { class: "mono round-confirm__prompt" }, "RETURN TO LOBBY?");
  const actions = el("div", { class: "round-confirm__actions" });
  const yesBtn = el("button", { class: "btn round-confirm__btn" }, "YES");
  const noBtn = el("button", { class: "btn outline round-confirm__btn" }, "NO");
  actions.appendChild(yesBtn);
  actions.appendChild(noBtn);
  box.appendChild(prompt);
  box.appendChild(actions);
  overlay.appendChild(box);
  root.appendChild(overlay);

  let pending = null;

  const close = () => {
    overlay.classList.add("round-confirm--hidden");
    pending = null;
  };

  yesBtn.addEventListener("click", () => {
    if (!pending) return;
    const { onYes } = pending;
    close();
    if (typeof onYes === "function") onYes();
  });

  noBtn.addEventListener("click", () => {
    if (!pending) return;
    const { onNo } = pending;
    close();
    if (typeof onNo === "function") onNo();
  });

  return {
    show(onYes, onNo) {
      pending = { onYes, onNo };
      overlay.classList.remove("round-confirm--hidden");
      requestAnimationFrame(() => { try { yesBtn.focus(); } catch {} });
    },
    destroy() {
      try { root.removeChild(overlay); } catch {}
    },
  };
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

export default {
  async mount(container) {
    const me = await ensureAuth();

    const params = getHashParams();
    const code = clampCode(params.get("code") || "");
    let round = parseInt(params.get("round") || "1", 10) || 1;

    const hue = Math.floor(Math.random() * 360);
    setThemeFromHue(hue);

    container.innerHTML = "";
    const root = el("div", { class: "view view-marking stage-center view-round" });

    const panel = el("div", { class: "card round-panel" });
    const heading = el("div", { class: "mono round-heading" }, "MARKING");
    const stepsRow = el("div", { class: "round-steps" });
    const stepButtons = [1, 2, 3].map((num) => {
      const btn = el("button", { class: "round-step", type: "button" }, String(num));
      stepsRow.appendChild(btn);
      return btn;
    });

    const body = el("div", { class: "round-panel__body" });
    const questionText = el("div", { class: "mono round-question" }, "");
    const answerLine = el("div", { class: "mono round-question__answer" }, "");
    const optionsRow = el("div", { class: "round-marking-options" });

    const btnRight = el(
      "button",
      { class: "btn outline round-mark", type: "button", "aria-pressed": "false" },
      "✓"
    );
    const btnUnknown = el(
      "button",
      { class: "btn outline round-mark", type: "button", "aria-pressed": "false" },
      "I DUNNO"
    );
    const btnWrong = el(
      "button",
      { class: "btn outline round-mark", type: "button", "aria-pressed": "false" },
      "✕"
    );

    optionsRow.appendChild(btnRight);
    optionsRow.appendChild(btnUnknown);
    optionsRow.appendChild(btnWrong);

    body.appendChild(questionText);
    body.appendChild(answerLine);
    body.appendChild(optionsRow);

    const submitBtn = el(
      "button",
      { class: "btn round-submit", type: "button", disabled: "disabled" },
      "SUBMIT MARKING"
    );

    panel.appendChild(heading);
    panel.appendChild(stepsRow);
    panel.appendChild(body);
    panel.appendChild(submitBtn);

    root.appendChild(panel);
    container.appendChild(root);

    const confirmOverlay = setupLobbyConfirm(root);

    let allowNavigation = false;
    const guardControl = {
      shouldBlock() {
        if (allowNavigation) {
          allowNavigation = false;
          return false;
        }
        return true;
      },
      confirm(_target, proceed, stay) {
      confirmOverlay.show(
        () => {
          allowNavigation = true;
          NavigationGuard.clearGuard(guardControl);
          proceed("#/lobby");
          allowNavigation = false;
        },
        () => {
          stay();
        }
      );
      },
    };
    NavigationGuard.setGuard(guardControl);

    const permitNavigation = (fn) => {
      allowNavigation = true;
      try {
        fn();
      } catch (err) {
        allowNavigation = false;
        throw err;
      } finally {
        setTimeout(() => { allowNavigation = false; }, 0);
      }
    };

    let idx = 0;
    let totalMarks = 3;
    let marks = new Array(totalMarks).fill(null);
    let published = false;
    let submitting = false;
    let advanceTimer = null;
    let dataReady = false;

    let oppName = "Opponent";
    let oppAnswers = [];
    let oppItems = [];

    const timerContext = { code, role: "", round };

    const clearAdvanceTimer = () => {
      if (advanceTimer) {
        clearTimeout(advanceTimer);
        advanceTimer = null;
      }
    };

    const animateSwap = (fn) => {
      body.classList.add("round-panel__body--fading");
      setTimeout(() => {
        fn();
        body.classList.remove("round-panel__body--fading");
      }, 160);
    };

    const updateStepStates = () => {
      stepButtons.forEach((btn, i) => {
        const done = marks[i] !== null && marks[i] !== undefined;
        const active = i === idx;
        btn.classList.toggle("round-step--active", active);
        btn.classList.toggle("round-step--done", done);
      });
    };

    const markButtons = [
      { btn: btnRight, value: VERDICT.RIGHT, className: "round-mark--right" },
      { btn: btnUnknown, value: VERDICT.UNKNOWN, className: "round-mark--unknown" },
      { btn: btnWrong, value: VERDICT.WRONG, className: "round-mark--wrong" },
    ];

    const refreshMarkStyles = () => {
      const mark = marks[idx];
      markButtons.forEach(({ btn, value, className }) => {
        btn.classList.remove("round-mark--right", "round-mark--wrong", "round-mark--unknown", "round-mark--active");
        const isActive = mark === value;
        if (isActive) {
          btn.classList.add("round-mark--active");
          btn.classList.add(className);
        }
        btn.setAttribute("aria-pressed", isActive ? "true" : "false");
      });
    };

    const setVerdictsEnabled = (enabled) => {
      markButtons.forEach(({ btn }) => {
        btn.disabled = !enabled;
        btn.classList.toggle("round-mark--locked", !enabled);
      });
    };

    const submitLabelDefault = "SUBMIT MARKING";
    let submitWaitingLabel = "WAITING";

    const updateSubmitState = () => {
      const allDecided = marks.every((value) => value === VERDICT.RIGHT || value === VERDICT.WRONG || value === VERDICT.UNKNOWN);
      const canSubmit = dataReady && allDecided && !published && !submitting;
      submitBtn.disabled = !canSubmit;
      submitBtn.classList.toggle("throb", canSubmit);
      submitBtn.textContent = published ? submitWaitingLabel : submitLabelDefault;
    };

    const showMark = (targetIdx, { immediate = false } = {}) => {
      if (!dataReady) return;
      let nextIdx = targetIdx;
      if (nextIdx < 0) nextIdx = 0;
      if (nextIdx >= totalMarks) nextIdx = totalMarks - 1;
      const apply = () => {
        idx = nextIdx;
        const currentItem = oppItems[idx] || {};
        const prompt = currentItem.question || "(missing question)";
        const chosenAnswer = oppAnswers[idx] || "(no answer recorded)";
        questionText.textContent = `${idx + 1}. ${prompt}`;
        answerLine.textContent = `${oppName.toUpperCase()} ANSWERED — ${chosenAnswer}`;
        refreshMarkStyles();
        updateStepStates();
        if (!published && !submitting) {
          setVerdictsEnabled(true);
          resumeRoundTimer(timerContext);
        }
      };
      if (immediate) apply();
      else animateSwap(apply);
    };

    const showPreparing = () => {
      questionText.textContent = "Preparing answers…";
      answerLine.textContent = "";
      setVerdictsEnabled(false);
      updateStepStates();
    };

    const enterWaitingState = () => {
      published = true;
      clearAdvanceTimer();
      pauseRoundTimer(timerContext);
      setVerdictsEnabled(false);
      submitBtn.classList.remove("throb");
      submitBtn.disabled = true;
      submitBtn.textContent = submitWaitingLabel;
    };

    const submitMarks = async () => {
      if (submitting || published) return;
      submitting = true;
      submitBtn.classList.remove("throb");
      submitBtn.disabled = true;
      submitBtn.textContent = "SUBMITTING…";
      setVerdictsEnabled(false);
      clearAdvanceTimer();
      pauseRoundTimer(timerContext);

      const safeMarks = marks.map((value) => {
        if (value === VERDICT.RIGHT) return VERDICT.RIGHT;
        if (value === VERDICT.WRONG) return VERDICT.WRONG;
        return VERDICT.UNKNOWN;
      });
      const totalSecondsRaw = getRoundTimerTotal(timerContext) / 1000;
      const totalSeconds = Math.max(0, Math.round(totalSecondsRaw * 100) / 100);
      const patch = {
        [`marking.${timerContext.role}.${round}`]: safeMarks,
        [`markingAck.${timerContext.role}.${round}`]: true,
        [`timings.${timerContext.role}.${round}`]: { totalSeconds },
        "timestamps.updatedAt": serverTimestamp(),
      };

      try {
        await updateDoc(roomRef(code), patch);
        submitting = false;
        marks = safeMarks;
        enterWaitingState();
        clearRoundTimer(timerContext);
      } catch (err) {
        console.warn("[marking] submit failed:", err);
        submitting = false;
        published = false;
        submitBtn.textContent = submitLabelDefault;
        updateSubmitState();
        setVerdictsEnabled(true);
        resumeRoundTimer(timerContext);
      }
    };

    submitBtn.addEventListener("click", () => {
      if (!published && !submitting) submitMarks();
    });

    const handleVerdict = (value) => {
      if (published || submitting || !dataReady) return;
      clearAdvanceTimer();
      marks[idx] = value;
      refreshMarkStyles();
      updateStepStates();
      updateSubmitState();
      advanceTimer = setTimeout(() => {
        advanceTimer = null;
        if (published || submitting) return;
        const next = marks.findIndex((entry) => entry === null || entry === undefined);
        if (next === -1) {
          showMark(idx, { immediate: true });
          submitBtn.focus?.();
        } else if (next !== idx) {
          showMark(next);
        } else if (idx < totalMarks - 1) {
          showMark(idx + 1);
        }
      }, 500);
    };

    btnRight.addEventListener("click", () => handleVerdict(VERDICT.RIGHT));
    btnUnknown.addEventListener("click", () => handleVerdict(VERDICT.UNKNOWN));
    btnWrong.addEventListener("click", () => handleVerdict(VERDICT.WRONG));

    stepButtons.forEach((btn, i) => {
      btn.addEventListener("click", () => {
        if (!dataReady) return;
        clearAdvanceTimer();
        showMark(i);
      });
    });

    let stopRoomWatch = null;
    let alive = true;
    let finalizing = false;

    this.unmount = () => {
      alive = false;
      clearAdvanceTimer();
      try { stopRoomWatch && stopRoomWatch(); } catch {}
      pauseRoundTimer(timerContext);
      NavigationGuard.clearGuard(guardControl);
      confirmOverlay.destroy();
    };

    const rRef = roomRef(code);
    const rdRef = doc(roundSubColRef(code), String(round));

    showPreparing();

    const roomSnap = await getDoc(rRef);
    const roomData0 = roomSnap.data() || {};
    const { hostUid, guestUid } = roomData0.meta || {};
    const storedRole = getStoredRole(code);
    const myRole = storedRole === "host" || storedRole === "guest"
      ? storedRole
      : hostUid === me.uid ? "host" : guestUid === me.uid ? "guest" : "guest";
    const oppRole = myRole === "host" ? "guest" : "host";
    oppName = oppRole === "host" ? "Daniel" : "Jaime";
    submitWaitingLabel = `WAITING FOR ${oppName.toUpperCase()}`;

    timerContext.code = code;
    timerContext.role = myRole;
    timerContext.round = round;

    try {
      const rdSnap = await getDoc(rdRef);
      const rd = rdSnap.data() || {};
      oppItems = (oppRole === "host" ? rd.hostItems : rd.guestItems) || [];
      totalMarks = Math.max(3, oppItems.length || 0);
    } catch (err) {
      console.warn("[marking] failed to load round doc:", err);
      oppItems = [];
      totalMarks = 3;
    }

    oppAnswers = (((roomData0.answers || {})[oppRole] || {})[round] || []).map((a) => a?.chosen || "");
    if (!Array.isArray(oppAnswers) || oppAnswers.length === 0) {
      oppAnswers = new Array(totalMarks).fill("");
    }

    marks = new Array(totalMarks).fill(null);

    const existingMarks = (((roomData0.marking || {})[myRole] || {})[round] || []);
    if (Array.isArray(existingMarks)) {
      for (let i = 0; i < totalMarks && i < existingMarks.length; i += 1) {
        const val = existingMarks[i];
        if (val === VERDICT.RIGHT || val === VERDICT.WRONG || val === VERDICT.UNKNOWN) {
          marks[i] = val;
        }
      }
    }

    dataReady = true;

    if (marks.every((value) => value === VERDICT.RIGHT || value === VERDICT.WRONG || value === VERDICT.UNKNOWN) && existingMarks.length >= totalMarks) {
      showMark(totalMarks - 1, { immediate: true });
      enterWaitingState();
      clearRoundTimer(timerContext);
    } else {
      const unanswered = marks.findIndex((value) => value === null || value === undefined);
      const startIdx = unanswered === -1 ? totalMarks - 1 : unanswered;
      showMark(startIdx, { immediate: true });
      updateSubmitState();
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
          permitNavigation(() => {
            window.location.hash = `#/countdown?code=${code}&round=${data.round || round}`;
          });
        }, 80);
        return;
      }

      if (stateName === "questions") {
        setTimeout(() => {
          permitNavigation(() => {
            window.location.hash = `#/questions?code=${code}&round=${data.round || round}`;
          });
        }, 80);
        return;
      }

      if (stateName === "award") {
        setTimeout(() => {
          permitNavigation(() => {
            window.location.hash = `#/award?code=${code}&round=${data.round || round}`;
          });
        }, 80);
        return;
      }

      if (stateName === "maths") {
        setTimeout(() => {
          permitNavigation(() => { window.location.hash = `#/maths?code=${code}`; });
        }, 80);
        return;
      }

      const markingAck = data.markingAck || {};
      const ackMine = Boolean(((markingAck[myRole] || {})[round]));
      const ackOpp = Boolean(((markingAck[oppRole] || {})[round]));

      if (ackMine && !published) {
        const incomingMarks = (((data.marking || {})[myRole] || {})[round] || marks);
        marks = new Array(totalMarks).fill(null).map((_, i) => {
          const val = incomingMarks[i];
          if (val === VERDICT.RIGHT || val === VERDICT.WRONG || val === VERDICT.UNKNOWN) return val;
          return marks[i];
        });
        refreshMarkStyles();
        updateStepStates();
        enterWaitingState();
        clearRoundTimer(timerContext);
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
