// /src/views/Award.js
//
// Award phase — review both players' answers and confirm before next round.
// • Shows cumulative scores and six Q&As (host + guest) with correctness markers.
// • Both players must tap Continue; host then advances to countdown for the next round (or maths after R5).

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
import { ensureBotAwardAck } from "../lib/SinglePlayerBot.js";

const CONTINUE_LEAD_MS = 3_000;

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

function getRoundMapValue(map = {}, roundNumber) {
  if (!map || typeof map !== "object") return undefined;
  if (map[roundNumber] !== undefined) return map[roundNumber];
  const key = String(roundNumber);
  if (map[key] !== undefined) return map[key];
  return undefined;
}

function normaliseClueValue(value) {
  if (typeof value === "string") return value.trim();
  return "";
}

function normaliseRevealValue(value) {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
    if (prompt) return prompt;
    const text = typeof value.text === "string" ? value.text.trim() : "";
    if (text) return text;
    const val = typeof value.value === "string" ? value.value.trim() : "";
    if (val) return val;
  }
  return "";
}

function resolveRoundClue(roomData = {}, round = 1) {
  const roundNumber = Number(round) || 1;
  const direct = normaliseClueValue(
    getRoundMapValue(roomData.clues, roundNumber)
  );
  if (direct) return direct;
  const maths = roomData.maths || {};
  const arrIndex = roundNumber - 1;
  if (Array.isArray(maths.events) && arrIndex >= 0 && arrIndex < maths.events.length) {
    const viaEvent = normaliseClueValue(maths.events[arrIndex]?.prompt);
    if (viaEvent) return viaEvent;
  }
  if (Array.isArray(maths.clues) && arrIndex >= 0 && arrIndex < maths.clues.length) {
    const viaMaths = normaliseClueValue(maths.clues[arrIndex]);
    if (viaMaths) return viaMaths;
  }
  return "";
}

function resolveRoundReveal(roomData = {}, round = 1) {
  const roundNumber = Number(round) || 1;
  const direct = normaliseRevealValue(
    getRoundMapValue(roomData.reveals, roundNumber)
  );
  if (direct) return direct;
  const maths = roomData.maths || {};
  const arrIndex = roundNumber - 1;
  if (
    Array.isArray(maths.events) &&
    arrIndex >= 0 &&
    arrIndex < maths.events.length
  ) {
    const viaEvent = normaliseRevealValue(maths.events[arrIndex]?.prompt);
    if (viaEvent) return viaEvent;
  }
  if (
    Array.isArray(maths.reveals) &&
    arrIndex >= 0 &&
    arrIndex < maths.reveals.length
  ) {
    const viaMaths = normaliseRevealValue(maths.reveals[arrIndex]);
    if (viaMaths) return viaMaths;
  }
  return "";
}

function normaliseTimingEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const totalSeconds =
    typeof entry.totalSeconds === "number" ? entry.totalSeconds : null;
  if (totalSeconds !== null && !Number.isNaN(totalSeconds)) return totalSeconds;
  const totalMs = typeof entry.totalMs === "number" ? entry.totalMs : null;
  if (totalMs !== null && !Number.isNaN(totalMs)) return totalMs / 1000;
  const total = typeof entry.total === "number" ? entry.total : null;
  if (total !== null && !Number.isNaN(total)) return total;
  return null;
}

function determineFasterRole(roomData = {}, round = 1) {
  const roundNumber = Number(round) || 1;
  const timings = roomData.timings || {};
  const hostEntry = normaliseTimingEntry(
    getRoundMapValue((timings.host || {}), roundNumber)
  );
  const guestEntry = normaliseTimingEntry(
    getRoundMapValue((timings.guest || {}), roundNumber)
  );
  if (hostEntry === null || guestEntry === null) return null;
  const epsilon = 0.01;
  if (hostEntry + epsilon < guestEntry) return "host";
  if (guestEntry + epsilon < hostEntry) return "guest";
  return null;
}

