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

    const timerRow = el("div", {
      class: "marking-timer-row",
      style: "display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:auto;padding-top:16px;border-top:1px dashed rgba(0,0,0,0.12);"
    });
    const timerDisplay = el("div", {
      class: "mono",
      style: "font-weight:700;font-size:24px;min-width:120px;text-align:center;"
    }, "0");
    const doneBtn = el("button", {
      class: "btn primary",
      style: "font-weight:700;letter-spacing:0.6px;padding-left:28px;padding-right:28px;",
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

    let questionsStartAt = Number((roomData0.questions || {}).startAt || 0) || 0;
    const markingEnterAt = Date.now();
    let published = false;
    let submitting = false;
    let stopRoomWatch = null;
    let stopRoundWatch = null;
    let latestTotalForMe = null;
    let latestRoundTimings = {};
    let timerInterval = null;
    let timerFrozen = false;
    let timerFrozenMs = null;
    let baseElapsedMs = null;
    let resumeAnchorMs = Date.now();
    let snippetOutcome = { winnerUid: null, tie: false };

    const formatSeconds = (ms) => {
      const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
      return String(Math.floor(safe / 1000));
    };

    const deriveBaseElapsed = () => {
      const mine = latestRoundTimings[me.uid] || {};
      const qDone = Number(mine.qDoneMs);
      if (Number.isFinite(qDone) && qDone > 0 && Number(questionsStartAt)) {
        return Math.max(0, qDone - Number(questionsStartAt));
      }
      if (Number.isFinite(mine.totalMs) && mine.totalMs > 0) {
        return Math.max(0, Number(mine.totalMs));
      }
      if (Number.isFinite(baseElapsedMs) && baseElapsedMs >= 0) {
        return Math.max(0, baseElapsedMs);
      }
      return 0;
    };

    const syncBaseElapsed = () => {
      const derived = deriveBaseElapsed();
      if (!Number.isFinite(baseElapsedMs) || Math.abs(derived - baseElapsedMs) > 3) {
        baseElapsedMs = derived;
        resumeAnchorMs = Date.now();
      }
    };

    const updateTimerDisplay = () => {
      if (timerFrozen && Number.isFinite(timerFrozenMs)) {
        timerDisplay.textContent = formatSeconds(timerFrozenMs);
        return;
      }
      const base = Number.isFinite(baseElapsedMs) ? Math.max(0, baseElapsedMs) : 0;
      const running = Math.max(0, Date.now() - resumeAnchorMs);
      timerDisplay.textContent = formatSeconds(base + running);
    };

    const freezeTimer = (ms) => {
      if (timerFrozen && Number.isFinite(timerFrozenMs)) return;
      timerFrozen = true;
      const fallback = Number.isFinite(baseElapsedMs) ? Math.max(0, baseElapsedMs) : 0;
      timerFrozenMs = Number.isFinite(ms) ? Math.max(0, ms) : fallback;
      if (Number.isFinite(timerFrozenMs)) {
        baseElapsedMs = timerFrozenMs;
      }
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
      updateTimerDisplay();
    };

    syncBaseElapsed();
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
    syncBaseElapsed();
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

      const baseFromQuestions = (() => {
        if (Number.isFinite(qDoneMs) && qDoneMs > 0 && Number(questionsStartAt)) {
          return Math.max(0, qDoneMs - Number(questionsStartAt));
        }
        if (Number.isFinite(baseElapsedMs)) {
          return Math.max(0, baseElapsedMs);
        }
        return 0;
      })();
      baseElapsedMs = baseFromQuestions;
      resumeAnchorMs = Date.now();
      const mSeg = Math.max(0, markDoneMs - markingEnterAt);
      const totalMs = Math.max(0, baseFromQuestions + mSeg);
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
        freezeTimer(totalMs);
        updateOutcomeDisplay();
        updateDoneState();
        setTimeout(() => {
          location.hash = `#/stop?code=${code}&round=${round}`;
        }, 140);
      } catch (err) {
        console.warn("[marking] publish failed:", err);
        submitting = false;
        updateDoneState();
      }
    };

    doneBtn.addEventListener("click", publish);

    stopRoomWatch = onSnapshot(rRef, (snap) => {
      const data = snap.data() || {};
      if (Number((data.questions || {}).startAt)) {
        questionsStartAt = Number(data.questions.startAt);
        syncBaseElapsed();
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
      syncBaseElapsed();
      if (!timerFrozen) updateTimerDisplay();

      if (published && !latestTotalForMe) {
        const myTiming = latestRoundTimings[me.uid] || {};
        if (Number(myTiming.totalMs)) {
          latestTotalForMe = Number(myTiming.totalMs);
          showPostSubmit(latestTotalForMe);
        }
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
