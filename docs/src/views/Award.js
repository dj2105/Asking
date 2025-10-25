// /src/views/Award.js
//
// Award phase — review both players' answers and confirm before next round.
// • Shows cumulative scores and six Q&As (host + guest) with correctness markers.
// • Both players must tap Continue; host then advances to countdown for the next round (or final after R5).

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

import { clampCode, getHashParams, getStoredRole } from "../lib/util.js";

const CONTINUE_LEAD_MS = 3_000;

const SLOW_COACH_LINES = [
  "Speed earns secrets.",
  "Hints don’t wait for hesitation.",
  "Quicker minds get the clues.",
  "Lag and lose the lead.",
  "No haste, no hint.",
  "The swift see what the slow miss.",
  "Hesitation costs revelation.",
  "Move faster to unlock wisdom.",
  "Delay denies discovery.",
  "A sluggish tap wins no clue.",
  "Only the sharp catch the whisper.",
  "The clock favours the keen.",
  "Too late for enlightenment.",
  "Speed is the price of insight.",
  "The hint runs ahead of you.",
  "Swift fingers, sharp minds.",
  "Clues slip past the slow.",
  "You blinked, the hint vanished.",
  "Momentum makes meaning.",
  "The hint rewards the hurried.",
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

function same(a, b) {
  return String(a || "").trim() === String(b || "").trim();
}

function resolveCorrectAnswer(answer = {}, fallbackItem = {}) {
  if (answer.correct) return answer.correct;
  if (fallbackItem.correct_answer) return fallbackItem.correct_answer;
  return "";
}

const roundTier = (r) => (r <= 1 ? "easy" : r === 2 ? "medium" : "hard");

function resolveRoundDistractor(item = {}, round) {
  const distractors = item.distractors || {};
  const tier = roundTier(round);
  return (
    distractors[tier] ||
    distractors.medium ||
    distractors.easy ||
    distractors.hard ||
    ""
  );
}

function renderQuestionSection({ heading, items, answers, round }) {
  const block = el("div", { class: "award-box award-box--questions" });
  block.appendChild(el("div", { class: "mono award-box__title" }, heading));

  for (let i = 0; i < 3; i += 1) {
    const item = items[i] || {};
    const answer = answers[i] || {};
    const question = item.question || answer.question || "(missing question)";
    const correctRaw = resolveCorrectAnswer(answer, item);
    const correct = correctRaw || "(missing option)";
    const chosen = answer.chosen || "";
    const wasAnswered = Boolean(chosen);
    const wasCorrect = wasAnswered && same(chosen, correct);

    const row = el("div", { class: "award-question" });
    const textCol = el("div", { class: "award-question__text" });
    textCol.appendChild(
      el("div", { class: "mono award-question__prompt" }, `${i + 1}. ${question}`)
    );

    let distractor = resolveRoundDistractor(item, round);
    if (!distractor || same(distractor, correct)) {
      const alt = chosen && !same(chosen, correct) ? chosen : "";
      if (alt) distractor = alt;
    }
    if (!distractor || same(distractor, correct)) distractor = "(missing option)";

    const choices = [
      { text: correct || "(missing option)", isCorrect: true },
      { text: distractor, isCorrect: false },
    ];

    for (const choice of choices) {
      const lineClasses = ["mono", "award-answer-line"];
      lineClasses.push(
        choice.isCorrect
          ? "award-answer-line--correct"
          : "award-answer-line--wrong"
      );
      textCol.appendChild(
        el("div", { class: lineClasses.join(" ") }, choice.text)
      );
    }

    const statusSymbol = wasCorrect ? "✓" : "✕";
    const status = el(
      "div",
      {
        class: wasCorrect
          ? "award-question__status award-question__status--right"
          : "award-question__status award-question__status--wrong"
      },
      statusSymbol
    );

    row.appendChild(textCol);
    row.appendChild(status);
    block.appendChild(row);
  }

  return block;
}

const roomRef = (code) => doc(db, "rooms", code);
const roundSubColRef = (code) => collection(roomRef(code), "rounds");

export default {
  async mount(container) {
    const me = await ensureAuth();

    const qs = getHashParams();
    const code = clampCode(qs.get("code") || "");
    let round = parseInt(qs.get("round") || "1", 10) || 1;

    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    container.innerHTML = "";
    const root = el("div", { class: "view view-award" });

    const card = el("div", { class: "card award-card" });
    const scoreHeading = el("div", { class: "mono award-title" }, "");
    const timeLine = el("div", { class: "mono award-timeline" }, "");
    const revealBox = el("div", { class: "mono award-reveal award-reveal--hidden" }, "");
    const reviewWrap = el("div", { class: "award-review" });

    card.appendChild(scoreHeading);
    card.appendChild(timeLine);
    card.appendChild(revealBox);
    card.appendChild(reviewWrap);

    const continueBtn = el("button", { class: "btn" }, "I'M READY");
    card.appendChild(continueBtn);

    root.appendChild(card);

    container.appendChild(root);

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
    const computeReadyLabel = (r) => (r >= 5 ? "I'M READY FOR FINAL" : `I'M READY FOR ROUND ${r + 1}`);
    let readyLabel = computeReadyLabel(round);
    let waitingLabel = `WAITING FOR ${oppName.toUpperCase()}`;
    continueBtn.textContent = readyLabel;

    let revealMap = roomData0.reveals || {};
    let mathsReveals = Array.isArray(roomData0.maths?.reveals) ? roomData0.maths.reveals : [];
    let timingsData = roomData0.timings || {};

    let reviewData = {
      hostItems: [],
      guestItems: [],
      hostAnswers: [],
      guestAnswers: []
    };

    const resolveReveal = (r) => {
      if (revealMap && typeof revealMap[r] === "string") return revealMap[r];
      const idx = r - 1;
      const entry = mathsReveals[idx];
      if (!entry) return "";
      if (typeof entry === "string") return entry;
      if (entry && typeof entry.prompt === "string") return entry.prompt;
      return "";
    };
    const formatSeconds = (value) => {
      const num = Number(value);
      if (!Number.isFinite(num)) return "—";
      return `${num.toFixed(1)}s`;
    };

    let slowCoachRound = null;
    let slowCoachLine = "";
    const pickSlowCoachLine = () => {
      if (!SLOW_COACH_LINES.length) {
        slowCoachLine = "";
        slowCoachRound = round;
        return;
      }
      const idx = Math.floor(Math.random() * SLOW_COACH_LINES.length);
      slowCoachLine = SLOW_COACH_LINES[idx];
      slowCoachRound = round;
    };

    const updateTimes = () => {
      const hostTiming = Number((((timingsData || {}).host || {})[round] || {}).totalSeconds);
      const guestTiming = Number((((timingsData || {}).guest || {})[round] || {}).totalSeconds);
      timeLine.textContent = `Round ${round} • Daniel ${formatSeconds(hostTiming)} • Jaime ${formatSeconds(guestTiming)}`;
    };
    const updateReveal = () => {
      const revealText = (resolveReveal(round) || "").trim();
      const hostTiming = Number((((timingsData || {}).host || {})[round] || {}).totalSeconds);
      const guestTiming = Number((((timingsData || {}).guest || {})[round] || {}).totalSeconds);
      const timingsReady = Number.isFinite(hostTiming) && Number.isFinite(guestTiming);
      if (revealText && timingsReady && hostTiming !== guestTiming) {
        const hostFaster = hostTiming < guestTiming;
        const winnerRole = hostFaster ? "host" : "guest";
        const isWinner = myRole === winnerRole;
        let displayText = revealText;
        if (!isWinner) {
          if (slowCoachRound !== round || !slowCoachLine) pickSlowCoachLine();
          displayText = slowCoachLine;
        }
        if (displayText) {
          revealBox.textContent = displayText;
          revealBox.classList.remove("award-reveal--hidden");
          return;
        }
      }
      revealBox.textContent = "";
      revealBox.classList.add("award-reveal--hidden");
    };

    const resetSlowCoachLine = () => {
      slowCoachRound = null;
      slowCoachLine = "";
    };

    const rdSnap = await getDoc(rdRef);
    const rd = rdSnap.data() || {};
    reviewData.hostItems = Array.isArray(rd.hostItems) ? rd.hostItems : [];
    reviewData.guestItems = Array.isArray(rd.guestItems) ? rd.guestItems : [];

    const answersHost0 = (((roomData0.answers || {}).host || {})[round] || []);
    const answersGuest0 = (((roomData0.answers || {}).guest || {})[round] || []);
    reviewData.hostAnswers = Array.isArray(answersHost0) ? answersHost0 : [];
    reviewData.guestAnswers = Array.isArray(answersGuest0) ? answersGuest0 : [];

    const countCorrect = (answers = [], items = []) => {
      let total = 0;
      for (let i = 0; i < answers.length; i += 1) {
        const answer = answers[i] || {};
        const chosen = answer.chosen;
        if (!chosen) continue;
        const correct = resolveCorrectAnswer(answer, items[i] || {});
        if (correct && same(chosen, correct)) total += 1;
      }
      return total;
    };

    const updateRoundScores = () => {
      const hostScore = countCorrect(reviewData.hostAnswers, reviewData.hostItems);
      const guestScore = countCorrect(reviewData.guestAnswers, reviewData.guestItems);
      scoreHeading.textContent = `Daniel ${hostScore} — ${guestScore} Jaime`;
    };

    const refreshReviews = () => {
      reviewWrap.innerHTML = "";
      const myItems = myRole === "host" ? reviewData.hostItems : reviewData.guestItems;
      const myAnswers = myRole === "host" ? reviewData.hostAnswers : reviewData.guestAnswers;
      const oppItems = myRole === "host" ? reviewData.guestItems : reviewData.hostItems;
      const oppAnswers = myRole === "host" ? reviewData.guestAnswers : reviewData.hostAnswers;

      reviewWrap.appendChild(renderQuestionSection({
        heading: "YOUR QUESTIONS",
        items: myItems,
        answers: myAnswers,
        round,
      }));
      reviewWrap.appendChild(renderQuestionSection({
        heading: `${oppName.toUpperCase()}'S QUESTIONS`,
        items: oppItems,
        answers: oppAnswers,
        round,
      }));
      updateRoundScores();
    };

    const refreshSummary = () => {
      updateRoundScores();
      updateTimes();
      updateReveal();
    };

    refreshReviews();
    refreshSummary();

    let ackMine = Boolean(((roomData0.awardAck || {})[myRole] || {})[round]);
    let ackOpp = Boolean(((roomData0.awardAck || {})[oppRole] || {})[round]);
    let advancing = false;

    const updateAckUI = () => {
      if (ackMine) {
        continueBtn.disabled = true;
        continueBtn.classList.remove("throb");
        continueBtn.textContent = waitingLabel;
      } else {
        continueBtn.disabled = false;
        continueBtn.classList.add("throb");
        continueBtn.textContent = readyLabel;
      }
    };

    updateAckUI();

    const advanceRound = async () => {
      if (advancing) return;
      advancing = true;
      try {
        await runTransaction(db, async (tx) => {
          const snap = await tx.get(rRef);
          if (!snap.exists()) return;
          const data = snap.data() || {};
          if ((data.state || "").toLowerCase() !== "award") return;
          const ackData = data.awardAck || {};
          const hostAck = Boolean((ackData.host || {})[round]);
          const guestAck = Boolean((ackData.guest || {})[round]);
          if (!(hostAck && guestAck)) return;

          const currentRound = Number(data.round) || round;
          if (currentRound >= 5) {
            console.log(`[flow] award -> final | code=${code} round=${currentRound}`);
            tx.update(rRef, {
              state: "final",
              "countdown.startAt": null,
              "timestamps.updatedAt": serverTimestamp(),
            });
          } else {
            const nextRound = currentRound + 1;
            const nextStart = Date.now() + CONTINUE_LEAD_MS;
            console.log(`[flow] award -> countdown | code=${code} round=${currentRound} next=${nextRound}`);
            tx.update(rRef, {
              state: "countdown",
              round: nextRound,
              "countdown.startAt": nextStart,
              "timestamps.updatedAt": serverTimestamp(),
            });
          }
        });
      } catch (err) {
        console.warn("[award] failed to advance:", err);
      } finally {
        advancing = false;
      }
    };

    continueBtn.addEventListener("click", async () => {
      if (ackMine) return;
      ackMine = true;
      updateAckUI();
      try {
        await updateDoc(rRef, {
          [`awardAck.${myRole}.${round}`]: true,
          "timestamps.updatedAt": serverTimestamp(),
        });
      } catch (err) {
        console.warn("[award] failed to acknowledge:", err);
        ackMine = false;
        updateAckUI();
      }
    });

    const stopRoundDoc = onSnapshot(rdRef, (snap) => {
      const data = snap.data() || {};
      reviewData.hostItems = Array.isArray(data.hostItems) ? data.hostItems : reviewData.hostItems;
      reviewData.guestItems = Array.isArray(data.guestItems) ? data.guestItems : reviewData.guestItems;
      refreshReviews();
      refreshSummary();
    }, (err) => {
      console.warn("[award] round watch error:", err);
    });

    const stop = onSnapshot(rRef, (snap) => {
      const data = snap.data() || {};

      if (data.reveals && typeof data.reveals === "object") {
        revealMap = data.reveals;
      }
      if (data.maths && Array.isArray(data.maths.reveals)) {
        mathsReveals = data.maths.reveals;
      }
      if (data.timings && typeof data.timings === "object") {
        timingsData = data.timings;
      }

      const stateName = String(data.state || "").toLowerCase();
      const dataRound = Number(data.round);
      if (stateName === "award" && dataRound && dataRound !== round) {
        round = dataRound;
        resetSlowCoachLine();
        readyLabel = computeReadyLabel(round);
        if (!ackMine) {
          continueBtn.textContent = readyLabel;
        }
      }

      if (stateName === "award") {
        const answersHost = (((data.answers || {}).host || {})[round] || []);
        const answersGuest = (((data.answers || {}).guest || {})[round] || []);
        reviewData.hostAnswers = Array.isArray(answersHost) ? answersHost : [];
        reviewData.guestAnswers = Array.isArray(answersGuest) ? answersGuest : [];
        refreshReviews();
        refreshSummary();
      }

      const ackData = data.awardAck || {};
      ackMine = Boolean((ackData[myRole] || {})[round]);
      ackOpp = Boolean((ackData[oppRole] || {})[round]);
      updateAckUI();
      if (ackMine && ackOpp && myRole === "host") {
        advanceRound();
      }

      if (stateName === "countdown") {
        const nextRound = Number(data.round || round + 1);
        setTimeout(() => {
          location.hash = `#/countdown?code=${code}&round=${nextRound}`;
        }, 80);
        return;
      }

      if (stateName === "questions") {
        setTimeout(() => { location.hash = `#/questions?code=${code}&round=${data.round || round}`; }, 80);
        return;
      }

      if (stateName === "marking") {
        setTimeout(() => { location.hash = `#/marking?code=${code}&round=${round}`; }, 80);
        return;
      }

      if (stateName === "final") {
        setTimeout(() => { location.hash = `#/final?code=${code}`; }, 80);
      }
      if (stateName !== "award") {
        refreshSummary();
      }
    }, (err) => {
      console.warn("[award] snapshot error:", err);
    });

    this.unmount = () => {
      try { stop && stop(); } catch {}
      try { stopRoundDoc && stopRoundDoc(); } catch {}
    };
  },

  async unmount() { /* handled per-instance */ }
};
