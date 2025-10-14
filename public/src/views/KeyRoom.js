// /src/views/KeyRoom.js
// Host-facing lobby for uploading sealed packs and launching a room code.
// • Host can enter any 3–5 char code (or roll a random 3-char code).
// • Packs are optional; missing sections fall back to <empty> placeholders.
// • START seeds Firestore with the assembled pack and jumps to the Code Room.

import { ensureAuth, db } from "../lib/firebase.js";
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

const DEFAULT_HOST_UID = "daniel-001";
const DEFAULT_GUEST_UID = "jaime-001";

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function createEmptyItem() {
  return {
    subject: "<empty>",
    difficulty_tier: "pub",
    question: "<empty>",
    correct_answer: "<empty>",
    distractors: {
      easy: "<empty>",
      medium: "<empty>",
      hard: "<empty>",
    },
  };
}

function sanitizeItem(source) {
  const empty = createEmptyItem();
  if (!source || typeof source !== "object") return empty;
  const distractors = source.distractors || {};
  return {
    subject: typeof source.subject === "string" && source.subject.trim() ? source.subject : empty.subject,
    difficulty_tier:
      typeof source.difficulty_tier === "string" && source.difficulty_tier.trim()
        ? source.difficulty_tier
        : empty.difficulty_tier,
    question: typeof source.question === "string" && source.question.trim() ? source.question : empty.question,
    correct_answer:
      typeof source.correct_answer === "string" && source.correct_answer.trim()
        ? source.correct_answer
        : empty.correct_answer,
    distractors: {
      easy: typeof distractors.easy === "string" && distractors.easy.trim() ? distractors.easy : empty.distractors.easy,
      medium:
        typeof distractors.medium === "string" && distractors.medium.trim()
          ? distractors.medium
          : empty.distractors.medium,
      hard: typeof distractors.hard === "string" && distractors.hard.trim() ? distractors.hard : empty.distractors.hard,
    },
  };
}

function ensureItemArray(list = []) {
  const items = Array.isArray(list) ? list : [];
  const out = [];
  for (let i = 0; i < 3; i += 1) {
    out.push(sanitizeItem(items[i]));
  }
  return out;
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
    if (which === "host") entry.hostItems = clone(round.hostItems || []);
    if (which === "guest") entry.guestItems = clone(round.guestItems || []);
    if (typeof round.interlude === "string" && round.interlude.trim()) {
      entry.interlude = round.interlude;
    }
  });
  return map;
}

function sanitizeMaths(source) {
  const maths = source && typeof source === "object" ? clone(source) : {};
  const beats = Array.isArray(maths.beats) ? maths.beats.filter((b) => typeof b === "string" && b.trim()) : [];
  const questions = Array.isArray(maths.questions) ? maths.questions : [];
  const answers = Array.isArray(maths.answers) ? maths.answers : [];
  return {
    location: typeof maths.location === "string" && maths.location.trim() ? maths.location : "<empty>",
    beats: beats.length ? beats : ["<empty>"],
    questions: [
      typeof questions[0] === "string" && questions[0].trim() ? questions[0] : "<empty>",
      typeof questions[1] === "string" && questions[1].trim() ? questions[1] : "<empty>",
    ],
    answers: [
      Number.isInteger(answers[0]) ? answers[0] : 0,
      Number.isInteger(answers[1]) ? answers[1] : 0,
    ],
  };
}

function determineSourceLabel(stage, kind) {
  if (kind === "host") {
    if (stage.hostOverride) return "Host (15)";
    if (stage.questionsOverride) return "All Questions (30)";
    if (stage.base) return "Full Pack";
    return "<empty>";
  }
  if (kind === "guest") {
    if (stage.guestOverride) return "Guest (15)";
    if (stage.questionsOverride) return "All Questions (30)";
    if (stage.base) return "Full Pack";
    return "<empty>";
  }
  if (kind === "maths") {
    if (stage.mathsOverride) return "Maths Pack";
    if (stage.base?.maths) return "Full Pack";
    return "<empty>";
  }
  return "<empty>";
}

