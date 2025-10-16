// /src/views/KeyRoom.js
// Host-only sealed-pack upload flow (revamped).
// - Host chooses a room code manually (or via Random button) and presses START to seed Firestore.
// - Any sealed file title can be uploaded in any order; we no longer require matching codes.
// - Full packs provide the baseline; optional question/maths overrides replace matching sections.
// - When START fires we build a composite pack, filling missing content with "<empty>",
//   seed Firestore, stamp the room into "coderoom" state, then route to #/coderoom.

import { ensureAuth, db } from "../lib/firebase.js";
import { doc, updateDoc, serverTimestamp, setDoc } from "firebase/firestore";
import {
  unsealFile,
  unsealHalfpack,
  unsealMaths,
  unsealQuestionPack,
  seedFirestoreFromPack,
  DEMO_PACK_PASSWORD,
  PACK_VERSION_FULL,
} from "../lib/seedUnsealer.js";
import { clampCode, copyToClipboard, getHashParams, setStoredRole } from "../lib/util.js";

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
const roundDocRef = (code, round) => doc(db, "rooms", code, "rounds", String(round));
const DEFAULT_HOST_UID = "daniel-001";
const DEFAULT_GUEST_UID = "jaime-001";
const PLACEHOLDER = "<empty>";

const JUMP_STAGES = [
  { value: "coderoom", label: "Code Room" },
  { value: "countdown", label: "Countdown" },
  { value: "questions", label: "Questions" },
  { value: "marking", label: "Marking" },
  { value: "award", label: "Award" },
  { value: "maths", label: "Maths" },
  { value: "final", label: "Final" },
];

const STAGE_RANK = {
  keyroom: 0,
  coderoom: 1,
  countdown: 2,
  questions: 3,
  marking: 4,
  award: 5,
  maths: 6,
  final: 7,
};

const SIM_PATTERN = [
  { host: [true, true, false], guest: [true, false, false] },
  { host: [false, true, true], guest: [true, true, false] },
  { host: [true, true, true], guest: [false, true, false] },
  { host: [true, false, true], guest: [true, true, false] },
  { host: [false, true, false], guest: [true, true, true] },
];

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function buildEmptyItem() {
  return {
    subject: PLACEHOLDER,
    difficulty_tier: PLACEHOLDER,
    question: PLACEHOLDER,
    correct_answer: PLACEHOLDER,
    distractors: {
      easy: PLACEHOLDER,
      medium: PLACEHOLDER,
      hard: PLACEHOLDER,
    },
  };
}

function padItems(list = []) {
  const items = Array.isArray(list) ? list.map((item) => clone(item)) : [];
  while (items.length < 3) items.push(buildEmptyItem());
  return items.slice(0, 3).map((item) => {
    const safe = item && typeof item === "object" ? item : buildEmptyItem();
    return {
      subject: typeof safe.subject === "string" && safe.subject.trim() ? safe.subject : PLACEHOLDER,
      difficulty_tier:
        typeof safe.difficulty_tier === "string" && safe.difficulty_tier.trim()
          ? safe.difficulty_tier
          : PLACEHOLDER,
      question: typeof safe.question === "string" && safe.question.trim() ? safe.question : PLACEHOLDER,
      correct_answer:
        typeof safe.correct_answer === "string" && safe.correct_answer.trim()
          ? safe.correct_answer
          : PLACEHOLDER,
      distractors: {
        easy:
          typeof safe?.distractors?.easy === "string" && safe.distractors.easy.trim()
            ? safe.distractors.easy
            : PLACEHOLDER,
        medium:
          typeof safe?.distractors?.medium === "string" && safe.distractors.medium.trim()
            ? safe.distractors.medium
            : PLACEHOLDER,
        hard:
          typeof safe?.distractors?.hard === "string" && safe.distractors.hard.trim()
            ? safe.distractors.hard
            : PLACEHOLDER,
      },
    };
  });
}

function normalizeFullRounds(rounds = []) {
  const map = {};
  for (let i = 1; i <= 5; i += 1) {
    map[i] = { hostItems: [], guestItems: [], interlude: PLACEHOLDER };
  }
  rounds.forEach((round) => {
    const rnum = Number(round?.round);
    if (!Number.isInteger(rnum) || rnum < 1 || rnum > 5) return;
    map[rnum] = {
      hostItems: clone(round.hostItems || []),
      guestItems: clone(round.guestItems || []),
      interlude: typeof round.interlude === "string" && round.interlude.trim() ? round.interlude : PLACEHOLDER,
    };
  });
  return map;
}

