// /src/views/SeedProgress.js
// Lightweight observer for pack seeding state.
// • No Gemini calls — simply watches rooms/{code} and mirrors seeds/status fields.
// • Useful for guests arriving early; automatically routes to countdown when ready.

import { ensureAuth, db } from "../lib/firebase.js";
import { doc, onSnapshot } from "firebase/firestore";
import {
  clampCode,
  getHashParams,
  timeUntil,
} from "../lib/util.js";

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

const roomRef = (code) => doc(db, "rooms", code);

export default {
  async mount(container) {
    await ensureAuth();

    const params = getHashParams();
    const code = clampCode(params.get("code") || "");

    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    container.innerHTML = "";
    const root = el("div", { class: "view view-seeding" });

    const card = el("div", { class: "card seeding-card" });
    const eyebrow = el("div", { class: "card-eyebrow mono" }, "Waiting for Daniel" );
    card.appendChild(eyebrow);

    const heading = el("div", { class: "card-title" }, code ? `Room ${code}` : "Room unknown");
    card.appendChild(heading);

    const status = el("div", { class: "status-line mono" }, "Waiting for Daniel to upload Jemima’s pack…");
    card.appendChild(status);

    const logEl = el("pre", {
      class: "mono small seeding-log"
    });
    card.appendChild(logEl);

    root.appendChild(card);
    container.appendChild(root);

    const personalize = (text) => {
      return String(text || "")
        .replace(/host/gi, "Daniel")
        .replace(/guest/gi, "Jaime");
    };

    const log = (line) => {
      const stamp = new Date().toISOString().split("T")[1].replace(/Z$/, "");
      logEl.textContent += `[${stamp}] ${line}\n`;
      logEl.scrollTop = logEl.scrollHeight;
    };

    if (!code) {
      status.textContent = personalize("No code provided.");
      return;
    }

    log("watching room document…");

    this._stop = onSnapshot(roomRef(code), (snap) => {
      if (!snap.exists()) {
        status.textContent = personalize("Room not found yet.");
        return;
      }

      const data = snap.data() || {};
      const seeds = data.seeds || {};
      const message = seeds.message || "Pack pending…";
      const progress = typeof seeds.progress === "number" ? `${Math.round(seeds.progress)}%` : "";
      const text = progress ? `${message} (${progress})` : message;
      status.textContent = personalize(text);

      if (data.countdown?.startAt) {
        const ms = timeUntil(data.countdown.startAt);
        if (ms > 0) {
          log(`countdown armed — begins in ${Math.ceil(ms / 1000)}s`);
        }
      }

      if (data.state === "countdown") {
        log("pack ready — routing to countdown");
        setTimeout(() => {
          location.hash = `#/countdown?code=${code}&round=${Number(data.round) || 1}`;
        }, 150);
        return;
      }

      if (data.state && data.state !== "seeding") {
        log(`state=${data.state} — redirecting`);
        let target = null;
        const round = Number(data.round) || 1;
        if (data.state === "questions") target = `#/questions?code=${code}&round=${round}`;
        else if (data.state === "marking") target = `#/marking?code=${code}&round=${round}`;
        else if (data.state === "award") target = `#/award?code=${code}&round=${round}`;
        else if (data.state === "maths") target = `#/maths?code=${code}`;
        else if (data.state === "final") target = `#/final?code=${code}`;
        if (target) {
          setTimeout(() => { location.hash = target; }, 150);
        }
      }
    }, (err) => {
      console.warn("[seeding] snapshot error", err);
      log(`error: ${err?.message || err}`);
    });
  },

  async unmount() {
    if (this._stop) {
      try { this._stop(); } catch {}
      this._stop = null;
    }
  },
};
