// /src/views/Lobby.js
// Guest-only join screen (clean carded layout).
// - NEVER creates rooms, NEVER routes to KeyRoom.
// - If code doesn’t exist → inline “Room not found” (stay here).
// - If room exists → (optionally) claim guest slot if free, then ALWAYS route to `#/watcher?code=XYZ`.
// - Input allows 3–5 char codes; Start button gently throbs when actionable.

import { ensureAuth, db } from "../lib/firebase.js";
import { doc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";

const roomRef = (code) => doc(db, "rooms", code);
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
    await ensureAuth();

    // Theme (random ink hue)
    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));
    document.documentElement.style.setProperty("--ink-s", "70%");
    document.documentElement.style.setProperty("--ink-l", "18%");

    container.innerHTML = "";
    const view = el("div", { class: "view view-lobby" });
    const card = el("div", { class: "card lobby-card" });
    view.appendChild(card);
    container.appendChild(view);

    card.appendChild(el("h1", { class: "lobby-title" }, "Jemima’s Asking"));
    card.appendChild(el("p", { class: "lobby-prompt" }, "Jaime, what’s the code?"));

    const input = el("input", {
      type: "text",
      autocomplete: "off",
      autocapitalize: "characters",
      maxlength: "5",
      placeholder: "C A T 9",
      class: "lobby-code-input",
      oninput: (e) => { e.target.value = clampCode(e.target.value); reflect(); },
      onkeydown: (e) => { if (e.key === "Enter") join(); }
    });

    const inputWrap = el("div", { class: "lobby-input-wrap" }, input);
    card.appendChild(inputWrap);

    const startBtn = el("button", {
      class: "btn lobby-start-btn",
      type: "button",
      onclick: join,
      disabled: true,
    }, "START");
    card.appendChild(startBtn);

    const status = el("div", { class: "lobby-status" }, "");
    card.appendChild(status);

    const hostLink = el("a", {
      href: "#/keyroom",
      class: "lobby-host-link"
    }, "Daniel’s entrance");
    card.appendChild(hostLink);

    function setStatus(msg) { status.textContent = msg || ""; }

    function reflect() {
      const value = clampCode(input.value);
      if (value !== input.value) input.value = value;
      const ready = value.length >= 3;
      startBtn.disabled = !ready;
      startBtn.classList.toggle("is-ready", ready);
      startBtn.classList.toggle("throb-soft", ready);
    }

    async function join() {
      setStatus("");
      const code = clampCode(input.value);
      if (code.length < 3) return;

      try {
        const rRef = roomRef(code);
        const snap = await getDoc(rRef);

        if (!snap.exists()) {
          setStatus("Room not found. Check the 3–5 letter code.");
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
