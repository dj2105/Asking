// /src/views/Lobby.js
// Guest-only join screen (clean carded layout).
// - NEVER creates rooms, NEVER routes to KeyRoom.
// - If code doesn’t exist → inline “Room not found” (stay here).
// - If room exists → (optionally) claim guest slot if free, then ALWAYS route to `#/watcher?code=XYZ`.
// - Input allows 3–5 char codes; Start button gently throbs when actionable.

import { ensureAuth, db } from "../lib/firebase.js";
import { doc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";

import { clampCode as clampCodeShared, setStoredRole, getLastRoomCode } from "../lib/util.js";

const roomRef = (code) => doc(db, "rooms", code);

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
const DEFAULT_GUEST_UID = "jaime-001";

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
    card.appendChild(el("p", { class: "lobby-prompt" }, "What’s the code?"));

    const params = new URLSearchParams((location.hash.split("?")[1] || ""));
    const initialCode = clampCode(params.get("code") || "");
    const recentCode = getLastRoomCode();

    const input = el("input", {
      type: "text",
      autocomplete: "off",
      autocapitalize: "characters",
      maxlength: "5",
      placeholder: "CAT",
      class: "lobby-code-input",
      value: initialCode,
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

    const rejoinHref = recentCode ? `#/rejoin?code=${recentCode}` : "#/rejoin";
    const linksRow = el("div", { class: "lobby-links-row" });
    const rejoinLink = el("a", {
      href: rejoinHref,
      class: "lobby-link lobby-link--left",
    }, "Rejoin Game");
    const hostLink = el("a", {
      href: "#/keyroom",
      class: "lobby-link lobby-link--right"
    }, "Daniel’s Entrance");
    linksRow.appendChild(rejoinLink);
    linksRow.appendChild(hostLink);
    card.appendChild(linksRow);

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

        const state = String(data.state || "").toLowerCase();
        const round = Number(data.round) || 1;

        if (state === "coderoom") {
          const startAt = Date.now() + 5_000;
          try {
            await updateDoc(rRef, {
              state: "countdown",
              round,
              "countdown.startAt": startAt,
              "meta.guestUid": data.meta?.guestUid || DEFAULT_GUEST_UID,
              "links.guestReady": true,
              "timestamps.updatedAt": serverTimestamp(),
            });
            console.log(`[lobby] armed countdown for room ${code}`);
          } catch (err) {
            console.warn("[lobby] failed to arm countdown:", err);
            setStatus("Couldn’t start the countdown. Try again.");
            return;
          }
          location.hash = `#/countdown?code=${code}&round=${round}`;
          return;
        }

        if (state === "countdown" || state === "questions" || state === "marking" || state === "award" || state === "maths" || state === "final") {
          const target = `#/watcher?code=${code}`;
          if (location.hash !== target) {
            location.hash = target;
          } else {
            setTimeout(() => window.dispatchEvent(new HashChangeEvent("hashchange")), 0);
          }
          return;
        }

        setStatus("Daniel hasn’t opened the code room yet.");
        return;
      } catch (e) {
        console.error("[lobby] join failed:", e);
        setStatus("Couldn’t join right now. Please try again.");
      }
    }

    // First paint
    reflect();
    if (initialCode) {
      join();
    }
  },

  async unmount() {}
};