function renderQuestionSection({ heading, items, answers, round, score, bonus = 0 }) {
  const block = el("div", { class: "award-box award-box--questions" });
  const header = el("div", { class: "award-box__header" });
  header.appendChild(el("div", { class: "mono award-box__title" }, heading));
  if (typeof score === "number" && !Number.isNaN(score)) {
    const badgeWrap = el("div", { class: "award-round-badges" });
    const scoreBadge = el("div", { class: "mono award-round-score" }, String(score));
    const hasBonus = Number(bonus) > 0;
    if (hasBonus) {
      badgeWrap.classList.add("award-round-badges--with-star");
      badgeWrap.appendChild(scoreBadge);
      badgeWrap.appendChild(
        el("div", { class: "award-speed-star" }, [
          el("div", { class: "award-speed-star__value" }, "+1"),
          el("div", { class: "award-speed-star__label" }, "fastest"),
        ])
      );
    } else {
      badgeWrap.appendChild(scoreBadge);
    }
    header.appendChild(badgeWrap);
  }
  block.appendChild(header);

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
    const baseRound = Number(round) || 1;
    const questionNumber = (Math.max(baseRound - 1, 0) * 3) + (i + 1);
    textCol.appendChild(
      el(
        "div",
        { class: "mono award-question__prompt" },
        `${questionNumber}. ${question}`
      )
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
    const cardTitle = el("div", { class: "mono award-card__heading" }, "SCORES");
    const scoreboard = el("div", { class: "award-scoreboard" });
    const hostScoreValue = el("div", { class: "mono award-scoreboard__value" }, "0");
    const hostScoreLabel = el("div", { class: "mono award-scoreboard__label" }, "DANIEL");
    const hostScore = el("div", { class: "award-scoreboard__player" });
    hostScore.appendChild(hostScoreValue);
    hostScore.appendChild(hostScoreLabel);

    const guestScoreValue = el("div", { class: "mono award-scoreboard__value" }, "0");
    const guestScoreLabel = el("div", { class: "mono award-scoreboard__label" }, "JAIME");
    const guestScore = el("div", { class: "award-scoreboard__player" });
    guestScore.appendChild(guestScoreValue);
    guestScore.appendChild(guestScoreLabel);

    scoreboard.appendChild(hostScore);
    scoreboard.appendChild(guestScore);

    const reviewWrap = el("div", { class: "award-review" });

    card.appendChild(cardTitle);
    card.appendChild(scoreboard);
    card.appendChild(reviewWrap);

    root.appendChild(card);

    const continueRow = el("div", { class: "award-continue-row" });
    const continueBtn = el(
      "button",
      { class: "btn award-continue-btn" },
      "ROUND 2"
    );
    continueRow.appendChild(continueBtn);

    root.appendChild(continueRow);

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
    const computeReadyLabel = (r) => {
      const base = Number(r) || 1;
      const nextRound = Math.min(base + 1, 5);
      return `ROUND ${nextRound}`;
    };
    let readyLabel = computeReadyLabel(round);
    let waitingLabel = `WAITING FOR ${oppName.toUpperCase()}`;
    continueBtn.textContent = readyLabel;

    let reviewData = {
      hostItems: [],
      guestItems: [],
      hostAnswers: [],
      guestAnswers: []
    };
    let roundScores = { host: 0, guest: 0 };

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

    let latestRoomData = roomData0;

    const recomputeRoundScores = () => {
      roundScores.host = countCorrect(reviewData.hostAnswers, reviewData.hostItems);
      roundScores.guest = countCorrect(reviewData.guestAnswers, reviewData.guestItems);
    };

    const updateScoreboardTotals = () => {
      const data = latestRoomData || {};
      const hostMap = (data.scores || {}).host || {};
      const guestMap = (data.scores || {}).guest || {};
      const bonusHostMap = ((data.speedBonuses || {}).host) || {};
      const bonusGuestMap = ((data.speedBonuses || {}).guest) || {};
      const limit = Math.min(Math.max(Number(round) || 1, 1), 5);
      const getValue = (map, index, fallback) => {
        const direct = getRoundMapValue(map, index);
        if (typeof direct === "number" && !Number.isNaN(direct)) return direct;
        if (index === limit && typeof fallback === "number" && !Number.isNaN(fallback)) {
          return fallback;
        }
        return 0;
      };
      let hostTotal = 0;
      let guestTotal = 0;
      for (let i = 1; i <= limit; i += 1) {
        hostTotal += getValue(hostMap, i, roundScores.host) + Number(getValue(bonusHostMap, i, 0));
        guestTotal += getValue(guestMap, i, roundScores.guest) + Number(getValue(bonusGuestMap, i, 0));
      }
      hostScoreValue.textContent = String(hostTotal);
      guestScoreValue.textContent = String(guestTotal);
    };

    const refreshReviews = () => {
      reviewWrap.innerHTML = "";
      const myItems = myRole === "host" ? reviewData.hostItems : reviewData.guestItems;
      const myAnswers = myRole === "host" ? reviewData.hostAnswers : reviewData.guestAnswers;
      const oppItems = myRole === "host" ? reviewData.guestItems : reviewData.hostItems;
      const oppAnswers = myRole === "host" ? reviewData.guestAnswers : reviewData.hostAnswers;

      recomputeRoundScores();
      const myScore = myRole === "host" ? roundScores.host : roundScores.guest;
      const oppScore = myRole === "host" ? roundScores.guest : roundScores.host;
      const bonusMap = latestRoomData.speedBonuses || {};
      const myBonus = Number(getRoundMapValue((bonusMap[myRole] || {}), round) || 0);
      const oppBonus = Number(getRoundMapValue((bonusMap[oppRole] || {}), round) || 0);

      reviewWrap.appendChild(renderQuestionSection({
        heading: "YOUR QUESTIONS",
        items: myItems,
        answers: myAnswers,
        round,
        score: myScore + myBonus,
        bonus: myBonus,
      }));
      reviewWrap.appendChild(renderQuestionSection({
        heading: `${oppName.toUpperCase()}’S QUESTIONS`,
        items: oppItems,
        answers: oppAnswers,
        round,
        score: oppScore + oppBonus,
        bonus: oppBonus,
      }));
      updateScoreboardTotals();
    };

    const refreshSummary = () => {
      recomputeRoundScores();
      updateScoreboardTotals();
    };

    refreshReviews();
    refreshSummary();

    let ackMine = Boolean(((roomData0.awardAck || {})[myRole] || {})[round]);
    let ackOpp = Boolean(((roomData0.awardAck || {})[oppRole] || {})[round]);
    if (myRole === "host") {
      const botAcked = await ensureBotAwardAck({ code, round, roomData: roomData0 });
      if (botAcked) ackOpp = true;
    }
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
            console.log(`[flow] award -> maths | code=${code} round=${currentRound}`);
            tx.update(rRef, {
              state: "maths",
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
      latestRoomData = data;
      if (data.maths && typeof data.maths === "object") {
      }

      const stateName = String(data.state || "").toLowerCase();
      const dataRound = Number(data.round);
      if (stateName === "award" && dataRound && dataRound !== round) {
        round = dataRound;
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

      if (stateName === "maths") {
        setTimeout(() => { location.hash = `#/maths?code=${code}`; }, 80);
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
