// /src/views/CodeRoom.js
// Host waiting room after seeding. Shows the chosen code, copy link, and watches for countdown.

import { ensureAuth } from "../lib/firebase.js";
import { clampCode, copyToClipboard, getHashParams } from "../lib/util.js";
import { startRoomWatcher } from "../roomWatcher.js";

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
    root.appendChild(card);

    card.appendChild(el("h1", { class: "title" }, "Code Room"));

    const codeDisplay = el(
      "div",
      {
        class: "mono",
        style: "font-size:32px;font-weight:700;text-align:center;margin-top:10px;letter-spacing:6px;",
      },
      code || "<empty>"
    );
    card.appendChild(codeDisplay);

    const copyRow = el(
      "div",
      {
        class: "mono small",
        style: "margin-top:8px;text-align:center;display:flex;flex-direction:column;gap:6px;align-items:center;",
      },
      []
    );
    const copyHint = el("span", {}, "Share this link with Jaime:");
    const copyBtn = el(
      "button",
      {
        class: "btn outline",
        type: "button",
        style: "padding:4px 12px;font-size:12px;",
      },
      "Copy link"
    );
    copyBtn.addEventListener("click", async () => {
      const link = `${location.origin}${location.pathname}#/lobby`; // default fallback
      const invite = `${location.origin}${location.pathname}#/watcher?code=${code}`;
      const ok = await copyToClipboard(code ? invite : link);
      if (ok) {
        status.textContent = "Link copied. Waiting for Jaime…";
      }
    });
    copyRow.appendChild(copyHint);
    copyRow.appendChild(copyBtn);
    card.appendChild(copyRow);

    const status = el(
      "div",
      {
        class: "mono",
        style: "margin-top:16px;text-align:center;min-height:18px;",
      },
      code ? "Waiting for Jaime…" : "No code provided."
    );
    card.appendChild(status);

    const backBtn = el(
      "button",
      { class: "btn outline", type: "button", style: "margin-top:16px;" },
      "Back"
    );
    backBtn.addEventListener("click", () => {
      if (code) {
        location.hash = `#/keyroom?code=${code}`;
      } else {
        location.hash = "#/keyroom";
      }
    });
    card.appendChild(backBtn);

    container.appendChild(root);

    if (!code) {
      status.textContent = "Room code missing.";
      return;
    }

    this._stop = startRoomWatcher(code, {
      onState: ({ state, round }) => {
        if (!state) return;
        const lower = String(state).toLowerCase();
        if (lower === "coderoom") {
          status.textContent = "Waiting for Jaime…";
          return;
        }
        if (lower === "countdown") {
          status.textContent = "Jaime joined! Countdown starting…";
          setTimeout(() => {
            const targetRound = Number(round) || 1;
            location.hash = `#/countdown?code=${code}&round=${targetRound}`;
          }, 120);
          return;
        }
        if (lower === "keyroom") {
          status.textContent = "Pack re-opened in Key Room.";
        }
      },
    });
  },

  async unmount() {
    if (this._stop) {
      try {
        this._stop();
      } catch (err) {
        console.warn("[coderoom] failed to stop watcher", err);
      }
    }
    this._stop = null;
  },
};
