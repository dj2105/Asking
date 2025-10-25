// /src/views/CodeRoom.js
// Host waiting room after seeding — shows the chosen code and waits for Jaime to join.
// - Displays the code prominently with a copy link helper.
// - Provides a Back button to return to the Key Room (resets state to keyroom if still idle).
// - Watches the room document; when state transitions to countdown/questions/etc we navigate automatically.

import { ensureAuth, db } from "../lib/firebase.js";
import { doc, onSnapshot, updateDoc, serverTimestamp } from "firebase/firestore";
import { clampCode, copyToClipboard, setStoredRole } from "../lib/util.js";

const roomRef = (code) => doc(db, "rooms", code);

function el(tag, attrs = {}, kids = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  (Array.isArray(kids) ? kids : [kids]).forEach((child) =>
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child)
  );
  return node;
}

function formatShareUrl(code) {
  const base = `${location.origin}${location.pathname}#/lobby`;
  return `${base}?code=${code}`;
}

export default {
  async mount(container, params = {}) {
    await ensureAuth();

    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    const code = clampCode(params.code || "");
    if (!code) {
      location.hash = "#/keyroom";
      return;
    }

    setStoredRole(code, "host");

    container.innerHTML = "";
    const root = el("div", { class: "view view-coderoom" });
    const card = el("div", { class: "card" });
    root.appendChild(card);
    container.appendChild(root);

    card.appendChild(el("h1", { class: "title" }, "Code Room"));

    const codeBlock = el("div", {
      class: "mono",
      style: "font-size:42px;font-weight:700;margin-top:10px;text-align:center;letter-spacing:6px;",
    }, code);
    card.appendChild(codeBlock);

    const copyLink = el(
      "button",
      {
        class: "btn outline",
        type: "button",
        onclick: async () => {
          const ok = await copyToClipboard(formatShareUrl(code));
          if (ok) status.textContent = "Link copied.";
        },
      },
      "Copy join link"
    );
    card.appendChild(el("div", { style: "text-align:center;margin-top:8px;" }, copyLink));

    const status = el(
      "div",
      { class: "mono", style: "margin-top:20px;min-height:20px;text-align:center;" },
      "Waiting for Jaime…"
    );
    card.appendChild(status);

    const guestBadge = el(
      "div",
      { class: "mono small", style: "margin-top:6px;text-align:center;opacity:0.8;" },
      ""
    );
    card.appendChild(guestBadge);

    const backBtn = el(
      "button",
      {
        class: "btn outline",
        type: "button",
        style: "margin-top:24px;",
        onclick: async () => {
          if (currentState === "coderoom") {
            try {
              await updateDoc(roomRef(code), {
                state: "keyroom",
                "links.guestReady": false,
                "timestamps.updatedAt": serverTimestamp(),
              });
            } catch (err) {
              console.warn("[coderoom] failed to reset state:", err);
            }
          }
          location.hash = `#/keyroom?code=${code}`;
        },
      },
      "Back"
    );
    card.appendChild(backBtn);

    let stop = null;
    let currentState = "coderoom";

    const navigateForState = (state, round) => {
      if (!state) return;
      const lower = state.toLowerCase();
      if (lower === "countdown") {
        location.hash = `#/countdown?code=${code}&round=${round || 1}`;
      } else if (lower === "questions") {
        location.hash = `#/questions?code=${code}&round=${round || 1}`;
      } else if (lower === "marking") {
        location.hash = `#/marking?code=${code}&round=${round || 1}`;
      } else if (lower === "award") {
        location.hash = `#/award?code=${code}&round=${round || 1}`;
      } else if (lower === "maths") {
        location.hash = `#/final?code=${code}`;
      } else if (lower === "final") {
        location.hash = `#/final?code=${code}`;
      }
    };

    stop = onSnapshot(
      roomRef(code),
      (snap) => {
        if (!snap.exists()) {
          status.textContent = "Room missing. Returning to Key Room.";
          setTimeout(() => { location.hash = "#/keyroom"; }, 600);
          return;
        }
        const data = snap.data() || {};
        currentState = data.state || "";
        const round = Number(data.round) || 1;
        const guestPresent = Boolean(data.links?.guestReady);

        if (currentState === "coderoom") {
          status.textContent = guestPresent ? "Jaime joined. Arming countdown…" : "Waiting for Jaime…";
          guestBadge.textContent = guestPresent ? "Guest connected." : "";
        } else if (currentState === "keyroom") {
          status.textContent = "Back in the Key Room.";
          guestBadge.textContent = guestPresent ? "Guest already linked." : "";
        } else {
          status.textContent = `State: ${currentState}`;
          guestBadge.textContent = guestPresent ? "Guest connected." : "";
        }

        if (currentState && currentState !== "coderoom" && currentState !== "keyroom") {
          navigateForState(currentState, round);
        }
      },
      (err) => {
        console.warn("[coderoom] watcher error", err);
      }
    );

    this._stopWatcher = () => {
      if (stop) {
        try {
          stop();
        } catch (err) {
          console.warn("[coderoom] failed to stop watcher", err);
        }
      }
    };
  },

  async unmount() {
    if (typeof this._stopWatcher === "function") {
      try { this._stopWatcher(); } catch {}
    }
    this._stopWatcher = null;
  },
};
