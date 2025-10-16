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

const CONTINUE_LEAD_MS = 5_000;

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

    const status = el(
      "div",
      {
        class: wasCorrect
          ? "award-question__status award-question__status--right"
          : "award-question__status award-question__status--wrong"
      },
      wasCorrect ? "✓" : "✕"
    );

    row.appendChild(textCol);
    row.appendChild(status);
    block.appendChild(row);
  }

  return block;
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

    const card = el("div", { class: "card award-card" });
    const heading = el("div", { class: "mono award-title" }, "Daniel 0 — 0 Jaime");
    card.appendChild(heading);

    const fastestBox = el("div", { class: "award-box" });
    const fastestTitle = el("div", { class: "mono award-box__title" }, "FASTEST PLAYER");
    const fastestRows = el("div", { class: "award-fastest" });
    const fastestHost = el("div", { class: "award-fastest__row" }, "Daniel — s");
    const fastestGuest = el("div", { class: "award-fastest__row" }, "Jaime — s");
    fastestRows.appendChild(fastestHost);
    fastestRows.appendChild(fastestGuest);
    const fastestOutcome = el("div", { class: "mono award-fastest__outcome" }, "");
    fastestBox.appendChild(fastestTitle);
    fastestBox.appendChild(fastestRows);
    fastestBox.appendChild(fastestOutcome);
    card.appendChild(fastestBox);

    const reviewWrap = el("div", { class: "award-review" });
    card.appendChild(reviewWrap);

    const continueBtn = el("button", { class: "btn" }, "I'M READY");
    card.appendChild(continueBtn);

    root.appendChild(card);

    const mathsMount = el("div", { class: "jemima-maths-pinned" });
    root.appendChild(mathsMount);

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
    const computeReadyLabel = (r) => (r >= 5 ? "I'M READY FOR MATHS" : `I'M READY FOR ROUND #${r + 1}`);
    let readyLabel = computeReadyLabel(round);
    let waitingLabel = `WAITING FOR ${oppName.toUpperCase()}`;
    continueBtn.textContent = readyLabel;

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

      const hostText = Number.isFinite(hostMs) ? formatSeconds(hostMs) : "— s";
      const guestText = Number.isFinite(guestMs) ? formatSeconds(guestMs) : "— s";
      fastestHost.textContent = `Daniel ${hostText}`;
      fastestGuest.textContent = `Jaime ${guestText}`;

      fastestHost.classList.remove("award-fastest__row--lead");
      fastestGuest.classList.remove("award-fastest__row--lead");

      let outcomeText = `Awaiting Jemima's ${ordinal(round)} Snippet`;

      if (Number.isFinite(hostMs) && Number.isFinite(guestMs)) {
        if (Math.abs(hostMs - guestMs) <= 1) {
          outcomeText = `Dead heat for Jemima's ${ordinal(round)} Snippet`;
        } else if (hostMs < guestMs) {
          fastestHost.classList.add("award-fastest__row--lead");
          outcomeText = `Daniel wins Jemima's ${ordinal(round)} Snippet`;
        } else {
          fastestGuest.classList.add("award-fastest__row--lead");
          outcomeText = `Jaime wins Jemima's ${ordinal(round)} Snippet`;
        }
      }

      if (Boolean(roundData.snippetTie)) {
        fastestHost.classList.add("award-fastest__row--lead");
        fastestGuest.classList.add("award-fastest__row--lead");
        outcomeText = `Dead heat for Jemima's ${ordinal(round)} Snippet`;
      } else if (roundData.snippetWinnerUid) {
        const winnerUid = roundData.snippetWinnerUid;
        if (winnerUid === hostUid) {
          fastestHost.classList.add("award-fastest__row--lead");
          outcomeText = `Daniel wins Jemima's ${ordinal(round)} Snippet`;
        } else if (winnerUid === guestUid) {
          fastestGuest.classList.add("award-fastest__row--lead");
          outcomeText = `Jaime wins Jemima's ${ordinal(round)} Snippet`;
        }
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
      heading.textContent = `Daniel ${hostScore} — ${guestScore} Jaime`;
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
