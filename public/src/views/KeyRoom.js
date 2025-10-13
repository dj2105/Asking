// /src/views/KeyRoom.js
// Host-only sealed-pack upload flow.
// • Decrypts the uploaded .sealed pack with the demo password.
// • Validates checksum/schema locally, displays generated date + verified badge.
// • Supports the classic single-pack upload and the new three-file halfpack intake.
// • Seeds Firestore with rooms/{code} and rounds/{1..5}, arms countdown 7s ahead.
// • Logs progress to a monospace console and routes host to the countdown view.

import { ensureAuth, db } from "../lib/firebase.js";
import { doc, onSnapshot, updateDoc, serverTimestamp } from "firebase/firestore";
import {
  unsealFile,
  unsealHalfpack,
  unsealMaths,
  unsealQuestionPack,
  seedFirestoreFromPack,
  DEMO_PACK_PASSWORD,
  PACK_VERSION_FULL,
  PACK_VERSION_HALF,
  PACK_VERSION_MATHS,
  PACK_VERSION_QUESTIONS,
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

const roomRef = (code) => doc(db, "rooms", code);

export default {
  async mount(container) {
    await ensureAuth();

    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    const params = getHashParams();
    const hintedCode = clampCode(params.get("code") || "");

    container.innerHTML = "";
    const root = el("div", { class: "view view-keyroom" });
    const card = el("div", { class: "card" });
    card.appendChild(el("h1", { class: "title" }, "Key Room"));
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
      questions: {
        label: "All Questions (30)",
        initial: "Awaiting 30-question pack.",
      },
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
    }, "Sources → Host: — · Guest: — · Maths: —");
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
      return {
        code: "",
        base: null,
        questionsOverride: null,
        hostOverride: null,
        guestOverride: null,
        mathsOverride: null,
      };
    }

    let seeded = false;
    let watchingCode = "";
    let stopRoomWatch = null;
    let latestRound = 1;
    let startPending = false;
    let lastRoomSummary = { guestPresent: false, state: "keyroom", countdownStart: 0 };

    let stage = createStage();
    let seedingInFlight = false;
    let reseedRequested = false;

    function hideRoomCode() {
      codeText.textContent = "";
      codeRow.style.display = "none";
      copyBtn.disabled = true;
    }

    function clone(value) {
      return JSON.parse(JSON.stringify(value ?? null));
    }

    function normalizeFullRounds(rounds = []) {
      const map = {};
      for (let i = 1; i <= 5; i += 1) {
        map[i] = { hostItems: [], guestItems: [], interlude: "" };
      }
      rounds.forEach((round) => {
        const rnum = Number(round?.round);
        if (!Number.isInteger(rnum) || rnum < 1 || rnum > 5) return;
        map[rnum] = {
          hostItems: clone(round.hostItems || []),
          guestItems: clone(round.guestItems || []),
          interlude: typeof round.interlude === "string" ? round.interlude : "",
        };
      });
      return map;
    }

    function normalizeHalfpackRounds(rounds = [], which) {
      const map = {};
      for (let i = 1; i <= 5; i += 1) {
        map[i] = { hostItems: [], guestItems: [], interlude: "" };
      }
      rounds.forEach((round) => {
        const rnum = Number(round?.round);
        if (!Number.isInteger(rnum) || rnum < 1 || rnum > 5) return;
        const entry = map[rnum];
        if (which === "host") {
          entry.hostItems = clone(round.hostItems || []);
        } else {
          entry.guestItems = clone(round.guestItems || []);
        }
        if (typeof round.interlude === "string" && round.interlude.trim()) {
          entry.interlude = round.interlude;
        }
      });
      return map;
    }

    function recalcStageCode() {
      const codes = [
        stage.base?.code,
        stage.questionsOverride?.code,
        stage.hostOverride?.code,
        stage.guestOverride?.code,
        stage.mathsOverride?.code,
      ].filter(Boolean);
      const unique = Array.from(new Set(codes));
      if (unique.length === 0) {
        stage.code = "";
        hideRoomCode();
        return;
      }
      stage.code = unique[0];
      showRoomCode(stage.code);
    }

    function getSourceLabel(kind) {
      if (kind === "host") {
        if (stage.hostOverride) return "Host (15)";
        if (stage.questionsOverride) return "All Questions (30)";
        if (stage.base) return "Full Pack";
        return null;
      }
      if (kind === "guest") {
        if (stage.guestOverride) return "Guest (15)";
        if (stage.questionsOverride) return "All Questions (30)";
        if (stage.base) return "Full Pack";
        return null;
      }
      if (kind === "maths") {
        if (stage.mathsOverride) return "Maths Pack";
        if (stage.base?.maths) return "Full Pack";
        return null;
      }
      return null;
    }

    function updateProgress() {
      const hostSource = getSourceLabel("host") || "—";
      const guestSource = getSourceLabel("guest") || "—";
      const mathsSource = getSourceLabel("maths") || "—";
      progressLine.textContent = `Sources → Host: ${hostSource} · Guest: ${guestSource} · Maths: ${mathsSource}`;
    }

    function resetStageUI() {
      stage = createStage();
      seeded = false;
      seedingInFlight = false;
      reseedRequested = false;
      Object.values(slotMap).forEach((slot) => {
        slot.statusEl.textContent = slot.initialText;
        slot.active = false;
        slot.clearBtn.disabled = true;
        slot.uploadBtn.disabled = false;
      });
      hideRoomCode();
      generatedLabel.textContent = "";
      metaRow.style.display = "none";
      startRow.style.display = "none";
      updateProgress();
    }

    function clearSlot(key) {
      const slot = slotMap[key];
      if (!slot) return;
      if (seedingInFlight) {
        status.textContent = "Please wait for the current seeding to finish.";
        return;
      }

      if (key === "full") {
        stage.base = null;
        status.textContent = "Full pack cleared.";
        log("full pack cleared.");
        generatedLabel.textContent = "";
        metaRow.style.display = "none";
      } else if (key === "questions") {
        stage.questionsOverride = null;
        status.textContent = "All questions pack cleared.";
        log("questions pack cleared.");
      } else if (key === "host" || key === "guest") {
        if (key === "host") {
          stage.hostOverride = null;
          status.textContent = "Host halfpack cleared.";
          log("host halfpack cleared.");
        } else {
          stage.guestOverride = null;
          status.textContent = "Guest halfpack cleared.";
          log("guest halfpack cleared.");
        }
      } else if (key === "maths") {
        stage.mathsOverride = null;
        status.textContent = "Maths block cleared.";
        log("maths block cleared.");
      }

      slot.statusEl.textContent = slot.initialText;
      slot.active = false;
      slot.clearBtn.disabled = true;
      slot.uploadBtn.disabled = false;

      recalcStageCode();
      updateProgress();
      maybeAssembleAndSeed();
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
      else if (versionHint === PACK_VERSION_QUESTIONS) order.push("questions");
      else if (versionHint === PACK_VERSION_MATHS) order.push("maths");
      if (!order.includes("full")) order.push("full");
      if (!order.includes("half")) order.push("half");
      if (!order.includes("questions")) order.push("questions");
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
          if (type === "questions") {
            const result = await unsealQuestionPack(stubFile, { password: DEMO_PACK_PASSWORD });
            return { type: "questions", ...result };
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
      setSlotsDisabled(true);
      status.textContent = "Seeding Firestore…";
      log("seeding Firestore…");
      try {
        const { code: seededCode } = await seedFirestoreFromPack(db, pack);
        seeded = true;
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
        if (viaFull) {
          log("base pack seeded (no overrides).");
        } else {
          log("composite pack seeded.");
        }
        watchRoom(seededCode);
      } catch (err) {
        seeded = false;
        const message = err?.message || "Failed to seed Firestore.";
        status.textContent = message;
        log(`error: ${message}`);
        console.error("[keyroom]", err);
        throw err;
      } finally {
        setSlotsDisabled(false);
        updateProgress();
      }
    }

    function buildAssembledPack() {
      const code = clampCode(stage.code);
      if (!code) return null;

      const hostSource = stage.hostOverride || stage.questionsOverride || stage.base;
      const guestSource = stage.guestOverride || stage.questionsOverride || stage.base;
      const mathsSource = stage.mathsOverride || stage.base;

      if (!hostSource || !guestSource || !mathsSource) return null;

      const rounds = [];
      for (let i = 1; i <= 5; i += 1) {
        const baseRound = stage.base?.rounds?.[i] || { hostItems: [], guestItems: [], interlude: "" };
        const questionsRound = stage.questionsOverride?.rounds?.[i];
        const hostRound = stage.hostOverride?.rounds?.[i];
        const guestRound = stage.guestOverride?.rounds?.[i];

        const hostItems =
          hostRound?.hostItems?.length === 3
            ? clone(hostRound.hostItems)
            : questionsRound?.hostItems?.length === 3
            ? clone(questionsRound.hostItems)
            : clone(baseRound.hostItems);

        const guestItems =
          guestRound?.guestItems?.length === 3
            ? clone(guestRound.guestItems)
            : questionsRound?.guestItems?.length === 3
            ? clone(questionsRound.guestItems)
            : clone(baseRound.guestItems);

        if (!Array.isArray(hostItems) || hostItems.length !== 3) return null;
        if (!Array.isArray(guestItems) || guestItems.length !== 3) return null;

        const interludeCandidates = [];
        if (typeof baseRound.interlude === "string" && baseRound.interlude.trim()) {
          interludeCandidates.push({ value: baseRound.interlude, loadedAt: stage.base?.loadedAt || 0 });
        }
        if (questionsRound && typeof questionsRound.interlude === "string" && questionsRound.interlude.trim()) {
          interludeCandidates.push({ value: questionsRound.interlude, loadedAt: stage.questionsOverride?.loadedAt || 0 });
        }
        if (hostRound && typeof hostRound.interlude === "string" && hostRound.interlude.trim()) {
          interludeCandidates.push({ value: hostRound.interlude, loadedAt: stage.hostOverride?.loadedAt || 0 });
        }
        if (guestRound && typeof guestRound.interlude === "string" && guestRound.interlude.trim()) {
          interludeCandidates.push({ value: guestRound.interlude, loadedAt: stage.guestOverride?.loadedAt || 0 });
        }
        interludeCandidates.sort((a, b) => a.loadedAt - b.loadedAt);
        const chosen = interludeCandidates.length ? interludeCandidates[interludeCandidates.length - 1] : null;
        const interlude = chosen ? chosen.value : "";
        if (!interlude) return null;

        rounds.push({
          round: i,
          hostItems,
          guestItems,
          interlude,
        });
      }

      const maths = clone((stage.mathsOverride?.maths || stage.base?.maths) || null);
      if (!maths) return null;

      const meta = stage.base?.meta || {};
      const questionsMeta = stage.questionsOverride?.meta || {};
      const hostUid = meta.hostUid || questionsMeta.hostUid || "demo-host";
      const guestUid = meta.guestUid || questionsMeta.guestUid || "demo-guest";

      const overridesActive = Boolean(
        stage.questionsOverride || stage.hostOverride || stage.guestOverride || stage.mathsOverride
      );

      const generatedAt =
        !overridesActive && stage.base?.generatedAt
          ? stage.base.generatedAt
          : new Date().toISOString();

      const pack = {
        version: PACK_VERSION_FULL,
        meta: {
          roomCode: code,
          generatedAt,
          hostUid,
          guestUid,
        },
        rounds,
        maths,
        integrity: { checksum: "0".repeat(64), verified: true },
      };

      return { pack, code, generatedAt, viaFull: Boolean(stage.base) && !overridesActive };
    }

    async function maybeAssembleAndSeed() {
      const assembled = buildAssembledPack();
      if (!assembled) {
        seeded = false;
        startRow.style.display = "none";
        if (!startPending) {
          startBtn.disabled = true;
          startBtn.classList.remove("throb");
        }
        const hasHost = Boolean(stage.hostOverride || stage.questionsOverride || stage.base);
        const hasGuest = Boolean(stage.guestOverride || stage.questionsOverride || stage.base);
        const hasMaths = Boolean(stage.mathsOverride || stage.base?.maths);
        if (!hasHost || !hasGuest) {
          status.textContent = "Need host & guest questions before seeding.";
        } else if (!hasMaths) {
          status.textContent = "Need maths block before seeding.";
        } else {
          status.textContent = "Awaiting complete pack…";
        }
        return;
      }

      seeded = false;
      if (!startPending) {
        startBtn.disabled = true;
        startBtn.classList.remove("throb");
      }
      status.textContent = assembled.viaFull ? "Preparing full pack…" : "Assembling pack…";
      if (!assembled.viaFull) {
        log(`assembling overrides for ${assembled.code}`);
      }

      if (seedingInFlight) {
        reseedRequested = true;
        return;
      }

      seedingInFlight = true;
      reseedRequested = false;
      try {
        await seedPackAndWatch(assembled.pack, assembled.code, assembled.generatedAt, {
          viaFull: assembled.viaFull,
        });
      } catch (err) {
        // handled in seedPackAndWatch
      } finally {
        seedingInFlight = false;
        if (reseedRequested) {
          reseedRequested = false;
          maybeAssembleAndSeed();
        }
      }
    }

    async function handleFullPack(result) {
      resetStageUI();
      const { pack, code } = result;
      const ensure = ensureStageCode(code);
      if (!ensure.ok) {
        const message = `Room code mismatch: expected ${ensure.expected}, got ${ensure.got}.`;
        status.textContent = message;
        log(`error: ${message}`);
        return;
      }

      stage.base = {
        code,
        rounds: normalizeFullRounds(pack.rounds || []),
        maths: clone(pack.maths),
        meta: {
          hostUid: pack.meta?.hostUid || "demo-host",
          guestUid: pack.meta?.guestUid || "demo-guest",
        },
        generatedAt: pack.meta?.generatedAt || new Date().toISOString(),
        checksum: pack.integrity?.checksum || "",
        loadedAt: Date.now(),
      };

      const fullSlot = slotMap.full;
      if (fullSlot) {
        fullSlot.statusEl.textContent = "Full pack loaded (base).";
        fullSlot.active = true;
        fullSlot.clearBtn.disabled = false;
      }
      copyBtn.disabled = false;
      const when = new Date(stage.base.generatedAt);
      if (!Number.isNaN(when.valueOf())) {
        generatedLabel.textContent = `Generated ${when.toLocaleString()}`;
        metaRow.style.display = "inline-flex";
      } else {
        generatedLabel.textContent = "";
        metaRow.style.display = "none";
      }
      status.textContent = "Full pack loaded. Override boxes will replace matching sections.";
      log(`unsealed pack ${code}`);
      if (stage.base.checksum) {
        log(`checksum OK (${stage.base.checksum.slice(0, 8)}…)`);
      }
      updateProgress();
      await maybeAssembleAndSeed();
    }

    async function handleQuestionsPack(result) {
      const { questions, code } = result;
      const ensure = ensureStageCode(code);
      const slot = slotMap.questions;
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

      const qMeta = questions.meta || {};
      stage.questionsOverride = {
        code,
        rounds: normalizeFullRounds(questions.rounds || []),
        meta: {
          hostUid: typeof qMeta.hostUid === "string" ? qMeta.hostUid : "",
          guestUid: typeof qMeta.guestUid === "string" ? qMeta.guestUid : "",
        },
        generatedAt:
          typeof qMeta.generatedAt === "string" && !Number.isNaN(Date.parse(qMeta.generatedAt))
            ? qMeta.generatedAt
            : "",
        loadedAt: Date.now(),
      };
      if (slot) {
        slot.statusEl.textContent = "All questions pack loaded.";
        slot.active = true;
        slot.clearBtn.disabled = false;
      }
      status.textContent = "Host & guest questions now come from the 30-question pack.";
      log(`30-question pack verified for ${code}`);
      updateProgress();
      await maybeAssembleAndSeed();
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

      const loadedAt = Date.now();
      if (which === "host") {
        stage.hostOverride = {
          code,
          rounds: normalizeHalfpackRounds(halfpack.rounds || [], "host"),
          loadedAt,
        };
      } else {
        stage.guestOverride = {
          code,
          rounds: normalizeHalfpackRounds(halfpack.rounds || [], "guest"),
          loadedAt,
        };
      }

      if (slot) {
        slot.statusEl.textContent = which === "host" ? "Host (15) loaded." : "Guest (15) loaded.";
        slot.active = true;
        slot.clearBtn.disabled = false;
      }
      status.textContent = which === "host"
        ? "Host questions overriding base content."
        : "Guest questions overriding base content.";
      log(`${which} halfpack verified for ${code}`);
      updateProgress();
      await maybeAssembleAndSeed();
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

      stage.mathsOverride = {
        code,
        maths: clone(maths),
        loadedAt: Date.now(),
      };
      if (slot) {
        slot.statusEl.textContent = "Maths block loaded.";
        slot.active = true;
        slot.clearBtn.disabled = false;
      }
      status.textContent = "Maths block overriding base content.";
      log(`maths block verified for ${code}`);
      updateProgress();
      await maybeAssembleAndSeed();
    }

    async function onFileChange(event) {
      if (seedingInFlight) {
        status.textContent = "Please wait for the current seeding to finish.";
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
        } else if (result.type === "questions") {
          await handleQuestionsPack(result);
          processedKey = "questions";
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
          slot.active = false;
          slot.clearBtn.disabled = true;
          slot.uploadBtn.disabled = false;
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
