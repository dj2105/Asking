// /src/views/Marking.js
//
// Marking phase — judge opponent answers, record timings, and await the snippet verdict.
// • Shows exactly three rows (opponent questions + their chosen answers).
// • Verdict buttons: ✓ (definitely right) / ✕ (absolutely wrong). No "unknown" option.
// • Submission writes marking.{role}.{round}, markingAck.{role}.{round} = true, and timing metadata for snippet race.
// • Host waits for both totals, computes the snippet winner, mirrors retained flags, and advances to award.

import {
  initFirebase,
  ensureAuth,
  roomRef,
  roundSubColRef,
  doc,
  getDoc,
  onSnapshot,
  setDoc,
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

export default {
  async mount(container) {
    const { db } = await initFirebase();
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

    const doneBtn = el("button", { class: "btn primary", style: "margin-top:12px;", disabled: "" }, "DONE");
    card.appendChild(doneBtn);

    const resultWrap = el("div", {
      style: "text-align:center;margin-top:18px;display:none;"
    });
    const finishLine = el("div", {
      class: "mono",
      style: "font-weight:700;font-size:18px;"
    }, "");
    const waitingLine = el("div", {
      class: "mono",
      style: "opacity:0.75;margin-top:4px;"
    }, "Waiting for opponent…");
    resultWrap.appendChild(finishLine);
    resultWrap.appendChild(waitingLine);
    card.appendChild(resultWrap);

    root.appendChild(card);

    const mathsMount = el("div", { class: "jemima-maths-pinned" });
    root.appendChild(mathsMount);

    container.appendChild(root);

    const rRef = roomRef(code);
    const rdRef = doc(roundSubColRef(code), String(round));
    const playerRef = doc(rRef, "players", me.uid);

    const roomSnap = await getDoc(rRef);
    const roomData0 = roomSnap.data() || {};
    const { hostUid, guestUid } = roomData0.meta || {};
    const storedRole = getStoredRole(code);
    const myRole = storedRole === "host" || storedRole === "guest"
      ? storedRole
      : hostUid === me.uid ? "host" : guestUid === me.uid ? "guest" : "guest";
    const oppRole = myRole === "host" ? "guest" : "host";

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

    try {
      if (mountMathsPane && roomData0.maths) {
        mountMathsPane(mathsMount, { maths: roomData0.maths, round, mode: "inline", roomCode: code, userUid: me.uid });
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

    const showPostSubmit = (totalMs) => {
      const secs = Number.isFinite(totalMs) && totalMs > 0 ? (totalMs / 1000).toFixed(1) : null;
      finishLine.textContent = secs
        ? `You finished this round in ${secs} seconds.`
        : "You finished this round.";
      waitingLine.textContent = "Waiting for opponent…";
      resultWrap.style.display = "block";
      list.style.display = "none";
      doneBtn.style.display = "none";
    };

    const updateDoneState = () => {
      if (published) {
        doneBtn.disabled = true;
        doneBtn.classList.remove("throb");
        return;
      }
      const ready = marks.every((v) => v === VERDICT.RIGHT || v === VERDICT.WRONG);
      doneBtn.disabled = !(ready && !submitting);
      doneBtn.classList.toggle("throb", ready && !submitting);
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
      latestTotalForMe = Number((latestRoundTimings[me.uid] || {}).totalMs) || null;
      showPostSubmit(latestTotalForMe);
    }

    updateDoneState();

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
        const candidate = (latestRoundTimings[me.uid] || {}).qDoneMs;
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
            await setDoc(rdRef, { timings: { [me.uid]: { qDoneMs } } }, { merge: true });
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

      const roundTimingPayload = { timings: { [me.uid]: { markDoneMs, totalMs } } };
      if (Number.isFinite(qDoneMs) && qDoneMs > 0) {
        roundTimingPayload.timings[me.uid].qDoneMs = qDoneMs;
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
        showPostSubmit(totalMs);
        updateDoneState();
      } catch (err) {
        console.warn("[marking] publish failed:", err);
        submitting = false;
        updateDoneState();
      }
    };

    doneBtn.addEventListener("click", publish);

    const finalizeSnippet = async (attempt = 0) => {
      if (snippetResolved || finalizeInFlight) return;
      finalizeInFlight = true;
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

          let winnerUid = null;
          if (hostTotal < guestTotal) winnerUid = hostId;
          else if (guestTotal < hostTotal) winnerUid = guestId;

          const answersHost = (((roomData.answers || {}).host || {})[round] || []);
          const answersGuest = (((roomData.answers || {}).guest || {})[round] || []);
          const countCorrect = (arr) => arr.reduce((acc, ans) =>
            acc + (same(ans?.chosen, ans?.correct) ? 1 : 0), 0);
          const roundHostScore = countCorrect(answersHost);
          const roundGuestScore = countCorrect(answersGuest);
          const baseScores = ((roomData.scores || {}).questions) || {};
          const nextHost = Number(baseScores.host || 0) + roundHostScore;
          const nextGuest = Number(baseScores.guest || 0) + roundGuestScore;

          tx.update(rRef, {
            state: "award",
            "scores.questions.host": nextHost,
            "scores.questions.guest": nextGuest,
            "marking.startAt": null,
            "timestamps.updatedAt": serverTimestamp(),
          });

          tx.set(rdRef, { snippetWinnerUid: winnerUid || null }, { merge: true });

          if (hostId) {
            const patchHost = { retainedSnippets: {} };
            patchHost.retainedSnippets[round] = winnerUid === hostId;
            tx.set(doc(rRef, "players", hostId), patchHost, { merge: true });
          }
          if (guestId) {
            const patchGuest = { retainedSnippets: {} };
            patchGuest.retainedSnippets[round] = winnerUid === guestId;
            tx.set(doc(rRef, "players", guestId), patchGuest, { merge: true });
          }
        });
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

      if (published && !latestTotalForMe) {
        const myTiming = latestRoundTimings[me.uid] || {};
        if (Number(myTiming.totalMs)) {
          latestTotalForMe = Number(myTiming.totalMs);
          showPostSubmit(latestTotalForMe);
        }
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
    };
  },

  async unmount() { /* instance cleanup handled above */ }
};
