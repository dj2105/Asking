// /src/views/KeyRoom.js
// Host-only sealed-pack upload flow with manual room code entry.
// • Host can upload any mix of sealed packs in any order.
// • Room code is chosen via text box or randomiser before pressing START.
// • START assembles the best-available content, fills gaps with "<empty>", seeds Firestore,
//   sets the room to coderoom state, and routes to the dedicated Code Room view.

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

const MAX_CODE_LENGTH = 3;

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
const clampRoomCode = (input) => clampCode(input).slice(0, MAX_CODE_LENGTH);
const PLACEHOLDER_ITEM = {
  subject: "<empty>",
  difficulty_tier: "<empty>",
  question: "<empty>",
  correct_answer: "<empty>",
  distractors: { easy: "<empty>", medium: "<empty>", hard: "<empty>" },
};
const PLACEHOLDER_MATHS = {
  location: "<empty>",
  beats: ["<empty>"],
  questions: ["<empty>", "<empty>"],
  answers: [0, 0],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function makePlaceholderItem() {
  return clone(PLACEHOLDER_ITEM);
}

function fillItems(list = []) {
  const out = clone(list || []).filter(Boolean).map((item) => {
    const base = typeof item === "object" && item ? item : {};
    return {
      subject: typeof base.subject === "string" && base.subject.trim() ? base.subject : "<empty>",
      difficulty_tier:
        typeof base.difficulty_tier === "string" && base.difficulty_tier.trim()
          ? base.difficulty_tier
          : "<empty>",
      question: typeof base.question === "string" && base.question.trim() ? base.question : "<empty>",
      correct_answer:
        typeof base.correct_answer === "string" && base.correct_answer.trim()
          ? base.correct_answer
          : "<empty>",
      distractors: {
        easy:
          typeof base?.distractors?.easy === "string" && base.distractors.easy.trim()
            ? base.distractors.easy
            : "<empty>",
        medium:
          typeof base?.distractors?.medium === "string" && base.distractors.medium.trim()
            ? base.distractors.medium
            : "<empty>",
        hard:
          typeof base?.distractors?.hard === "string" && base.distractors.hard.trim()
            ? base.distractors.hard
            : "<empty>",
      },
    };
  });
  while (out.length < 3) out.push(makePlaceholderItem());
  return out.slice(0, 3);
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

function randomCode() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < MAX_CODE_LENGTH; i += 1) {
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
    const hintedCode = clampRoomCode(params.get("code") || "");

    container.innerHTML = "";
    const root = el("div", { class: "view view-keyroom" });
    const card = el("div", { class: "card" });
    card.appendChild(el("h1", { class: "title" }, "Key Room"));
    const intro = el(
      "div",
      { class: "mono", style: "margin-bottom:10px;" },
      "Upload Jemima’s sealed packs in any order, then choose your code."
    );
    card.appendChild(intro);

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
      "Enter a code and press START when ready."
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

    const codeRow = el("div", {
      class: "mono",
      style:
        "margin-top:16px;display:flex;flex-wrap:wrap;gap:10px;justify-content:center;align-items:center;",
    });
    const codeInput = el("input", {
      type: "text",
      inputmode: "text",
      autocapitalize: "characters",
      maxlength: String(MAX_CODE_LENGTH),
      class: "input",
      style: "text-transform:uppercase;width:90px;text-align:center;",
      value: hintedCode,
      oninput: (event) => {
        const next = clampRoomCode(event.target.value);
        if (event.target.value !== next) event.target.value = next;
        reflectStartState();
      },
    });
    const randomBtn = el(
      "button",
      { class: "btn outline", type: "button" },
      "RANDOM"
    );
    randomBtn.addEventListener("click", () => {
      codeInput.value = randomCode();
      reflectStartState();
    });
    const startBtn = el("button", { class: "btn primary", type: "button", disabled: "" }, "START");
    codeRow.appendChild(codeInput);
    codeRow.appendChild(randomBtn);
    codeRow.appendChild(startBtn);
    card.appendChild(codeRow);

    const logEl = el("pre", {
      class: "mono small",
      style:
        "margin-top:14px;background:rgba(0,0,0,0.05);padding:10px;border-radius:10px;min-height:120px;max-height:180px;overflow:auto;",
    });
    card.appendChild(logEl);

    const navRow = el(
      "div",
      { style: "margin-top:14px;text-align:center;" },
      el("a", { href: "#/lobby", class: "btn outline" }, "BACK")
    );
    card.appendChild(navRow);

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
    let seeding = false;

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
      randomBtn.disabled = Boolean(flag);
      codeInput.disabled = Boolean(flag);
    }

    function updateProgress() {
      const hostSource = stage.hostOverride
        ? "Host (15)"
        : stage.questionsOverride
        ? "All Questions (30)"
        : stage.base
        ? "Full Pack"
        : "—";
      const guestSource = stage.guestOverride
        ? "Guest (15)"
        : stage.questionsOverride
        ? "All Questions (30)"
        : stage.base
        ? "Full Pack"
        : "—";
      const mathsSource = stage.mathsOverride
        ? "Maths Pack"
        : stage.base?.maths
        ? "Full Pack"
        : "—";
      progressLine.textContent = `Sources → Host: ${hostSource} · Guest: ${guestSource} · Maths: ${mathsSource}`;
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
    }

    function clearSlot(key) {
      const slot = slotMap[key];
      if (!slot) return;
      if (seeding) {
        status.textContent = "Please wait for the current start to finish.";
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
        status.textContent = "Maths block cleared.";
        log("maths block cleared.");
      }

      slot.statusEl.textContent = slot.initialText;
      slot.active = false;
      slot.clearBtn.disabled = true;
      slot.uploadBtn.disabled = false;

      updateProgress();
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

    function assemblePackForCode(code) {
      const rounds = [];
      for (let i = 1; i <= 5; i += 1) {
        const baseRound = stage.base?.rounds?.[i] || {};
        const questionsRound = stage.questionsOverride?.rounds?.[i] || {};
        const hostRound = stage.hostOverride?.rounds?.[i] || {};
        const guestRound = stage.guestOverride?.rounds?.[i] || {};

        const hostItems = hostRound.hostItems?.length
          ? hostRound.hostItems
          : questionsRound.hostItems?.length
          ? questionsRound.hostItems
          : baseRound.hostItems?.length
          ? baseRound.hostItems
          : [];

        const guestItems = guestRound.guestItems?.length
          ? guestRound.guestItems
          : questionsRound.guestItems?.length
          ? questionsRound.guestItems
          : baseRound.guestItems?.length
          ? baseRound.guestItems
          : [];

        const interludeCandidate = [
          hostRound.interlude,
          guestRound.interlude,
          questionsRound.interlude,
          baseRound.interlude,
        ].find((value) => typeof value === "string" && value.trim());

        rounds.push({
          round: i,
          hostItems: fillItems(hostItems),
          guestItems: fillItems(guestItems),
          interlude: interludeCandidate || "<empty>",
        });
      }

      const sourceMaths = clone(stage.mathsOverride?.maths || stage.base?.maths || null);
      const maths = sourceMaths
        ? {
            location:
              typeof sourceMaths.location === "string" && sourceMaths.location.trim()
                ? sourceMaths.location
                : "<empty>",
            beats: Array.isArray(sourceMaths.beats) && sourceMaths.beats.length
              ? sourceMaths.beats.map((beat) =>
                  typeof beat === "string" && beat.trim() ? beat : "<empty>"
                )
              : ["<empty>"],
            questions: Array.isArray(sourceMaths.questions) && sourceMaths.questions.length >= 2
              ? sourceMaths.questions
                  .slice(0, 2)
                  .map((q) => (typeof q === "string" && q.trim() ? q : "<empty>"))
              : ["<empty>", "<empty>"],
            answers: Array.isArray(sourceMaths.answers) && sourceMaths.answers.length >= 2
              ? sourceMaths.answers.slice(0, 2).map((ans) => (Number.isInteger(ans) ? ans : 0))
              : [0, 0],
          }
        : clone(PLACEHOLDER_MATHS);

      const hostUid = stage.base?.meta?.hostUid || stage.questionsOverride?.meta?.hostUid || "daniel-001";
      const guestUid = stage.base?.meta?.guestUid || stage.questionsOverride?.meta?.guestUid || "jaime-001";
      const generatedAt =
        stage.base?.generatedAt ||
        stage.questionsOverride?.generatedAt ||
        new Date().toISOString();
      const checksum = stage.base?.checksum || "0".repeat(64);

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
        integrity: { checksum, verified: true },
      };
    }

    async function handleFullPack(result) {
      resetStageUI();
      const { pack } = result;
      stage.base = {
        rounds: normalizeFullRounds(pack.rounds || []),
        maths: clone(pack.maths),
        meta: {
          hostUid: pack.meta?.hostUid || "daniel-001",
          guestUid: pack.meta?.guestUid || "jaime-001",
        },
        generatedAt: pack.meta?.generatedAt || new Date().toISOString(),
        checksum: pack.integrity?.checksum || "0".repeat(64),
      };

      const fullSlot = slotMap.full;
      if (fullSlot) {
        fullSlot.statusEl.textContent = "Full pack loaded (base).";
        fullSlot.active = true;
        fullSlot.clearBtn.disabled = false;
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
      log(`unsealed pack ${pack.meta?.roomCode || ""}`);
      updateProgress();
    }

    async function handleQuestionsPack(result) {
      const { questions } = result;
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
      };
      const slot = slotMap.questions;
      if (slot) {
        slot.statusEl.textContent = "All questions pack loaded.";
        slot.active = true;
        slot.clearBtn.disabled = false;
      }
      status.textContent = "Host & guest questions now come from the 30-question pack.";
      log("30-question pack verified.");
      updateProgress();
    }

    async function handleHalfpack(result) {
      const { halfpack, which } = result;
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

      const slot = slotMap[which];
      if (slot) {
        slot.statusEl.textContent = which === "host" ? "Host (15) loaded." : "Guest (15) loaded.";
        slot.active = true;
        slot.clearBtn.disabled = false;
      }
      status.textContent = which === "host"
        ? "Host questions overriding base content."
        : "Guest questions overriding base content.";
      log(`${which} halfpack verified.`);
      updateProgress();
    }

    async function handleMaths(result) {
      const { maths } = result;
      stage.mathsOverride = { maths: clone(maths), loadedAt: Date.now() };
      const slot = slotMap.maths;
      if (slot) {
        slot.statusEl.textContent = "Maths block loaded.";
        slot.active = true;
        slot.clearBtn.disabled = false;
      }
      status.textContent = "Maths block overriding base content.";
      log("maths pack verified.");
      updateProgress();
    }

    async function onFileChange(event) {
      const key = event.target?.getAttribute("data-slot-key");
      const slot = slotMap[key];
      const [file] = event.target.files || [];
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

    function reflectStartState() {
      const code = clampRoomCode(codeInput.value);
      const ready = !seeding && code.length === MAX_CODE_LENGTH;
      startBtn.disabled = !ready;
      startBtn.classList.toggle("throb", ready);
    }

    async function beginRoom() {
      const code = clampRoomCode(codeInput.value);
      if (code.length !== MAX_CODE_LENGTH || seeding) return;

      seeding = true;
      reflectStartState();
      setSlotsDisabled(true);
      status.textContent = `Opening room ${code}…`;
      log(`assembling pack for ${code}`);

      try {
        const pack = assemblePackForCode(code);
        await seedFirestoreFromPack(db, pack);
        await updateDoc(roomRef(code), {
          state: "coderoom",
          round: 1,
          "countdown.startAt": null,
          "timestamps.updatedAt": serverTimestamp(),
        });
        setStoredRole(code, "host");
        status.textContent = `Room ${code} ready. Share the code with Jaime.`;
        log(`room ${code} seeded and moved to code room.`);
        setTimeout(() => {
          location.hash = `#/coderoom?code=${code}`;
        }, 150);
      } catch (err) {
        console.error("[keyroom] failed to seed:", err);
        status.textContent = err?.message || "Failed to start. Try again.";
        log(`error: ${err?.message || err}`);
      } finally {
        seeding = false;
        setSlotsDisabled(false);
        reflectStartState();
      }
    }

    startBtn.addEventListener("click", beginRoom);

    resetStageUI();
    reflectStartState();
  },

  async unmount() {},
};
