// /src/views/Award.js
//
// Award phase — review both players' answers and confirm before next round.
// • Shows cumulative scores and six Q&As (host + guest) with correctness markers.
// • Both players must tap Continue; host then advances to countdown for the next round (or maths after R5).

import {
  initFirebase,
  ensureAuth,
  roomRef,
  roundSubColRef,
  doc,
  getDoc,
  onSnapshot,
  updateDoc,
  serverTimestamp,
  runTransaction
} from "../lib/firebase.js";

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

const roundTier = (r) => (r <= 1 ? "easy" : r === 2 ? "medium" : "hard");

function same(a, b) {
  return String(a || "").trim() === String(b || "").trim();
}

function buildOptions(item, round) {
  const tier = roundTier(round);
  const correct = item?.correct_answer || "";
  const distractors = item?.distractors || {};
  let wrong = distractors[tier] || distractors.medium || distractors.easy || distractors.hard || "";
  const options = [];
  if (correct) options.push(correct);
  if (wrong && !same(wrong, correct)) options.push(wrong);
  if (options.length < 2) {
    const alt = Object.values(distractors).find((d) => d && !same(d, correct) && !same(d, wrong));
    if (alt) options.push(alt);
  }
  while (options.length < 2) options.push("(missing option)");
  return options.slice(0, 2);
}

function renderPlayerBlock(label, items, answers, round) {
  const block = el("div", { class: "award-block" });
  block.appendChild(el("div", {
    class: "mono",
    style: "text-align:center;font-weight:700;margin-top:4px;margin-bottom:6px;font-size:18px;"
  }, label));

  for (let i = 0; i < 3; i += 1) {
    const item = items[i] || {};
    const answer = answers[i] || {};
    const question = item.question || answer.question || "(missing question)";
    const correct = answer.correct || item.correct_answer || "";
    const chosen = answer.chosen || "";
    const options = buildOptions(item, round);

    const row = el("div", { class: "mark-row" });
    row.appendChild(el("div", { class: "q mono" }, `${i + 1}. ${question}`));

    const list = el("div", {
      class: "a mono",
      style: "display:flex;flex-direction:column;gap:6px;"
    });

    options.forEach((opt) => {
      const isCorrect = same(opt, correct);
      const isChosen = same(opt, chosen);
      const line = el("div", {
        class: "mono",
        style: `display:flex;justify-content:space-between;gap:10px;${isCorrect ? "color:var(--ok);" : ""}`
      });
      line.appendChild(el("span", {}, opt || "(missing option)"));
      const indicator = isChosen ? (isCorrect ? "✓" : "✕") : "";
      const badge = el("span", {
        class: "mono",
        style: `font-weight:700;${isCorrect ? "color:var(--ok);" : indicator ? "color:var(--bad);" : ""}`
      }, indicator);
      line.appendChild(badge);
      list.appendChild(line);
    });

    row.appendChild(list);
    block.appendChild(row);
  }

  return block;
}

export default {
  async mount(container) {
    const { db } = await initFirebase();
    const me = await ensureAuth();

    const qs = getHashParams();
    const code = clampCode(qs.get("code") || "");
    let round = parseInt(qs.get("round") || "1", 10) || 1;

    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    container.innerHTML = "";
    const root = el("div", { class: "view view-award" });
    const title = el("h1", { class: "title" }, `Round ${round}`);
    root.appendChild(title);

    const card = el("div", { class: "card" });
    const tag = el("div", { class: "mono", style: "text-align:center;margin-bottom:8px;" }, `Room ${code}`);
    card.appendChild(tag);

    const scoreHeadline = el("div", {
      class: "mono",
      style: "text-align:center;font-weight:700;font-size:24px;margin-bottom:12px;"
    }, "Daniel 0 — 0 Jaime");
    card.appendChild(scoreHeadline);

    const snippetChip = el("div", {
      class: "mono",
      style: "text-align:center;margin-bottom:12px;padding:6px 16px;border-radius:999px;border:1px solid currentColor;display:inline-block;align-self:center;"
    }, "Snippet Winner: — (tie)");
    card.appendChild(snippetChip);

    const reviewWrap = el("div", { style: "display:flex;flex-direction:column;gap:16px;" });
    card.appendChild(reviewWrap);

    const waitMsg = el("div", {
      class: "mono small",
      style: "text-align:center;margin-top:14px;display:none;opacity:.8;"
    }, "Waiting for opponent…");

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

    const updateScoresDisplay = (scores = {}) => {
      const hostScore = Number((scores.host ?? 0)) || 0;
      const guestScore = Number((scores.guest ?? 0)) || 0;
      scoreHeadline.textContent = `Daniel ${hostScore} — ${guestScore} Jaime`;
    };

    const refreshReviews = () => {
      reviewWrap.innerHTML = "";
      reviewWrap.appendChild(renderPlayerBlock("Daniel", reviewData.hostItems, reviewData.hostAnswers, round));
      reviewWrap.appendChild(renderPlayerBlock("Jaime", reviewData.guestItems, reviewData.guestAnswers, round));
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
          waitMsg.textContent = "Waiting for opponent…";
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
      waitMsg.textContent = "Waiting for opponent…";
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

    const nameForUid = (uid) => {
      if (!uid) return "Snippet Winner: — (tie)";
      if (uid === hostUid) return "Snippet Winner: Daniel";
      if (uid === guestUid) return "Snippet Winner: Jaime";
      return "Snippet Winner: —";
    };

    const updateSnippetChip = (uid) => {
      snippetChip.textContent = nameForUid(uid);
    };

    updateSnippetChip(rd.snippetWinnerUid || null);

    const stopRoundDoc = onSnapshot(rdRef, (snap) => {
      const data = snap.data() || {};
      updateSnippetChip(data.snippetWinnerUid || null);
    }, (err) => {
      console.warn("[award] round snippet watch error:", err);
    });

    const stop = onSnapshot(rRef, (snap) => {
      const data = snap.data() || {};

      if (Number(data.round) && Number(data.round) !== round) {
        round = Number(data.round);
        title.textContent = `Round ${round}`;
      }

      updateScoresDisplay(((data.scores || {}).questions) || {});

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
