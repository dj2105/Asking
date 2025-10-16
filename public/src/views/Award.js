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

function createAnswerLine(label, value, { variant = "", indicator = "" } = {}) {
  const classes = ["award-answer-line", "mono"];
  if (variant) classes.push(`award-answer-line--${variant}`);
  const line = el("div", { class: classes.join(" ") });
  line.appendChild(el("div", { class: "award-answer-label" }, label));
  const safeValue = value === null || value === undefined || value === ""
    ? "—"
    : String(value);
  line.appendChild(el("div", { class: "award-answer-value" }, safeValue));
  line.appendChild(el("div", { class: "award-answer-indicator" }, indicator ? String(indicator) : ""));
  return line;
}

function renderQuestionReview({ title, items = [], answers = [], pickLabel }) {
  const block = el("div", { class: "award-block" });
  block.appendChild(el("div", { class: "award-block__title mono" }, title));

  for (let i = 0; i < 3; i += 1) {
    const item = items[i] || {};
    const answer = answers[i] || {};
    const question = item.question || answer.question || "(missing question)";
    const correctRaw = answer.correct || item.correct_answer || "";
    const chosenRaw = answer.chosen || "";
    const correct = correctRaw || "(missing correct answer)";
    const chosen = chosenRaw || "(no answer)";
    const isCorrect = chosenRaw && same(chosenRaw, correctRaw);

    const row = el("div", { class: "mark-row" });
    row.appendChild(el("div", { class: "q mono" }, `${i + 1}. ${question}`));

    const detail = el("div", { class: "award-answer" });
    detail.appendChild(createAnswerLine("Correct answer", correct, { variant: "correct" }));
    detail.appendChild(
      createAnswerLine(pickLabel, chosen, {
        variant: chosenRaw ? (isCorrect ? "right" : "wrong") : "none",
        indicator: chosenRaw ? (isCorrect ? "✓" : "✕") : ""
      })
    );

    row.appendChild(detail);
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

const ordinalSuffix = (n) => {
  const num = Number(n);
  if (!Number.isFinite(num)) return `${n}th`;
  const abs = Math.abs(num);
  const mod100 = abs % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${num}th`;
  const mod10 = abs % 10;
  if (mod10 === 1) return `${num}st`;
  if (mod10 === 2) return `${num}nd`;
  if (mod10 === 3) return `${num}rd`;
  return `${num}th`;
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

    const card = el("div", { class: "card" });

    const scoreHeadline = el("div", {
      class: "mono",
      style: "text-align:center;font-weight:700;font-size:24px;margin-bottom:12px;"
    }, "Daniel 0 — 0 Jaime");
    card.appendChild(scoreHeadline);

    const snippetSummary = el("div", { class: "snippet-summary" });
    const snippetHeading = el("div", { class: "mono snippet-winner" }, "FASTEST PLAYER");
    const snippetWinnerLine = el("div", { class: "mono snippet-winner-name" }, "—");
    const snippetTimes = el("div", { class: "snippet-times" });
    const snippetTimeHost = el("div", { class: "mono snippet-time" }, "Daniel — s");
    const snippetTimeGuest = el("div", { class: "mono snippet-time" }, "Jaime — s");
    snippetTimes.appendChild(snippetTimeHost);
    snippetTimes.appendChild(snippetTimeGuest);
    const snippetOutcome = el("div", { class: "mono snippet-outcome" }, `Jemima’s ${ordinalSuffix(round)} Snippet is on the line…`);
    snippetSummary.appendChild(snippetHeading);
    snippetSummary.appendChild(snippetWinnerLine);
    snippetSummary.appendChild(snippetTimes);
    snippetSummary.appendChild(snippetOutcome);
    card.appendChild(snippetSummary);

    const reviewWrap = el("div", { style: "display:flex;flex-direction:column;gap:16px;" });
    card.appendChild(reviewWrap);

    const waitMsg = el("div", {
      class: "mono small",
      style: "text-align:center;margin-top:14px;display:none;opacity:.8;"
    }, "");

    const continueBtn = el("button", { class: "btn primary", style: "margin-top:12px;" }, "Continue");
    card.appendChild(continueBtn);
    card.appendChild(waitMsg);

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
    const waitForOpp = `Waiting for ${oppName}…`;
    waitMsg.textContent = waitForOpp;

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

    let snippetData = rd;

    const applySnippetSummary = (roundData = {}, roundNumber = round) => {
      const activeRound = Number(roundNumber) || Number(round) || 1;
      const ordinalText = ordinalSuffix(activeRound);
      const winnerUid = roundData.snippetWinnerUid || null;
      const tie = Boolean(roundData.snippetTie);

      const timings = roundData.timings || {};
      const hostEntry = resolveTimingForRole(timings, "host", [hostUid]);
      const guestEntry = resolveTimingForRole(timings, "guest", [guestUid]);
      const hostTime = formatSeconds(Number(hostEntry?.info?.totalMs));
      const guestTime = formatSeconds(Number(guestEntry?.info?.totalMs));

      const hostCandidates = [hostUid, hostEntry?.uid].filter(Boolean);
      const guestCandidates = [guestUid, guestEntry?.uid].filter(Boolean);

      let fastestLabel = "—";
      let outcomeText = `Jemima’s ${ordinalText} Snippet is on the line…`;

      if (tie) {
        fastestLabel = "Dead heat";
        outcomeText = `Dead heat — Jemima keeps her ${ordinalText} Snippet`;
      } else if (winnerUid && hostCandidates.includes(winnerUid)) {
        fastestLabel = "Daniel";
        outcomeText = `Daniel wins Jemima’s ${ordinalText} Snippet`;
      } else if (winnerUid && guestCandidates.includes(winnerUid)) {
        fastestLabel = "Jaime";
        outcomeText = `Jaime wins Jemima’s ${ordinalText} Snippet`;
      }

      snippetWinnerLine.textContent = fastestLabel;
      snippetOutcome.textContent = outcomeText;

      snippetTimeHost.textContent = `Daniel ${hostTime}`;
      snippetTimeGuest.textContent = `Jaime ${guestTime}`;
    };

    applySnippetSummary(snippetData, round);

    const updateScoresDisplay = (scores = {}) => {
      const hostScore = Number((scores.host ?? 0)) || 0;
      const guestScore = Number((scores.guest ?? 0)) || 0;
      scoreHeadline.textContent = `Daniel ${hostScore} — ${guestScore} Jaime`;
    };

    const refreshReviews = () => {
      reviewWrap.innerHTML = "";
      const myItems = myRole === "host" ? reviewData.hostItems : reviewData.guestItems;
      const myAnswers = myRole === "host" ? reviewData.hostAnswers : reviewData.guestAnswers;
      const oppItems = myRole === "host" ? reviewData.guestItems : reviewData.hostItems;
      const oppAnswers = myRole === "host" ? reviewData.guestAnswers : reviewData.hostAnswers;

      reviewWrap.appendChild(
        renderQuestionReview({
          title: "YOUR QUESTIONS",
          items: myItems,
          answers: myAnswers,
          pickLabel: "You picked"
        })
      );

      const oppTitle = `${oppName.toUpperCase()}\u2019S QUESTIONS`;
      reviewWrap.appendChild(
        renderQuestionReview({
          title: oppTitle,
          items: oppItems,
          answers: oppAnswers,
          pickLabel: `${oppName} picked`
        })
      );
    };

    try {
      if (mountMathsPane && roomData0.maths) {
        mountMathsPane(mathsMount, { maths: roomData0.maths, round, mode: "inline", roomCode: code, userUid: me.uid });
      }
    } catch (err) {
      console.warn("[award] MathsPane mount failed:", err);
    }

    updateScoresDisplay(((roomData0.scores || {}).questions) || {});
    refreshReviews();

    let ackMine = Boolean(((roomData0.awardAck || {})[myRole] || {})[round]);
    let ackOpp = Boolean(((roomData0.awardAck || {})[oppRole] || {})[round]);
    let advancing = false;

    const updateAckUI = () => {
      if (ackMine) {
        continueBtn.disabled = "";
        continueBtn.classList.remove("throb");
        continueBtn.textContent = "Waiting…";
        if (ackOpp) {
          waitMsg.style.display = "none";
        } else {
          waitMsg.textContent = waitForOpp;
          waitMsg.style.display = "";
        }
      } else {
        continueBtn.disabled = null;
        continueBtn.classList.add("throb");
        continueBtn.textContent = "Continue";
        waitMsg.style.display = "none";
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
      waitMsg.textContent = waitForOpp;
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
      snippetData = snap.data() || {};
      applySnippetSummary(snippetData, round);
    }, (err) => {
      console.warn("[award] round snippet watch error:", err);
    });

    const stop = onSnapshot(rRef, (snap) => {
      const data = snap.data() || {};

      if (Number(data.round) && Number(data.round) !== round) {
        round = Number(data.round);
      }

      updateScoresDisplay(((data.scores || {}).questions) || {});

      applySnippetSummary(snippetData, round);

      if ((data.state || "").toLowerCase() === "award") {
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

      if (data.state === "countdown") {
        const nextRound = Number(data.round || round + 1);
        setTimeout(() => {
          location.hash = `#/countdown?code=${code}&round=${nextRound}`;
        }, 80);
        return;
      }

      if (data.state === "questions") {
        setTimeout(() => { location.hash = `#/questions?code=${code}&round=${data.round || round}`; }, 80);
        return;
      }

      if (data.state === "marking") {
        setTimeout(() => { location.hash = `#/marking?code=${code}&round=${round}`; }, 80);
        return;
      }

      if (data.state === "maths") {
        setTimeout(() => { location.hash = `#/maths?code=${code}`; }, 80);
        return;
      }

      if (data.state === "final") {
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