function normalizeHalfpackRounds(rounds = [], which) {
  const map = {};
  for (let i = 1; i <= 5; i += 1) {
    map[i] = { hostItems: [], guestItems: [], interlude: PLACEHOLDER };
  }
  rounds.forEach((round) => {
    const rnum = Number(round?.round);
    if (!Number.isInteger(rnum) || rnum < 1 || rnum > 5) return;
    if (which === "host") {
      map[rnum].hostItems = clone(round.hostItems || []);
    } else {
      map[rnum].guestItems = clone(round.guestItems || []);
    }
    if (typeof round.interlude === "string" && round.interlude.trim()) {
      map[rnum].interlude = round.interlude;
    }
  });
  return map;
}

function normalizeMaths(maths = null) {
  const src = maths && typeof maths === "object" ? maths : {};
  const beats = Array.isArray(src.beats) ? src.beats.slice(0, 4) : [];
  while (beats.length < 4) beats.push(PLACEHOLDER);
  return {
    location: typeof src.location === "string" && src.location.trim() ? src.location : PLACEHOLDER,
    beats: beats.map((beat) => (typeof beat === "string" && beat.trim() ? beat : PLACEHOLDER)),
    questions: Array.isArray(src.questions) && src.questions.length
      ? [0, 1].map((idx) => {
          const q = src.questions[idx];
          return typeof q === "string" && q.trim() ? q : PLACEHOLDER;
        })
      : [PLACEHOLDER, PLACEHOLDER],
    answers: Array.isArray(src.answers) && src.answers.length
      ? [0, 1].map((idx) => {
          const a = src.answers[idx];
          return Number.isInteger(a) ? a : 0;
        })
      : [0, 0],
  };
}

function generateRandomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 3; i += 1) {
    const idx = Math.floor(Math.random() * alphabet.length);
    out += alphabet[idx];
  }
  return out;
}

function normalizeStage(value) {
  const lower = String(value || "").toLowerCase();
  if (JUMP_STAGES.some((entry) => entry.value === lower)) return lower;
  return "coderoom";
}

function clampRoundForStage(stage, rawRound) {
  const base = Math.min(Math.max(parseInt(rawRound, 10) || 1, 1), 5);
  if (stage === "maths" || stage === "final") return 5;
  return base;
}

function pickDistractor(item, variant = 0) {
  const distractors = (item && typeof item === "object" ? item.distractors : null) || {};
  const order = ["medium", "hard", "easy"];
  const rotated = order.slice(variant % order.length).concat(order.slice(0, variant % order.length));
  for (const key of rotated) {
    const val = distractors[key];
    if (typeof val === "string" && val.trim() && val !== item?.correct_answer) {
      return val;
    }
  }
  if (typeof distractors.medium === "string" && distractors.medium.trim()) return distractors.medium;
  if (typeof distractors.easy === "string" && distractors.easy.trim()) return distractors.easy;
  if (typeof distractors.hard === "string" && distractors.hard.trim()) return distractors.hard;
  return item?.correct_answer || PLACEHOLDER;
}

function buildAnswerList(items = [], pattern = []) {
  const list = Array.isArray(items) ? items : [];
  return list.map((item, idx) => {
    const safe = item && typeof item === "object" ? item : {};
    const correct = typeof safe.correct_answer === "string" ? safe.correct_answer : "";
    const shouldBeCorrect = pattern[idx] !== false;
    const fallback = pickDistractor(safe, idx);
    const chosen = shouldBeCorrect ? correct || fallback : fallback;
    return {
      question: typeof safe.question === "string" ? safe.question : PLACEHOLDER,
      chosen: typeof chosen === "string" ? chosen : "",
      correct: typeof correct === "string" ? correct : "",
    };
  });
}

function countCorrectAnswers(list = []) {
  return list.reduce((total, entry) => {
    if (!entry) return total;
    const chosen = String(entry.chosen || "").trim();
    const correct = String(entry.correct || "").trim();
    return total + (chosen && correct && chosen === correct ? 1 : 0);
  }, 0);
}

