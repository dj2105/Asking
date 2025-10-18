// /src/views/Countdown.js
//
// Countdown phase — shared 3·2·1 timer anchored to Firestore.
// • Shows a bold monospace timer that counts real seconds (3 → 2 → 1 → 0).
// • Host ensures `countdown.startAt` exists (ms epoch). Guests simply wait for it.
// • When timer elapses, host flips the room to `state:"questions"`.
// • Both players navigate to /questions once the room state changes.
//
// Query params: ?code=ABC&round=N
// Firestore:
//   READ  rooms/{code} -> meta.hostUid/guestUid, countdown.startAt, state, round
//   WRITE (host only)
//     - Arm timer:   countdown.startAt = Date.now()+3000, state:"countdown", round (idempotent)
//     - On expiry:   state:"questions", countdown.startAt -> null
//
// Visual language: Courier, narrow column, minimal card.

import { ensureAuth, db } from "../lib/firebase.js";
import {
  doc,
  collection,
  getDoc,
  onSnapshot,
  updateDoc,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import {
  clampCode,
  getHashParams,
  timeUntil,
  getStoredRole,
} from "../lib/util.js";
import { applyTheme } from "../lib/theme.js";

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

export default {
  async mount(container) {
    const me = await ensureAuth();

    const qs = getHashParams();
    const code = clampCode(qs.get("code") || "");
    let round = parseInt(qs.get("round") || "1", 10) || 1;
    const themePhase = () => applyTheme({ phase: "countdown", round });
    themePhase();

    container.innerHTML = "";
    const root = el("div", { class: "view view-countdown stage-center stage-center--solo" });
    const timer = el("div", { class: "mono countdown-big" }, "5");
    root.appendChild(timer);
    container.appendChild(root);

    const reduceMotion = (() => {
      try {
        return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      } catch (err) {
        return false;
      }
    })();

    const pulseTimer = () => {
      if (reduceMotion) return;
      timer.classList.remove("countdown-tick");
      void timer.offsetWidth; // restart animation frame
      timer.classList.add("countdown-tick");
    };

    let lastDisplay = "5";
    pulseTimer();

    const rRef = roomRef(code);
    const snap0 = await getDoc(rRef);
    const room0 = snap0.data() || {};
    const { hostUid, guestUid } = room0.meta || {};
    const storedRole = getStoredRole(code);
    const myRole = storedRole === "host" || storedRole === "guest"
      ? storedRole
      : hostUid === me.uid ? "host" : guestUid === me.uid ? "guest" : "guest";

    let countdownStartAt = Number(room0?.countdown?.startAt || 0) || 0;
    let hasFlipped = false;
    let roundReady = false;
    let stopRoundWatch = null;
    const roundsCol = roundSubColRef(code);

    // Allow round label to follow doc updates (e.g., if host armed next round before guest arrived)
    if (Number(room0.round)) {
      round = Number(room0.round);
    }

    const watchRoundDoc = (rNum) => {
      if (stopRoundWatch) { try { stopRoundWatch(); } catch {} }
      const docRef = doc(roundsCol, String(rNum));
      stopRoundWatch = onSnapshot(docRef, (snap) => {
        const d = snap.data() || {};
        const hostItems = Array.isArray(d.hostItems) ? d.hostItems.length : 0;
        const guestItems = Array.isArray(d.guestItems) ? d.guestItems.length : 0;
        roundReady = hostItems === 3 && guestItems === 3;
      }, (err) => {
        console.warn("[countdown] round snapshot error:", err);
      });
    };

    watchRoundDoc(round);

    const stop = onSnapshot(rRef, (snap) => {
      const data = snap.data() || {};

      if (Number(data.round) && Number(data.round) !== round) {
        round = Number(data.round);
        roundReady = false;
        watchRoundDoc(round);
        themePhase();
      }

      const remoteStart = Number(data?.countdown?.startAt || 0) || 0;
      if (remoteStart && remoteStart !== countdownStartAt) {
        countdownStartAt = remoteStart;
        hasFlipped = false;
        lastDisplay = null;
      }
      if (!remoteStart) {
        if (countdownStartAt) {
          lastDisplay = null;
        }
        countdownStartAt = 0;
        hasFlipped = false;
      }

      if (data.state === "questions") {
        setTimeout(() => {
          location.hash = `#/questions?code=${code}&round=${round}`;
        }, 80);
        return;
      }

      if (data.state && data.state !== "countdown") {
        // Fallback routing if we landed late
        let target = null;
        if (data.state === "marking") target = `#/marking?code=${code}&round=${round}`;
        else if (data.state === "award") target = `#/award?code=${code}&round=${round}`;
        else if (data.state === "maths") target = `#/maths?code=${code}`;
        else if (data.state === "final") target = `#/final?code=${code}`;
        if (target) {
          setTimeout(() => { location.hash = target; }, 80);
        }
        return;
      }

    }, (err) => {
      console.warn("[countdown] snapshot error:", err);
    });

    const tick = setInterval(async () => {
      if (!countdownStartAt) {
        if (lastDisplay !== "5") {
          lastDisplay = "5";
          timer.textContent = "5";
          pulseTimer();
        }
        return;
      }

      const remainMs = timeUntil(countdownStartAt);
      const secs = Math.ceil(remainMs / 1000);
      const display = String(secs > 0 ? secs : 0);
      if (display !== lastDisplay) {
        lastDisplay = display;
        timer.textContent = display;
        pulseTimer();
      }

      if (remainMs <= 0 && !hasFlipped) {
        if (!roundReady) {
          return;
        }
        hasFlipped = true;
        if (myRole === "host") {
          try {
            console.log(`[flow] countdown -> questions | code=${code} round=${round} role=${myRole}`);
            const now = Date.now();
            const roundDocRef = doc(roundsCol, String(round));
            await Promise.all([
              updateDoc(rRef, {
                state: "questions",
                "countdown.startAt": null,
                "timestamps.updatedAt": serverTimestamp()
              }),
              setDoc(roundDocRef, { timingsMeta: { questionsStartAt: now } }, { merge: true })
            ]);
          } catch (err) {
            console.warn("[countdown] failed to flip to questions:", err);
            hasFlipped = false; // allow retry
          }
        }
      }
    }, 200);

    this.unmount = () => {
      try { stop && stop(); } catch {}
      try { clearInterval(tick); } catch {}
      if (stopRoundWatch) { try { stopRoundWatch(); } catch {} }
    };
  },

  async unmount() { /* handled in instance */ }
};
