// /src/views/Marking.js
//
// Marking phase — judge opponent answers, record timings, and await the snippet verdict.
// • Shows exactly three rows (opponent questions + their chosen answers).
// • Verdict buttons: ✓ (definitely right) / ✕ (absolutely wrong). No "unknown" option.
// • Submission writes marking.{role}.{round}, markingAck.{role}.{round} = true, and timing metadata for snippet race.
// • Host waits for both totals, computes the snippet winner, mirrors retained flags, and advances to award.

import { ensureAuth, db } from "../lib/firebase.js";
import {
  doc,
  collection,
  getDoc,
  onSnapshot,
  setDoc,
  updateDoc,
  serverTimestamp,
  runTransaction,
} from "firebase/firestore";

import * as MathsPaneMod from "../lib/MathsPane.js";
import { clampCode, getHashParams, getStoredRole, SNIPPET_TIE_TOKEN } from "../lib/util.js";
const mountMathsPane =
  (typeof MathsPaneMod?.default === "function" ? MathsPaneMod.default :
   typeof MathsPaneMod?.mount === "function" ? MathsPaneMod.mount :
   typeof MathsPaneMod?.default?.mount === "function" ? MathsPaneMod.default.mount :
   null);

const VERDICT = { RIGHT: "right", WRONG: "wrong" };

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

const roomRef = (code) => doc(db, "rooms", code);
const roundSubColRef = (code) => collection(roomRef(code), "rounds");

const STOP_DELAY_MS = 5_000;
const COUNTDOWN_ARM_MS = 3_000;
const TIE_EPSILON_MS = 2;