function routeForState(state, code, round) {
  const baseRound = Math.min(Math.max(Number(round) || 1, 1), 5);
  switch ((state || "").toLowerCase()) {
    case "keyroom":
      return `#/keyroom?code=${code}`;
    case "coderoom":
      return `#/coderoom?code=${code}`;
    case "countdown":
      return `#/countdown?code=${code}&round=${baseRound}`;
    case "questions":
      return `#/questions?code=${code}&round=${baseRound}`;
    case "marking":
      return `#/marking?code=${code}&round=${baseRound}`;
    case "award":
      return `#/award?code=${code}&round=${baseRound}`;
    case "maths":
      return `#/maths?code=${code}`;
    case "final":
      return `#/final?code=${code}`;
    default:
      return `#/coderoom?code=${code}`;
  }
}

function guestLinkForState(state, code) {
  const base = `${location.origin}${location.pathname}`;
  const lower = String(state || "").toLowerCase();
  if (lower === "keyroom" || lower === "coderoom") {
    return `${base}#/lobby?code=${code}`;
  }
  return `${base}#/watcher?code=${code}`;
}

async function applyJumpPlan({ code, pack, stage, round, log }) {
  const targetStage = normalizeStage(stage);
  const rank = STAGE_RANK[targetStage] ?? STAGE_RANK.coderoom;
  const activeRound = clampRoundForStage(targetStage, round);
  const answeredLimit = rank >= STAGE_RANK.marking ? Math.min(activeRound, 5) : Math.max(0, Math.min(activeRound - 1, 5));
  const scoreboardLimit = rank >= STAGE_RANK.maths
    ? 5
    : rank >= STAGE_RANK.award
    ? Math.min(activeRound, 5)
    : Math.max(0, Math.min(activeRound - 1, 5));
  const markingCompleteLimit = rank >= STAGE_RANK.award
    ? Math.min(activeRound, 5)
    : Math.max(0, Math.min(activeRound - 1, 5));
  const awardAckLimit = rank >= STAGE_RANK.maths
    ? 5
    : Math.max(0, Math.min(activeRound - 1, 5));

  const hostUid = pack?.meta?.hostUid || DEFAULT_HOST_UID;
  const guestUid = pack?.meta?.guestUid || DEFAULT_GUEST_UID;

  const answers = { host: {}, guest: {} };
  const submitted = { host: {}, guest: {} };
  const marking = { host: {}, guest: {}, startAt: rank >= STAGE_RANK.marking ? Date.now() - 8_000 : null };
  const markingAck = { host: {}, guest: {} };
  const award = { startAt: rank >= STAGE_RANK.award ? Date.now() - 5_000 : null };
  const awardAck = { host: {}, guest: {} };
  const mathsAnswers = {};
  const mathsAnswersAck = {};
  const countdown = { startAt: rank === STAGE_RANK.countdown ? Date.now() + 6_000 : null };
  const links = { guestReady: rank >= STAGE_RANK.countdown };

  const hostRoundCorrect = {};
  const guestRoundCorrect = {};
  const roundPayloads = [];

  const rounds = Array.isArray(pack?.rounds) ? pack.rounds : [];
  const roundMap = new Map();
  rounds.forEach((entry) => {
    const rnum = Number(entry?.round);
    if (Number.isInteger(rnum)) roundMap.set(rnum, entry);
  });

  for (let r = 1; r <= 5; r += 1) {
    const entry = roundMap.get(r) || {};
    const hostItems = Array.isArray(entry.hostItems) ? entry.hostItems : [];
    const guestItems = Array.isArray(entry.guestItems) ? entry.guestItems : [];
    const pattern = SIM_PATTERN[(r - 1) % SIM_PATTERN.length];

    const hostAnswersList = buildAnswerList(hostItems, pattern.host || []);
    const guestAnswersList = buildAnswerList(guestItems, pattern.guest || []);

    const includeAnswers = r <= answeredLimit || (rank >= STAGE_RANK.marking && r === activeRound);
    const includeMarking = r <= markingCompleteLimit;
    const includeGuestMarkingOnly = rank === STAGE_RANK.marking && r === activeRound;

    if (includeAnswers) {
      answers.host[r] = hostAnswersList;
      answers.guest[r] = guestAnswersList;
      submitted.host[r] = true;
      submitted.guest[r] = true;
      hostRoundCorrect[r] = countCorrectAnswers(hostAnswersList);
      guestRoundCorrect[r] = countCorrectAnswers(guestAnswersList);
    } else {
      hostRoundCorrect[r] = 0;
      guestRoundCorrect[r] = 0;
    }

    if (includeMarking) {
      marking.host[r] = guestAnswersList.map((ans) =>
        ans?.chosen && ans?.correct && ans.chosen === ans.correct ? "right" : "wrong"
      );
      marking.guest[r] = hostAnswersList.map((ans) =>
        ans?.chosen && ans?.correct && ans.chosen === ans.correct ? "right" : "wrong"
      );
      markingAck.host[r] = true;
      markingAck.guest[r] = true;
    } else if (includeGuestMarkingOnly) {
      marking.host[r] = [];
      marking.guest[r] = hostAnswersList.map((ans) =>
        ans?.chosen && ans?.correct && ans.chosen === ans.correct ? "right" : "wrong"
      );
      markingAck.host[r] = false;
      markingAck.guest[r] = true;
    }

    if (r <= awardAckLimit) {
      awardAck.host[r] = true;
      awardAck.guest[r] = true;
    } else if (rank >= STAGE_RANK.award && r === activeRound) {
      awardAck.guest[r] = true;
      awardAck.host[r] = rank >= STAGE_RANK.maths;
    }

    if (includeAnswers) {
      const baseStamp = Date.now() - (420_000 - r * 28_000);
      const hostTiming = {
        role: "host",
        qDoneMs: baseStamp + 12_000,
        markDoneMs: baseStamp + 30_000,
        totalMs: 30_000,
      };
      const guestTiming = {
        role: "guest",
        qDoneMs: baseStamp + 10_000,
        markDoneMs: baseStamp + 27_000,
        totalMs: 27_000,
      };
      const timings = { [hostUid]: hostTiming, [guestUid]: guestTiming };
      const payload = { timings };
      const snippetComplete = r <= markingCompleteLimit || (rank >= STAGE_RANK.award && r === activeRound);
      if (snippetComplete) {
        const diff = Math.abs(hostTiming.totalMs - guestTiming.totalMs);
        const tie = diff <= 1;
        payload.snippetTie = tie;
        payload.snippetWinnerUid = tie
          ? null
          : hostTiming.totalMs < guestTiming.totalMs
          ? hostUid
          : guestUid;
      }
      roundPayloads.push({ round: r, data: payload });
    }
  }

  if (rank >= STAGE_RANK.maths) {
    const guestMaths = Array.isArray(pack?.maths?.answers)
      ? pack.maths.answers.slice(0, 2)
      : [0, 0];
    mathsAnswers.guest = guestMaths;
    mathsAnswersAck.guest = true;
    if (rank >= STAGE_RANK.final) {
      mathsAnswers.host = guestMaths.map((ans, idx) =>
        Number.isInteger(ans) ? ans + (idx === 0 ? -1 : 1) : ans
      );
      mathsAnswersAck.host = true;
    }
  }

  let hostScore = 0;
  let guestScore = 0;
  for (let r = 1; r <= Math.min(scoreboardLimit, 5); r += 1) {
    hostScore += hostRoundCorrect[r] || 0;
    guestScore += guestRoundCorrect[r] || 0;
  }

  const patch = {
    state: targetStage,
    round: activeRound,
    countdown,
    answers,
    submitted,
    marking,
    markingAck,
    award,
    awardAck,
    mathsAnswers,
    mathsAnswersAck,
    scores: { questions: { host: hostScore, guest: guestScore } },
    links,
    "timestamps.updatedAt": serverTimestamp(),
  };

  await updateDoc(roomRef(code), patch);
  await Promise.all(
    roundPayloads.map(({ round: r, data }) => setDoc(roundDocRef(code, r), data, { merge: true }))
  );

  if (typeof log === "function") {
    log(
      `jumped to ${targetStage} · round ${activeRound} · Daniel ${hostScore} — ${guestScore} Jaime`
    );
  }

  return {
    state: targetStage,
    round: activeRound,
    scores: { host: hostScore, guest: guestScore },
    hostRoute: routeForState(targetStage, code, activeRound),
    guestLink: guestLinkForState(targetStage, code),
  };
}

