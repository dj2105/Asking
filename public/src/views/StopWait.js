// /src/views/StopWait.js
//
// Post-marking waiting room — appears after a player taps STOP.
// • First finisher sees "waiting for <opponent>" until the other submits.
// • Host finalises the snippet race once both have stopped, pushing everyone to Award.
// • Guests simply idle here until the room state flips.

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

function same(a, b) {
  return String(a || "").trim() === String(b || "").trim();
}

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

export default {
  async mount(container) {
    const me = await ensureAuth();

    const qs = getHashParams();
    const code = clampCode(qs.get("code") || "");
    let round = parseInt(qs.get("round") || "1", 10) || 1;

    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    container.innerHTML = "";
    const root = el("div", { class: "view view-stopwait" });
    const title = el("h1", { class: "title" }, `Round ${round}`);
    root.appendChild(title);

    const card = el("div", { class: "card", style: "text-align:center" });
    const tag = el("div", { class: "mono", style: "margin-bottom:8px;" }, `Room ${code}`);
    card.appendChild(tag);

    const msg = el("div", {
      class: "mono",
      style: "font-size:1.15em;line-height:1.45;margin:24px auto;max-width:420px;white-space:pre-wrap;",
    }, "Waiting for opponent…");
    card.appendChild(msg);

    const sub = el("div", {
      class: "mono small",
      style: "opacity:.8;",
    }, "Timer paused. Hold tight.");
    card.appendChild(sub);

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
    const oppName = myRole === "host" ? "Jaime" : "Daniel";

    let ackMine = Boolean(((roomData0.markingAck || {})[myRole] || {})[round]);
    let ackOpp = Boolean(((roomData0.markingAck || {})[oppRole] || {})[round]);
    let finalizeInFlight = false;
    let snippetResolved = false;

    const updateMessage = () => {
      if (!ackMine) {
        msg.textContent = "Re-opening marking…";
        return;
      }
      if (!ackOpp) {
        msg.textContent = `You finished first. Waiting for ${oppName}…`;
        sub.textContent = "Timer paused. They’ll be here soon.";
        return;
      }
      if (!snippetResolved) {
        msg.textContent = "Both players stopped. Linking your snippets…";
        sub.textContent = "Timer paused. Don’t touch anything.";
        return;
      }
      msg.textContent = "Link complete. Sending you to the award screen…";
      sub.textContent = "Timer paused.";
    };

    updateMessage();

    const finalizeSnippet = async (attempt = 0) => {
      if (snippetResolved || finalizeInFlight || myRole !== "host") return;
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
          const ackData = roomData.markingAck || {};
          const ackHost = Boolean((ackData.host || {})[round]);
          const ackGuest = Boolean((ackData.guest || {})[round]);
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

          tx.update(rRef, {
            state: "award",
            "scores.questions.host": nextHost,
            "scores.questions.guest": nextGuest,
            "marking.startAt": null,
            "roundTimer.startAt": null,
            "countdown.startAt": null,
            "timestamps.updatedAt": serverTimestamp(),
          });

          tx.set(rdRef, { snippetWinnerUid: winnerUid || null, snippetTie: tie }, { merge: true });

          const hostDocIds = uniqueList([hostEntry.uid, hostId, meta.hostUid]);
          const guestDocIds = uniqueList([guestEntry.uid, guestId, meta.guestUid]);

          hostDocIds.forEach((id) => {
            if (!id) return;
            const patchHost = { retainedSnippets: {} };
            patchHost.retainedSnippets[round] = tie || (winnerUid && winnerUid === hostEntry.uid);
            tx.set(doc(rRef, "players", id), patchHost, { merge: true });
          });
          guestDocIds.forEach((id) => {
            if (!id) return;
            const patchGuest = { retainedSnippets: {} };
            patchGuest.retainedSnippets[round] = tie || (winnerUid && winnerUid === guestEntry.uid);
            tx.set(doc(rRef, "players", id), patchGuest, { merge: true });
          });
        });
        snippetResolved = true;
        updateMessage();
      } catch (err) {
        console.warn("[stopwait] finalize failed:", err);
        if (attempt < 2) {
          setTimeout(() => finalizeSnippet(attempt + 1), 400 * (attempt + 1));
        }
      } finally {
        finalizeInFlight = false;
      }
    };

    const stopRoomWatch = onSnapshot(rRef, (snap) => {
      const data = snap.data() || {};

      if (Number(data.round) && Number(data.round) !== round) {
        round = Number(data.round);
        title.textContent = `Round ${round}`;
      }

      ackMine = Boolean(((data.markingAck || {})[myRole] || {})[round]);
      ackOpp = Boolean(((data.markingAck || {})[oppRole] || {})[round]);
      updateMessage();

      const state = (data.state || "").toLowerCase();
      if (state === "award") {
        snippetResolved = true;
        updateMessage();
        setTimeout(() => { location.hash = `#/award?code=${code}&round=${round}`; }, 120);
        return;
      }

      if (state === "countdown") {
        setTimeout(() => { location.hash = `#/countdown?code=${code}&round=${data.round || round}`; }, 120);
        return;
      }

      if (state === "questions") {
        setTimeout(() => { location.hash = `#/questions?code=${code}&round=${data.round || round}`; }, 120);
        return;
      }

      if (state === "maths") {
        setTimeout(() => { location.hash = `#/maths?code=${code}`; }, 120);
        return;
      }

      if (state === "final") {
        setTimeout(() => { location.hash = `#/final?code=${code}`; }, 120);
        return;
      }

      if (myRole === "host" && ackMine && ackOpp && !snippetResolved) {
        finalizeSnippet();
      }
    }, (err) => {
      console.warn("[stopwait] room watch error:", err);
    });

    const stopRoundWatch = onSnapshot(rdRef, (snap) => {
      const data = snap.data() || {};
      if (myRole === "host" && ackMine && ackOpp && !snippetResolved) {
        finalizeSnippet();
      }
    }, (err) => {
      console.warn("[stopwait] round watch error:", err);
    });

    this.unmount = () => {
      try { stopRoomWatch && stopRoomWatch(); } catch {}
      try { stopRoundWatch && stopRoundWatch(); } catch {}
    };
  },

  async unmount() { /* handled in instance */ }
};
