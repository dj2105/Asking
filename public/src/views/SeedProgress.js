// /src/views/SeedProgress.js
// Lightweight observer for pack seeding state.
// • No Gemini calls — simply watches rooms/{code} and mirrors seeds/status fields.
// • Useful for guests arriving early; automatically routes to countdown when ready.

import {
  initFirebase,
  ensureAuth,
  roomRef,
  onSnapshot,
} from "../lib/firebase.js";
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

export default {
  async mount(container) {
    await initFirebase();
    await ensureAuth();

    const params = getHashParams();
    const code = clampCode(params.get("code") || "");

    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    container.innerHTML = "";
    const root = el("div", { class: "view view-seeding" });
    root.appendChild(el("h1", { class: "title" }, "Linking Jemima…"));

    const card = el("div", { class: "card" });
    const heading = el("div", { class: "mono", style: "text-align:center;margin-bottom:8px;" },
      code ? `Room ${code}` : "Room unknown");
    card.appendChild(heading);

    const status = el("div", { class: "mono", style: "min-height:18px;" }, "Waiting for host upload…");
    card.appendChild(status);

    const logEl = el("pre", {
      class: "mono small", style: "margin-top:12px;background:rgba(0,0,0,0.05);padding:10px;border-radius:10px;min-height:120px;max-height:200px;overflow:auto;"
    });
    card.appendChild(logEl);

    root.appendChild(card);
    container.appendChild(root);

    const log = (line) => {
      const stamp = new Date().toISOString().split("T")[1].replace(/Z$/, "");
      logEl.textContent += `[${stamp}] ${line}\n`;
      logEl.scrollTop = logEl.scrollHeight;
    };

    if (!code) {
      status.textContent = "No code provided.";
      return;
    }

    log("watching room document…");

    this._stop = onSnapshot(roomRef(code), (snap) => {
      if (!snap.exists()) {
        status.textContent = "Room not found yet.";
        return;
      }

      const data = snap.data() || {};
      const seeds = data.seeds || {};
      const message = seeds.message || "Pack pending…";
      const progress = typeof seeds.progress === "number" ? `${Math.round(seeds.progress)}%` : "";
      status.textContent = progress ? `${message} (${progress})` : message;

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