export default {
  async mount(container) {
    const me = await ensureAuth();

    const params = getHashParams();
    const code = clampCode(params.get("code") || "");
    const round = parseInt(params.get("round") || "1", 10) || 1;

    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    container.innerHTML = "";
    const root = el("div", { class: "view view-marking" });
    root.appendChild(el("h1", { class: "title" }, `Round ${round}`));

    const card = el("div", { class: "card" });
    const tag = el("div", { class: "mono", style: "text-align:center;margin-bottom:8px;" }, `Room ${code}`);
    card.appendChild(tag);

    const list = el("div", { class: "qa-list" });
    card.appendChild(list);

    const stopRow = el("div", {
      style: "display:flex;align-items:center;justify-content:center;gap:14px;margin-top:16px;"
    });
    const stopBtn = el("button", {
      class: "btn primary",
      style: "min-width:120px;font-weight:700;",
      disabled: ""
    }, "STOP");
    const liveTimer = el("div", {
      class: "mono",
      style: "font-size:26px;font-weight:700;min-width:120px;text-align:center;"
    }, "0.000");
    stopRow.appendChild(stopBtn);
    stopRow.appendChild(liveTimer);
    card.appendChild(stopRow);

    const resultWrap = el("div", {
      style: "text-align:center;margin-top:24px;display:none;"
    });
    const frozenTimer = el("div", {
      class: "mono",
      style: "font-size:52px;font-weight:700;line-height:1;"
    }, "0.000");
    const messageBox = el("div", {
      style: "margin-top:16px;text-align:center;font-family:Courier,monospace;font-weight:700;"
    }, "");
    resultWrap.appendChild(frozenTimer);
    resultWrap.appendChild(messageBox);
    card.appendChild(resultWrap);

    root.appendChild(card);

    const mathsMount = el("div", { class: "jemima-maths-pinned" });
    root.appendChild(mathsMount);

    container.appendChild(root);

    const rRef = roomRef(code);
    const rdRef = doc(roundSubColRef(code), String(round));
    const playerRef = doc(rRef, "players", myUid);

    const roomSnap = await getDoc(rRef);
    const roomData0 = roomSnap.data() || {};
    const { hostUid, guestUid } = roomData0.meta || {};
    const storedRole = getStoredRole(code);
    const myRole = storedRole === "host" || storedRole === "guest"
      ? storedRole
      : hostUid === me.uid ? "host" : guestUid === me.uid ? "guest" : "guest";
    const oppRole = myRole === "host" ? "guest" : "host";
    const myUid = me.uid;
    const oppUid = oppRole === "host" ? hostUid : guestUid;

    let roundStartAt = Number((roomData0.countdown || {}).startAt || 0) || 0;
    const markingEnterAt = Date.now();
    let published = false;
    let submitting = false;
    let stopRoomWatch = null;
    let stopRoundWatch = null;
    let snippetResolved = false;
    let finalizeInFlight = false;
    let latestTotalForMe = null;
    let latestRoundTimings = {};
    let timerInterval = null;
    let timerFrozen = false;
    let displayedMs = 0;
    let messageMode = "idle";
    let currentWinnerToken = null;
    let scheduledAdvance = false;
    let advanceTimeout = null;

    const formatSeconds = (ms) => {
      const value = Number(ms);
      if (!Number.isFinite(value) || value <= 0) return "0.000";
      return (value / 1000).toFixed(3);
    };

    const computeElapsed = () => {
      const base = Number(roundStartAt) || 0;
      const ref = base > 0 ? base : markingEnterAt;
      return Math.max(0, Date.now() - ref);
    };

    const refreshLiveTimer = () => {
      if (timerFrozen) return;
      const elapsed = computeElapsed();
      displayedMs = elapsed;
      liveTimer.textContent = formatSeconds(elapsed);
    };

    const startLiveTimer = () => {
      if (timerInterval) clearInterval(timerInterval);
      timerFrozen = false;
      refreshLiveTimer();
      timerInterval = setInterval(refreshLiveTimer, 60);
    };

    const freezeTimerDisplay = (ms) => {
      const value = Number.isFinite(ms) && ms >= 0 ? ms : displayedMs;
      timerFrozen = true;
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
      const pretty = formatSeconds(value);
      liveTimer.textContent = pretty;
      frozenTimer.textContent = pretty;
      displayedMs = value;
    };

    const resetMessageStyles = () => {
      messageBox.style.fontFamily = "Courier, monospace";
      messageBox.style.fontWeight = "700";
      messageBox.style.fontSize = "16px";
      messageBox.style.color = "rgba(0,0,0,0.7)";
      messageBox.style.display = "block";
      messageBox.style.textTransform = "none";
      messageBox.style.lineHeight = "1.4";
      messageBox.style.letterSpacing = "normal";
      messageBox.style.flexDirection = "";
      messageBox.style.alignItems = "";
      messageBox.style.justifyContent = "";
      messageBox.style.gap = "";
    };

    const showWaitingMessage = (text = "Connecting…") => {
      if (messageMode === `waiting:${text}`) return;
      resetMessageStyles();
      messageBox.textContent = text;
      messageMode = `waiting:${text}`;
    };

    const showWinnerMessage = () => {
      if (messageMode === "winner") return;
      messageMode = "winner";
      messageBox.innerHTML = "";
      messageBox.style.fontFamily = "Impact, Haettenschweiler, 'Arial Black', sans-serif";
      messageBox.style.fontWeight = "700";
      messageBox.style.fontSize = "36px";
      messageBox.style.color = "#b7f7c2";
      messageBox.style.display = "flex";
      messageBox.style.flexDirection = "column";
      messageBox.style.alignItems = "center";
      messageBox.style.justifyContent = "center";
      messageBox.style.gap = "6px";
      ["YOU\u2019RE", "A", "WINNER!"].forEach((word) => {
        const line = document.createElement("div");
        line.textContent = word;
        messageBox.appendChild(line);
      });
    };

    const showTieMessage = () => {
      showWinnerMessage();
    };

    const showLoserMessage = (totalMs) => {
      if (messageMode === "loser") return;
      resetMessageStyles();
      messageBox.textContent = `ROUND COMPLETED IN ${formatSeconds(totalMs)} SECONDS`;
      messageBox.style.fontSize = "18px";
      messageBox.style.color = "rgba(0,0,0,0.75)";
      messageMode = "loser";
    };

    const enterPostStop = (totalMs) => {
      const value = Number.isFinite(totalMs) ? totalMs : displayedMs;
      freezeTimerDisplay(value);
      stopBtn.disabled = true;
      stopBtn.classList.remove("throb");
      stopRow.style.display = "none";
      list.style.display = "none";
      resultWrap.style.display = "block";
      showWaitingMessage();
    };

    const updateOutcome = () => {
      if (!published) return;
      const myTiming = latestTotalForMe ?? Number((latestRoundTimings[myUid] || {}).totalMs);
      const myTotal = Number(myTiming);
      if (!Number.isFinite(myTotal)) return;

      const oppTiming = oppUid ? latestRoundTimings[oppUid] || {} : {};
      const oppTotal = Number(oppTiming.totalMs);

      if (currentWinnerToken === SNIPPET_TIE_TOKEN) {
        showTieMessage();
        return;
      }
      if (currentWinnerToken === myUid) {
        showWinnerMessage();
        return;
      }
      if (currentWinnerToken && oppUid && currentWinnerToken === oppUid) {
        showLoserMessage(myTotal);
        return;
      }

      if (Number.isFinite(oppTotal)) {
        if (Math.abs(myTotal - oppTotal) <= TIE_EPSILON_MS) {
          showTieMessage();
        } else if (myTotal < oppTotal) {
          showWinnerMessage();
        } else {
          showLoserMessage(myTotal);
        }
        return;
      }

      showWinnerMessage();
    };

    try {
      if (mountMathsPane && roomData0.maths) {
        mountMathsPane(mathsMount, { maths: roomData0.maths, round, mode: "inline", roomCode: code, userUid: myUid });
      }
    } catch (err) {
      console.warn("[marking] MathsPane mount failed:", err);
    }

    const rdSnap = await getDoc(rdRef);
    const rd = rdSnap.data() || {};
    latestRoundTimings = rd.timings || {};
    const oppItems = (oppRole === "host" ? rd.hostItems : rd.guestItems) || [];
    const oppAnswers = (((roomData0.answers || {})[oppRole] || {})[round] || []).map((a) => a?.chosen || "");

    let marks = [null, null, null];
    const disableFns = [];

    const updateDoneState = () => {
      if (published) {
        stopBtn.disabled = true;
        stopBtn.classList.remove("throb");
        return;
      }
      const ready = marks.every((v) => v === VERDICT.RIGHT || v === VERDICT.WRONG);
      stopBtn.disabled = !(ready && !submitting);
      stopBtn.classList.toggle("throb", ready && !submitting);
    };

    const buildRow = (idx, question, chosen) => {
      const row = el("div", { class: "mark-row" });
      row.appendChild(el("div", { class: "q mono" }, `${idx + 1}. ${question || "(missing question)"}`));
      row.appendChild(el("div", { class: "a mono" }, chosen || "(no answer recorded)"));

      const pair = el("div", { class: "verdict-row" });
      const btnRight = el("button", { class: "btn outline choice-tick" }, "✓ He's right");
      const btnWrong = el("button", { class: "btn outline choice-cross" }, "✕ Totally wrong");

      const reflect = () => {
        btnRight.classList.toggle("active", marks[idx] === VERDICT.RIGHT);
        btnWrong.classList.toggle("active", marks[idx] === VERDICT.WRONG);
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

      pair.appendChild(btnRight);
      pair.appendChild(btnWrong);
      row.appendChild(pair);

      disableFns.push(() => {
        btnRight.disabled = true;
        btnWrong.disabled = true;
        btnRight.classList.remove("throb");
        btnWrong.classList.remove("throb");
      });

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
      marks = existingMarks.map((v) => (v === VERDICT.RIGHT ? VERDICT.RIGHT : VERDICT.WRONG));
      published = true;
      disableFns.forEach((fn) => { try { fn(); } catch {} });
      latestTotalForMe = Number((latestRoundTimings[myUid] || {}).totalMs) || null;
      enterPostStop(latestTotalForMe || 0);
      updateOutcome();
    }

    updateDoneState();

    if (!published) {
      startLiveTimer();
    }

    const publish = async () => {
      if (published || submitting) return;
      const ready = marks.every((v) => v === VERDICT.RIGHT || v === VERDICT.WRONG);
      if (!ready) return;

      submitting = true;
      updateDoneState();

      const safeMarks = marks.map((v) => (v === VERDICT.RIGHT ? VERDICT.RIGHT : VERDICT.WRONG));
      const markDoneMs = Date.now();

      let qDoneMs = null;
      try {
        const latest = await getDoc(rdRef);
        const latestData = latest.data() || {};
        latestRoundTimings = latestData.timings || {};
        const candidate = (latestRoundTimings[myUid] || {}).qDoneMs;
        if (Number(candidate)) qDoneMs = Number(candidate);
      } catch (err) {
        console.warn("[marking] failed to read round timings:", err);
      }

      if (!qDoneMs) {
        try {
          const playerSnap = await getDoc(playerRef);
          const playerData = playerSnap.data() || {};
          const candidate = (((playerData.rounds || {})[round] || {}).timings || {}).qDoneMs;
          if (Number(candidate)) {
            qDoneMs = Number(candidate);
            await setDoc(rdRef, { timings: { [myUid]: { qDoneMs } } }, { merge: true });
          }
        } catch (err) {
          console.warn("[marking] qDone fallback failed:", err);
        }
      }

      const qSeg = (Number.isFinite(qDoneMs) && qDoneMs && roundStartAt)
        ? Math.max(0, qDoneMs - roundStartAt)
        : 0;
      const mSeg = Math.max(0, markDoneMs - markingEnterAt);
      const totalMs = Math.max(0, qSeg + mSeg);
      latestTotalForMe = totalMs;

      const patch = {};
      patch[`marking.${myRole}.${round}`] = safeMarks;
      patch[`markingAck.${myRole}.${round}`] = true;
      patch["timestamps.updatedAt"] = serverTimestamp();

      const roundTimingPayload = { timings: { [myUid]: { markDoneMs, totalMs } } };
      if (Number.isFinite(qDoneMs) && qDoneMs > 0) {
        roundTimingPayload.timings[myUid].qDoneMs = qDoneMs;
      }

      const playerTimingPayload = { rounds: {} };
      playerTimingPayload.rounds[round] = { timings: { markDoneMs } };
      if (Number.isFinite(qDoneMs) && qDoneMs > 0) {
        playerTimingPayload.rounds[round].timings.qDoneMs = qDoneMs;
      }

      try {
        console.log(`[flow] submit marking | code=${code} round=${round} role=${myRole}`);
        await Promise.all([
          updateDoc(rRef, patch),
          setDoc(rdRef, roundTimingPayload, { merge: true }),
          setDoc(playerRef, playerTimingPayload, { merge: true })
        ]);
        marks = safeMarks;
        published = true;
        submitting = false;
        disableFns.forEach((fn) => { try { fn(); } catch {} });
        enterPostStop(totalMs);
        updateOutcome();
        updateDoneState();
      } catch (err) {
        console.warn("[marking] publish failed:", err);
        submitting = false;
        updateDoneState();
      }
    };

    stopBtn.addEventListener("click", publish);

    const scheduleAdvance = (plan) => {
      if (!plan || myRole !== "host") return;
      if (scheduledAdvance && advanceTimeout) return;
      const waitMs = Math.max(0, Number(plan.advanceAt) - Date.now());
      scheduledAdvance = true;
      if (advanceTimeout) {
        clearTimeout(advanceTimeout);
        advanceTimeout = null;
      }
      advanceTimeout = setTimeout(async () => {
        try {
          if (plan.nextState === "countdown") {
            const nextRoundNum = Number(plan.nextRound) || (round + 1);
            const countdownStart = Date.now() + COUNTDOWN_ARM_MS;
            await updateDoc(rRef, {
              state: "countdown",
              round: nextRoundNum,
              "countdown.startAt": countdownStart,
              "marking.advanceAt": null,
              "marking.nextState": null,
              "marking.nextRound": null,
              "timestamps.updatedAt": serverTimestamp(),
            });
          } else if (plan.nextState === "maths") {
            await updateDoc(rRef, {
              state: "maths",
              "countdown.startAt": null,
              "marking.advanceAt": null,
              "marking.nextState": null,
              "marking.nextRound": null,
              "timestamps.updatedAt": serverTimestamp(),
            });
          }
          advanceTimeout = null;
          scheduledAdvance = false;
        } catch (err) {
          console.warn("[marking] advance dispatch failed:", err);
          scheduledAdvance = false;
          advanceTimeout = null;
          setTimeout(() => scheduleAdvance(plan), 600);
        }
      }, waitMs);
    };

    const finalizeSnippet = async (attempt = 0) => {
      if (snippetResolved || finalizeInFlight) return;
      finalizeInFlight = true;
      let nextPlan = null;
      try {
        await runTransaction(db, async (tx) => {
          const roomSnapCur = await tx.get(rRef);
          if (!roomSnapCur.exists()) return;
          const roomData = roomSnapCur.data() || {};
          if ((roomData.state || "").toLowerCase() !== "marking") return;

          const meta = roomData.meta || {};
          const hostId = meta.hostUid || hostUid || "";
          const guestId = meta.guestUid || guestUid || "";
          const ackHost = Boolean(((roomData.markingAck || {}).host || {})[round]);
          const ackGuest = Boolean(((roomData.markingAck || {}).guest || {})[round]);
          if (!(ackHost && ackGuest)) return;

          const roundSnapCur = await tx.get(rdRef);
          if (!roundSnapCur.exists()) return;
          const roundData = roundSnapCur.data() || {};
          const timings = roundData.timings || {};
          const hostTiming = hostId ? timings[hostId] || {} : {};
          const guestTiming = guestId ? timings[guestId] || {} : {};
          const hostTotalRaw = hostTiming.totalMs;
          const guestTotalRaw = guestTiming.totalMs;
          if (!Number.isFinite(hostTotalRaw) || !Number.isFinite(guestTotalRaw)) return;
          const hostTotal = Number(hostTotalRaw);
          const guestTotal = Number(guestTotalRaw);

          const winners = [];
          if (Math.abs(hostTotal - guestTotal) <= TIE_EPSILON_MS) {
            if (hostId) winners.push(hostId);
            if (guestId) winners.push(guestId);
          } else if (hostTotal < guestTotal) {
            if (hostId) winners.push(hostId);
          } else if (guestId) {
            winners.push(guestId);
          }

          const answersHost = (((roomData.answers || {}).host || {})[round] || []);
          const answersGuest = (((roomData.answers || {}).guest || {})[round] || []);
          const countCorrect = (arr) => arr.reduce((acc, ans) =>
            acc + (same(ans?.chosen, ans?.correct) ? 1 : 0), 0);
          const roundHostScore = countCorrect(answersHost);
          const roundGuestScore = countCorrect(answersGuest);
          const baseScores = ((roomData.scores || {}).questions) || {};
          const nextHost = Number(baseScores.host || 0) + roundHostScore;
          const nextGuest = Number(baseScores.guest || 0) + roundGuestScore;

          const winnerToken = winners.length >= 2 ? SNIPPET_TIE_TOKEN : winners[0] || null;
          const now = Date.now();
          const advanceAt = now + STOP_DELAY_MS;
          const nextState = round >= 5 ? "maths" : "countdown";
          const nextRound = round >= 5 ? round : round + 1;

          tx.update(rRef, {
            "scores.questions.host": nextHost,
            "scores.questions.guest": nextGuest,
            "marking.startAt": null,
            "marking.completedAt": serverTimestamp(),
            "marking.advanceAt": advanceAt,
            "marking.nextState": nextState,
            "marking.nextRound": nextRound,
            "timestamps.updatedAt": serverTimestamp(),
          });

          tx.set(rdRef, { snippetWinnerUid: winnerToken }, { merge: true });

          if (hostId) {
            const patchHost = { retainedSnippets: {} };
            patchHost.retainedSnippets[round] = winners.includes(hostId);
            tx.set(doc(rRef, "players", hostId), patchHost, { merge: true });
          }
          if (guestId) {
            const patchGuest = { retainedSnippets: {} };
            patchGuest.retainedSnippets[round] = winners.includes(guestId);
            tx.set(doc(rRef, "players", guestId), patchGuest, { merge: true });
          }

          nextPlan = { nextState, nextRound, advanceAt };
        });
        if (nextPlan && myRole === "host") {
          scheduleAdvance(nextPlan);
        }
        snippetResolved = true;
      } catch (err) {
        console.warn("[marking] finalize failed:", err);
        if (attempt < 2) {
          setTimeout(() => finalizeSnippet(attempt + 1), 400 * (attempt + 1));
        }
      } finally {
        finalizeInFlight = false;
      }
    };

    stopRoomWatch = onSnapshot(rRef, (snap) => {
      const data = snap.data() || {};
      if (Number((data.countdown || {}).startAt)) {
        roundStartAt = Number(data.countdown.startAt);
        if (!timerFrozen) {
          refreshLiveTimer();
        }
      }

      const markingMeta = data.marking || {};
      if (myRole === "host" && markingMeta && markingMeta.nextState && Number(markingMeta.advanceAt)) {
        scheduleAdvance({
          nextState: markingMeta.nextState,
          nextRound: markingMeta.nextRound,
          advanceAt: Number(markingMeta.advanceAt),
        });
      }

      if (data.state === "award") {
        setTimeout(() => {
          location.hash = `#/award?code=${code}&round=${round}`;
        }, 80);
        return;
      }

      if (data.state === "countdown") {
        setTimeout(() => {
          location.hash = `#/countdown?code=${code}&round=${data.round || round}`;
        }, 80);
        return;
      }

      if (data.state === "questions") {
        setTimeout(() => {
          location.hash = `#/questions?code=${code}&round=${data.round || round}`;
        }, 80);
        return;
      }

      if (data.state === "maths") {
        setTimeout(() => { location.hash = `#/maths?code=${code}`; }, 80);
      }
    }, (err) => {
      console.warn("[marking] room snapshot error:", err);
    });

    stopRoundWatch = onSnapshot(rdRef, (snap) => {
      const data = snap.data() || {};
      latestRoundTimings = data.timings || {};

      if (published) {
        const myTiming = latestRoundTimings[myUid] || {};
        if (Number(myTiming.totalMs)) {
          latestTotalForMe = Number(myTiming.totalMs);
          freezeTimerDisplay(latestTotalForMe);
          resultWrap.style.display = "block";
          updateOutcome();
        }
      }

      if (Object.prototype.hasOwnProperty.call(data, "snippetWinnerUid")) {
        currentWinnerToken = data.snippetWinnerUid || null;
        updateOutcome();
      }

      const hostReady = Boolean(hostUid) && Number.isFinite(Number((latestRoundTimings[hostUid] || {}).totalMs));
      const guestReady = Boolean(guestUid) && Number.isFinite(Number((latestRoundTimings[guestUid] || {}).totalMs));
      if (hostReady && guestReady && myRole === "host" && !snippetResolved) {
        finalizeSnippet();
      }
    }, (err) => {
      console.warn("[marking] round snapshot error:", err);
    });

    this.unmount = () => {
      try { stopRoomWatch && stopRoomWatch(); } catch {}
      try { stopRoundWatch && stopRoundWatch(); } catch {}
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
      if (advanceTimeout) {
        clearTimeout(advanceTimeout);
        advanceTimeout = null;
      }
    };
  },

  async unmount() { /* instance cleanup handled above */ }
};
