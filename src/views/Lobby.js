// /src/views/Lobby.js
// Guest-only join screen styled as a centered business card.
// - NEVER creates rooms, NEVER routes to KeyRoom.
// - If code doesn’t exist → inline “Room not found” (stay here).
// - If room exists → (optionally) claim guest slot if free, then ALWAYS route to `#/watcher?code=XYZ`.
// - Card glows green with a GO! overlay when the code is ready to submit.

import {
  initFirebase, ensureAuth,
  roomRef, getDoc, updateDoc, serverTimestamp
} from "../lib/firebase.js";
import { clampCode as clampCodeShared, setStoredRole } from "../lib/util.js";

function el(tag, attrs = {}, kids = []) {
  const n = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (k === "class") n.className = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  (Array.isArray(kids) ? kids : [kids]).forEach(c =>
    n.appendChild(typeof c === "string" ? document.createTextNode(c) : c)
  );
  return n;
}

const clampCode = (v) => clampCodeShared(v || "");

export default {
  async mount(container) {
    await initFirebase();
    await ensureAuth();

    // Theme (random ink hue)
    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));
    document.documentElement.style.setProperty("--ink-s", "70%");
    document.documentElement.style.setProperty("--ink-l", "18%");

    // Inject lobby-specific styles once
    if (!document.getElementById("lobby-style")) {
      const style = document.createElement("style");
      style.id = "lobby-style";
      style.textContent = `
        .view-lobby {
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          position: relative;
          background: #f5f1e8;
          padding: 40px 16px;
          box-sizing: border-box;
          font-family: 'Courier New', Courier, monospace;
        }

        .view-lobby .lobby-card {
          position: relative;
          width: min(360px, 88vw);
          border: 2px solid rgba(0, 0, 0, 0.5);
          border-radius: 22px;
          background: var(--card-bg, #ffffff);
          padding: 34px 28px 32px;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 22px;
          text-align: center;
          transition: background 200ms ease, transform 220ms ease, box-shadow 220ms ease;
          box-shadow: 0 18px 28px rgba(0, 0, 0, 0.08);
          animation: lobbyCardShadow 6s ease-in-out infinite alternate;
        }

        .view-lobby .lobby-title {
          font-size: 24px;
          font-weight: 900;
          margin: 0;
        }

        .view-lobby .lobby-prompt {
          font-size: 18px;
          font-weight: 700;
          line-height: 1.4;
          margin: 0;
          max-width: 320px;
        }

        .view-lobby .lobby-stack {
          display: flex;
          flex-direction: column;
          gap: 18px;
          width: 100%;
          align-items: center;
        }

        .view-lobby .lobby-code-input {
          width: 100%;
          border: 2px solid rgba(0, 0, 0, 0.5);
          border-radius: 14px;
          background: rgba(255, 255, 255, 0.96);
          padding: 14px 18px;
          font-size: 24px;
          letter-spacing: 0.4em;
          text-transform: uppercase;
          text-align: center;
          box-sizing: border-box;
          transition: border-color 160ms ease, background 160ms ease;
        }

        .view-lobby .lobby-status {
          font-size: 13px;
          min-height: 18px;
        }

        .view-lobby .lobby-start {
          font-family: 'Helvetica Neue', Arial, sans-serif;
          font-weight: 700;
          font-size: 18px;
          letter-spacing: 0.18em;
          color: rgba(12, 87, 33, 0.85);
          background: transparent;
          border: none;
          cursor: pointer;
          opacity: 0;
          transform: translateX(0);
          transition: opacity 160ms ease, transform 220ms ease;
          position: relative;
          padding: 4px 0 6px;
        }

        .view-lobby .lobby-start:disabled {
          cursor: default;
        }

        .view-lobby .lobby-start.animate {
          animation: lobbyStartDrift 1.1s ease-in-out infinite alternate;
        }

        .view-lobby .lobby-start:focus-visible {
          outline: 2px dashed rgba(0, 0, 0, 0.4);
          outline-offset: 4px;
        }

        @keyframes lobbyCardShadow {
          from {
            box-shadow: 0 16px 32px rgba(0, 0, 0, 0.08);
            transform: translateY(0);
          }
          to {
            box-shadow: 0 22px 44px rgba(0, 0, 0, 0.12);
            transform: translateY(-3px);
          }
        }

        @keyframes lobbyStartDrift {
          from {
            transform: translateX(0);
          }
          to {
            transform: translateX(9px);
          }
        }
      `;
      document.head.appendChild(style);
    }

    // Layout (card centered on pale backdrop)
    container.innerHTML = "";
    const view = el("div", { class: "view view-lobby" });
    container.appendChild(view);

    const card = el("div", { class: "lobby-card" });
    const stack = el("div", { class: "lobby-stack" });
    const title = el("h1", { class: "lobby-title" }, "Jemima’s Asking");
    const prompt = el("p", { class: "lobby-prompt" }, "Jaime, what’s the code?");

    const input = el("input", {
      type: "text",
      autocomplete: "off",
      autocapitalize: "characters",
      maxlength: "5",
      placeholder: "C A T",
      class: "lobby-code-input",
      oninput: (e) => { e.target.value = clampCode(e.target.value); reflect(); },
      onkeydown: (e) => { if (e.key === "Enter") join(); }
    });

    stack.appendChild(title);
    stack.appendChild(prompt);
    stack.appendChild(input);

    const startButton = el("button", {
      class: "lobby-start",
      type: "button",
      onclick: join,
      "aria-label": "Submit room code"
    }, "START");

    const status = el("div", { class: "lobby-status" }, "");
    stack.appendChild(startButton);
    stack.appendChild(status);

    card.appendChild(stack);

    view.appendChild(card);

    // Host link (host-only path)
    const hostLink = el("a", {
      href: "#/keyroom",
      style: "position:absolute;bottom:18px;left:50%;transform:translateX(-50%);font-size:12px;text-decoration:underline;"
    }, "Daniel’s entrance");
    view.appendChild(hostLink);

    function setStatus(msg) { status.textContent = msg || ""; }

    function tintForChars(count) {
      const capped = Math.min(Math.max(count, 0), 5);
      const palette = [
        "#ffffff",
        "#f4fbf4",
        "#e9f7ea",
        "#dff3e0",
        "#d5efd6",
        "#cbeccd"
      ];
      return palette[capped];
    }

    function reflect() {
      const value = clampCode(input.value);
      if (value !== input.value) input.value = value;
      const length = value.length;

      card.style.setProperty("--card-bg", tintForChars(length));

      const opacities = [0, 0.45, 0.7, 1, 1, 1];
      startButton.style.opacity = opacities[Math.min(length, opacities.length - 1)];
      startButton.disabled = length < 3;
      startButton.classList.toggle("animate", length >= 3);
    }

    async function join() {
      setStatus("");
      const code = clampCode(input.value);
      if (code.length !== 3) return;

      try {
        const rRef = roomRef(code);
        const snap = await getDoc(rRef);

        if (!snap.exists()) {
          setStatus("Room not found. Check the 3-letter code.");
          console.warn(`[lobby] join code=${code} | room not found`);
          return;
        }

        const data = snap.data() || {};
        setStoredRole(code, "guest");

        if (data.state === "keyroom") {
          const startAt = Date.now() + 7_000;
          const round = Number(data.round) || 1;
          try {
            await updateDoc(rRef, {
              state: "countdown",
              round,
              "countdown.startAt": startAt,
              "timestamps.updatedAt": serverTimestamp(),
            });
            console.log(`[lobby] auto-armed countdown for room ${code}`);
          } catch (err) {
            console.warn("[lobby] failed to arm countdown:", err);
          }
        }

        const target = `#/watcher?code=${code}`;
        if (location.hash !== target) {
          location.hash = target;
        } else {
          setTimeout(() => window.dispatchEvent(new HashChangeEvent("hashchange")), 0);
        }
      } catch (e) {
        console.error("[lobby] join failed:", e);
        setStatus("Couldn’t join right now. Please try again.");
      }
    }

    // First paint
    reflect();
  },

  async unmount() {}
};
