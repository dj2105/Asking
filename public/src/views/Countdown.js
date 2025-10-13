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
} from "firebase/firestore";
import {
  clampCode,
  getHashParams,
  timeUntil,
  getStoredRole,
} from "../lib/util.js";

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

    // per-view hue
    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    container.innerHTML = "";
    const root = el("div", { class: "view view-countdown" });
    const title = el("h1", { class: "title" }, `Round ${round}`);
    root.appendChild(title);

    const card = el("div", { class: "card" });
    const tag = el("div", { class: "mono", style: "text-align:center;margin-bottom:8px;" }, `Room ${code}`);
    card.appendChild(tag);

    const msg = el("div", { class: "mono", style: "text-align:center;opacity:.8;margin-bottom:12px;" }, "Get ready…");
    card.appendChild(msg);

    const timer = el("div", {
      class: "mono",
      style: "font-size:64px;line-height:1;text-align:center;font-weight:700;"
    }, "—");
    card.appendChild(timer);

    const sub = el("div", { class: "mono small", style: "text-align:center;margin-top:12px;" }, "Waiting for host…");
    card.appendChild(sub);

    root.appendChild(card);
    container.appendChild(root);

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
      title.textContent = `Round ${round}`;
    }

    const updateSubMessage = () => {
      if (!countdownStartAt) {
        sub.textContent = myRole === "host"
          ? "Press Start in the Key Room when Jaime has joined."
          : "Waiting for Daniel to press Start…";
      } else if (!roundReady) {
        sub.textContent = "Preparing questions…";
      } else {
        sub.textContent = "";
      }
    };

    const watchRoundDoc = (rNum) => {
      if (stopRoundWatch) { try { stopRoundWatch(); } catch {} }
      const docRef = doc(roundsCol, String(rNum));
      stopRoundWatch = onSnapshot(docRef, (snap) => {
        const d = snap.data() || {};
        const hostItems = Array.isArray(d.hostItems) ? d.hostItems.length : 0;
        const guestItems = Array.isArray(d.guestItems) ? d.guestItems.length : 0;
        roundReady = hostItems === 3 && guestItems === 3;
        updateSubMessage();
      }, (err) => {
        console.warn("[countdown] round snapshot error:", err);
      });
    };

    watchRoundDoc(round);
    updateSubMessage();

    const stop = onSnapshot(rRef, (snap) => {
      const data = snap.data() || {};

      if (Number(data.round) && Number(data.round) !== round) {
        round = Number(data.round);
        title.textContent = `Round ${round}`;
        roundReady = false;
        watchRoundDoc(round);
      }

      const remoteStart = Number(data?.countdown?.startAt || 0) || 0;
      if (remoteStart && remoteStart !== countdownStartAt) {
        countdownStartAt = remoteStart;
        hasFlipped = false;
      }
      if (!remoteStart) {
        countdownStartAt = 0;
        hasFlipped = false;
      }
      updateSubMessage();

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
        timer.textContent = "—";
        updateSubMessage();
        return;
      }

      const remainMs = timeUntil(countdownStartAt);
      const secs = Math.ceil(remainMs / 1000);
      timer.textContent = String(secs > 0 ? secs : 0);

      if (remainMs <= 0 && !hasFlipped) {
        if (!roundReady) {
          updateSubMessage();
          return;
        }
        hasFlipped = true;
        if (myRole === "host") {
          try {
            console.log(`[flow] countdown -> questions | code=${code} round=${round} role=${myRole}`);
            await updateDoc(rRef, {
              state: "questions",
              "countdown.startAt": null,
              "timestamps.updatedAt": serverTimestamp()
            });
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
