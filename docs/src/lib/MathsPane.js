// /src/lib/MathsPane.js
//
// Jemima’s Maths Pane — inverted helper that now focuses on round clues.
// • Shows only the clue for the current round.
// • Watches the room document for live clue/maths updates.
// • Falls back to the supplied maths payload when Firestore is unavailable.

import { db } from "./firebase.js";
import { doc, onSnapshot } from "firebase/firestore";

const watcherMap = new WeakMap();

const clampCode = (value) =>
  String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 5);

const normaliseClue = (value) => {
  if (typeof value === "string") return value.trim();
  return "";
};

const clueFromMap = (map, round) => {
  if (!map || typeof map !== "object") return "";
  const direct = map[round];
  return normaliseClue(direct);
};

const clueFromArray = (arr, round) => {
  if (!Array.isArray(arr)) return "";
  const idx = round - 1;
  if (idx < 0 || idx >= arr.length) return "";
  return normaliseClue(arr[idx]);
};

function resolveClue(roomData = {}, fallbackMaths = {}, round = 1) {
  const fromRoom = clueFromMap(roomData.clues, round);
  if (fromRoom) return fromRoom;

  const fromRoomMaths = clueFromArray(roomData.maths?.clues, round);
  if (fromRoomMaths) return fromRoomMaths;

  const fromFallbackMaths = clueFromArray(fallbackMaths?.clues, round);
  if (fromFallbackMaths) return fromFallbackMaths;

  return "";
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

  const clueEl = document.createElement("div");
  clueEl.className = "mono maths-panel__clue";
  box.appendChild(clueEl);

  container.appendChild(box);

  const applyClue = (roomData = {}) => {
    const text = resolveClue(roomData, maths, round);
    clueEl.textContent = text;
    clueEl.classList.toggle("maths-panel__clue--empty", !text);
  };

  applyClue({ maths });

  const code = clampCode(roomCode);
  if (!code) {
    return;
  }

  let stop = null;
  stop = onSnapshot(doc(db, "rooms", code), (snap) => {
    if (!snap.exists()) {
      applyClue({ maths });
      return;
    }
    const roomData = snap.data() || {};
    if (!roomData.maths && maths) {
      roomData.maths = maths;
    }
    applyClue(roomData);
  }, (err) => {
    console.warn("[maths-pane] room watch error:", err);
  });

  watcherMap.set(container, () => {
    try { stop && stop(); } catch {}
  });
}

export default { mount };
