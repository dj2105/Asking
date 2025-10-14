// /src/views/CodeRoom.js
// Host-only room code display. Shows the chosen code, offers a copy helper,
// waits for Jaime to join, and routes both players to countdown when the guest enters.

import { ensureAuth, db } from "../lib/firebase.js";
import { doc, onSnapshot } from "firebase/firestore";
import { clampCode, copyToClipboard, getHashParams, setStoredRole } from "../lib/util.js";

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

function routeForState(state, code, round) {
  const r = Number(round) || 1;
  switch (String(state || "").toLowerCase()) {
    case "countdown":
      return `#/countdown?code=${code}&round=${r}`;
    case "questions":
      return `#/questions?code=${code}&round=${r}`;
    case "marking":
      return `#/marking?code=${code}&round=${r}`;
    case "award":
      return `#/award?code=${code}&round=${r}`;
    case "maths":
      return `#/maths?code=${code}`;
    case "final":
      return `#/final?code=${code}`;
    default:
      return null;
  }
}

export default {
  async mount(container) {
    await ensureAuth();

    const params = getHashParams();
    const code = clampCode(params.get("code") || "").slice(0, 5);
    if (code) setStoredRole(code, "host");

    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    container.innerHTML = "";
    const view = el("div", { class: "view view-coderoom" });
    const card = el("div", { class: "card" });
    view.appendChild(card);

    card.appendChild(el("h1", { class: "title" }, "Code Room"));

    const codeDisplay = el(
      "div",
      {
        class: "mono",
        style: "font-weight:700;font-size:32px;text-align:center;letter-spacing:4px;margin-top:4px;",
      },
      code || "—"
    );
    card.appendChild(codeDisplay);

    const status = el(
      "div",
      { class: "mono small", style: "margin-top:14px;min-height:20px;text-align:center;" },
      code ? "Waiting for Jaime to enter the code." : "No code supplied."
    );

    const copyRow = el(
      "div",
      { class: "mono small", style: "text-align:center;margin-top:6px;" },
      code
        ? el(
            "button",
            {
              type: "button",
              class: "mono small",
              style:
                "border:none;background:none;color:inherit;text-decoration:underline;padding:0;cursor:pointer;",
              onclick: async () => {
                if (!code) return;
                const ok = await copyToClipboard(code);
                if (ok) status.textContent = "Code copied. Waiting for Jaime…";
              },
            },
            "Copy code"
          )
          : ""
    );
    card.appendChild(copyRow);
    card.appendChild(status);

    const backBtn = el("a", { href: "#/keyroom", class: "btn outline", style: "margin-top:18px;display:inline-block;" }, "BACK");
    const backWrap = el("div", { style: "text-align:center;margin-top:10px;" }, backBtn);
    card.appendChild(backWrap);

    container.appendChild(view);

    if (!code) {
      this.unmount = () => {};
      return;
    }

    const stop = onSnapshot(
      roomRef(code),
      (snap) => {
        if (!snap.exists()) {
          status.textContent = "Room not found.";
          return;
        }
        const data = snap.data() || {};
        const next = routeForState(data.state, code, data.round);
        if (next && data.state && data.state.toLowerCase() !== "coderoom") {
          setTimeout(() => {
            if (location.hash !== next) location.hash = next;
          }, 80);
          return;
        }
        status.textContent = data.state === "coderoom"
          ? "Share the code with Jaime."
          : "Preparing room…";
      },
      (err) => {
        console.warn("[coderoom] watcher error", err);
        status.textContent = "Couldn’t read room status.";
      }
    );

    this.unmount = () => {
      try {
        stop();
      } catch {}
    };
  },

  async unmount() {},
};
