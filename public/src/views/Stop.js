// /src/views/Stop.js
//
// Waiting view after pressing STOP in Marking. Both players land here until the
// second STOP arrives and the host finalises the round.

import { ensureAuth, db } from "../lib/firebase.js";
import {
  doc,
  collection,
  getDoc,
  onSnapshot,
} from "firebase/firestore";

import { clampCode, getHashParams, getStoredRole } from "../lib/util.js";
import { finalizeMarkingRace } from "../lib/markingFinalizer.js";

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

const PLAYER_NAME = { host: "Daniel", guest: "Jaime" };

const roomRef = (code) => doc(db, "rooms", code);
const roundRef = (code, round) => doc(collection(roomRef(code), "rounds"), String(round));

export default {
  async mount(container) {
    const me = await ensureAuth();

    const params = getHashParams();
    const code = clampCode(params.get("code") || "");
    const round = parseInt(params.get("round") || "1", 10) || 1;

    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    container.innerHTML = "";
    const root = el("div", { class: "view view-stop" });
    const title = el("h1", { class: "title" }, `Round ${round}`);
    root.appendChild(title);

    const card = el("div", { class: "card", style: "text-align:center" });
    const roomLabel = el("div", { class: "mono", style: "margin-bottom:8px;" }, `Room ${code}`);
    card.appendChild(roomLabel);

    const mainLine = el("div", {
      class: "mono",
      style: "font-size:24px;font-weight:700;margin-top:16px;"
    }, "Waiting…");
    card.appendChild(mainLine);

    const detailLine = el("div", {
      class: "mono",
      style: "margin-top:12px;opacity:0.8;"
    }, "Linking opponents…");
    card.appendChild(detailLine);

    root.appendChild(card);
    container.appendChild(root);

    const rRef = roomRef(code);
    const rdRef = roundRef(code, round);

    const roomSnap = await getDoc(rRef);
    const roomData = roomSnap.data() || {};
    const { hostUid, guestUid } = roomData.meta || {};
    const storedRole = getStoredRole(code);
    const myRole = storedRole === "host" || storedRole === "guest"
      ? storedRole
      : hostUid === me.uid ? "host" : guestUid === me.uid ? "guest" : "guest";
    const oppRole = myRole === "host" ? "guest" : "host";
    const myName = PLAYER_NAME[myRole] || "You";
    const oppName = PLAYER_NAME[oppRole] || "your opponent";

    let ackMine = Boolean(((roomData.markingAck || {})[myRole] || {})[round]);
    let ackOpp = Boolean(((roomData.markingAck || {})[oppRole] || {})[round]);
    let finalizeInFlight = false;
    let snippetResolved = false;

    const ensureMarkingAck = () => {
      if (!ackMine) {
        setTimeout(() => {
          location.replace(`#/marking?code=${code}&round=${round}`);
        }, 50);
      }
    };

    ensureMarkingAck();

    const updateCopy = () => {
      if (!ackMine) {
        mainLine.textContent = "Returning to marking…";
        detailLine.textContent = "Re-open the marking page to finish scoring.";
        return;
      }
      if (!ackOpp) {
        mainLine.textContent = `Waiting for ${oppName}.`;
        detailLine.textContent = `${myName} is locked in. Hold tight…`;
        return;
      }
      mainLine.textContent = "Both players locked.";
      detailLine.textContent = "Linking you to the awards screen…";
    };

    updateCopy();

    const tryFinalize = async (attempt = 0) => {
      if (snippetResolved || finalizeInFlight) return;
      finalizeInFlight = true;
      try {
        const resolved = await finalizeMarkingRace({ code, round });
        if (resolved) {
          snippetResolved = true;
        } else if (attempt < 2) {
          setTimeout(() => tryFinalize(attempt + 1), 400 * (attempt + 1));
        }
      } catch (err) {
        console.warn("[stop] finalize failed:", err);
        if (attempt < 2) {
          setTimeout(() => tryFinalize(attempt + 1), 400 * (attempt + 1));
        }
      } finally {
        finalizeInFlight = false;
      }
    };

    const stopRound = onSnapshot(rdRef, (snap) => {
      const data = snap.data() || {};
      if (typeof data.snippetTie !== "undefined" || typeof data.snippetWinnerUid !== "undefined") {
        snippetResolved = true;
      }
    }, (err) => {
      console.warn("[stop] round snapshot error:", err);
    });

    const stopRoom = onSnapshot(rRef, (snap) => {
      const data = snap.data() || {};
      ackMine = Boolean(((data.markingAck || {})[myRole] || {})[round]);
      ackOpp = Boolean(((data.markingAck || {})[oppRole] || {})[round]);
      updateCopy();

      if (!ackMine) {
        ensureMarkingAck();
        return;
      }

      if (ackMine && ackOpp && myRole === "host" && !snippetResolved) {
        tryFinalize();
      }

      const state = (data.state || "").toLowerCase();
      if (state === "award") {
        setTimeout(() => {
          location.hash = `#/award?code=${code}&round=${round}`;
        }, 60);
        return;
      }
      if (state === "marking" && !ackMine) {
        ensureMarkingAck();
      }
      if (state === "questions") {
        setTimeout(() => {
          location.hash = `#/questions?code=${code}&round=${data.round || round}`;
        }, 60);
        return;
      }
      if (state === "countdown") {
        const nextRound = Number(data.round) || round + 1;
        setTimeout(() => {
          location.hash = `#/countdown?code=${code}&round=${nextRound}`;
        }, 60);
        return;
      }
      if (state === "maths") {
        setTimeout(() => { location.hash = `#/maths?code=${code}`; }, 60);
        return;
      }
      if (state === "final") {
        setTimeout(() => { location.hash = `#/final?code=${code}`; }, 60);
      }
    }, (err) => {
      console.warn("[stop] room snapshot error:", err);
    });

    this.unmount = () => {
      try { stopRoom && stopRoom(); } catch {}
      try { stopRound && stopRound(); } catch {}
    };
  },

  async unmount() { /* handled via instance */ }
};