async function determineSealedType(file) {
  let envelopeText;
  try {
    envelopeText = await file.text();
  } catch (err) {
    throw new Error("Failed to read sealed file.");
  }
  let envelope;
  try {
    envelope = JSON.parse(envelopeText);
  } catch (err) {
    throw new Error("Sealed pack is not valid JSON.");
  }

  const stubFile = {
    name: file.name,
    async text() {
      return envelopeText;
    },
  };

  const order = ["full", "half", "questions", "maths"];
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
      if (err?.message === "Unsupported sealed version.") continue;
      throw err;
    }
  }
  throw new Error("Unsupported sealed version.");
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
    root.appendChild(card);
    container.appendChild(root);

    const headerRow = el("div", {
      style: "display:flex;justify-content:space-between;align-items:center;gap:10px;",
    });
    headerRow.appendChild(el("h1", { class: "title" }, "Key Room"));
    const lobbyBtn = el(
      "button",
      {
        class: "btn outline",
        type: "button",
        onclick: () => {
          location.hash = "#/lobby";
        },
      },
      "Back"
    );
    headerRow.appendChild(lobbyBtn);
    card.appendChild(headerRow);

    const intro = el(
      "div",
      { class: "mono", style: "margin-bottom:10px;" },
      "Upload Jemima’s sealed packs, pick a code, then press START."
    );
    card.appendChild(intro);

    const codeRow = el("div", {
      class: "mono",
      style: "display:flex;align-items:center;gap:8px;margin-bottom:12px;justify-content:center;flex-wrap:wrap;",
    });
    const codeInput = el("input", {
      type: "text",
      class: "mono",
      style: "font-size:18px;padding:6px 10px;border:1px solid rgba(0,0,0,0.2);border-radius:8px;width:120px;text-align:center;",
      maxlength: "5",
      value: hintedCode,
      oninput: (event) => {
        event.target.value = clampCode(event.target.value);
        reflectStartState();
      },
    });
    const randomBtn = el(
      "button",
      {
        class: "btn outline",
        type: "button",
        onclick: () => {
          codeInput.value = clampCode(generateRandomCode());
          reflectStartState();
        },
      },
      "Random"
    );
    const copyLinkBtn = el(
      "button",
      {
        class: "btn outline",
        type: "button",
        onclick: async () => {
          const code = clampCode(codeInput.value);
          if (!code) return;
          const share = `${location.origin}${location.pathname}#/lobby`;
          const ok = await copyToClipboard(`${share}?code=${code}`);
          if (ok) status.textContent = "Link copied.";
        },
      },
      "Copy link"
    );
    codeRow.appendChild(el("span", { style: "font-weight:700;" }, "Room code"));
    codeRow.appendChild(codeInput);
    codeRow.appendChild(randomBtn);
    codeRow.appendChild(copyLinkBtn);
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
    slot.label = cfg.label;
      slotMap[role] = slot;
      uploadGrid.appendChild(slot.wrapper);
    }

    const progressLine = el("div", {
      class: "mono small",
      style: "margin-top:4px;text-align:center;min-height:18px;",
    }, "Sources → Host: — · Guest: — · Maths: —");
    card.appendChild(progressLine);

    const metaRow = el("div", {
      class: "mono small",
      style: "margin-top:6px;display:none;justify-content:center;align-items:center;gap:6px;",
    });
    const generatedLabel = el("span", {}, "");
    metaRow.appendChild(generatedLabel);
    card.appendChild(metaRow);

    const jumpWrap = el(
      "div",
      {
        class: "mono",
        style:
          "margin-top:12px;display:flex;flex-direction:column;align-items:center;gap:8px;padding:12px;border:1px solid rgba(0,0,0,0.12);border-radius:10px;",
      }
    );
    jumpWrap.appendChild(el("span", { style: "font-weight:700;" }, "Jump to stage"));
    const jumpRow = el("div", {
      style: "display:flex;gap:10px;flex-wrap:wrap;justify-content:center;align-items:center;",
    });
    const stageSelect = el("select", {
      class: "mono",
      style: "padding:6px 12px;border-radius:8px;border:1px solid rgba(0,0,0,0.24);",
    });
    JUMP_STAGES.forEach(({ value, label }) => {
      stageSelect.appendChild(el("option", { value }, label));
    });
    const roundWrap = el("label", {
      class: "mono",
      style: "display:flex;align-items:center;gap:6px;", "for": "keyroom-round-select",
    });
    roundWrap.appendChild(el("span", { style: "font-weight:700;" }, "Round"));
    const roundSelect = el("select", {
      id: "keyroom-round-select",
      class: "mono",
      style: "padding:6px 10px;border-radius:8px;border:1px solid rgba(0,0,0,0.24);",
    });
    for (let r = 1; r <= 5; r += 1) {
      roundSelect.appendChild(el("option", { value: String(r) }, String(r)));
    }
    roundWrap.appendChild(roundSelect);
    jumpRow.appendChild(stageSelect);
    jumpRow.appendChild(roundWrap);
    jumpWrap.appendChild(jumpRow);
    const jumpHint = el(
      "div",
      { class: "mono small", style: "opacity:.75;text-align:center;max-width:320px;" },
      "Daniel will sit in the host chair. Jaime’s link will match this stage."
    );
    jumpWrap.appendChild(jumpHint);
    card.appendChild(jumpWrap);

    const status = el(
      "div",
      { class: "mono small", style: "margin-top:10px;min-height:18px;" },
      hintedCode ? `Enter ${hintedCode} or pick a new code.` : "Choose a room code to get started."
    );
    card.appendChild(status);

    const startRow = el("div", {
      class: "mono",
      style: "margin-top:16px;display:flex;justify-content:center;",
    });
    const startBtn = el("button", { class: "btn primary", disabled: "" }, "Start");
    startRow.appendChild(startBtn);
    card.appendChild(startRow);

    const guestLinkWrap = el("div", {
      class: "mono small",
      style:
        "display:none;margin-top:12px;text-align:center;word-break:break-all;padding:10px;border:1px dashed rgba(0,0,0,0.2);border-radius:10px;",
    });
    const guestLinkLabel = el("div", { style: "font-weight:700;margin-bottom:6px;" }, "Jaime’s link");
    const guestLinkText = el("div", { style: "margin-bottom:8px;" }, "");
    const copyGuestBtn = el(
      "button",
      { class: "btn outline", type: "button", style: "font-size:13px;" },
      "Copy Jaime link"
    );
    guestLinkWrap.appendChild(guestLinkLabel);
    guestLinkWrap.appendChild(guestLinkText);
    guestLinkWrap.appendChild(copyGuestBtn);
    card.appendChild(guestLinkWrap);

    const logEl = el("pre", {
      class: "mono small",
      style: "margin-top:14px;background:rgba(0,0,0,0.05);padding:10px;border-radius:10px;min-height:120px;max-height:180px;overflow:auto;",
    });
    card.appendChild(logEl);

    const stage = {
      base: null,
      questionsOverride: null,
      hostOverride: null,
      guestOverride: null,
      mathsOverride: null,
    };

    let latestGuestLink = "";

    function refreshJumpControls() {
      const value = stageSelect.value;
      if (value === "maths" || value === "final") {
        roundWrap.style.display = "none";
        roundSelect.value = "5";
      } else if (value === "coderoom") {
        roundWrap.style.display = "none";
        roundSelect.value = "1";
      } else {
        roundWrap.style.display = "flex";
      }
    }

    stageSelect.addEventListener("change", () => {
      refreshJumpControls();
      reflectStartState();
    });
    roundSelect.addEventListener("change", () => {
      reflectStartState();
    });
    refreshJumpControls();

    copyGuestBtn.addEventListener("click", async () => {
      if (!latestGuestLink) return;
      const ok = await copyToClipboard(latestGuestLink);
      if (ok) status.textContent = "Jaime link copied.";
    });

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

    function log(message) {
      const stamp = new Date().toISOString().split("T")[1].replace(/Z$/, "");
      logEl.textContent += `[${stamp}] ${message}\n`;
      logEl.scrollTop = logEl.scrollHeight;
      console.log(`[keyroom] ${message}`);
    }

    function reflectStartState() {
      const code = clampCode(codeInput.value);
      const ready = code.length >= 3;
      startBtn.disabled = !ready;
      startBtn.classList.toggle("throb", ready);
      const stageLabel = stageSelect.options?.[stageSelect.selectedIndex]?.textContent || stageSelect.value;
      const needsRound = roundWrap.style.display !== "none";
      const roundLabel = needsRound ? ` round ${roundSelect.value}` : "";
      if (!ready) {
        status.textContent = "Enter a 3–5 character code to enable START.";
      } else if (!stage.base && !stage.questionsOverride && !stage.hostOverride && !stage.guestOverride) {
        status.textContent = `Starting without uploads. Target: ${stageLabel}${roundLabel}.`;
      } else {
        status.textContent = `Press START to jump Daniel to ${stageLabel}${roundLabel}.`;
      }
    }

    function clearSlot(key) {
      const slot = slotMap[key];
      if (!slot) return;
      if (key === "full") {
        stage.base = null;
        generatedLabel.textContent = "";
        metaRow.style.display = "none";
      } else if (key === "questions") {
        stage.questionsOverride = null;
      } else if (key === "host") {
        stage.hostOverride = null;
      } else if (key === "guest") {
        stage.guestOverride = null;
      } else if (key === "maths") {
        stage.mathsOverride = null;
      }
      slot.statusEl.textContent = slot.initialText;
      slot.active = false;
      slot.clearBtn.disabled = true;
      slot.uploadBtn.disabled = false;
      status.textContent = `${slot.label || slot.key} cleared.`;
      log(`${key} cleared.`);
      updateProgress();
      reflectStartState();
    }

    async function handleFullPack(result) {
      const { pack } = result;
      stage.questionsOverride = null;
      stage.hostOverride = null;
      stage.guestOverride = null;
      stage.mathsOverride = null;
      Object.entries(slotMap).forEach(([key, slot]) => {
        if (!slot || key === "full") return;
        slot.statusEl.textContent = slot.initialText;
        slot.active = false;
        slot.clearBtn.disabled = true;
      });
      stage.base = {
        rounds: normalizeFullRounds(pack.rounds || []),
        maths: normalizeMaths(pack.maths),
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
      log("full pack verified.");
      if (stage.base.checksum) {
        log(`checksum OK (${stage.base.checksum.slice(0, 8)}…)`);
      }
      updateProgress();
      reflectStartState();
    }

    async function handleQuestionsPack(result) {
      const { questions } = result;
      stage.questionsOverride = {
        rounds: normalizeFullRounds(questions.rounds || []),
        meta: {
          hostUid: typeof questions.meta?.hostUid === "string" ? questions.meta.hostUid : "",
          guestUid: typeof questions.meta?.guestUid === "string" ? questions.meta.guestUid : "",
        },
        generatedAt:
          typeof questions.meta?.generatedAt === "string" && !Number.isNaN(Date.parse(questions.meta.generatedAt))
            ? questions.meta.generatedAt
            : "",
        loadedAt: Date.now(),
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
      reflectStartState();
    }

    async function handleHalfpack(result) {
      const { halfpack, which } = result;
      const normalized = normalizeHalfpackRounds(halfpack.rounds || [], which);
      const halfMeta = halfpack?.meta || {};
      if (which === "host") {
        stage.hostOverride = {
          rounds: normalized,
          loadedAt: Date.now(),
          meta: {
            hostUid: typeof halfMeta.hostUid === "string" ? halfMeta.hostUid : "",
          },
        };
      } else {
        stage.guestOverride = {
          rounds: normalized,
          loadedAt: Date.now(),
          meta: {
            guestUid: typeof halfMeta.guestUid === "string" ? halfMeta.guestUid : "",
          },
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
      reflectStartState();
    }

    async function handleMaths(result) {
      const { maths } = result;
      stage.mathsOverride = { maths: normalizeMaths(maths), loadedAt: Date.now() };
      const slot = slotMap.maths;
      if (slot) {
        slot.statusEl.textContent = "Maths block loaded.";
        slot.active = true;
        slot.clearBtn.disabled = false;
      }
      status.textContent = "Maths block overriding base content.";
      log("maths block verified.");
      updateProgress();
      reflectStartState();
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

    function assemblePack(code) {
      const normalizedCode = clampCode(code);
      const rounds = {};
      for (let i = 1; i <= 5; i += 1) {
        rounds[i] = {
          hostItems: [],
          guestItems: [],
          interlude: PLACEHOLDER,
        };
      }

      if (stage.base) {
        for (let i = 1; i <= 5; i += 1) {
          const entry = stage.base.rounds?.[i];
          if (entry) {
            rounds[i].hostItems = clone(entry.hostItems || []);
            rounds[i].guestItems = clone(entry.guestItems || []);
            if (entry.interlude) rounds[i].interlude = entry.interlude;
          }
        }
      }

      if (stage.questionsOverride) {
        for (let i = 1; i <= 5; i += 1) {
          const entry = stage.questionsOverride.rounds?.[i];
          if (entry) {
            rounds[i].hostItems = clone(entry.hostItems || rounds[i].hostItems);
            rounds[i].guestItems = clone(entry.guestItems || rounds[i].guestItems);
            if (entry.interlude) rounds[i].interlude = entry.interlude;
          }
        }
      }

      if (stage.hostOverride) {
        for (let i = 1; i <= 5; i += 1) {
          const entry = stage.hostOverride.rounds?.[i];
          if (entry && entry.hostItems?.length) {
            rounds[i].hostItems = clone(entry.hostItems);
            if (entry.interlude && entry.interlude.trim()) {
              rounds[i].interlude = entry.interlude;
            }
          }
        }
      }

      if (stage.guestOverride) {
        for (let i = 1; i <= 5; i += 1) {
          const entry = stage.guestOverride.rounds?.[i];
          if (entry && entry.guestItems?.length) {
            rounds[i].guestItems = clone(entry.guestItems);
            if (entry.interlude && entry.interlude.trim()) {
              rounds[i].interlude = entry.interlude;
            }
          }
        }
      }

      const assembledRounds = [];
      for (let i = 1; i <= 5; i += 1) {
        assembledRounds.push({
          round: i,
          hostItems: padItems(rounds[i].hostItems),
          guestItems: padItems(rounds[i].guestItems),
          interlude:
            typeof rounds[i].interlude === "string" && rounds[i].interlude.trim()
              ? rounds[i].interlude
              : PLACEHOLDER,
        });
      }

      let maths = normalizeMaths(stage.mathsOverride?.maths || stage.base?.maths || null);
      if (stage.mathsOverride?.maths) {
        maths = normalizeMaths(stage.mathsOverride.maths);
      }

      const hostUid =
        stage.hostOverride?.meta?.hostUid ||
        stage.questionsOverride?.meta?.hostUid ||
        stage.base?.meta?.hostUid ||
        DEFAULT_HOST_UID;
      const guestUid =
        stage.guestOverride?.meta?.guestUid ||
        stage.questionsOverride?.meta?.guestUid ||
        stage.base?.meta?.guestUid ||
        DEFAULT_GUEST_UID;
      const generatedAt =
        stage.base?.generatedAt || stage.questionsOverride?.generatedAt || new Date().toISOString();

      const pack = {
        version: PACK_VERSION_FULL,
        meta: {
          roomCode: normalizedCode,
          hostUid,
          guestUid,
          generatedAt,
        },
        rounds: assembledRounds,
        maths,
        integrity: { checksum: "0".repeat(64), verified: true },
      };

      return pack;
    }

    async function startGame() {
      const code = clampCode(codeInput.value);
      if (code.length < 3) {
        status.textContent = "Enter a valid room code first.";
        return;
      }
      startBtn.disabled = true;
      startBtn.classList.remove("throb");
      status.textContent = "Seeding Firestore…";
      guestLinkWrap.style.display = "none";
      guestLinkText.textContent = "";
      latestGuestLink = "";

      const desiredStage = stageSelect.value;
      const desiredRound = roundSelect.value;
      const stageLabel = stageSelect.options?.[stageSelect.selectedIndex]?.textContent || desiredStage;
      const needsRound = roundWrap.style.display !== "none";
      const roundLabel = needsRound ? ` round ${desiredRound}` : "";

      const pack = assemblePack(code);
      try {
        await seedFirestoreFromPack(db, pack);
        const jump = await applyJumpPlan({ code, pack, stage: desiredStage, round: desiredRound, log });
        setStoredRole(code, "host");
        latestGuestLink = jump?.guestLink || guestLinkForState(desiredStage, code);
        guestLinkText.textContent = latestGuestLink;
        guestLinkWrap.style.display = "";
        const scoreLine = jump?.scores
          ? `Daniel ${jump.scores.host} — ${jump.scores.guest} Jaime`
          : "";
        status.textContent = scoreLine
          ? `Room ${code} ready. ${scoreLine}.`
          : `Room ${code} ready.`;
        log(`room ${code} prepared; jumping to ${stageLabel}${roundLabel}.`);
        const hostRoute = jump?.hostRoute || routeForState(desiredStage, code, desiredRound);
        location.hash = hostRoute;
      } catch (err) {
        console.error("[keyroom] start failed", err);
        status.textContent = err?.message || "Failed to start. Please try again.";
        startBtn.disabled = false;
        reflectStartState();
      }
    }

    startBtn.addEventListener("click", startGame);

    updateProgress();
    reflectStartState();
  },

  async unmount() {},
};
