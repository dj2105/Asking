// /src/roomWatcher.js
// Central watcher that maps room.state -> route safely.
// - Debounces transient/undefined states (no spurious hops to Lobby)
// - Only navigates when target route actually changes
// - Understands all phases: seeding, countdown, questions, marking, interlude, award, final
// - Works as a "view" at #/watcher?code=XYZ OR as a helper you can call from other views

import { ensureAuth, db } from "./lib/firebase.js";
import { doc, onSnapshot } from "firebase/firestore";

const roomRef = (code) => doc(db, "rooms", code);

// --- tiny DOM helper for the standalone #/watcher view ---
function el(tag, attrs = {}, kids = []) {
  const n = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (k === "class") n.className = v;
    else n.setAttribute(k, v);
  }
  (Array.isArray(kids) ? kids : [kids]).forEach(c =>
    n.appendChild(typeof c === "string" ? document.createTextNode(c) : c)
  );
  return n;
}

const clampCode = (s) => String(s || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
function getHashParams() {
  const raw = window.location.hash || "";
  return new URLSearchParams(raw.split("?")[1] || "");
}
function getQueryCode() {
  return clampCode(getHashParams().get("code") || "");
}

function computeRound(room = {}) {
  const fromTop = Number(room.round);
  if (Number.isFinite(fromTop) && fromTop > 0) return fromTop;
  const fromMeta = Number(room.meta?.round);
  if (Number.isFinite(fromMeta) && fromMeta > 0) return fromMeta;
  return 1;
}

function targetForState(state, code, round) {
  const r = round || 1;
  switch (String(state || "").toLowerCase()) {
    case "countdown":
      return `#/countdown?code=${code}&round=${r}`;
    case "questions":
      return `#/questions?code=${code}&round=${r}`;
    case "marking":
      return `#/marking?code=${code}&round=${r}`;
    case "interlude":
      return `#/interlude?code=${code}&round=${r}`;
    case "award":
      return `#/award?code=${code}&round=${r}`;
    case "keyroom":
      return null; // stay put; guests shouldn’t be routed into the key room
    case "maths":
      return `#/maths?code=${code}`;
    case "final":
      return `#/final?code=${code}`;
    case "lobby":
      return "#/lobby";
    default:
      return null;
  }
}

// Avoid routing loops
function sameRoute(a, b){ return String(a||"") === String(b||""); }

// Public API if you want to start watching from any view
export function startRoomWatcher(code, { onState } = {}) {
  const c = clampCode(code);
  if (!c) {
    console.warn("[watcher] startRoomWatcher called without code");
    return () => {};
  }

  let unknownSince = 0;
  let lastPushed = null;

  const stop = onSnapshot(
    roomRef(c),
    (snap) => {
      if (!snap.exists()) {
        if (typeof onState === "function") {
          try { onState({ state: null, round: 1, room: null, exists: false }); } catch {}
        }
        if (!unknownSince) unknownSince = Date.now();
        if (Date.now() - unknownSince > 1500) {
          const safe = "#/lobby";
          if (!sameRoute(safe, window.location.hash)) {
            lastPushed = safe;
            console.log(`[watcher] state=missing round=1 → nav ${safe}`);
            window.location.hash = safe;
          }
        }
        return;
      }

      const room = snap.data() || {};
      const state = room.state || "";
      const round = computeRound(room);

      if (typeof onState === "function") {
        try { onState({ state, round, room, exists: true }); } catch {}
      }

      if (state.toLowerCase() === "coderoom") {
        unknownSince = 0;
        return;
      }

      if (state.toLowerCase() === "seeding") {
        unknownSince = 0;
        return; // stay on watcher with waiting copy
      }

      const target = targetForState(state, c, round);

      if (target) {
        unknownSince = 0;
        if (!sameRoute(target, window.location.hash) && lastPushed !== target) {
          lastPushed = target;
          console.log(`[watcher] state=${state || "unknown"} round=${round} → nav ${target}`);
          window.location.hash = target;
        }
        return;
      }

      if (!unknownSince) unknownSince = Date.now();
      if (Date.now() - unknownSince > 1500) {
        const safe = "#/lobby";
        if (!sameRoute(safe, window.location.hash)) {
          lastPushed = safe;
          console.log(`[watcher] state=${state || "unknown"} round=${round} → nav ${safe}`);
          window.location.hash = safe;
        }
      }
    },
    (err) => {
      console.warn("[watcher] snapshot error:", err?.message || err);
    }
  );

  return () => {
    try { stop(); } catch {}
  };
}

// --- Default export as a minimal "view" for #/watcher?code=XYZ ---
export default {
  async mount(container){
    await ensureAuth();

    const code = getQueryCode();
    container.innerHTML = "";
    const wrapper = el("div", { class: "view view-watcher" });
    const card = el("div", { class: "card seeding-card" }, [
      el("div", { class: "card-eyebrow mono" }, "Watching for Daniel"),
      el("div", { class: "card-title" }, code ? `Room ${code}` : "Room unknown"),
      el("div", { class: "status-line mono", id: "wstatus" }, "Waiting for room state…")
    ]);
    wrapper.appendChild(card);
    container.appendChild(wrapper);

    const statusEl = card.querySelector("#wstatus");
    this._stop = startRoomWatcher(code, {
      onState: ({ state, round, exists }) => {
        if (state && state.toLowerCase() === "seeding") {
          statusEl.textContent = "Waiting for Daniel…";
          return;
        }
        if (!exists) {
          statusEl.textContent = "Room not found.";
          return;
        }
        statusEl.textContent = state
          ? `State: ${state} • Round ${round || 1}`
          : "Waiting for room state…";
      }
    });
  },
  async unmount(){
    if (this._stop) this._stop();
    this._stop = null;
  }
};
