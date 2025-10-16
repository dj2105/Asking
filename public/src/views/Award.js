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

import * as MathsPaneMod from "../lib/MathsPane.js";
import { clampCode, getHashParams, getStoredRole } from "../lib/util.js";
const mountMathsPane =
  (typeof MathsPaneMod?.default === "function" ? MathsPaneMod.default :
   typeof MathsPaneMod?.mount === "function" ? MathsPaneMod.mount :
   typeof MathsPaneMod?.default?.mount === "function" ? MathsPaneMod.default.mount :
   null);

const CONTINUE_LEAD_MS = 7_000;

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

function ordinal(nRaw) {
  const n = Math.abs(Math.round(Number(nRaw) || 0));
  const v = n % 100;
  const suffix = v >= 11 && v <= 13
    ? "th"
    : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
  return `${n}${suffix}`;
}

function resolveCorrectAnswer(answer = {}, fallbackItem = {}) {
  if (answer.correct) return answer.correct;
  if (fallbackItem.correct_answer) return fallbackItem.correct_answer;
  return "";
}

function renderQuestionSection({ heading, items, answers, choiceLabel }) {
  const box = el("div", { class: "award-box award-box--questions" });
  box.appendChild(el("div", { class: "award-box__title" }, heading));

  for (let i = 0; i < 3; i += 1) {
    const item = items[i] || {};
    const answer = answers[i] || {};
    const question = item.question || answer.question || "(missing question)";
    const correctRaw = resolveCorrectAnswer(answer, item);
    const correct = correctRaw || "(missing option)";
    const chosen = answer.chosen || "";
    const wasAnswered = Boolean(chosen);
    const wasCorrect = wasAnswered && same(chosen, correct);

    const row = el("div", { class: "award-question-row" });
    const textCol = el("div", { class: "award-question-row__text" });
    textCol.appendChild(el("div", { class: "award-question-row__prompt" }, `${i + 1}. ${question}`));

    const correctLine = el("div", { class: "award-answer-line award-answer-line--correct" }, `Correct: ${correct}`);
    const chosenClass = wasCorrect
      ? "award-answer-line--right"
      : "award-answer-line--wrong";
    const chosenLabel = wasAnswered ? `${choiceLabel}: ${chosen}` : `${choiceLabel}: No answer`;
    const chosenLine = el("div", { class: `award-answer-line ${chosenClass}` }, chosenLabel);
    textCol.appendChild(correctLine);
    textCol.appendChild(chosenLine);

    const status = el(
      "div",
      { class: `award-question-row__status ${wasCorrect ? "status-right" : "status-wrong"}` },
      wasCorrect ? "✓" : "✕"
    );

    row.appendChild(textCol);
    row.appendChild(status);
    box.appendChild(row);
  }

  return box;
}

const roomRef = (code) => doc(db, "rooms", code);
const roundSubColRef = (code) => collection(roomRef(code), "rounds");

const resolveTimingForRole = (timings = {}, roleName, fallbacks = []) => {
  const want = String(roleName || "").toLowerCase();
  if (!want) return null;
  const entries = Object.entries(timings || {});
  for (const [uid, infoRaw] of entries) {
    const info = infoRaw || {};
    if (String(info.role || "").toLowerCase() === want) {
      return { uid, info };
    }
  }
  for (const candidate of fallbacks) {
    if (!candidate) continue;
    if (Object.prototype.hasOwnProperty.call(timings || {}, candidate)) {
      return { uid: candidate, info: (timings || {})[candidate] || {} };
    }
  }
  if (entries.length === 1) {
    const [uid, infoRaw] = entries[0];
    return { uid, info: infoRaw || {} };
  }
  return null;
};

