// /src/views/KeyRoom.js
import {
  initFirebase, ensureAuth,
  roomRef, getDoc, setDoc, updateDoc, serverTimestamp,
  claimRoleIfEmpty
} from "../lib/firebase.js";

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

const clampCode = s => String(s || "")
  .trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);

function randCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 3; i++) s += A[(Math.random() * A.length) | 0];
  return s;
}

export default {
  async mount(container) {
    await initFirebase();
    const me = await ensureAuth();

    // Theme hue per view
    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    // Parse / generate code
    const qs = new URLSearchParams((location.hash.split("?")[1] || ""));
    const code = clampCode(qs.get("code") || randCode());

    container.innerHTML = "";
    const root = el("div", { class: "view view-keyroom" });

    // Header
    root.appendChild(el("h1", { class: "title", style: "text-align:center; font-weight:700;" }, "Key Room"));

    // Code display (no box wrapper; keep minimal)
    const codeRow = el("div", { class: "mono", style: "margin:8px 0 10px; text-align:center;" }, `Room code: ${code}`);
    root.appendChild(codeRow);

    // Fields
    const hint = el("div", { class: "mono", style: "margin-top:6px;" }, "Paste keys/config below (stored locally):");
    const keyIn = el("input", {
      type: "text",
      placeholder: "Gemini API Key (Pro/Flash)",
      style: "width:100%; margin-top:6px; padding:10px; border:2px solid var(--ink); border-radius:12px; background:transparent;"
    });
    keyIn.value = localStorage.getItem("geminiKey") || "";

    const qcfgIn = el("textarea", {
      placeholder: "Paste QCFG JSON",
      style: "width:100%; height:130px; margin-top:8px; padding:10px; border:2px solid var(--ink); border-radius:12px; background:transparent;"
    });
    qcfgIn.value = localStorage.getItem("qcfgJson") || "";

    const jmathsIn = el("textarea", {
      placeholder: "Paste JMaths JSON",
      style: "width:100%; height:130px; margin-top:8px; padding:10px; border:2px solid var(--ink); border-radius:12px; background:transparent;"
    });
    jmathsIn.value = localStorage.getItem("jmathsJson") || "";

    const status = el("div", { class: "mono", style: "margin-top:8px; min-height:18px;" }, "");
    const startBtn = el("button", { class: "btn throb", style: "margin-top:12px;" }, "Start seeding");

    // Save-on-edit
    keyIn.addEventListener("input", () => localStorage.setItem("geminiKey", keyIn.value.trim()));
    qcfgIn.addEventListener("input", () => localStorage.setItem("qcfgJson", qcfgIn.value.trim()));
    jmathsIn.addEventListener("input", () => localStorage.setItem("jmathsJson", jmathsIn.value.trim()));

    root.appendChild(hint);
    root.appendChild(keyIn);
    root.appendChild(qcfgIn);
    root.appendChild(jmathsIn);
    root.appendChild(status);
    root.appendChild(startBtn);

    container.appendChild(root);

    // ----- Host-only initialisation -----
    const ref = roomRef(code);
    const snap = await getDoc(ref);

    if (!snap.exists()) {
      // Create the room (host-only)
      await setDoc(ref, {
        state: "lobby",
        round: 1,
        meta: { hostUid: me.uid },
        seeds: { progress: 0, counters: { approved: 0, rejected: 0 } },
        timestamps: { createdAt: serverTimestamp(), updatedAt: serverTimestamp() }
      });
      status.textContent = "Room created.";
    } else {
      // Claim host if empty; never overwrite
      try {
        await claimRoleIfEmpty(code, me.uid, "host");
        status.textContent = "Host claimed.";
      } catch {
        status.textContent = "Host ready.";
      }
    }

    // ----- Start seeding -> go to seeding view -----
    startBtn.addEventListener("click", async () => {
      startBtn.disabled = true;
      status.textContent = "Arming seeding…";
      try {
        await updateDoc(ref, {
          state: "seeding",
          round: 1,
          "timestamps.updatedAt": serverTimestamp()
        });
        location.hash = `#/seeding?code=${code}`;
      } catch (e) {
        status.textContent = "Failed to arm seeding. Is Firestore emulator running?";
        startBtn.disabled = false;
      }
    });
  },

  async unmount() {}
};
