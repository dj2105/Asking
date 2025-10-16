// /src/views/Marking.js
//
// Marking phase — judge opponent answers, record timings, and await the snippet verdict.
// • Shows exactly three rows (opponent questions + their chosen answers).
// • Verdict buttons: ✓ (definitely right) / ✕ (absolutely wrong) / I DUNNO (unsure capture).
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

const VERDICT = { RIGHT: "right", WRONG: "wrong", UNKNOWN: "unknown" };

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

    const card = el("div", { class: "card" });
    const heading = el("h2", { class: "view-heading" }, "Marking");
    const metaStrip = el("div", { class: "meta-strip" });
    const roomChip = el("span", { class: "meta-chip" }, code || "Room");
    const roundChip = el("span", { class: "meta-chip" }, `Round ${round}`);
    metaStrip.appendChild(roomChip);
    metaStrip.appendChild(roundChip);
    const introNote = el("div", { class: "view-note" }, "Decide whether each answer earns the point.");

    const list = el("div", { class: "qa-list" });

    const timerRow = el("div", { class: "timer-row" });
    const timerDisplay = el("div", { class: "mono timer-display" }, "0");
    const doneBtn = el("button", {
      class: "btn outline timer-button",
      disabled: ""
    }, "Share verdict");
    timerRow.appendChild(timerDisplay);
    timerRow.appendChild(doneBtn);

    const resultWrap = el("div", { class: "result-panel" });
    const freezeLine = el("div", { class: "mono result-heading" }, "");
    const winnerLine = el("div", { class: "result-winner" }, "");
    const waitingLine = el("div", { class: "mono small muted" }, "");
    resultWrap.appendChild(freezeLine);
    resultWrap.appendChild(winnerLine);
    resultWrap.appendChild(waitingLine);

    card.appendChild(heading);
    card.appendChild(metaStrip);
    card.appendChild(introNote);
    card.appendChild(list);
    card.appendChild(timerRow);
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
    const oppName = oppRole === "host" ? "Daniel" : "Jaime";
    const readableName = myRole === "host" ? "Daniel" : "Jaime";
    heading.textContent = `${readableName} marks ${oppName}`;
    introNote.textContent = `Call Jemima’s verdict on ${oppName}’s answers.`;
    doneBtn.textContent = `Send to ${oppName}`;
    roomChip.textContent = code || "Room";
    waitingLine.textContent = `Linking to ${oppName}…`;

    const fallbackStartAt = Number((roomData0.countdown || {}).startAt || 0) || null;
    const markingEnterAt = Date.now();
    let published = false;
    let submitting = false;
    let stopRoomWatch = null;
    let stopRoundWatch = null;
    let snippetResolved = false;
    let finalizeInFlight = false;
    let latestTotalForMe = null;
    let latestRoundTimings = {};
    let snippetOutcome = { winnerUid: null, tie: false };
    let timerInterval = null;
    let timerFrozen = false;
    let timerFrozenMs = null;
    let questionStartAt = null;
    let qDoneMsLatest = null;
    let timerOffsetMs = 0;

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

    const baseQuestionStart = () => {
      if (Number.isFinite(questionStartAt) && questionStartAt > 0) return questionStartAt;
      if (Number.isFinite(fallbackStartAt) && fallbackStartAt > 0) return fallbackStartAt;
      return null;
    };

    const computeQuestionSegment = (qDoneValue) => {
      const base = baseQuestionStart();
      if (Number.isFinite(qDoneValue) && Number.isFinite(base)) {
        return Math.max(0, qDoneValue - base);
      }
      return 0;
    };

    const formatSeconds = (ms) => {
      if (!Number.isFinite(ms) || ms < 0) return "0";
      const secs = Math.floor(ms / 1000);
      return String(secs);
    };

    const liveElapsedMs = () => timerOffsetMs + Math.max(0, Date.now() - markingEnterAt);

    const updateTimerDisplay = () => {
      if (timerFrozen) {
        const frozen = Number.isFinite(timerFrozenMs) ? timerFrozenMs : liveElapsedMs();
        timerDisplay.textContent = formatSeconds(frozen);
        return;
      }
      timerDisplay.textContent = formatSeconds(liveElapsedMs());
    };

    const refreshTimerOffset = () => {
      const next = computeQuestionSegment(qDoneMsLatest);
      timerOffsetMs = Number.isFinite(next) ? next : 0;
      if (!timerFrozen) updateTimerDisplay();
    };

    const freezeTimer = (ms) => {
      if (timerFrozen && Number.isFinite(timerFrozenMs)) return;
      timerFrozen = true;
      if (Number.isFinite(ms)) timerFrozenMs = Math.max(0, ms);
      else timerFrozenMs = liveElapsedMs();
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
    latestRoundTimings = rd.timings || {};
    const timingsMeta0 = rd.timingsMeta || {};
    if (Number(timingsMeta0.questionsStartAt)) {
      const candidate = Number(timingsMeta0.questionsStartAt);
      if (Number.isFinite(candidate) && candidate > 0) {
        questionStartAt = candidate;
      }
    }
    const myTimingInit = latestRoundTimings[me.uid] || {};
    if (Number(myTimingInit.qDoneMs)) {
      const candidate = Number(myTimingInit.qDoneMs);
      if (Number.isFinite(candidate) && candidate > 0) {
        qDoneMsLatest = candidate;
      }
    }
    try {
      const playerSnap0 = await getDoc(playerRef);
      const playerData0 = playerSnap0.data() || {};
      const qDoneFromPlayer = Number((((playerData0.rounds || {})[round] || {}).timings || {}).qDoneMs);
      if (!Number.isFinite(qDoneMsLatest) && Number.isFinite(qDoneFromPlayer) && qDoneFromPlayer > 0) {
        qDoneMsLatest = qDoneFromPlayer;
      }
    } catch (err) {
      console.warn("[marking] failed to read player timing:", err);
    }
    refreshTimerOffset();
    const oppItems = (oppRole === "host" ? rd.hostItems : rd.guestItems) || [];
    const oppAnswers = (((roomData0.answers || {})[oppRole] || {})[round] || []).map((a) => a?.chosen || "");

    let marks = [null, null, null];
    const disableFns = [];

    const updateOutcomeDisplay = () => {
      if (!published) {
        resultWrap.classList.remove("active");
        list.style.display = "";
        timerRow.style.opacity = "";
        freezeLine.textContent = "";
        winnerLine.textContent = "";
        waitingLine.textContent = `Linking to ${oppName}…`;
        return;
      }
      const secsLine = Number.isFinite(latestTotalForMe)
        ? `Round wrapped in ${formatSeconds(latestTotalForMe)}s`
        : "Round wrapped — timing pending";
      freezeLine.textContent = secsLine;
      resultWrap.classList.add("active");
      list.style.display = "none";
      timerRow.style.opacity = "0.85";

      const oppFallback = oppRole === "host" ? [hostUid] : [guestUid];
      const oppEntry = resolveTimingForRole(latestRoundTimings, oppRole, oppFallback);
      const oppDone = Boolean(oppEntry && Number.isFinite(Number(oppEntry.info?.totalMs)));

      if (!oppDone) {
        winnerLine.textContent = "";
        waitingLine.textContent = `Waiting for ${oppName}…`;
        return;
      }

      const { winnerUid, tie } = snippetOutcome || {};
      if (tie) {
        winnerLine.textContent = "Snippet shared";
        waitingLine.textContent = "Dead heat — Daniel and Jaime both keep it.";
        return;
      }
      if (winnerUid && winnerUid === me.uid) {
        winnerLine.textContent = `${readableName} keeps Jemima’s snippet`;
        waitingLine.textContent = "Connected. Preparing the award.";
        return;
      }
      if (winnerUid) {
        winnerLine.textContent = `${oppName} keeps Jemima’s snippet`;
        waitingLine.textContent = "Link complete. Await the next round…";
        return;
      }
      winnerLine.textContent = "";
      waitingLine.textContent = `Linking to ${oppName}…`;
    };

    const showPostSubmit = (totalMs) => {
      let finalMs = Number.isFinite(totalMs) ? Math.max(0, Number(totalMs)) : liveElapsedMs();
      if (!Number.isFinite(finalMs) || finalMs < 0) finalMs = 0;
      latestTotalForMe = finalMs;
      freezeTimer(finalMs);
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
      const ready = marks.every((v) =>
        v === VERDICT.RIGHT || v === VERDICT.WRONG || v === VERDICT.UNKNOWN
      );
      doneBtn.disabled = !(ready && !submitting);
      doneBtn.classList.toggle("throb", ready && !submitting);
    };

    const buildRow = (idx, question, chosen) => {
      const row = el("div", { class: "mark-row" });
      row.appendChild(el("div", { class: "q mono" }, `${idx + 1}. ${question || "(missing question)"}`));

      const answerBox = el("div", { class: "a mono mark-answer" });
      answerBox.appendChild(
        el(
          "div",
          { class: "mark-answer__label mono small" },
          `${oppName}’s answer`
        )
      );
      answerBox.appendChild(
        el(
          "div",
          { class: "mark-answer__text" },
          chosen || "(no answer recorded)"
        )
      );
      row.appendChild(answerBox);

      const pair = el("div", { class: "verdict-row" });
      const btnRight = el(
        "button",
        {
          class: "btn verdict-btn verdict-tick",
          type: "button",
          title: "Mark as correct",
          "aria-pressed": "false",
        },
        "✓"
      );
      const btnWrong = el(
        "button",
        {
          class: "btn verdict-btn verdict-cross",
          type: "button",
          title: "Mark as incorrect",
          "aria-pressed": "false",
        },
        "✕"
      );
      const btnUnknown = el(
        "button",
        {
          class: "btn verdict-btn verdict-idk",
          type: "button",
          title: "Mark as unsure",
          "aria-pressed": "false",
        },
        "I DUNNO"
      );

      const reflect = () => {
        const mark = marks[idx];
        const isRight = mark === VERDICT.RIGHT;
        const isWrong = mark === VERDICT.WRONG;
        const isUnknown = mark === VERDICT.UNKNOWN;
        btnRight.classList.toggle("active", isRight);
        btnWrong.classList.toggle("active", isWrong);
        btnUnknown.classList.toggle("active", isUnknown);
        btnRight.setAttribute("aria-pressed", isRight ? "true" : "false");
        btnWrong.setAttribute("aria-pressed", isWrong ? "true" : "false");
        btnUnknown.setAttribute("aria-pressed", isUnknown ? "true" : "false");
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
      btnUnknown.addEventListener("click", () => {
        if (published || submitting) return;
        marks[idx] = VERDICT.UNKNOWN;
        reflect();
        updateDoneState();
      });

      pair.appendChild(btnRight);
      pair.appendChild(btnWrong);
      pair.appendChild(btnUnknown);
      row.appendChild(pair);

      disableFns.push(() => {
        btnRight.disabled = true;
        btnWrong.disabled = true;
        btnUnknown.disabled = true;
        btnRight.classList.remove("throb");
        btnWrong.classList.remove("throb");
        btnUnknown.classList.remove("throb");
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
      marks = existingMarks.map((v) => {
        if (v === VERDICT.RIGHT) return VERDICT.RIGHT;
        if (v === VERDICT.WRONG) return VERDICT.WRONG;
        return VERDICT.UNKNOWN;
      });
      published = true;
      disableFns.forEach((fn) => { try { fn(); } catch {} });
      latestTotalForMe = Number((latestRoundTimings[me.uid] || {}).totalMs) || null;
      showPostSubmit(latestTotalForMe);
    }

    updateDoneState();

    const publish = async () => {
      if (published || submitting) return;
      const ready = marks.every((v) =>
        v === VERDICT.RIGHT || v === VERDICT.WRONG || v === VERDICT.UNKNOWN
      );
      if (!ready) return;

      submitting = true;
      updateDoneState();

      const safeMarks = marks.map((v) => {
        if (v === VERDICT.RIGHT) return VERDICT.RIGHT;
        if (v === VERDICT.WRONG) return VERDICT.WRONG;
        return VERDICT.UNKNOWN;
      });
      const markDoneMs = Date.now();

      let qDoneMs = null;
      try {
        const latest = await getDoc(rdRef);
        const latestData = latest.data() || {};
        latestRoundTimings = latestData.timings || {};
        const candidate = (latestRoundTimings[me.uid] || {}).qDoneMs;
        if (Number(candidate)) {
          qDoneMs = Number(candidate);
          if (Number.isFinite(qDoneMs) && qDoneMs > 0) {
            qDoneMsLatest = qDoneMs;
          }
        }
      } catch (err) {
        console.warn("[marking] failed to read round timings:", err);
      }

      if (!Number.isFinite(qDoneMs) || qDoneMs <= 0) {
        try {
          const playerSnap = await getDoc(playerRef);
          const playerData = playerSnap.data() || {};
          const candidate = (((playerData.rounds || {})[round] || {}).timings || {}).qDoneMs;
          if (Number(candidate)) {
            qDoneMs = Number(candidate);
            if (Number.isFinite(qDoneMs) && qDoneMs > 0) {
              qDoneMsLatest = qDoneMs;
            }
            await setDoc(rdRef, { timings: { [me.uid]: { qDoneMs } } }, { merge: true });
          }
        } catch (err) {
          console.warn("[marking] qDone fallback failed:", err);
        }
      }

      refreshTimerOffset();

      const qSeg = computeQuestionSegment(qDoneMsLatest);
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

      if (data.state === "award") {
        setTimeout(() => {
          location.hash = `#/award?code=${code}&round=${data.round || round}`;
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
      if (Number(data?.timingsMeta?.questionsStartAt)) {
        const candidate = Number(data.timingsMeta.questionsStartAt);
        if (Number.isFinite(candidate) && candidate > 0) {
          questionStartAt = candidate;
        }
      }

      latestRoundTimings = data.timings || {};
      const myTiming = latestRoundTimings[me.uid] || {};
      if (Number(myTiming.qDoneMs)) {
        const candidate = Number(myTiming.qDoneMs);
        if (Number.isFinite(candidate) && candidate > 0) {
          qDoneMsLatest = candidate;
        }
      }
      refreshTimerOffset();

      if (published && !latestTotalForMe) {
        const myTiming = latestRoundTimings[me.uid] || {};
        if (Number(myTiming.totalMs)) {
          latestTotalForMe = Number(myTiming.totalMs);
          showPostSubmit(latestTotalForMe);
        }
      }

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
