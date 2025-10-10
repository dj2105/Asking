// /src/views/KeyRoom.js
// Host-only sealed-pack upload flow.
// • Decrypts the uploaded .sealed pack with the demo password.
// • Validates checksum/schema locally, displays generated date + verified badge.
// • Seeds Firestore with rooms/{code} and rounds/{1..5}, arms countdown 7s ahead.
// • Logs progress to a monospace console and routes host to the countdown view.

import {
  initFirebase,
  ensureAuth,
} from "../lib/firebase.js";
import {
  unsealFile,
  seedFirestoreFromPack,
  DEMO_PACK_PASSWORD,
} from "../lib/seedUnsealer.js";
import {
  clampCode,
  copyToClipboard,
  getHashParams,
  setStoredRole,
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
    const { db } = await initFirebase();
    await ensureAuth();

    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    const params = getHashParams();
    const hintedCode = clampCode(params.get("code") || "");

    container.innerHTML = "";
    const root = el("div", { class: "view view-keyroom" });
    root.appendChild(el("h1", { class: "title" }, "Key Room"));

    const card = el("div", { class: "card" });
    const intro = el("div", { class: "mono", style: "margin-bottom:10px;" },
      "Upload Jemima’s sealed pack to start the duel.");
    card.appendChild(intro);

    const fileLabel = el("label", {
      class: "mono", style: "display:block;margin-bottom:8px;font-weight:700;"
    }, "Sealed pack (.sealed)");
    card.appendChild(fileLabel);

    const fileInput = el("input", {
      type: "file",
      accept: ".sealed",
      class: "input",
      onchange: onFileChange,
    });
    card.appendChild(fileInput);

    const status = el("div", { class: "mono small", style: "margin-top:10px;min-height:18px;" }, hintedCode
      ? `Waiting for pack ${hintedCode}…`
      : "Waiting for pack…");
    card.appendChild(status);

    const codeRow = el("div", {
      class: "mono", style: "margin-top:14px;display:none;align-items:center;gap:10px;justify-content:center;"
    });
    const codeText = el("span", { class: "code-tag" }, "");
    const copyBtn = el("button", { class: "btn outline", disabled: "" }, "Copy");
    copyBtn.addEventListener("click", async () => {
      const ok = await copyToClipboard(codeText.textContent || "");
      if (ok) status.textContent = "Code copied.";
    });
    codeRow.appendChild(codeText);
    codeRow.appendChild(copyBtn);
    card.appendChild(codeRow);

    const metaRow = el("div", {
      class: "mono small", style: "margin-top:6px;display:none;justify-content:center;align-items:center;gap:6px;"
    });
    const verifiedDot = el("span", { class: "verified-dot verified-dot--ok" });
    metaRow.appendChild(verifiedDot);
    const generatedLabel = el("span", {}, "");
    metaRow.appendChild(generatedLabel);
    card.appendChild(metaRow);

    const logEl = el("pre", {
      class: "mono small", style: "margin-top:14px;background:rgba(0,0,0,0.05);padding:10px;border-radius:10px;min-height:120px;max-height:180px;overflow:auto;"
    });
    card.appendChild(logEl);

    root.appendChild(card);
    container.appendChild(root);

    let seeded = false;

    if (hintedCode) {
      codeText.textContent = `Room ${hintedCode}`;
      codeRow.style.display = "flex";
    }

    function log(message) {
      const stamp = new Date().toISOString().split("T")[1].replace(/Z$/, "");
      logEl.textContent += `[${stamp}] ${message}\n`;
      logEl.scrollTop = logEl.scrollHeight;
      console.log(`[keyroom] ${message}`);
    }

    async function onFileChange(event) {
      if (seeded) return;
      const file = event.target?.files?.[0];
      if (!file) return;

      status.textContent = "Unsealing pack…";
      log(`selected ${file.name}`);
      try {
        const { pack, code } = await unsealFile(file, { password: DEMO_PACK_PASSWORD });
        codeText.textContent = `Room ${code}`;
        codeRow.style.display = "flex";
        copyBtn.disabled = false;
        const when = new Date(pack.meta.generatedAt);
        generatedLabel.textContent = `Generated ${when.toLocaleString()}`;
        metaRow.style.display = "inline-flex";
        status.textContent = "Pack verified.";
        log(`unsealed pack ${code}`);
        log(`checksum OK (${pack.integrity.checksum.slice(0, 8)}…)`);

        log("seeding Firestore…");
        const { startAt } = await seedFirestoreFromPack(db, pack);
        seeded = true;
        fileInput.disabled = true;
        status.textContent = "Countdown armed.";
        log(`rooms/${code} updated; countdown starts at ${new Date(startAt).toLocaleTimeString()}`);

        setStoredRole(code, "host");

        setTimeout(() => {
          location.hash = `#/countdown?code=${code}&round=1`;
        }, 400);
      } catch (err) {
        const message = err?.message || "Failed to load sealed pack.";
        status.textContent = message;
        log(`error: ${message}`);
        console.error("[keyroom]", err);
        event.target.value = "";
      }
    }

    this.unmount = () => {};
  },

  async unmount() {},
};
