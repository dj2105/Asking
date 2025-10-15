// /src/views/StopWait.js
//
// Post-marking holding screen shown after pressing STOP.
// • Displays opponent wait message until both players submit their STOP.
// • Routes automatically to Award once the room state flips.
//
// Query params: ?code=ABC&round=N

import { ensureAuth, db } from "../lib/firebase.js";
import {
  doc,
  collection,
  getDoc,
  onSnapshot,
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

const roleLabel = (role) => (role === "host" ? "Daniel" : "Jaime");

export default {
  async mount(container) {
    const me = await ensureAuth();

    const params = getHashParams();
    const code = clampCode(params.get("code") || "");
    let round = parseInt(params.get("round") || "1", 10) || 1;

    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    container.innerHTML = "";
    const root = el("div", { class: "view view-stopwait" });
    const title = el("h1", { class: "title" }, `Round ${round}`);
    root.appendChild(title);

    const card = el("div", { class: "card" });
    const heading = el("div", {
      class: "mono",
      style: "text-align:center;font-weight:700;margin-bottom:12px;",
    }, "Stop pressed");
    const statusLine = el("div", {
      class: "mono",
      style: "text-align:center;white-space:pre-wrap;min-height:48px;",
    }, "Linking…");
    card.appendChild(heading);
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
    const oppName = roleLabel(oppRole);

    statusLine.textContent = `Waiting for ${oppName}…`;

    let stopRoomWatch = null;
    let stopRoundWatch = null;

    stopRoundWatch = onSnapshot(rdRef, (snap) => {
      const data = snap.data() || {};
      const winnerUid = data.snippetWinnerUid || null;
      if (winnerUid) {
        const note = winnerUid === hostUid
          ? "Snippet secured by Daniel."
          : winnerUid === guestUid
            ? "Snippet secured by Jaime."
            : "Snippet shared."
        heading.textContent = note;
      }
    }, (err) => {
      console.warn("[stopwait] round snapshot error:", err);
    });

    stopRoomWatch = onSnapshot(rRef, (snap) => {
      const data = snap.data() || {};

      if (Number(data.round) && Number(data.round) !== round) {
        round = Number(data.round);
        title.textContent = `Round ${round}`;
      }

      const ackData = data.markingAck || {};
      const myAck = Boolean((ackData[myRole] || {})[round]);
      const oppAck = Boolean((ackData[oppRole] || {})[round]);

      if (!myAck) {
        statusLine.textContent = "Confirming your stop…";
      } else if (!oppAck) {
        statusLine.textContent = `Waiting for ${oppName}…`;
      } else {
        statusLine.textContent = "Both players ready. Linking to awards…";
      }

      const state = String(data.state || "").toLowerCase();
      if (state === "award") {
        setTimeout(() => {
          location.hash = `#/award?code=${code}&round=${round}`;
        }, 80);
        return;
      }
      if (state === "marking") {
        setTimeout(() => {
          location.hash = `#/marking?code=${code}&round=${round}`;
        }, 80);
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
      console.warn("[stopwait] room snapshot error:", err);
    });

    this.unmount = () => {
      try { stopRoomWatch && stopRoomWatch(); } catch {}
      try { stopRoundWatch && stopRoundWatch(); } catch {}
    };
  },

  async unmount() { /* per-instance cleanup above */ },
};
