// /src/views/CodeRoom.js
// Host-only waiting room that displays the chosen code and waits for Jaime to join.
// • Shows the code in large type with a copy shortcut.
// • Watches Firestore for state changes -> countdown/questions/etc.

import { ensureAuth, db } from "../lib/firebase.js";
import { doc, onSnapshot } from "firebase/firestore";
import { clampCode, copyToClipboard, getHashParams, setStoredRole } from "../lib/util.js";

function el(tag, attrs = {}, kids = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  (Array.isArray(kids) ? kids : [kids]).forEach((child) =>
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child)
  );
  return node;
}

const roomRef = (code) => doc(db, "rooms", code);

export default {
  async mount(container) {
    await ensureAuth();

    const params = getHashParams();
    const code = clampCode(params.get("code") || "");

    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    container.innerHTML = "";
    const root = el("div", { class: "view view-coderoom" });
    const card = el("div", { class: "card" });

    card.appendChild(el("h1", { class: "title" }, "Code Room"));

    const codeLabel = el(
      "div",
      {
        class: "mono",
        style:
          "font-size:40px;font-weight:700;letter-spacing:8px;text-align:center;margin-top:4px;margin-bottom:6px;",
      },
      code || "—"
    );
    card.appendChild(codeLabel);

    const copyRow = el(
      "div",
      { class: "mono small", style: "text-align:center;margin-bottom:12px;" },
      []
    );
    const copyBtn = el(
      "button",
      {
        class: "btn outline",
        type: "button",
        style: "padding:4px 14px;font-size:12px;",
      },
      "Copy code"
    );
    if (code.length < 3) {
      copyBtn.disabled = true;
    }
    copyBtn.addEventListener("click", async () => {
      if (!code) return;
      const ok = await copyToClipboard(code);
      if (ok) {
        statusEl.textContent = "Code copied.";
      } else {
        statusEl.textContent = "Couldn’t copy."
      }
    });
    copyRow.appendChild(copyBtn);
    card.appendChild(copyRow);

    const statusEl = el(
      "div",
      { class: "mono", style: "text-align:center;min-height:18px;margin-bottom:14px;" },
      code ? "Waiting for Jaime to join." : "Missing room code."
    );
    card.appendChild(statusEl);

    const backBtn = el(
      "a",
      { class: "btn outline", href: "#/keyroom", style: "display:inline-block;" },
      "Back"
    );
    card.appendChild(backBtn);

    root.appendChild(card);
    container.appendChild(root);

    if (!code) {
      return;
    }

    setStoredRole(code, "host");

    const stop = onSnapshot(
      roomRef(code),
      (snap) => {
        if (!snap.exists()) {
          statusEl.textContent = "Room not found.";
          return;
        }
        const data = snap.data() || {};
        const round = Number(data.round) || 1;
        const state = String(data.state || "").toLowerCase();

        if (state === "coderoom" || state === "keyroom") {
          statusEl.textContent = "Waiting for Jaime to join.";
          return;
        }

        if (state === "countdown") {
          statusEl.textContent = "Countdown armed.";
          setTimeout(() => {
            location.hash = `#/countdown?code=${code}&round=${round}`;
          }, 150);
          return;
        }

        let target = null;
        if (state === "questions") target = `#/questions?code=${code}&round=${round}`;
        else if (state === "marking") target = `#/marking?code=${code}&round=${round}`;
        else if (state === "award") target = `#/award?code=${code}&round=${round}`;
        else if (state === "maths") target = `#/maths?code=${code}`;
        else if (state === "final") target = `#/final?code=${code}`;

        if (target) {
          setTimeout(() => {
            location.hash = target;
          }, 150);
        }
      },
      (err) => {
        console.warn("[coderoom] snapshot error:", err);
        statusEl.textContent = "Connection lost.";
      }
    );

    this.unmount = () => {
      try { stop(); } catch (err) {
        console.warn("[coderoom] failed to unmount watcher", err);
      }
    };
  },

  async unmount() {},
};
