// /src/lib/MathsPane.js
//
// Jemima’s Maths Pane — inverted helper that now focuses on reveal access.
// • Shows which round reveals the current player has earned (fastest time wins).
// • Watches the room document for timings + reveal content.
// • Falls back to a friendly placeholder until any reveals are unlocked.

import { db } from "./firebase.js";
import { doc, onSnapshot } from "firebase/firestore";

const watcherMap = new WeakMap();

const clampCode = (value) =>
  String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 5);

function normaliseReveal(entry) {
  if (!entry) return "";
  if (typeof entry === "string") return entry;
  if (typeof entry === "object") {
    if (typeof entry.prompt === "string") return entry.prompt;
    if (typeof entry.text === "string") return entry.text;
    if (typeof entry.value === "string") return entry.value;
  }
  return "";
}

function determineRole(room = {}, userUid = "") {
  const meta = room.meta || {};
  if (userUid && meta.hostUid === userUid) return "host";
  if (userUid && meta.guestUid === userUid) return "guest";
  return "guest";
}

function collectReveals(room = {}, role = "guest") {
  const timings = room.timings || {};
  const hostTimings = timings.host || {};
  const guestTimings = timings.guest || {};
  const revealsMap = room.reveals || {};
  const mathsReveals = Array.isArray(room.maths?.reveals) ? room.maths.reveals : [];

  const entries = [];
  for (let round = 1; round <= 5; round += 1) {
    const hostTiming = Number((hostTimings[round] || {}).totalSeconds);
    const guestTiming = Number((guestTimings[round] || {}).totalSeconds);
    const revealText = normaliseReveal(revealsMap[round] ?? mathsReveals[round - 1]);
    if (!revealText) continue;
    if (!Number.isFinite(hostTiming) || !Number.isFinite(guestTiming)) continue;
    if (hostTiming === guestTiming) continue;
    const hostFaster = hostTiming < guestTiming;
    const winnerRole = hostFaster ? "host" : "guest";
    if (winnerRole === role) {
      entries.push({ round, text: revealText });
    }
  }
  return entries;
}

function renderList(listEl, entries, currentRound) {
  listEl.innerHTML = "";
  if (!entries.length) {
    const item = document.createElement("li");
    item.className = "maths-panel__item maths-panel__item--subtle";
    item.textContent = "No reveals unlocked yet.";
    listEl.appendChild(item);
    return;
  }
  entries
    .sort((a, b) => a.round - b.round)
    .forEach(({ round, text }) => {
      const li = document.createElement("li");
      li.className = "maths-panel__item";
      if (round === currentRound) li.classList.add("maths-panel__item--bold");
      li.textContent = `Round ${round}: ${text}`;
      listEl.appendChild(li);
    });
}

export function mount(container, { maths, round = 1, roomCode, userUid } = {}) {
  if (!container) return;

  const prevCleanup = watcherMap.get(container);
  if (typeof prevCleanup === "function") {
    try { prevCleanup(); } catch {}
  }
  watcherMap.delete(container);

  container.innerHTML = "";
  const box = document.createElement("div");
  box.className = "jemima-maths-box mono";

  const heading = document.createElement("div");
  heading.className = "mono maths-panel__heading";
  heading.textContent = "Unlocked reveals";
  box.appendChild(heading);

  const listEl = document.createElement("ul");
  listEl.className = "mono maths-panel__list";
  box.appendChild(listEl);

  container.appendChild(box);

  const code = clampCode(roomCode);
  if (!code || !userUid) {
    renderList(listEl, [], round);
    return;
  }

  let stop = null;
  stop = onSnapshot(doc(db, "rooms", code), (snap) => {
    if (!snap.exists()) {
      renderList(listEl, [], round);
      return;
    }
    const roomData = snap.data() || {};
    // Prefer live maths info but fallback to prop for initial render.
    if (!roomData.maths && maths) {
      roomData.maths = maths;
    }
    const role = determineRole(roomData, userUid);
    const entries = collectReveals(roomData, role);
    renderList(listEl, entries, round);
  }, (err) => {
    console.warn("[maths-pane] room watch error:", err);
  });

  watcherMap.set(container, () => {
    try { stop && stop(); } catch {}
  });
}

export default { mount };