function buildPackFromStage(stage, code) {
  const safeCode = clampCode(code);
  const baseMeta = stage.base?.meta || {};
  const questionsMeta = stage.questionsOverride?.meta || {};
  const hostUid = baseMeta.hostUid || questionsMeta.hostUid || DEFAULT_HOST_UID;
  const guestUid = baseMeta.guestUid || questionsMeta.guestUid || DEFAULT_GUEST_UID;

  const rounds = [];
  for (let i = 1; i <= 5; i += 1) {
    const baseRound = stage.base?.rounds?.[i] || {};
    const questionsRound = stage.questionsOverride?.rounds?.[i] || {};
    const hostRound = stage.hostOverride?.rounds?.[i] || {};
    const guestRound = stage.guestOverride?.rounds?.[i] || {};

    const hostItems = hostRound.hostItems?.length === 3
      ? ensureItemArray(hostRound.hostItems)
      : questionsRound.hostItems?.length === 3
      ? ensureItemArray(questionsRound.hostItems)
      : ensureItemArray(baseRound.hostItems);

    const guestItems = guestRound.guestItems?.length === 3
      ? ensureItemArray(guestRound.guestItems)
      : questionsRound.guestItems?.length === 3
      ? ensureItemArray(questionsRound.guestItems)
      : ensureItemArray(baseRound.guestItems);

    const interludeCandidates = [];
    if (typeof baseRound.interlude === "string" && baseRound.interlude.trim()) {
      interludeCandidates.push({ value: baseRound.interlude, loadedAt: stage.base?.loadedAt || 0 });
    }
    if (typeof questionsRound.interlude === "string" && questionsRound.interlude.trim()) {
      interludeCandidates.push({ value: questionsRound.interlude, loadedAt: stage.questionsOverride?.loadedAt || 0 });
    }
    if (typeof hostRound.interlude === "string" && hostRound.interlude.trim()) {
      interludeCandidates.push({ value: hostRound.interlude, loadedAt: stage.hostOverride?.loadedAt || 0 });
    }
    if (typeof guestRound.interlude === "string" && guestRound.interlude.trim()) {
      interludeCandidates.push({ value: guestRound.interlude, loadedAt: stage.guestOverride?.loadedAt || 0 });
    }
    interludeCandidates.sort((a, b) => a.loadedAt - b.loadedAt);
    const chosen = interludeCandidates.length ? interludeCandidates[interludeCandidates.length - 1] : null;
    const interlude = chosen ? chosen.value : "<empty>";

    rounds.push({
      round: i,
      hostItems,
      guestItems,
      interlude,
    });
  }

  const mathsSource = stage.mathsOverride?.maths || stage.base?.maths || null;
  const maths = sanitizeMaths(mathsSource);

  const overridesActive = Boolean(
    stage.questionsOverride || stage.hostOverride || stage.guestOverride || stage.mathsOverride
  );
  const generatedAt =
    !overridesActive && stage.base?.generatedAt
      ? stage.base.generatedAt
      : stage.questionsOverride?.generatedAt || new Date().toISOString();

  return {
    version: PACK_VERSION_FULL,
    meta: {
      roomCode: safeCode,
      generatedAt,
      hostUid,
      guestUid,
    },
    rounds,
    maths,
    integrity: { checksum: "0".repeat(64), verified: true },
  };
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

function createStage() {
  return {
    base: null,
    questionsOverride: null,
    hostOverride: null,
    guestOverride: null,
    mathsOverride: null,
  };
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
      "Enter a room code and optionally upload sealed packs."
    );
    card.appendChild(intro);

    const codeRow = el("div", {
      class: "mono",
      style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px;justify-content:center;",
    });
    const codeInput = el("input", {
      type: "text",
      class: "input",
      maxlength: "5",
      value: hintedCode,
      placeholder: "ABC",
      autocapitalize: "characters",
      style: "width:120px;text-align:center;font-weight:700;letter-spacing:4px;",
    });
    const randomBtn = el("button", { class: "btn outline", type: "button" }, "Random");
    const startBtn = el("button", { class: "btn primary", type: "button", disabled: "" }, "Start");
    codeRow.appendChild(codeInput);
    codeRow.appendChild(randomBtn);
    codeRow.appendChild(startBtn);
    card.appendChild(codeRow);

    const uploadGrid = el("div", {
      class: "mono",
      style: "display:flex;flex-direction:column;gap:10px;margin-bottom:10px;",
    });
    card.appendChild(uploadGrid);

    const slotConfigs = {
      full: { label: "Full Pack", initial: "Awaiting full pack." },
      questions: { label: "All Questions (30)", initial: "Awaiting 30-question pack." },
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
      });
      const uploadBtn = el("button", { class: "btn outline", type: "button" }, "Upload");
      uploadBtn.addEventListener("click", () => {
        if (!uploadBtn.disabled) input.click();
      });
      const clearBtn = el("button", { class: "btn outline", type: "button", disabled: "" }, "Clear");
      clearBtn.addEventListener("click", () => clearSlot(key));
      input.addEventListener("change", onFileChange);
      const buttonRow = el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;" }, [uploadBtn, clearBtn]);
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
      { class: "mono small", style: "margin-top:4px;text-align:center;min-height:18px;" },
      "Sources → Host: <empty> · Guest: <empty> · Maths: <empty>"
    );
    card.appendChild(progressLine);

    const status = el(
      "div",
      { class: "mono small", style: "margin-top:10px;min-height:18px;" },
      "Enter a room code to get started."
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

    const logEl = el("pre", {
      class: "mono small",
      style:
        "margin-top:14px;background:rgba(0,0,0,0.05);padding:10px;border-radius:10px;min-height:120px;max-height:180px;overflow:auto;",
    });
    card.appendChild(logEl);

    const backBtn = el(
      "a",
      { class: "btn outline", href: "#/lobby", style: "display:inline-block;margin-top:14px;" },
      "Back"
    );
    card.appendChild(backBtn);

    root.appendChild(card);
    container.appendChild(root);

    let stage = createStage();
    let processingFile = false;
    let startPending = false;

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

    function updateProgress() {
      progressLine.textContent = `Sources → Host: ${determineSourceLabel(stage, "host")} · Guest: ${determineSourceLabel(
        stage,
        "guest"
      )} · Maths: ${determineSourceLabel(stage, "maths")}`;
    }

    function resetStageUI() {
      stage = createStage();
      Object.values(slotMap).forEach((slot) => {
        slot.statusEl.textContent = slot.initialText;
        slot.active = false;
        slot.clearBtn.disabled = true;
        slot.uploadBtn.disabled = false;
      });
      updateProgress();
      generatedLabel.textContent = "";
      metaRow.style.display = "none";
    }

    function reflectStartButton() {
      const code = clampCode(codeInput.value || "");
      if (code !== codeInput.value) {
        codeInput.value = code;
      }
      const ready = code.length >= 3 && !processingFile && !startPending;
      startBtn.disabled = !ready;
      startBtn.classList.toggle("throb", ready);
    }

    function clearSlot(key) {
      const slot = slotMap[key];
      if (!slot || processingFile) return;
      if (key === "full") {
        stage.base = null;
        generatedLabel.textContent = "";
        metaRow.style.display = "none";
        status.textContent = "Full pack cleared.";
        log("full pack cleared.");
      } else if (key === "questions") {
        stage.questionsOverride = null;
        status.textContent = "All questions pack cleared.";
        log("questions pack cleared.");
      } else if (key === "host") {
        stage.hostOverride = null;
        status.textContent = "Host halfpack cleared.";
        log("host halfpack cleared.");
      } else if (key === "guest") {
        stage.guestOverride = null;
        status.textContent = "Guest halfpack cleared.";
        log("guest halfpack cleared.");
      } else if (key === "maths") {
        stage.mathsOverride = null;
        status.textContent = "Maths pack cleared.";
        log("maths block cleared.");
      }
      slot.statusEl.textContent = slot.initialText;
      slot.active = false;
      slot.clearBtn.disabled = true;
      slot.uploadBtn.disabled = false;
      updateProgress();
    }

    async function onFileChange(event) {
      if (processingFile) {
        status.textContent = "Please wait for the current file to finish.";
        event.target.value = "";
        return;
      }

      const key = event.target?.dataset?.slotKey || "";
      const slot = key ? slotMap[key] : null;
      const file = event.target?.files?.[0];
      event.target.value = "";
      if (!file) return;

      processingFile = true;
      setSlotsDisabled(true);
      reflectStartButton();
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
      } finally {
        processingFile = false;
        setSlotsDisabled(false);
        reflectStartButton();
      }

      if (slot && processedKey && processedKey !== key) {
        slot.statusEl.textContent = slot.initialText;
        slot.active = false;
        slot.clearBtn.disabled = true;
        slot.uploadBtn.disabled = false;
      }
    }

    async function handleFullPack(result) {
      resetStageUI();
      const { pack, code } = result;
      stage.base = {
        code,
        rounds: normalizeFullRounds(pack.rounds || []),
        maths: clone(pack.maths),
        meta: {
          hostUid: pack.meta?.hostUid || DEFAULT_HOST_UID,
          guestUid: pack.meta?.guestUid || DEFAULT_GUEST_UID,
        },
        generatedAt: pack.meta?.generatedAt || new Date().toISOString(),
        checksum: pack.integrity?.checksum || "",
        loadedAt: Date.now(),
      };

      const slot = slotMap.full;
      if (slot) {
        slot.statusEl.textContent = "Full pack loaded (base).";
        slot.active = true;
        slot.clearBtn.disabled = false;
      }
      const when = new Date(stage.base.generatedAt);
      if (!Number.isNaN(when.valueOf())) {
        generatedLabel.textContent = `Generated ${when.toLocaleString()}`;
        metaRow.style.display = "inline-flex";
      } else {
        generatedLabel.textContent = "";
        metaRow.style.display = "none";
      }
      status.textContent = "Full pack loaded. Overrides will replace matching sections.";
      log(`unsealed pack ${code || "(no code)"}`);
      if (stage.base.checksum) {
        log(`checksum OK (${stage.base.checksum.slice(0, 8)}…)`);
      }
      updateProgress();
    }

    async function handleQuestionsPack(result) {
      const { questions } = result;
      const slot = slotMap.questions;
      const qMeta = questions.meta || {};
      stage.questionsOverride = {
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
      log("30-question pack loaded.");
      updateProgress();
    }

    async function handleHalfpack(result) {
      const { halfpack, which } = result;
      const slot = slotMap[which];
      const loadedAt = Date.now();
      if (which === "host") {
        stage.hostOverride = {
          rounds: normalizeHalfpackRounds(halfpack.rounds || [], "host"),
          loadedAt,
        };
      } else {
        stage.guestOverride = {
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
      log(`${which} halfpack loaded.`);
      updateProgress();
    }

    async function handleMaths(result) {
      const { maths } = result;
      const slot = slotMap.maths;
      stage.mathsOverride = {
        maths: clone(maths),
        loadedAt: Date.now(),
      };
      if (slot) {
        slot.statusEl.textContent = "Maths block loaded.";
        slot.active = true;
        slot.clearBtn.disabled = false;
      }
      status.textContent = "Maths block overriding base content.";
      log("maths block loaded.");
      updateProgress();
    }

    async function startRoom() {
      if (processingFile || startPending) return;
      const code = clampCode(codeInput.value || "");
      if (code.length < 3) {
        status.textContent = "Enter a 3–5 letter code.";
        reflectStartButton();
        return;
      }

      startPending = true;
      reflectStartButton();
      setSlotsDisabled(true);
      codeInput.disabled = true;
      randomBtn.disabled = true;
      status.textContent = "Creating room…";
      log(`assembling pack for code ${code}`);

      try {
        const pack = buildPackFromStage(stage, code);
        pack.meta.roomCode = code;
        await seedFirestoreFromPack(db, pack, { initialState: "coderoom" });
        setStoredRole(code, "host");
        status.textContent = "Room ready. Heading to code room…";
        log(`room ${code} prepared.`);
        setTimeout(() => {
          location.hash = `#/coderoom?code=${code}`;
        }, 250);
      } catch (err) {
        const message = err?.message || "Failed to create room.";
        status.textContent = message;
        log(`error: ${message}`);
        console.error("[keyroom]", err);
        startPending = false;
        setSlotsDisabled(false);
        codeInput.disabled = false;
        randomBtn.disabled = false;
        reflectStartButton();
      }
    }

    codeInput.addEventListener("input", () => {
      reflectStartButton();
      status.textContent = "Ready when you are.";
    });
    codeInput.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        startRoom();
      }
    });

    randomBtn.addEventListener("click", () => {
      if (processingFile) return;
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ";
      let code = "";
      for (let i = 0; i < 3; i += 1) {
        code += alphabet[Math.floor(Math.random() * alphabet.length)];
      }
      codeInput.value = code;
      reflectStartButton();
      status.textContent = "Random code generated.";
    });

    startBtn.addEventListener("click", startRoom);

    reflectStartButton();
    updateProgress();
  },

  async unmount() {},
};
