// /src/views/KeyRoom.js
// Host-only sealed-pack upload flow.
// • Decrypts the uploaded .sealed pack with the demo password.
// • Validates checksum/schema locally, displays generated date + verified badge.
// • Supports the classic single-pack upload and the new three-file halfpack intake.
// • Seeds Firestore with rooms/{code} and rounds/{1..5}, arms countdown 7s ahead.
// • Logs progress to a monospace console and routes host to the countdown view.

import {
  initFirebase,
  ensureAuth,
  roomRef,
  onSnapshot,
  updateDoc,
  serverTimestamp,
} from "../lib/firebase.js";
import {
  unsealFile,
  unsealHalfpack,
  unsealMaths,
  seedFirestoreFromPack,
  DEMO_PACK_PASSWORD,
  PACK_VERSION_FULL,
  PACK_VERSION_HALF,
  PACK_VERSION_MATHS,
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
    const intro = el(
      "div",
      { class: "mono", style: "margin-bottom:10px;" },
      "Upload Jemima’s sealed pack (full or trio) to start the duel."
    );
    card.appendChild(intro);

    const uploadGrid = el("div", {
      class: "mono",
      style: "display:flex;flex-direction:column;gap:10px;margin-bottom:10px;",
    });
    card.appendChild(uploadGrid);

    const slotConfigs = {
      full: { label: "Full Pack", initial: "Awaiting full pack." },
      host: { label: "Host (15)", initial: "Awaiting host halfpack." },
      guest: { label: "Guest (15)", initial: "Awaiting guest halfpack." },
      maths: { label: "Maths", initial: "Awaiting maths block." },
    };

    const slotMap = {};

    function createSlot(key, labelText, initialStatus) {
      const statusEl = el(
        "span",
        {
          class: "mono small",
          style: "min-height:18px;display:block;",
        },
        initialStatus
      );
      const input = el("input", {
        type: "file",
        accept: ".sealed",
        style: "display:none;",
        "data-slot-key": key,
        onchange: onFileChange,
      });
      const uploadBtn = el(
        "button",
        { class: "btn outline", type: "button" },
        "Upload"
      );
      uploadBtn.addEventListener("click", () => {
        if (!uploadBtn.disabled) input.click();
      });
      const clearBtn = el(
        "button",
        { class: "btn outline", type: "button", disabled: "" },
        "Clear"
      );
      clearBtn.addEventListener("click", () => {
        clearSlot(key);
      });
      const buttonRow = el(
        "div",
        { style: "display:flex;gap:8px;flex-wrap:wrap;" },
        [uploadBtn, clearBtn]
      );
      const wrapper = el(
        "div",
        {
          class: "mono",
          style:
            "display:flex;flex-direction:column;gap:6px;padding:10px;border:1px dashed rgba(0,0,0,0.25);border-radius:10px;",
        },
        [el("span", { style: "font-weight:700;" }, labelText), buttonRow, statusEl, input]
      );
      return {
        key,
        wrapper,
        input,
        statusEl,
        uploadBtn,
        clearBtn,
        initialText: initialStatus,
        active: false,
      };
    }

    for (const [role, cfg] of Object.entries(slotConfigs)) {
      const slot = createSlot(role, cfg.label, cfg.initial);
      slotMap[role] = slot;
      uploadGrid.appendChild(slot.wrapper);
    }

    const progressLine = el("div", {
      class: "mono small",
      style: "margin-top:4px;text-align:center;min-height:18px;",
    }, "Verified: 0/3");
    card.appendChild(progressLine);

    const status = el(
      "div",
      { class: "mono small", style: "margin-top:10px;min-height:18px;" },
      hintedCode ? `Waiting for pack ${hintedCode}…` : "Waiting for pack…"
    );
    card.appendChild(status);

    const codeRow = el("div", {
      class: "mono",
      style: "margin-top:14px;display:none;align-items:center;gap:10px;justify-content:center;",
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
      class: "mono small",
      style: "margin-top:6px;display:none;justify-content:center;align-items:center;gap:6px;",
    });
    const verifiedDot = el("span", { class: "verified-dot verified-dot--ok" });
    metaRow.appendChild(verifiedDot);
    const generatedLabel = el("span", {}, "");
    metaRow.appendChild(generatedLabel);
    card.appendChild(metaRow);

    const startRow = el("div", {
      class: "mono",
      style: "margin-top:16px;display:none;justify-content:center;",
    });
    const startBtn = el("button", { class: "btn primary", disabled: "" }, "Start");
    startRow.appendChild(startBtn);
    card.appendChild(startRow);

    const logEl = el("pre", {
      class: "mono small",
      style: "margin-top:14px;background:rgba(0,0,0,0.05);padding:10px;border-radius:10px;min-height:120px;max-height:180px;overflow:auto;",
    });
    card.appendChild(logEl);

    root.appendChild(card);
    container.appendChild(root);

    function createStage() {
      const rounds = {};
      for (let i = 1; i <= 5; i += 1) {
        rounds[i] = { hostItems: [], guestItems: [], interlude: "" };
      }
      return { code: "", rounds, maths: null };
    }

    let seeded = false;
    let watchingCode = "";
    let stopRoomWatch = null;
    let latestRound = 1;
    let startPending = false;
    let lastRoomSummary = { guestPresent: false, state: "keyroom", countdownStart: 0 };

    const stageLoaded = { host: false, guest: false, maths: false };
    let usingFullPack = false;
    let stage = createStage();

    function updateProgress() {
      if (usingFullPack) {
        progressLine.textContent = "Verified: Full pack ready.";
        return;
      }
      const count = (stageLoaded.host ? 1 : 0) + (stageLoaded.guest ? 1 : 0) + (stageLoaded.maths ? 1 : 0);
      progressLine.textContent = `Verified: ${count}/3`;
    }

    function resetStageUI() {
      stage = createStage();
      stageLoaded.host = false;
      stageLoaded.guest = false;
      stageLoaded.maths = false;
      usingFullPack = false;
      Object.values(slotMap).forEach((slot) => {
        slot.statusEl.textContent = slot.initialText;
        slot.active = false;
        slot.clearBtn.disabled = true;
        slot.uploadBtn.disabled = false;
      });
      updateProgress();
    }

    function clearSlot(key) {
      const slot = slotMap[key];
      if (!slot) return;
      if (seeded) return;

      if (key === "full") {
        resetStageUI();
        status.textContent = "Full pack cleared.";
        log("full pack cleared.");
        return;
      }

      if (key === "host" || key === "guest") {
        for (let i = 1; i <= 5; i += 1) {
          if (key === "host") {
            stage.rounds[i].hostItems = [];
          } else {
            stage.rounds[i].guestItems = [];
          }
        }
        stageLoaded[key] = false;
        slot.statusEl.textContent = slot.initialText;
        slot.active = false;
        slot.clearBtn.disabled = true;
        slot.uploadBtn.disabled = false;
        status.textContent = key === "host" ? "Host halfpack cleared." : "Guest halfpack cleared.";
        log(`${key} halfpack cleared.`);
        updateProgress();
        return;
      }

      if (key === "maths") {
        stage.maths = null;
        stageLoaded.maths = false;
        slot.statusEl.textContent = slot.initialText;
        slot.active = false;
        slot.clearBtn.disabled = true;
        slot.uploadBtn.disabled = false;
        status.textContent = "Maths block cleared.";
        log("maths block cleared.");
        updateProgress();
      }
    }

    function applyFullPackDominance() {
      usingFullPack = true;
      Object.entries(slotMap).forEach(([key, slot]) => {
        if (key === "full") return;
        slot.statusEl.textContent = "Overridden by full pack.";
        slot.active = false;
        slot.clearBtn.disabled = true;
        slot.uploadBtn.disabled = true;
      });
      updateProgress();
    }

    function showRoomCode(code) {
      if (!code) return;
      codeText.textContent = `Room ${code}`;
      codeRow.style.display = "flex";
      copyBtn.disabled = false;
    }

    function log(message) {
      const stamp = new Date().toISOString().split("T")[1].replace(/Z$/, "");
      logEl.textContent += `[${stamp}] ${message}\n`;
      logEl.scrollTop = logEl.scrollHeight;
      console.log(`[keyroom] ${message}`);
    }

    function setSlotsDisabled(flag) {
      Object.values(slotMap).forEach((slot) => {
        slot.input.disabled = Boolean(flag);
        slot.uploadBtn.disabled = Boolean(flag);
        slot.clearBtn.disabled = Boolean(flag || !slot.active);
      });
    }

    function ensureStageCode(code) {
      const next = clampCode(code);
      if (!next) {
        return { ok: false, expected: stage.code || "", got: clampCode(code) };
      }
      if (!stage.code) {
        stage.code = next;
        showRoomCode(next);
        return { ok: true };
      }
      if (stage.code === next) {
        return { ok: true };
      }
      return { ok: false, expected: stage.code, got: next };
    }

    function clone(value) {
      return JSON.parse(JSON.stringify(value ?? null));
    }

    async function determineSealedType(file) {
      let envelopeText;
      let versionHint = "";
      try {
        envelopeText = await file.text();
        const envelope = JSON.parse(envelopeText);
        if (envelope && typeof envelope.version === "string") {
          versionHint = envelope.version;
        }
      } catch (err) {
        throw new Error("Sealed pack is not valid JSON.");
      }

      const stubFile = {
        name: file.name,
        async text() {
          return envelopeText;
        },
      };

      const order = [];
      if (versionHint === PACK_VERSION_FULL) order.push("full");
      else if (versionHint === PACK_VERSION_HALF) order.push("half");
      else if (versionHint === PACK_VERSION_MATHS) order.push("maths");
      if (!order.includes("full")) order.push("full");
      if (!order.includes("half")) order.push("half");
      if (!order.includes("maths")) order.push("maths");

      for (const type of order) {
        try {
          if (type === "full") {
            const result = await unsealFile(stubFile, { password: DEMO_PACK_PASSWORD });
            return { type: "full", ...result };
          }
          if (type === "half") {
            const result = await unsealHalfpack(stubFile, { password: DEMO_PACK_PASSWORD });
            return { type: "half", ...result };
          }
          if (type === "maths") {
            const result = await unsealMaths(stubFile, { password: DEMO_PACK_PASSWORD });
            return { type: "maths", ...result };
          }
        } catch (err) {
          if (err?.message === "Unsupported sealed version.") {
            continue;
          }
          throw err;
        }
      }

      throw new Error("Unsupported sealed version.");
    }

    async function seedPackAndWatch(pack, code, generatedAtISO, options = {}) {
      const { viaFull = false } = options;
      status.textContent = "Seeding Firestore…";
      log("seeding Firestore…");
      const { code: seededCode } = await seedFirestoreFromPack(db, pack);
      seeded = true;
      setSlotsDisabled(true);
      startRow.style.display = "flex";
      status.textContent = "Pack ready. Waiting for Jaime…";
      log(`rooms/${code} prepared; waiting for guest before starting.`);
      setStoredRole(code, "host");
      showRoomCode(code);
      const when = new Date(generatedAtISO);
      if (!Number.isNaN(when.valueOf())) {
        generatedLabel.textContent = `Generated ${when.toLocaleString()}`;
        metaRow.style.display = "inline-flex";
      }
      progressLine.textContent = viaFull ? "Verified: Full pack ready." : "Verified: 3/3";
      watchRoom(seededCode);
    }

    async function tryCompleteStage() {
      if (seeded) return;
      if (!stageLoaded.host || !stageLoaded.guest || !stageLoaded.maths) return;

      for (let i = 1; i <= 5; i += 1) {
        const round = stage.rounds[i];
        if (!round) {
          status.textContent = "Halfpack invalid: each round needs exactly 3 items for its side.";
          return;
        }
        if (!Array.isArray(round.hostItems) || round.hostItems.length !== 3 ||
            !Array.isArray(round.guestItems) || round.guestItems.length !== 3) {
          status.textContent = "Halfpack invalid: each round needs exactly 3 items for its side.";
          return;
        }
        if (typeof round.interlude !== "string" || !round.interlude.trim()) {
          status.textContent = "Halfpack invalid: each round needs exactly 3 items for its side.";
          return;
        }
      }

      if (!stage.maths) return;

      progressLine.textContent = "Verified: 3/3";
      status.textContent = "Assembling pack…";
      log(`assembling full pack from halfpacks (${stage.code})`);

      const nowIso = new Date().toISOString();
      const rounds = [];
      for (let i = 1; i <= 5; i += 1) {
        const round = stage.rounds[i];
        rounds.push({
          round: i,
          hostItems: clone(round.hostItems),
          guestItems: clone(round.guestItems),
          interlude: round.interlude,
        });
      }

      const fullPack = {
        version: PACK_VERSION_FULL,
        meta: {
          roomCode: stage.code,
          generatedAt: nowIso,
          hostUid: "demo-host",
          guestUid: "demo-guest",
        },
        rounds,
        maths: clone(stage.maths),
        integrity: { checksum: "0".repeat(64), verified: true },
      };

      try {
        await seedPackAndWatch(fullPack, stage.code, nowIso);
      } catch (err) {
        const message = err?.message || "Failed to seed Firestore.";
        status.textContent = message;
        log(`error: ${message}`);
        console.error("[keyroom]", err);
      }
    }

    async function handleFullPack(result) {
      resetStageUI();
      const { pack, code } = result;
      const fullSlot = slotMap.full;
      if (fullSlot) {
        fullSlot.active = true;
        fullSlot.clearBtn.disabled = false;
        fullSlot.statusEl.textContent = "Full pack verified.";
      }
      applyFullPackDominance();
      showRoomCode(code);
      copyBtn.disabled = false;
      const when = new Date(pack.meta.generatedAt);
      if (!Number.isNaN(when.valueOf())) {
        generatedLabel.textContent = `Generated ${when.toLocaleString()}`;
        metaRow.style.display = "inline-flex";
      }
      status.textContent = "Pack verified.";
      log(`unsealed pack ${code}`);
      log(`checksum OK (${pack.integrity.checksum.slice(0, 8)}…)`);
      try {
        await seedPackAndWatch(pack, code, pack.meta.generatedAt, { viaFull: true });
        if (fullSlot) {
          fullSlot.statusEl.textContent = "Full pack loaded.";
          fullSlot.clearBtn.disabled = true;
        }
      } catch (err) {
        const message = err?.message || "Failed to seed Firestore.";
        status.textContent = message;
        if (fullSlot) {
          fullSlot.statusEl.textContent = message;
          fullSlot.active = false;
          fullSlot.clearBtn.disabled = false;
        }
        Object.entries(slotMap).forEach(([key, slot]) => {
          if (key === "full") return;
          slot.statusEl.textContent = slot.initialText;
          slot.active = false;
          slot.clearBtn.disabled = true;
          slot.uploadBtn.disabled = false;
        });
        usingFullPack = false;
        updateProgress();
        log(`error: ${message}`);
        console.error("[keyroom]", err);
      }
    }

    async function handleHalfpack(result) {
      const { halfpack, which, code } = result;
      const ensure = ensureStageCode(code);
      const slot = slotMap[which];
      if (!ensure.ok) {
        const message = `Room code mismatch: expected ${ensure.expected}, got ${ensure.got}.`;
        status.textContent = message;
        if (slot) {
          slot.statusEl.textContent = message;
          slot.active = false;
          slot.clearBtn.disabled = true;
        }
        log(`error: ${message}`);
        return;
      }
      if (stageLoaded[which]) {
        status.textContent = "This side is already loaded.";
        if (slot) {
          slot.statusEl.textContent = "This side is already loaded.";
          slot.active = true;
          slot.clearBtn.disabled = false;
        }
        log(`ignored duplicate ${which} halfpack`);
        return;
      }

      halfpack.rounds.forEach((round) => {
        const rnum = Number(round.round);
        if (!stage.rounds[rnum]) return;
        if (which === "host") {
          stage.rounds[rnum].hostItems = clone(round.hostItems);
        } else {
          stage.rounds[rnum].guestItems = clone(round.guestItems);
        }
        stage.rounds[rnum].interlude = round.interlude;
      });

      stageLoaded[which] = true;
      const message = which === "host" ? "Host (15) verified." : "Guest (15) verified.";
      if (slot) {
        slot.statusEl.textContent = message;
        slot.active = true;
        slot.clearBtn.disabled = false;
      }
      status.textContent = message;
      log(`${which} halfpack verified for ${code}`);
      updateProgress();
      await tryCompleteStage();
    }

    async function handleMaths(result) {
      const { maths, code } = result;
      const ensure = ensureStageCode(code);
      const slot = slotMap.maths;
      if (!ensure.ok) {
        const message = `Room code mismatch: expected ${ensure.expected}, got ${ensure.got}.`;
        status.textContent = message;
        if (slot) {
          slot.statusEl.textContent = message;
          slot.active = false;
          slot.clearBtn.disabled = true;
        }
        log(`error: ${message}`);
        return;
      }
      if (stageLoaded.maths) {
        status.textContent = "This side is already loaded.";
        if (slot) {
          slot.statusEl.textContent = "This side is already loaded.";
          slot.active = true;
          slot.clearBtn.disabled = false;
        }
        log("ignored duplicate maths block");
        return;
      }

      stage.maths = clone(maths);
      stageLoaded.maths = true;
      if (slot) {
        slot.statusEl.textContent = "Maths verified.";
        slot.active = true;
        slot.clearBtn.disabled = false;
      }
      status.textContent = "Maths verified.";
      log(`maths block verified for ${code}`);
      updateProgress();
      await tryCompleteStage();
    }

    async function onFileChange(event) {
      if (seeded) {
        event.target.value = "";
        return;
      }
      const key = event.target?.dataset?.slotKey || "";
      const slot = key ? slotMap[key] : null;
      const file = event.target?.files?.[0];
      event.target.value = "";
      if (!file) return;

      status.textContent = "Unsealing pack…";
      if (slot) {
        slot.statusEl.textContent = "Unsealing…";
        slot.active = false;
        slot.clearBtn.disabled = true;
      }
      log(`selected ${file.name}`);
      let processedKey = null;
      try {
        const result = await determineSealedType(file);
        if (result.type === "full") {
          await handleFullPack(result);
          processedKey = "full";
        } else if (result.type === "half") {
          await handleHalfpack(result);
          processedKey = result.which;
        } else if (result.type === "maths") {
          await handleMaths(result);
          processedKey = "maths";
        }
      } catch (err) {
        const message = err?.message || "Failed to load sealed pack.";
        status.textContent = message;
        if (slot) {
          slot.statusEl.textContent = message;
        }
        log(`error: ${message}`);
        console.error("[keyroom]", err);
        return;
      }

      if (slot && processedKey && processedKey !== key) {
        slot.statusEl.textContent = slot.initialText;
        slot.active = false;
        slot.clearBtn.disabled = true;
        slot.uploadBtn.disabled = false;
      }
    }

    resetStageUI();

    if (hintedCode) {
      showRoomCode(hintedCode);
      startRow.style.display = "none";
      watchRoom(hintedCode);
    }

    function updateStartState({ guestPresent, state, countdownStart }) {
      lastRoomSummary = { guestPresent, state, countdownStart };
      const ready = seeded && guestPresent && state === "keyroom" && !startPending;
      startBtn.disabled = !ready;
      startBtn.classList.toggle("throb", Boolean(ready));
      if (!guestPresent) {
        status.textContent = "Pack ready. Waiting for Jaime…";
      } else if (state === "keyroom") {
        status.textContent = "Jaime joined. Press Start when ready.";
      }

      if (state === "countdown" && countdownStart) {
        status.textContent = "Countdown armed.";
        startBtn.disabled = true;
        startBtn.classList.remove("throb");
        if (!startPending) {
          setTimeout(() => {
            location.hash = `#/countdown?code=${watchingCode}&round=${latestRound}`;
          }, 400);
        }
      }
    }

    const startCountdown = async () => {
      if (!watchingCode || startPending) return;
      startPending = true;
      startBtn.disabled = true;
      startBtn.classList.remove("throb");
      status.textContent = "Starting…";
      const startAt = Date.now() + 7_000;
      try {
        await updateDoc(roomRef(watchingCode), {
          state: "countdown",
          round: latestRound,
          "countdown.startAt": startAt,
          "timestamps.updatedAt": serverTimestamp(),
        });
        log(`countdown armed for ${new Date(startAt).toLocaleTimeString()}`);
        setTimeout(() => {
          location.hash = `#/countdown?code=${watchingCode}&round=${latestRound}`;
        }, 400);
      } catch (err) {
        console.warn("[keyroom] failed to start countdown:", err);
        status.textContent = "Failed to start. Try again.";
        startPending = false;
        updateStartState(lastRoomSummary);
      }
    };

    startBtn.addEventListener("click", startCountdown);

    function watchRoom(code) {
      if (!code) return;
      if (stopRoomWatch) {
        try { stopRoomWatch(); } catch (err) { console.warn("[keyroom] failed to stop watcher", err); }
      }
      watchingCode = code;
      stopRoomWatch = onSnapshot(roomRef(code), (snap) => {
        if (!snap.exists()) return;
        const data = snap.data() || {};
        latestRound = Number(data.round) || 1;
        const meta = data.meta || {};
        const guestPresent = Boolean(meta.guestUid);
        if (!seeded && data.seeds?.progress === 100) {
          seeded = true;
          setSlotsDisabled(true);
          showRoomCode(code);
          copyBtn.disabled = false;
          startRow.style.display = "flex";
          progressLine.textContent = "Pack ready (remote).";
          Object.values(slotMap).forEach((slot) => {
            slot.statusEl.textContent = "Pack ready (remote).";
            slot.active = false;
            slot.clearBtn.disabled = true;
            slot.uploadBtn.disabled = true;
          });
          status.textContent = guestPresent ? "Jaime joined. Press Start when ready." : "Pack ready. Waiting for Jaime…";
        }
        if (data.meta?.generatedAt && !generatedLabel.textContent) {
          const when = new Date(data.meta.generatedAt);
          if (!Number.isNaN(when.valueOf())) {
            generatedLabel.textContent = `Generated ${when.toLocaleString()}`;
            metaRow.style.display = "inline-flex";
          }
        }
        const countdownStart = Number(data?.countdown?.startAt || 0) || 0;
        updateStartState({ guestPresent, state: data.state || "", countdownStart });
        if (data.state && data.state !== "keyroom" && data.state !== "countdown") {
          let target = null;
          if (data.state === "questions") target = `#/questions?code=${code}&round=${data.round || latestRound}`;
          else if (data.state === "marking") target = `#/marking?code=${code}&round=${data.round || latestRound}`;
          else if (data.state === "award") target = `#/award?code=${code}&round=${data.round || latestRound}`;
          else if (data.state === "maths") target = `#/maths?code=${code}`;
          else if (data.state === "final") target = `#/final?code=${code}`;
          if (target) setTimeout(() => { location.hash = target; }, 200);
        }
      });
    }

    this.unmount = () => {
      if (stopRoomWatch) {
        try { stopRoomWatch(); } catch (err) { console.warn("[keyroom] failed to unmount watcher", err); }
      }
    };
  },

  async unmount() {},
};
