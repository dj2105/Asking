// /src/views/MarkingWait.js
//
// Transitional wait screen after a player presses STOP during marking.
// • First finisher sees "waiting for <opponent>" while the other marks.
// • When both players have stopped, host finalises snippet outcome and
//   flips the room to the award phase.
// • Guests simply wait for the state change and follow along.

import { ensureAuth, db } from "../lib/firebase.js";
import {
  doc,
  collection,
  getDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
} from "firebase/firestore";

import { clampCode, getHashParams, getStoredRole } from "../lib/util.js";

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

const roomRef = (code) => doc(db, "rooms", code);
const roundSubColRef = (code) => collection(roomRef(code), "rounds");

const nameForRole = (role) => (role === "host" ? "Daniel" : "Jaime");

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

function same(a, b) {
  return String(a || "").trim() === String(b || "").trim();
}

export default {
  async mount(container) {
    const me = await ensureAuth();

    const params = getHashParams();
    const code = clampCode(params.get("code") || "");
    let round = parseInt(params.get("round") || "1", 10) || 1;

    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    container.innerHTML = "";
    const root = el("div", { class: "view view-marking-wait" });
    const title = el("h1", { class: "title" }, `Round ${round}`);
    root.appendChild(title);

    const card = el("div", { class: "card" });
    const tag = el("div", { class: "mono", style: "text-align:center;margin-bottom:8px;" }, `Room ${code}`);
    card.appendChild(tag);

    const headline = el("div", {
      class: "mono",
      style: "text-align:center;font-weight:700;font-size:22px;margin-bottom:12px;"
    }, "Timer paused.");
    card.appendChild(headline);

    const statusLine = el("div", {
      class: "mono",
      style: "text-align:center;font-size:18px;min-height:48px;white-space:pre-line;"
    }, "Linking opponents…");
    card.appendChild(statusLine);

    root.appendChild(card);
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
    const oppName = nameForRole(oppRole);

    let ackMine = Boolean(((roomData0.markingAck || {})[myRole] || {})[round]);
    let ackOpp = Boolean(((roomData0.markingAck || {})[oppRole] || {})[round]);
    let finalizeInFlight = false;
    let finalizeDone = false;
    let stopRoomWatch = null;
    let stopRoundWatch = null;

    const updateStatus = () => {
      if (!ackMine) {
        statusLine.textContent = "Reopening marking…";
        return;
      }
      if (!ackOpp) {
        statusLine.textContent = `You finished first, waiting for ${oppName}.`;
        return;
      }
      statusLine.textContent = "Both players stopped. Preparing awards…";
    };

    updateStatus();

    const finalizeSnippet = async (attempt = 0) => {
      if (finalizeDone || finalizeInFlight || myRole !== "host") return;
      finalizeInFlight = true;
      try {
        await runTransaction(db, async (tx) => {
          const roomSnapCur = await tx.get(rRef);
          if (!roomSnapCur.exists()) return;
          const roomData = roomSnapCur.data() || {};
          if ((roomData.state || "").toLowerCase() !== "marking") return;

          const ackData = roomData.markingAck || {};
          const hostAck = Boolean((ackData.host || {})[round]);
          const guestAck = Boolean((ackData.guest || {})[round]);
          if (!(hostAck && guestAck)) return;

          const roundSnapCur = await tx.get(rdRef);
          if (!roundSnapCur.exists()) return;
          const roundData = roundSnapCur.data() || {};
          const timings = roundData.timings || {};

          const hostEntry = resolveTimingForRole(timings, "host", [roomData.meta?.hostUid, hostUid]);
          const guestEntry = resolveTimingForRole(timings, "guest", [roomData.meta?.guestUid, guestUid]);
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

          const hostDocIds = uniqueList([hostEntry.uid, roomData.meta?.hostUid, hostUid]);
          const guestDocIds = uniqueList([guestEntry.uid, roomData.meta?.guestUid, guestUid]);
          const hostWon = tie || (winnerUid && winnerUid === hostEntry.uid);
          const guestWon = tie || (winnerUid && winnerUid === guestEntry.uid);

          hostDocIds.forEach((id) => {
            if (!id) return;
            const patch = { retainedSnippets: {} };
            patch.retainedSnippets[round] = hostWon;
            tx.set(doc(rRef, "players", id), patch, { merge: true });
          });

          guestDocIds.forEach((id) => {
            if (!id) return;
            const patch = { retainedSnippets: {} };
            patch.retainedSnippets[round] = guestWon;
            tx.set(doc(rRef, "players", id), patch, { merge: true });
          });
        });
        finalizeDone = true;
      } catch (err) {
        console.warn("[marking-wait] finalize failed:", err);
        if (attempt < 2) {
          setTimeout(() => finalizeSnippet(attempt + 1), 400 * (attempt + 1));
        }
      } finally {
        finalizeInFlight = false;
      }
    };

    stopRoundWatch = onSnapshot(rdRef, (snap) => {
      const data = snap.data() || {};
      if (ackMine && ackOpp && myRole === "host" && !finalizeDone) {
        finalizeSnippet();
      }
    }, (err) => {
      console.warn("[marking-wait] round snapshot error:", err);
    });

    stopRoomWatch = onSnapshot(rRef, (snap) => {
      const data = snap.data() || {};

      if (Number(data.round) && Number(data.round) !== round) {
        round = Number(data.round);
        title.textContent = `Round ${round}`;
      }

      const ackData = data.markingAck || {};
      ackMine = Boolean((ackData[myRole] || {})[round]);
      ackOpp = Boolean((ackData[oppRole] || {})[round]);
      updateStatus();

      if (!ackMine) {
        setTimeout(() => { location.hash = `#/marking?code=${code}&round=${round}`; }, 80);
        return;
      }

      if (ackMine && ackOpp && myRole === "host" && !finalizeDone) {
        finalizeSnippet();
      }

      const state = String(data.state || "").toLowerCase();
      if (state === "award") {
        setTimeout(() => { location.hash = `#/award?code=${code}&round=${round}`; }, 80);
        return;
      }
      if (state === "marking") {
        return;
      }
      if (state === "countdown") {
        setTimeout(() => { location.hash = `#/countdown?code=${code}&round=${data.round || round}`; }, 80);
        return;
      }
      if (state === "questions") {
        setTimeout(() => { location.hash = `#/questions?code=${code}&round=${data.round || round}`; }, 80);
        return;
      }
      if (state === "maths") {
        setTimeout(() => { location.hash = `#/maths?code=${code}`; }, 80);
        return;
      }
      if (state === "final") {
        setTimeout(() => { location.hash = `#/final?code=${code}`; }, 80);
      }
    }, (err) => {
      console.warn("[marking-wait] room snapshot error:", err);
    });

    this.unmount = () => {
      try { stopRoomWatch && stopRoomWatch(); } catch {}
      try { stopRoundWatch && stopRoundWatch(); } catch {}
    };
  },

  async unmount() { /* handled above */ }
};