const formatSeconds = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return "— s";
  const secs = ms / 1000;
  const precision = secs >= 10 ? 1 : 2;
  let text = secs.toFixed(precision);
  text = text.replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1");
  return `${text} s`;
};

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
    const stage = el("div", { class: "view-stage view-stage--center" });

    const card = el("div", { class: "card card--center award-card" });
    const scoreHeadline = el("h2", { class: "view-heading award-score" }, "Daniel 0 — 0 Jaime");
    card.appendChild(scoreHeadline);

    const boxesWrap = el("div", { class: "award-boxes" });

    const fastestBox = el("div", { class: "award-box" });
    const fastestTitle = el("div", { class: "award-box__title" }, "FASTEST PLAYER");
    const fastestList = el("div", { class: "fastest-list" });
    const fastestHost = el("div", { class: "fastest-entry" }, "Daniel — s");
    const fastestGuest = el("div", { class: "fastest-entry" }, "Jaime — s");
    fastestList.appendChild(fastestHost);
    fastestList.appendChild(fastestGuest);
    const fastestOutcome = el("div", { class: "fastest-outcome" }, "");
    fastestBox.appendChild(fastestTitle);
    fastestBox.appendChild(fastestList);
    fastestBox.appendChild(fastestOutcome);

    const reviewWrap = el("div", { class: "award-boxes__questions" });

    boxesWrap.appendChild(fastestBox);
    boxesWrap.appendChild(reviewWrap);

    const continueBtn = el("button", { class: "btn" }, "Continue");

    card.appendChild(boxesWrap);
    card.appendChild(continueBtn);

    const mathsMount = el("div", { class: "jemima-maths-pinned" });

    stage.appendChild(card);
    stage.appendChild(mathsMount);

    root.appendChild(stage);
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
    const readableName = myRole === "host" ? "Daniel" : "Jaime";
    const waitForOpp = `WAITING FOR ${oppName.toUpperCase()}`;
    const computeNextRoundText = (r) => (
      r >= 5 ? "I'M READY FOR THE MATHS ROUND" : `I'M READY FOR ROUND #${r + 1}`
    );
    let nextRoundText = computeNextRoundText(round);
    continueBtn.textContent = nextRoundText;

    let reviewData = {
      hostItems: [],
      guestItems: [],
      hostAnswers: [],
      guestAnswers: []
    };

    const rdSnap = await getDoc(rdRef);
    const rd = rdSnap.data() || {};
    reviewData.hostItems = Array.isArray(rd.hostItems) ? rd.hostItems : [];
    reviewData.guestItems = Array.isArray(rd.guestItems) ? rd.guestItems : [];

    const answersHost0 = (((roomData0.answers || {}).host || {})[round] || []);
    const answersGuest0 = (((roomData0.answers || {}).guest || {})[round] || []);
    reviewData.hostAnswers = Array.isArray(answersHost0) ? answersHost0 : [];
    reviewData.guestAnswers = Array.isArray(answersGuest0) ? answersGuest0 : [];

    const applySnippetSummary = (roundData = {}) => {
      const timings = roundData.timings || {};
      const hostEntry = resolveTimingForRole(timings, "host", [hostUid]);
      const guestEntry = resolveTimingForRole(timings, "guest", [guestUid]);
      const hostMs = Number(hostEntry?.info?.totalMs);
      const guestMs = Number(guestEntry?.info?.totalMs);

      const hostTime = formatSeconds(hostMs);
      const guestTime = formatSeconds(guestMs);
      fastestHost.textContent = `Daniel ${hostTime}`;
      fastestGuest.textContent = `Jaime ${guestTime}`;

      fastestHost.classList.remove("fastest-entry--lead");
      fastestGuest.classList.remove("fastest-entry--lead");

      let winnerUid = roundData.snippetWinnerUid || null;
      const tie = Boolean(roundData.snippetTie);

      if (!winnerUid && Number.isFinite(hostMs) && Number.isFinite(guestMs)) {
        if (Math.abs(hostMs - guestMs) <= 1) {
          winnerUid = null;
        } else if (hostMs < guestMs && hostEntry) {
          winnerUid = hostEntry.uid;
        } else if (guestMs < hostMs && guestEntry) {
          winnerUid = guestEntry.uid;
        }
      }

      if (!tie) {
        if (winnerUid && hostEntry && winnerUid === hostEntry.uid) {
          fastestHost.classList.add("fastest-entry--lead");
        } else if (winnerUid && guestEntry && winnerUid === guestEntry.uid) {
          fastestGuest.classList.add("fastest-entry--lead");
        }
      }

      let outcomeText = "";
      if (tie) {
        outcomeText = `Dead heat for Jemima's ${ordinal(round)} Snippet`;
      } else if (winnerUid && hostEntry && winnerUid === hostEntry.uid) {
        outcomeText = `Daniel wins Jemima's ${ordinal(round)} Snippet`;
      } else if (winnerUid && guestEntry && winnerUid === guestEntry.uid) {
        outcomeText = `Jaime wins Jemima's ${ordinal(round)} Snippet`;
      } else if (winnerUid === hostUid) {
        outcomeText = `Daniel wins Jemima's ${ordinal(round)} Snippet`;
      } else if (winnerUid === guestUid) {
        outcomeText = `Jaime wins Jemima's ${ordinal(round)} Snippet`;
      } else {
        outcomeText = `Awaiting Jemima's ${ordinal(round)} Snippet`;
      }

      fastestOutcome.textContent = outcomeText;
    };

    applySnippetSummary(rd);

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
      scoreHeadline.textContent = `Daniel ${hostScore} — ${guestScore} Jaime`;
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
        choiceLabel: "You chose",
      }));
      reviewWrap.appendChild(renderQuestionSection({
        heading: `${oppName.toUpperCase()}'S QUESTIONS`,
        items: oppItems,
        answers: oppAnswers,
        choiceLabel: `${oppName} chose`,
      }));
      updateRoundScores();
    };

    try {
      if (mountMathsPane && roomData0.maths) {
        mountMathsPane(mathsMount, { maths: roomData0.maths, round, mode: "inline", roomCode: code, userUid: me.uid });
      }
    } catch (err) {
      console.warn("[award] MathsPane mount failed:", err);
    }

    refreshReviews();

    let ackMine = Boolean(((roomData0.awardAck || {})[myRole] || {})[round]);
    let ackOpp = Boolean(((roomData0.awardAck || {})[oppRole] || {})[round]);
    let advancing = false;

    const updateAckUI = () => {
      if (ackMine) {
        continueBtn.disabled = true;
        continueBtn.classList.remove("throb");
        continueBtn.textContent = waitForOpp;
      } else {
        continueBtn.disabled = false;
        continueBtn.classList.add("throb");
        continueBtn.textContent = nextRoundText;
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
      applySnippetSummary(data);
      refreshReviews();
    }, (err) => {
      console.warn("[award] round snippet watch error:", err);
    });

    const stop = onSnapshot(rRef, (snap) => {
      const data = snap.data() || {};

      const stateName = String(data.state || "").toLowerCase();
      const dataRound = Number(data.round);
      if (stateName === "award" && dataRound && dataRound !== round) {
        round = dataRound;
        nextRoundText = computeNextRoundText(round);
        updateAckUI();
      }

      if (stateName === "award") {
        const answersHost = (((data.answers || {}).host || {})[round] || []);
        const answersGuest = (((data.answers || {}).guest || {})[round] || []);
        reviewData.hostAnswers = Array.isArray(answersHost) ? answersHost : [];
        reviewData.guestAnswers = Array.isArray(answersGuest) ? answersGuest : [];
        refreshReviews();
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
