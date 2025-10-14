// /src/views/KeyRoom.js
// Host-only staging area for sealed packs and manual room code entry.
// • Allows uploading any mix of full/half/question/maths packs (codes can differ).
// • START assembles a composite pack (filling gaps with “<empty>” placeholders) and seeds Firestore.
// • Room code is taken from the on-screen textbox (or RANDOM button) when START is pressed.
// • After seeding the host is routed to the Code Room while Jaime waits to join.

import { ensureAuth, db } from "../lib/firebase.js";
import { doc, updateDoc, serverTimestamp } from "firebase/firestore";
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
import { clampCode, getHashParams, setStoredRole } from "../lib/util.js";

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

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function makePlaceholderItem(role, round, index) {
  return {
    subject: "<empty>",
    difficulty_tier: "<empty>",
    question: "<empty>",
    correct_answer: "<empty>",
    distractors: {
      easy: "<empty>",
      medium: "<empty>",
      hard: "<empty>",
    },
    meta: {
      role,
      round,
      index,
    },
  };
}

function placeholderMaths() {
  return {
    location: "<empty>",
    beats: ["<empty>", "<empty>", "<empty>", "<empty>"],
    questions: ["<empty>", "<empty>"],
    answers: [0, 0],
  };
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

function labelWithCode(label, source) {
  if (source?.code) {
    return `${label} (${source.code})`;
  }
  return label;
}

function generateRandomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < 3; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

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
      "Upload any Jemima sealed packs (optional), pick a room code, then press START."
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

    const progressLine = el(
      "div",
      {
        class: "mono small",
        style: "margin-top:4px;text-align:center;min-height:18px;",
      },
      "Sources → Host: — · Guest: — · Maths: —"
    );
    card.appendChild(progressLine);

    const status = el(
      "div",
      { class: "mono small", style: "margin-top:10px;min-height:18px;" },
      ""
    );
    card.appendChild(status);

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
      style:
        "margin-top:18px;display:flex;flex-direction:column;gap:10px;align-items:center;justify-content:center;",
    });
    const codeLabel = el(
      "span",
      { class: "mono", style: "font-weight:700;" },
      "Room code"
    );
    const codeInput = el("input", {
      type: "text",
      class: "input",
      style:
        "text-transform:uppercase;text-align:center;font-size:20px;letter-spacing:4px;max-width:160px;padding:6px 10px;",
      autocomplete: "off",
      autocapitalize: "characters",
      maxlength: "5",
    });
    const codeRow = el(
      "div",
      { style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:center;" },
      [codeLabel, codeInput]
    );
    const controlsRow = el(
      "div",
      { style: "display:flex;gap:10px;flex-wrap:wrap;justify-content:center;" },
      []
    );
    const randomBtn = el("button", { class: "btn outline", type: "button" }, "Random");
    const startBtn = el("button", { class: "btn primary", type: "button", disabled: "" }, "START");
    controlsRow.appendChild(randomBtn);
    controlsRow.appendChild(startBtn);
    startRow.appendChild(codeRow);
    startRow.appendChild(controlsRow);
    card.appendChild(startRow);

    const logEl = el("pre", {
      class: "mono small",
      style:
        "margin-top:14px;background:rgba(0,0,0,0.05);padding:10px;border-radius:10px;min-height:120px;max-height:180px;overflow:auto;",
    });
    card.appendChild(logEl);

    const backBtn = el(
      "button",
      { class: "btn outline", type: "button", style: "margin-top:12px;" },
      "Back"
    );
    backBtn.addEventListener("click", () => {
      location.hash = "#/lobby";
    });
    card.appendChild(backBtn);

    root.appendChild(card);
    container.appendChild(root);

    function createStage() {
      return {
        base: null,
        questionsOverride: null,
        hostOverride: null,
        guestOverride: null,
        mathsOverride: null,
      };
    }

    let stage = createStage();
    let starting = false;

    function log(message) {
      const stamp = new Date().toISOString().split("T")[1].replace(/Z$/, "");
      logEl.textContent += `[${stamp}] ${message}\n`;
      logEl.scrollTop = logEl.scrollHeight;
      console.log(`[keyroom] ${message}`);
    }

    function getSourceLabel(kind) {
      if (kind === "host") {
        if (stage.hostOverride) return labelWithCode("Host (15)", stage.hostOverride);
        if (stage.questionsOverride) return labelWithCode("All Questions (30)", stage.questionsOverride);
        if (stage.base) return labelWithCode("Full Pack", stage.base);
        return null;
      }
      if (kind === "guest") {
        if (stage.guestOverride) return labelWithCode("Guest (15)", stage.guestOverride);
        if (stage.questionsOverride) return labelWithCode("All Questions (30)", stage.questionsOverride);
        if (stage.base) return labelWithCode("Full Pack", stage.base);
        return null;
      }
      if (kind === "maths") {
        if (stage.mathsOverride) return labelWithCode("Maths Pack", stage.mathsOverride);
        if (stage.base?.maths) return labelWithCode("Full Pack", stage.base);
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

    function updateReadiness() {
      const hasHost = Boolean(stage.hostOverride || stage.questionsOverride || stage.base);
      const hasGuest = Boolean(stage.guestOverride || stage.questionsOverride || stage.base);
      const hasMaths = Boolean(stage.mathsOverride || stage.base?.maths);

      if (!hasHost && !hasGuest && !hasMaths) {
        status.textContent = "No packs loaded. START will use <empty> placeholders.";
        return;
      }

      const missing = [];
      if (!hasHost) missing.push("host questions");
      if (!hasGuest) missing.push("guest questions");
      if (!hasMaths) missing.push("maths block");

      if (missing.length) {
        status.textContent = `Missing ${missing.join(" & ")}. START will fill them with <empty>.`;
      } else {
        status.textContent = "Ready. START will use the uploaded sources.";
      }
    }

    function reflectCodeState() {
      const clamped = clampCode(codeInput.value || "");
      if (clamped !== codeInput.value) codeInput.value = clamped;
      const ready = !starting && clamped.length >= 3;
      startBtn.disabled = !ready;
      startBtn.classList.toggle("throb", ready);
    }

    function resetStageUI() {
      stage = createStage();
      Object.values(slotMap).forEach((slot) => {
        slot.statusEl.textContent = slot.initialText;
        slot.active = false;
        slot.clearBtn.disabled = true;
        slot.uploadBtn.disabled = false;
      });
      generatedLabel.textContent = "";
      metaRow.style.display = "none";
      updateProgress();
      updateReadiness();
    }

    function clearSlot(key) {
      const slot = slotMap[key];
      if (!slot) return;

      if (key === "full") {
        stage.base = null;
        generatedLabel.textContent = "";
        metaRow.style.display = "none";
        log("full pack cleared.");
      } else if (key === "questions") {
        stage.questionsOverride = null;
        log("questions pack cleared.");
      } else if (key === "host") {
        stage.hostOverride = null;
        log("host halfpack cleared.");
      } else if (key === "guest") {
        stage.guestOverride = null;
        log("guest halfpack cleared.");
      } else if (key === "maths") {
        stage.mathsOverride = null;
        log("maths block cleared.");
      }

      slot.statusEl.textContent = slot.initialText;
      slot.active = false;
      slot.clearBtn.disabled = true;
      slot.uploadBtn.disabled = false;

      updateProgress();
      updateReadiness();
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

    function applyGeneratedAt(iso) {
      if (typeof iso === "string" && !Number.isNaN(Date.parse(iso))) {
        const when = new Date(iso);
        generatedLabel.textContent = `Generated ${when.toLocaleString()}`;
        metaRow.style.display = "inline-flex";
      } else {
        generatedLabel.textContent = "";
        metaRow.style.display = "none";
      }
    }

    async function handleFullPack(result) {
      const { pack, code } = result;
      stage.base = {
        code,
        rounds: normalizeFullRounds(pack.rounds || []),
        maths: clone(pack.maths),
        meta: {
          hostUid: pack.meta?.hostUid || "daniel-001",
          guestUid: pack.meta?.guestUid || "jaime-001",
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
      applyGeneratedAt(stage.base.generatedAt);
      log(`unsealed pack ${code}`);
      if (stage.base.checksum) {
        log(`checksum OK (${stage.base.checksum.slice(0, 8)}…)`);
      }
      updateProgress();
      updateReadiness();
    }

    async function handleQuestionsPack(result) {
      const { questions, code } = result;
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
      const slot = slotMap.questions;
      if (slot) {
        slot.statusEl.textContent = "All questions pack loaded.";
        slot.active = true;
        slot.clearBtn.disabled = false;
      }
      log(`30-question pack verified (${code}).`);
      updateProgress();
      updateReadiness();
    }

    async function handleHalfpack(result) {
      const { halfpack, which, code } = result;
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
      const slot = slotMap[which];
      if (slot) {
        slot.statusEl.textContent = which === "host" ? "Host (15) loaded." : "Guest (15) loaded.";
        slot.active = true;
        slot.clearBtn.disabled = false;
      }
      log(`${which} halfpack verified (${code}).`);
      updateProgress();
      updateReadiness();
    }

    async function handleMaths(result) {
      const { maths, code } = result;
      stage.mathsOverride = {
        code,
        maths: clone(maths),
        loadedAt: Date.now(),
      };
      const slot = slotMap.maths;
      if (slot) {
        slot.statusEl.textContent = "Maths block loaded.";
        slot.active = true;
        slot.clearBtn.disabled = false;
      }
      log(`maths block verified (${code}).`);
      updateProgress();
      updateReadiness();
    }

    async function onFileChange(event) {
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

      try {
        const result = await determineSealedType(file);
        if (result.type === "full") {
          await handleFullPack(result);
        } else if (result.type === "questions") {
          await handleQuestionsPack(result);
        } else if (result.type === "half") {
          await handleHalfpack(result);
        } else if (result.type === "maths") {
          await handleMaths(result);
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
    }

    function chooseItems(roundIndex, role) {
      const key = role === "host" ? "hostItems" : "guestItems";
      const fromHalf = role === "host" ? stage.hostOverride?.rounds?.[roundIndex]?.[key] : stage.guestOverride?.rounds?.[roundIndex]?.[key];
      const fromQuestions = stage.questionsOverride?.rounds?.[roundIndex]?.[key];
      const fromBase = stage.base?.rounds?.[roundIndex]?.[key];
      const stacks = [fromHalf, fromQuestions, fromBase];
      for (const arr of stacks) {
        if (Array.isArray(arr) && arr.length === 3) {
          return clone(arr);
        }
      }
      const fallback = [];
      stacks.forEach((arr) => {
        if (Array.isArray(arr)) {
          arr.forEach((item) => {
            if (fallback.length < 3) {
              const copy = clone(item);
              if (copy && typeof copy === "object") fallback.push(copy);
            }
          });
        }
      });
      while (fallback.length < 3) {
        fallback.push(makePlaceholderItem(role, roundIndex, fallback.length + 1));
      }
      return fallback.slice(0, 3);
    }

    function chooseInterlude(roundIndex) {
      const baseRound = stage.base?.rounds?.[roundIndex];
      const questionRound = stage.questionsOverride?.rounds?.[roundIndex];
      const hostRound = stage.hostOverride?.rounds?.[roundIndex];
      const guestRound = stage.guestOverride?.rounds?.[roundIndex];
      const candidates = [];
      if (baseRound?.interlude) candidates.push({ value: baseRound.interlude, loadedAt: stage.base?.loadedAt || 0 });
      if (questionRound?.interlude) candidates.push({ value: questionRound.interlude, loadedAt: stage.questionsOverride?.loadedAt || 0 });
      if (hostRound?.interlude) candidates.push({ value: hostRound.interlude, loadedAt: stage.hostOverride?.loadedAt || 0 });
      if (guestRound?.interlude) candidates.push({ value: guestRound.interlude, loadedAt: stage.guestOverride?.loadedAt || 0 });
      if (!candidates.length) return "<empty>";
      candidates.sort((a, b) => a.loadedAt - b.loadedAt);
      return candidates[candidates.length - 1].value || "<empty>";
    }

    function buildCompositePack(code) {
      const rounds = [];
      for (let i = 1; i <= 5; i += 1) {
        rounds.push({
          round: i,
          hostItems: chooseItems(i, "host"),
          guestItems: chooseItems(i, "guest"),
          interlude: chooseInterlude(i) || "<empty>",
        });
      }

      const maths = clone(stage.mathsOverride?.maths || stage.base?.maths) || placeholderMaths();

      const hostUid =
        stage.hostOverride?.meta?.hostUid ||
        stage.questionsOverride?.meta?.hostUid ||
        stage.base?.meta?.hostUid ||
        "daniel-001";
      const guestUid =
        stage.guestOverride?.meta?.guestUid ||
        stage.questionsOverride?.meta?.guestUid ||
        stage.base?.meta?.guestUid ||
        "jaime-001";

      const generatedAt =
        stage.base?.generatedAt ||
        stage.questionsOverride?.generatedAt ||
        new Date().toISOString();

      return {
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
    }

    async function startGame() {
      const code = clampCode(codeInput.value || "");
      if (code.length < 3) {
        status.textContent = "Enter a room code (3–5 letters/numbers).";
        return;
      }
      if (starting) return;

      starting = true;
      reflectCodeState();
      randomBtn.disabled = true;
      codeInput.disabled = true;
      status.textContent = "Preparing room…";

      let failed = false;
      try {
        const pack = buildCompositePack(code);
        await seedFirestoreFromPack(db, pack);
        await updateDoc(roomRef(code), {
          state: "coderoom",
          "timestamps.updatedAt": serverTimestamp(),
        });
        setStoredRole(code, "host");
        log(`room ${code} prepared.`);
        status.textContent = "Room ready. Heading to the Code Room…";
        location.hash = `#/coderoom?code=${code}`;
      } catch (err) {
        const message = err?.message || "Failed to start. Try again.";
        status.textContent = message;
        log(`error: ${message}`);
        console.error("[keyroom]", err);
        failed = true;
      } finally {
        starting = false;
        randomBtn.disabled = false;
        codeInput.disabled = false;
        reflectCodeState();
        updateProgress();
        if (!failed) {
          updateReadiness();
        }
      }
    }

    resetStageUI();
    if (hintedCode) {
      codeInput.value = hintedCode;
    }
    reflectCodeState();

    codeInput.addEventListener("input", reflectCodeState);
    codeInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        startGame();
      }
    });
    randomBtn.addEventListener("click", () => {
      codeInput.value = generateRandomCode();
      reflectCodeState();
    });
    startBtn.addEventListener("click", startGame);
  },

  async unmount() {},
};
