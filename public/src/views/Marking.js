// /src/views/Marking.js
//
// Marking phase — judge opponent answers, record timings, and await the snippet verdict.
// • Shows exactly three rows (opponent questions + their chosen answers).
// • Verdict buttons: ✓ (definitely right) / ✕ (absolutely wrong) / I DUNNO (no score).
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
import { clampCode, getHashParams, getStoredRole } from "../lib/util.js";
const mountMathsPane =
  (typeof MathsPaneMod?.default === "function" ? MathsPaneMod.default :
   typeof MathsPaneMod?.mount === "function" ? MathsPaneMod.mount :
   typeof MathsPaneMod?.default?.mount === "function" ? MathsPaneMod.default.mount :
   null);

const VERDICT = { RIGHT: "right", WRONG: "wrong", DUNNO: "dunno" };
const VERDICT_VALUES = Object.freeze(Object.values(VERDICT));

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

    const timerRow = el("div", { class: "timer-row" });
    const timerDisplay = el("div", { class: "mono timer-display" }, "0");
    const doneBtn = el("button", {
      class: "btn primary stop-btn",
      disabled: ""
    }, "STOP");
    timerRow.appendChild(timerDisplay);
    timerRow.appendChild(doneBtn);
    card.appendChild(timerRow);

    const resultWrap = el("div", {
      style: "text-align:center;margin-top:18px;display:none;"
    });
    const freezeLine = el("div", {
      class: "mono",
      style: "font-weight:700;font-size:20px;margin-bottom:10px;"
    }, "");
    const winnerLine = el("div", {
      style: "display:none;font-size:34px;font-weight:700;line-height:1.05;text-transform:uppercase;white-space:pre-line;font-family:Impact,Haettenschweiler,'Arial Black','Arial Narrow Bold',sans-serif;color:#c8f7c5;"
    }, "");
    const waitingLine = el("div", {
      class: "mono",
      style: "opacity:0.78;margin-top:6px;"
    }, "Linking to opponent…");
    resultWrap.appendChild(freezeLine);
    resultWrap.appendChild(winnerLine);
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

    let questionStartAt = 0;
    if (Number(((roomData0.marking || {}).questionStartAt))) {
      questionStartAt = Number((roomData0.marking || {}).questionStartAt);
    }
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
    let timerFrozenMs = null;
    let snippetOutcome = { winnerUid: null, tie: false };

    const uniqueList = (arr = []) => Array.from(new Set(arr.filter((v) => Boolean(v))));
    const resolveTimingForRole = (timings = {}, roleName, fallbackIds = []) => {
      const want = String(roleName || "").toLowerCase();
      if (!want) return null;
      const entries = Object.entries(timings || {});
      for (const [uid, infoRaw] of entries) {
        const info = infoRaw || {};
        const got = String(info.role || "").toLowerCase();
        if (got === want) {
          return { uid, info };
        }
      }
      const fallbacks = uniqueList(fallbackIds);
      for (const candidate of fallbacks) {
        if (candidate && Object.prototype.hasOwnProperty.call(timings || {}, candidate)) {
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
      if (!Number.isFinite(ms) || ms <= 0) return "0";
      return String(Math.floor(ms / 1000));
    };

    const questionElapsedBeforeMarking = () => {
      const myTiming = latestRoundTimings[me.uid] || {};
      const qDone = Number(myTiming.qDoneMs);
      if (Number(questionStartAt) && Number(qDone)) {
        return Math.max(0, qDone - questionStartAt);
      }
      if (Number(questionStartAt)) {
        return Math.max(0, markingEnterAt - questionStartAt);
      }
      return 0;
    };

    const updateTimerDisplay = () => {
      if (timerFrozen && Number.isFinite(timerFrozenMs)) {
        timerDisplay.textContent = formatSeconds(timerFrozenMs);
        return;
      }
      const elapsed = questionElapsedBeforeMarking() + Math.max(0, Date.now() - markingEnterAt);
      timerDisplay.textContent = formatSeconds(elapsed);
    };

    const freezeTimer = (ms) => {
      if (timerFrozen && Number.isFinite(timerFrozenMs)) return;
      timerFrozen = true;
      if (Number.isFinite(ms)) timerFrozenMs = Math.max(0, ms);
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
      updateTimerDisplay();
    };

    timerInterval = setInterval(updateTimerDisplay, 250);
    updateTimerDisplay();

    try {
      if (mountMathsPane && roomData0.maths) {
        mountMathsPane(mathsMount, { maths: roomData0.maths, round, mode: "inline", roomCode: code, userUid: me.uid });
      }
    } catch (err) {
      console.warn("[marking] MathsPane mount failed:", err);
    }

    const rdSnap = await getDoc(rdRef);
    const rd = rdSnap.data() || {};
    if (Number(((rd.timingsShared || {}).questionStartAt))) {
      questionStartAt = Number((rd.timingsShared || {}).questionStartAt);
    }
    latestRoundTimings = rd.timings || {};
    const oppItems = (oppRole === "host" ? rd.hostItems : rd.guestItems) || [];
    const oppAnswers = (((roomData0.answers || {})[oppRole] || {})[round] || []).map((a) => a?.chosen || "");

    let marks = [null, null, null];
    const reflectFns = [];
    const disableFns = [];

    const updateOutcomeDisplay = () => {
      if (!published) {
        resultWrap.style.display = "none";
        return;
      }
      const secsLine = Number.isFinite(latestTotalForMe)
        ? `ROUND COMPLETED IN ${formatSeconds(latestTotalForMe)} SECONDS`
        : "ROUND COMPLETED IN — SECONDS";
      freezeLine.textContent = secsLine;
      freezeLine.style.display = "block";

      const { winnerUid, tie } = snippetOutcome || {};
      const isWinner = tie || (winnerUid && winnerUid === me.uid);
      if (isWinner) {
        winnerLine.textContent = "YOU’RE\nA\nWINNER!";
        winnerLine.style.display = "block";
        waitingLine.textContent = tie
          ? "Dead heat! Snippet unlocked for both."
          : "Connected. Snippet secured.";
      } else if (winnerUid) {
        winnerLine.style.display = "none";
        waitingLine.textContent = "Link complete. Await the next round…";
      } else {
        winnerLine.style.display = "none";
        waitingLine.textContent = "Linking to opponent…";
      }

      resultWrap.style.display = "block";
      list.style.display = "none";
      timerRow.style.opacity = "0.85";
    };

    const showPostSubmit = (totalMs) => {
      if (Number.isFinite(totalMs)) {
        latestTotalForMe = Number(totalMs);
        freezeTimer(latestTotalForMe);
      } else {
        freezeTimer(totalMs);
      }
      doneBtn.disabled = true;
      doneBtn.classList.remove("throb");
      doneBtn.style.pointerEvents = "none";
      updateOutcomeDisplay();
    };

    const updateDoneState = () => {
      if (published) {
        doneBtn.disabled = true;
        doneBtn.classList.remove("throb");
        return;
      }
      const ready = marks.every((v) => VERDICT_VALUES.includes(v));
      doneBtn.disabled = !(ready && !submitting);
      doneBtn.classList.toggle("throb", ready && !submitting);
    };

    const buildRow = (idx, question, chosen) => {
      const row = el("div", { class: "mark-row" });
      row.appendChild(el("div", { class: "q mono" }, `${idx + 1}. ${question || "(missing question)"}`));
      row.appendChild(el("div", { class: "a mono" }, chosen || "(no answer recorded)"));

      const pair = el("div", { class: "verdict-row" });
      const btnRight = el("button", {
        class: "btn outline choice-btn choice-tick",
        type: "button",
        "aria-label": "Mark correct"
      }, "✓");
      const btnWrong = el("button", {
        class: "btn outline choice-btn choice-cross",
        type: "button",
        "aria-label": "Mark incorrect"
      }, "✕");
      const btnDunno = el("button", {
        class: "btn outline choice-btn choice-dunno",
        type: "button"
      }, "I DUNNO");

      const reflect = () => {
        btnRight.classList.toggle("active", marks[idx] === VERDICT.RIGHT);
        btnWrong.classList.toggle("active", marks[idx] === VERDICT.WRONG);
        btnDunno.classList.toggle("active", marks[idx] === VERDICT.DUNNO);
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
      btnDunno.addEventListener("click", () => {
        if (published || submitting) return;
        marks[idx] = VERDICT.DUNNO;
        reflect();
        updateDoneState();
      });

      pair.appendChild(btnRight);
      pair.appendChild(btnWrong);
      pair.appendChild(btnDunno);
      row.appendChild(pair);

      disableFns.push(() => {
        btnRight.disabled = true;
        btnWrong.disabled = true;
        btnDunno.disabled = true;
        btnRight.classList.remove("throb");
        btnWrong.classList.remove("throb");
        btnDunno.classList.remove("throb");
      });

      reflectFns.push(reflect);
      reflect();

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
      marks = existingMarks.map((v) =>
        v === VERDICT.RIGHT
          ? VERDICT.RIGHT
          : v === VERDICT.WRONG
            ? VERDICT.WRONG
            : VERDICT.DUNNO
      );
      published = true;
      disableFns.forEach((fn) => { try { fn(); } catch {} });
      latestTotalForMe = Number((latestRoundTimings[me.uid] || {}).totalMs) || null;
      showPostSubmit(latestTotalForMe);
      setTimeout(() => {
        location.hash = `#/stopwait?code=${code}&round=${round}`;
      }, 120);
    }

    reflectFns.forEach((fn) => {
      try { fn(); } catch {}
    });

    updateDoneState();

    const publish = async () => {
      if (published || submitting) return;
      const ready = marks.every((v) => VERDICT_VALUES.includes(v));
      if (!ready) return;

      submitting = true;
      updateDoneState();

      const safeMarks = marks.map((v) =>
        v === VERDICT.RIGHT
          ? VERDICT.RIGHT
          : v === VERDICT.WRONG
            ? VERDICT.WRONG
            : VERDICT.DUNNO
      );
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

      let qSeg = 0;
      if (Number.isFinite(qDoneMs) && Number(questionStartAt)) {
        qSeg = Math.max(0, qDoneMs - questionStartAt);
      } else if (Number(questionStartAt)) {
        qSeg = Math.max(0, markingEnterAt - questionStartAt);
      }
      const mSeg = Math.max(0, markDoneMs - markingEnterAt);
      const totalMs = Math.max(0, qSeg + mSeg);
      latestTotalForMe = totalMs;

      const patch = {};
      patch[`marking.${myRole}.${round}`] = safeMarks;
      patch[`markingAck.${myRole}.${round}`] = true;
      patch["timestamps.updatedAt"] = serverTimestamp();

      const roundTimingPayload = { timings: { [me.uid]: { markDoneMs, totalMs, role: myRole } } };
      if (Number.isFinite(qDoneMs) && qDoneMs > 0) {
        roundTimingPayload.timings[me.uid].qDoneMs = qDoneMs;
      }

      const playerTimingPayload = { rounds: {} };
      playerTimingPayload.rounds[round] = { timings: { markDoneMs, role: myRole } };
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
        setTimeout(() => {
          location.hash = `#/stopwait?code=${code}&round=${round}`;
        }, 120);
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
          const hostEntry = resolveTimingForRole(timings, "host", [meta.hostUid, hostUid]);
          const guestEntry = resolveTimingForRole(timings, "guest", [meta.guestUid, guestUid]);
          if (!hostEntry || !guestEntry) return;

          const hostTotalRaw = hostEntry.info?.totalMs;
          const guestTotalRaw = guestEntry.info?.totalMs;
          if (!Number.isFinite(hostTotalRaw) || !Number.isFinite(guestTotalRaw)) return;
          const hostTotal = Number(hostTotalRaw);
          const guestTotal = Number(guestTotalRaw);

          const diff = Math.abs(hostTotal - guestTotal);
          const tie = diff <= 1;

          let winnerUid = null;
          if (!tie) {
            if (hostTotal < guestTotal) winnerUid = hostEntry.uid;
            else if (guestTotal < hostTotal) winnerUid = guestEntry.uid;
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

          const currentRound = Number(roomData.round) || round;

          tx.update(rRef, {
            state: "award",
            round: currentRound,
            "scores.questions.host": nextHost,
            "scores.questions.guest": nextGuest,
            "marking.startAt": null,
            "countdown.startAt": null,
            "timestamps.updatedAt": serverTimestamp(),
          });

          tx.set(rdRef, { snippetWinnerUid: winnerUid || null, snippetTie: tie }, { merge: true });

          const hostWon = tie || (winnerUid && winnerUid === hostEntry.uid);
          const guestWon = tie || (winnerUid && winnerUid === guestEntry.uid);
          const hostDocIds = uniqueList([hostEntry.uid, hostId, meta.hostUid]);
          const guestDocIds = uniqueList([guestEntry.uid, guestId, meta.guestUid]);

          hostDocIds.forEach((id) => {
            if (!id) return;
            const patchHost = { retainedSnippets: {} };
            patchHost.retainedSnippets[round] = hostWon;
            tx.set(doc(rRef, "players", id), patchHost, { merge: true });
          });
          guestDocIds.forEach((id) => {
            if (!id) return;
            const patchGuest = { retainedSnippets: {} };
            patchGuest.retainedSnippets[round] = guestWon;
            tx.set(doc(rRef, "players", id), patchGuest, { merge: true });
          });
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
      if (Number(((data.marking || {}).questionStartAt))) {
        questionStartAt = Number((data.marking || {}).questionStartAt);
        if (!timerFrozen) updateTimerDisplay();
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
      if (Number(((data.timingsShared || {}).questionStartAt))) {
        questionStartAt = Number((data.timingsShared || {}).questionStartAt);
      }

      if (published && !latestTotalForMe) {
        const myTiming = latestRoundTimings[me.uid] || {};
        if (Number(myTiming.totalMs)) {
          latestTotalForMe = Number(myTiming.totalMs);
          showPostSubmit(latestTotalForMe);
        }
      }

      if (!timerFrozen) updateTimerDisplay();

      const hostTimingEntry = resolveTimingForRole(latestRoundTimings, "host", [hostUid]);
      const guestTimingEntry = resolveTimingForRole(latestRoundTimings, "guest", [guestUid]);
      const hostReady = Boolean(hostTimingEntry && Number.isFinite(Number(hostTimingEntry.info?.totalMs)));
      const guestReady = Boolean(guestTimingEntry && Number.isFinite(Number(guestTimingEntry.info?.totalMs)));
      if (hostReady && guestReady && myRole === "host" && !snippetResolved) {
        finalizeSnippet();
      }

      const tie = Boolean(data.snippetTie);
      const winnerUid = data.snippetWinnerUid || null;
      snippetOutcome = { winnerUid, tie };
      if (published) updateOutcomeDisplay();
    }, (err) => {
      console.warn("[marking] round snapshot error:", err);
    });

    this.unmount = () => {
      try { stopRoomWatch && stopRoomWatch(); } catch {}
      try { stopRoundWatch && stopRoundWatch(); } catch {}
      if (timerInterval) {
        try { clearInterval(timerInterval); } catch {}
      }
    };
  },

  async unmount() { /* instance cleanup handled above */ }
};
