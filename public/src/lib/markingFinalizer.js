// /src/lib/markingFinalizer.js
//
// Shared helper to finalise the marking phase once both players have
// acknowledged their STOP press. Runs the same transaction that used to live
// inline in Marking.js so views can safely re-use it.

import { db } from "./firebase.js";
import {
  doc,
  collection,
  serverTimestamp,
  runTransaction,
} from "firebase/firestore";

function roomRef(code) {
  return doc(db, "rooms", code);
}

function roundRef(code, round) {
  return doc(collection(roomRef(code), "rounds"), String(round));
}

function same(a, b) {
  return String(a || "").trim() === String(b || "").trim();
}

const uniqueList = (arr = []) => Array.from(new Set(arr.filter(Boolean)));

const resolveTimingForRole = (timings = {}, roleName, fallbackIds = []) => {
  const want = String(roleName || "").toLowerCase();
  if (!want) return null;
  const entries = Object.entries(timings || {});
  for (const [uid, infoRaw] of entries) {
    const info = infoRaw || {};
    if (String(info.role || "").toLowerCase() === want) {
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

export async function finalizeMarkingRace({ code, round }) {
  const trimmed = String(code || "").trim().toUpperCase();
  const roundNum = Number(round);
  if (!trimmed || !Number.isFinite(roundNum) || roundNum <= 0) {
    return false;
  }

  const rRef = roomRef(trimmed);
  const rdRef = roundRef(trimmed, roundNum);

  let resolved = false;

  await runTransaction(db, async (tx) => {
    const roomSnapCur = await tx.get(rRef);
    if (!roomSnapCur.exists()) return;
    const roomData = roomSnapCur.data() || {};
    if ((roomData.state || "").toLowerCase() !== "marking") return;

    const meta = roomData.meta || {};
    const hostId = meta.hostUid || "";
    const guestId = meta.guestUid || "";
    const ackHost = Boolean(((roomData.markingAck || {}).host || {})[roundNum]);
    const ackGuest = Boolean(((roomData.markingAck || {}).guest || {})[roundNum]);
    if (!(ackHost && ackGuest)) return;

    const roundSnapCur = await tx.get(rdRef);
    if (!roundSnapCur.exists()) return;
    const roundData = roundSnapCur.data() || {};
    const timings = roundData.timings || {};
    const hostEntry = resolveTimingForRole(timings, "host", [meta.hostUid]);
    const guestEntry = resolveTimingForRole(timings, "guest", [meta.guestUid]);
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

    const answersHost = (((roomData.answers || {}).host || {})[roundNum] || []);
    const answersGuest = (((roomData.answers || {}).guest || {})[roundNum] || []);
    const countCorrect = (arr = []) => arr.reduce((acc, ans) => acc + (same(ans?.chosen, ans?.correct) ? 1 : 0), 0);
    const roundHostScore = countCorrect(answersHost);
    const roundGuestScore = countCorrect(answersGuest);
    const baseScores = ((roomData.scores || {}).questions) || {};
    const nextHost = Number(baseScores.host || 0) + roundHostScore;
    const nextGuest = Number(baseScores.guest || 0) + roundGuestScore;

    const currentRound = Number(roomData.round) || roundNum;

    tx.update(rRef, {
      state: "award",
      round: currentRound,
      "scores.questions.host": nextHost,
      "scores.questions.guest": nextGuest,
      "marking.startAt": null,
      "timestamps.updatedAt": serverTimestamp(),
      "countdown.startAt": null
    });

    tx.set(rdRef, { snippetWinnerUid: winnerUid || null, snippetTie: tie }, { merge: true });

    const hostWon = tie || (winnerUid && winnerUid === hostEntry.uid);
    const guestWon = tie || (winnerUid && winnerUid === guestEntry.uid);
    const hostDocIds = uniqueList([hostEntry.uid, hostId, meta.hostUid]);
    const guestDocIds = uniqueList([guestEntry.uid, guestId, meta.guestUid]);

    hostDocIds.forEach((id) => {
      if (!id) return;
      const patchHost = { retainedSnippets: {} };
      patchHost.retainedSnippets[roundNum] = hostWon;
      tx.set(doc(rRef, "players", id), patchHost, { merge: true });
    });
    guestDocIds.forEach((id) => {
      if (!id) return;
      const patchGuest = { retainedSnippets: {} };
      patchGuest.retainedSnippets[roundNum] = guestWon;
      tx.set(doc(rRef, "players", id), patchGuest, { merge: true });
    });

    resolved = true;
  });

  return resolved;
}

export default {
  finalizeMarkingRace,
};

