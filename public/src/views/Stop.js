// /src/views/Stop.js
//
// Stop handoff view — shown after a player taps STOP in marking.
// • First finisher waits here for the opponent.
// • Host finalises timings + snippet winner once both players have stopped.
// • When state flips to award, both players are routed to the award screen.

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

const roomRef = (code) => doc(db, "rooms", code);
const roundSubColRef = (code) => collection(roomRef(code), "rounds");

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

const same = (a, b) => String(a || "").trim() === String(b || "").trim();

export default {
  async mount(container) {
    const me = await ensureAuth();

    const params = getHashParams();
    const code = clampCode(params.get("code") || "");
    let round = parseInt(params.get("round") || "1", 10) || 1;

    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    container.innerHTML = "";
    const root = el("div", { class: "view view-stop" });
    const title = el("h1", { class: "title" }, `Round ${round}`);
    root.appendChild(title);

    const card = el("div", { class: "card" });
    const tag = el("div", { class: "mono", style: "text-align:center;margin-bottom:8px;" }, `Room ${code}`);
    card.appendChild(tag);

    const status = el("div", {
      class: "mono",
      style: "text-align:center;font-weight:700;font-size:20px;margin:20px auto 6px;max-width:360px;white-space:pre-wrap;"
    }, "Linking opponent…");
    card.appendChild(status);

    const subline = el("div", {
      class: "mono small",
      style: "text-align:center;opacity:.8;max-width:360px;margin:0 auto;"
    }, "If you navigated here by mistake, stay put – we’ll jump to awards when ready.");
    card.appendChild(subline);

    root.appendChild(card);
    container.appendChild(root);

    const rRef = roomRef(code);
    let rdRef = doc(roundSubColRef(code), String(round));

    const roomSnap = await getDoc(rRef);
    const roomData0 = roomSnap.data() || {};
    if (!round || round <= 0) {
      const roomRound = Number(roomData0.round);
      if (Number.isFinite(roomRound) && roomRound > 0) {
        round = roomRound;
        title.textContent = `Round ${round}`;
        rdRef = doc(roundSubColRef(code), String(round));
      }
    }
    const { hostUid, guestUid } = roomData0.meta || {};
    const storedRole = getStoredRole(code);
    const myRole = storedRole === "host" || storedRole === "guest"
      ? storedRole
      : hostUid === me.uid ? "host" : guestUid === me.uid ? "guest" : "guest";
    const oppRole = myRole === "host" ? "guest" : "host";
    const myName = nameForRole(myRole);
    const oppName = nameForRole(oppRole);

    let ackMine = Boolean(((roomData0.markingAck || {})[myRole] || {})[round]);
    let ackOpp = Boolean(((roomData0.markingAck || {})[oppRole] || {})[round]);
    let finalizing = false;
    let finalized = false;
    let currentRound = round;

    const updateStatus = () => {
      if (ackMine && ackOpp) {
        status.textContent = "Both players stopped. Preparing awards…";
        return;
      }
      if (ackMine) {
        status.textContent = `Waiting for ${oppName}…`;
        return;
      }
      status.textContent = `Hold tight, ${myName}…`;
    };

    updateStatus();

    const finalizeIfReady = async () => {
      if (finalized || finalizing) return;
      if (myRole !== "host") return;
      if (!(ackMine && ackOpp)) return;
      finalizing = true;
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

          const activeRound = Number(roomData.round) || round;

          tx.update(rRef, {
            state: "award",
            round: activeRound,
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
        finalized = true;
      } catch (err) {
        console.warn("[stop] finalize failed:", err);
      } finally {
        finalizing = false;
      }
    };

    const stopRoomWatch = onSnapshot(rRef, (snap) => {
      const data = snap.data() || {};
      if (Number(data.round)) {
        currentRound = Number(data.round);
        title.textContent = `Round ${currentRound}`;
      }

      ackMine = Boolean(((data.markingAck || {})[myRole] || {})[round]);
      ackOpp = Boolean(((data.markingAck || {})[oppRole] || {})[round]);
      updateStatus();

      if (ackMine && ackOpp && myRole === "host") {
        finalizeIfReady();
      }

      if (data.state === "award") {
        setTimeout(() => {
          location.hash = `#/award?code=${code}&round=${currentRound}`;
        }, 120);
        return;
      }

      if (data.state === "questions") {
        setTimeout(() => { location.hash = `#/questions?code=${code}&round=${currentRound}`; }, 120);
        return;
      }

      if (data.state === "countdown") {
        setTimeout(() => { location.hash = `#/countdown?code=${code}&round=${currentRound}`; }, 120);
        return;
      }

      if (data.state === "maths") {
        setTimeout(() => { location.hash = `#/maths?code=${code}`; }, 120);
        return;
      }

      if (data.state === "final") {
        setTimeout(() => { location.hash = `#/final?code=${code}`; }, 120);
      }
    }, (err) => {
      console.warn("[stop] room snapshot error:", err);
    });

    const stopRoundWatch = onSnapshot(rdRef, (snap) => {
      const data = snap.data() || {};
      if (data && typeof data.snippetTie !== "undefined") {
        finalized = finalized || Boolean(data.snippetTie) || Boolean(data.snippetWinnerUid);
      }
    }, (err) => {
      console.warn("[stop] round snapshot error:", err);
    });

    this.unmount = () => {
      try { stopRoomWatch && stopRoomWatch(); } catch {}
      try { stopRoundWatch && stopRoundWatch(); } catch {}
    };
  },

  async unmount() { /* handled per-instance */ }
};
