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

const roleLabels = { host: "Daniel", guest: "Jaime" };

const ordinal = (n) => {
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return "";
  const remTen = num % 10;
  const remHundred = num % 100;
  let suffix = "th";
  if (remHundred < 11 || remHundred > 13) {
    if (remTen === 1) suffix = "st";
    else if (remTen === 2) suffix = "nd";
    else if (remTen === 3) suffix = "rd";
  }
  return `${num}${suffix}`;
};

function renderPlayerBlock(label, items, answers, selectionLabel) {
  const block = el("div", { class: "award-block" });
  block.appendChild(el("div", {
    class: "mono",
    style: "text-align:center;font-weight:700;margin-top:4px;margin-bottom:6px;font-size:18px;text-transform:uppercase;letter-spacing:0.06em;"
  }, label));

  for (let i = 0; i < 3; i += 1) {
    const item = items[i] || {};
    const answer = answers[i] || {};
    const question = item.question || answer.question || "(missing question)";
    const correct = answer.correct || item.correct_answer || "";
    const chosen = answer.chosen || "";

    const row = el("div", { class: "mark-row" });
    row.appendChild(el("div", { class: "q mono" }, `${i + 1}. ${question}`));

    const list = el("div", {
      class: "a mono",
      style: "display:flex;flex-direction:column;gap:8px;margin-top:10px;"
    });

    const isCorrect = chosen && correct ? same(chosen, correct) : false;
    const choiceColor = chosen
      ? isCorrect
        ? "color:var(--ok);"
        : "color:var(--bad);"
      : "opacity:.7;";
    const choiceLine = el("div", {
      style: `display:flex;justify-content:space-between;gap:12px;align-items:center;font-weight:700;${choiceColor}`
    });
    choiceLine.appendChild(el("span", {}, `${selectionLabel}:`));
    choiceLine.appendChild(el("span", {
      style: "flex:1;text-align:right;"
    }, chosen || "(no answer)"));
    choiceLine.appendChild(el("span", {
      style: `margin-left:12px;font-weight:700;${chosen ? (isCorrect ? "color:var(--ok);" : "color:var(--bad);") : "opacity:.5;"}`
    }, chosen ? (isCorrect ? "✓" : "✕") : "—"));
    list.appendChild(choiceLine);

    const correctLine = el("div", {
      style: "display:flex;justify-content:space-between;gap:12px;align-items:center;font-weight:700;color:var(--ok);"
    });
    correctLine.appendChild(el("span", {}, "Correct answer:"));
    correctLine.appendChild(el("span", {
      style: "flex:1;text-align:right;color:var(--ok);"
    }, correct || "(missing correct answer)"));
    list.appendChild(correctLine);

    row.appendChild(list);
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
    let awardRoundIndex = round;

    const hostLabel = roleLabels.host;
    const guestLabel = roleLabels.guest;

    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    container.innerHTML = "";
    const root = el("div", { class: "view view-award" });

    const card = el("div", { class: "card" });

    const scoreHeadline = el("div", {
      class: "mono",
      style: "text-align:center;font-weight:700;font-size:24px;margin-bottom:12px;"
    }, `${hostLabel} 0 — 0 ${guestLabel}`);
    card.appendChild(scoreHeadline);

    const snippetSummary = el("div", { class: "snippet-summary" });
    const snippetHeading = el("div", { class: "mono snippet-winner" }, "FASTEST PLAYER");
    const snippetTimes = el("div", { class: "snippet-times" });
    const snippetTimeHost = el("div", { class: "mono snippet-time" }, `${hostLabel} — s`);
    const snippetTimeGuest = el("div", { class: "mono snippet-time" }, `${guestLabel} — s`);
    snippetTimes.appendChild(snippetTimeHost);
    snippetTimes.appendChild(snippetTimeGuest);
    const snippetResultLine = el("div", {
      class: "mono snippet-result"
    }, "Awaiting snippet result…");
    snippetSummary.appendChild(snippetHeading);
    snippetSummary.appendChild(snippetTimes);
    snippetSummary.appendChild(snippetResultLine);
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
    awardRoundIndex = Number(roomData0.round) || awardRoundIndex;
    const { hostUid, guestUid } = roomData0.meta || {};
    const storedRole = getStoredRole(code);
    const myRole = storedRole === "host" || storedRole === "guest"
      ? storedRole
      : hostUid === me.uid ? "host" : guestUid === me.uid ? "guest" : "guest";
    const oppRole = myRole === "host" ? "guest" : "host";
    const oppName = oppRole === "host" ? hostLabel : guestLabel;
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

    const applySnippetSummary = (roundData = {}) => {
      const timings = roundData.timings || {};
      const hostEntry = resolveTimingForRole(timings, "host", [hostUid]);
      const guestEntry = resolveTimingForRole(timings, "guest", [guestUid]);
      const hostTime = formatSeconds(Number(hostEntry?.info?.totalMs));
      const guestTime = formatSeconds(Number(guestEntry?.info?.totalMs));
      snippetTimeHost.textContent = `${hostLabel} ${hostTime}`;
      snippetTimeGuest.textContent = `${guestLabel} ${guestTime}`;

      const winnerUid = roundData.snippetWinnerUid || null;
      const tie = Boolean(roundData.snippetTie);
      const ord = ordinal(awardRoundIndex) || (awardRoundIndex ? String(awardRoundIndex) : "");
      const snippetLabel = ord ? `Jemima's ${ord} Snippet` : "Jemima's Snippet";
      let resultText = "Awaiting snippet result…";
      if (tie) {
        resultText = `Dead heat for ${snippetLabel}`;
      } else if (winnerUid === hostUid) {
        resultText = `${hostLabel} wins ${snippetLabel}`;
      } else if (winnerUid === guestUid) {
        resultText = `${guestLabel} wins ${snippetLabel}`;
      } else if (winnerUid) {
        resultText = `${snippetLabel} stays with Jemima`;
      }
      snippetResultLine.textContent = resultText;
    };

    applySnippetSummary(rd);

    const updateScoresDisplay = (scores = {}) => {
      const hostScore = Number((scores.host ?? 0)) || 0;
      const guestScore = Number((scores.guest ?? 0)) || 0;
      scoreHeadline.textContent = `${hostLabel} ${hostScore} — ${guestScore} ${guestLabel}`;
    };

    const refreshReviews = () => {
      reviewWrap.innerHTML = "";
      const myItems = myRole === "host" ? reviewData.hostItems : reviewData.guestItems;
      const myAnswers = myRole === "host" ? reviewData.hostAnswers : reviewData.guestAnswers;
      const oppItems = myRole === "host" ? reviewData.guestItems : reviewData.hostItems;
      const oppAnswers = myRole === "host" ? reviewData.guestAnswers : reviewData.hostAnswers;

      reviewWrap.appendChild(
        renderPlayerBlock("YOUR QUESTIONS", myItems, myAnswers, "You chose")
      );
      const oppTitle = `${oppName.toUpperCase()}'S QUESTIONS`;
      reviewWrap.appendChild(
        renderPlayerBlock(oppTitle, oppItems, oppAnswers, `${oppName} chose`)
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
      const data = snap.data() || {};
      applySnippetSummary(data);
    }, (err) => {
      console.warn("[award] round snippet watch error:", err);
    });

    const stop = onSnapshot(rRef, (snap) => {
      const data = snap.data() || {};
      const stateNow = String(data.state || "").toLowerCase();

      if (stateNow === "award") {
        const dataRound = Number(data.round);
        if (Number.isFinite(dataRound) && dataRound > 0) {
          if (dataRound !== round) {
            round = dataRound;
          }
          awardRoundIndex = dataRound;
        }
      }

      updateScoresDisplay(((data.scores || {}).questions) || {});

      if (stateNow === "award") {
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
