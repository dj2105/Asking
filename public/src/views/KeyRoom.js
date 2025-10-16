// /src/views/KeyRoom.js
// Host-only sealed-pack upload flow (revamped).
// - Host chooses a room code manually (or via Random button) and presses START to seed Firestore.
// - Any sealed file title can be uploaded in any order; we no longer require matching codes.
// - Full packs provide the baseline; optional question/maths overrides replace matching sections.
// - When START fires we build a composite pack, filling missing content with "<empty>",
//   seed Firestore, stamp the room into "coderoom" state, then route to #/coderoom.

import { ensureAuth, db } from "../lib/firebase.js";
import { collection, doc, setDoc, updateDoc, serverTimestamp } from "firebase/firestore";
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
const roundSubColRef = (code) => collection(roomRef(code), "rounds");
const playerDocRef = (code, uid) => doc(db, "rooms", code, "players", uid || "unknown");
const DEFAULT_HOST_UID = "daniel-001";
const DEFAULT_GUEST_UID = "jaime-001";
const PLACEHOLDER = "<empty>";

const STAGE_RANK = {
  countdown: 1,
  questions: 2,
  marking: 3,
  award: 4,
  maths: 5,
  final: 6,
};

const HOST_PATTERNS = [
  [true, true, false],
  [true, false, true],
  [true, true, true],
  [false, true, true],
  [true, false, false],
];

const GUEST_PATTERNS = [
  [true, false, false],
  [true, true, false],
  [false, false, true],
  [true, true, true],
  [false, true, false],
];

function sanitizeStage(value) {
  const key = String(value || "").toLowerCase();
  return STAGE_RANK[key] ? key : "countdown";
}

function routeForStage(stage, code, round) {
  const r = Math.max(1, Math.min(5, Number(round) || 1));
  switch (sanitizeStage(stage)) {
    case "countdown":
      return `#/countdown?code=${code}&round=${r}`;
    case "questions":
      return `#/questions?code=${code}&round=${r}`;
    case "marking":
      return `#/marking?code=${code}&round=${r}`;
    case "award":
      return `#/award?code=${code}&round=${r}`;
    case "maths":
      return `#/maths?code=${code}`;
    case "final":
      return `#/final?code=${code}`;
    default:
      return `#/countdown?code=${code}&round=${r}`;
  }
}

function pickWrongAnswer(item = {}) {
  const correct = String(item.correct_answer || "").trim();
  const candidates = [
    item?.distractors?.easy,
    item?.distractors?.medium,
    item?.distractors?.hard,
  ]
    .map((text) => (typeof text === "string" ? text.trim() : ""))
    .filter((text) => text && text !== correct);
  return candidates[0] || "";
}

function buildAnswerSet(items = [], pattern = []) {
  return items.map((item, idx) => {
    const correct = String(item?.correct_answer || "").trim();
    const question = String(item?.question || "").trim();
    const shouldBeCorrect = Boolean(pattern[idx]);
    let chosen = correct;
    if (!shouldBeCorrect || !chosen) {
      const wrong = pickWrongAnswer(item);
      chosen = wrong || correct || "";
    }
    return {
      question,
      chosen,
      correct,
    };
  });
}

function countCorrectAnswers(list = []) {
  return list.reduce((total, entry) => {
    const chosen = String(entry?.chosen || "").trim();
    const correct = String(entry?.correct || "").trim();
    return total + (chosen && correct && chosen === correct ? 1 : 0);
  }, 0);
}

function verdictList(pattern = []) {
  return pattern.map((isCorrect) => (isCorrect ? "right" : "wrong"));
}

function hasOwnData(obj = {}) {
  return Object.keys(obj).length > 0;
}

async function applyJumpState({ code, pack, stage, round }) {
  const normalizedCode = clampCode(code);
  if (!normalizedCode) throw new Error("Room code missing.");

  const targetStage = sanitizeStage(stage);
  let targetRound = Math.max(1, Math.min(5, Number(round) || 1));
  if (targetStage === "maths" || targetStage === "final") targetRound = 5;

  const hostUid = pack?.meta?.hostUid || DEFAULT_HOST_UID;
  const guestUid = pack?.meta?.guestUid || DEFAULT_GUEST_UID;

  const rounds = Array.isArray(pack?.rounds) ? pack.rounds : [];

  const answersHost = {};
  const answersGuest = {};
  const submittedHost = {};
  const submittedGuest = {};
  const markingHost = {};
  const markingGuest = {};
  const markingAckHost = {};
  const markingAckGuest = {};
  const awardAckHost = {};
  const awardAckGuest = {};

  const roundPayloads = {};
  const hostPlayerRounds = {};
  const guestPlayerRounds = {};
  const hostRetained = {};
  const guestRetained = {};

  let hostScoreTotal = 0;
  let guestScoreTotal = 0;

  const stageRank = STAGE_RANK[targetStage];
  const now = Date.now();
  let timelineCursor = now - 5 * 60_000;

  const stageForRound = (r) => {
    if (stageRank >= STAGE_RANK.maths) return "completed";
    if (r < targetRound) return "completed";
    if (r > targetRound) return "future";
    if (stageRank <= STAGE_RANK.countdown) return "pending";
    if (stageRank === STAGE_RANK.questions) return "questions";
    if (stageRank === STAGE_RANK.marking) return "marking";
    if (stageRank === STAGE_RANK.award) return "award";
    return "completed";
  };

  for (let i = 0; i < rounds.length; i += 1) {
    const entry = rounds[i] || {};
    const r = Number(entry.round) || i + 1;
    const status = stageForRound(r);
    const hostItems = Array.isArray(entry.hostItems) ? entry.hostItems : [];
    const guestItems = Array.isArray(entry.guestItems) ? entry.guestItems : [];
    const hostPattern = HOST_PATTERNS[(r - 1) % HOST_PATTERNS.length];
    const guestPattern = GUEST_PATTERNS[(r - 1) % GUEST_PATTERNS.length];
    const hostAnswersList = buildAnswerSet(hostItems, hostPattern);
    const guestAnswersList = buildAnswerSet(guestItems, guestPattern);
    const hostCorrect = countCorrectAnswers(hostAnswersList);
    const guestCorrect = countCorrectAnswers(guestAnswersList);

    const questionsStartAt = timelineCursor;
    const hostQuestionMs = 24_000 + r * 800;
    const guestQuestionMs = 26_000 + r * 900;
    const hostMarkMs = 9_000 + r * 400;
    const guestMarkMs = 11_000 + r * 350;
    const hostQDone = questionsStartAt + hostQuestionMs;
    const guestQDone = questionsStartAt + guestQuestionMs;
    const hostMarkDone = hostQDone + hostMarkMs;
    const guestMarkDone = guestQDone + guestMarkMs;
    const hostTotalMs = hostMarkDone - questionsStartAt;
    const guestTotalMs = guestMarkDone - questionsStartAt;

    const payload = {};
    let touched = false;

    if (status === "completed" || status === "award" || status === "marking") {
      answersHost[r] = hostAnswersList;
      answersGuest[r] = guestAnswersList;
      submittedHost[r] = true;
      submittedGuest[r] = true;
      hostScoreTotal += hostCorrect;
      guestScoreTotal += guestCorrect;
    }

    if (status === "completed" || status === "award") {
      const hostVerdicts = verdictList(guestPattern);
      const guestVerdicts = verdictList(hostPattern);
      markingHost[r] = hostVerdicts;
      markingGuest[r] = guestVerdicts;
      markingAckHost[r] = true;
      markingAckGuest[r] = true;
    } else if (status === "marking") {
      markingHost[r] = [];
      markingGuest[r] = [];
    }

    if (status === "completed" || stageRank >= STAGE_RANK.maths) {
      awardAckHost[r] = true;
      awardAckGuest[r] = true;
    } else if (status === "award") {
      awardAckHost[r] = false;
      awardAckGuest[r] = false;
    }

    if (status !== "pending" && status !== "future") {
      payload.timingsMeta = { questionsStartAt };
      touched = true;
    }

    if (status === "completed") {
      payload.timings = {
        [hostUid]: { qDoneMs: hostQDone, markDoneMs: hostMarkDone, totalMs: hostTotalMs, role: "host" },
        [guestUid]: { qDoneMs: guestQDone, markDoneMs: guestMarkDone, totalMs: guestTotalMs, role: "guest" },
      };
      const diff = Math.abs(hostTotalMs - guestTotalMs);
      const tie = diff < 1_000;
      payload.snippetTie = tie;
      payload.snippetWinnerUid = tie
        ? null
        : hostTotalMs < guestTotalMs
        ? hostUid
        : guestUid;
      touched = true;

      hostPlayerRounds[r] = { timings: { qDoneMs: hostQDone, markDoneMs: hostMarkDone, role: "host" } };
      guestPlayerRounds[r] = { timings: { qDoneMs: guestQDone, markDoneMs: guestMarkDone, role: "guest" } };
      const hostWon = tie || payload.snippetWinnerUid === hostUid;
      const guestWon = tie || payload.snippetWinnerUid === guestUid;
      hostRetained[r] = hostWon;
      guestRetained[r] = guestWon;
    } else if (status === "award") {
      payload.timings = {
        [hostUid]: { qDoneMs: hostQDone, markDoneMs: hostMarkDone, totalMs: hostTotalMs, role: "host" },
        [guestUid]: { qDoneMs: guestQDone, markDoneMs: guestMarkDone, totalMs: guestTotalMs, role: "guest" },
      };
      const diff = Math.abs(hostTotalMs - guestTotalMs);
      const tie = diff < 1_000;
      payload.snippetTie = tie;
      payload.snippetWinnerUid = tie
        ? null
        : hostTotalMs < guestTotalMs
        ? hostUid
        : guestUid;
      touched = true;

      hostPlayerRounds[r] = { timings: { qDoneMs: hostQDone, markDoneMs: hostMarkDone, role: "host" } };
      guestPlayerRounds[r] = { timings: { qDoneMs: guestQDone, markDoneMs: guestMarkDone, role: "guest" } };
      const hostWon = tie || payload.snippetWinnerUid === hostUid;
      const guestWon = tie || payload.snippetWinnerUid === guestUid;
      hostRetained[r] = hostWon;
      guestRetained[r] = guestWon;
    } else if (status === "marking") {
      payload.timings = {
        [hostUid]: { qDoneMs: hostQDone, role: "host" },
        [guestUid]: { qDoneMs: guestQDone, role: "guest" },
      };
      touched = true;
      hostPlayerRounds[r] = { timings: { qDoneMs: hostQDone, role: "host" } };
      guestPlayerRounds[r] = { timings: { qDoneMs: guestQDone, role: "guest" } };
    }

    if (touched) {
      roundPayloads[r] = payload;
    }

    timelineCursor += 70_000;
  }

  const countdownStartAt = stageRank === STAGE_RANK.countdown ? now + 7_000 : null;
  const markingStartAt = stageRank === STAGE_RANK.marking ? now - 5_000 : null;
  const awardStartAt = stageRank === STAGE_RANK.award ? now - 3_000 : null;

  const mathsAnswers = {};
  const mathsAnswersAck = {};
  if (targetStage === "final") {
    mathsAnswers.host = [42, 17];
    mathsAnswers.guest = [38, 17];
    mathsAnswersAck.host = true;
    mathsAnswersAck.guest = true;
  }

  const roomPatch = {
    state: targetStage,
    round: targetRound,
    "meta.hostUid": hostUid,
    "meta.guestUid": guestUid,
    "countdown.startAt": countdownStartAt,
    "marking.startAt": markingStartAt,
    "award.startAt": awardStartAt,
    "answers.host": answersHost,
    "answers.guest": answersGuest,
    "submitted.host": submittedHost,
    "submitted.guest": submittedGuest,
    "marking.host": markingHost,
    "marking.guest": markingGuest,
    "markingAck.host": markingAckHost,
    "markingAck.guest": markingAckGuest,
    "awardAck.host": awardAckHost,
    "awardAck.guest": awardAckGuest,
    "scores.questions.host": hostScoreTotal,
    "scores.questions.guest": guestScoreTotal,
    "links.guestReady": true,
    mathsAnswers,
    mathsAnswersAck,
    "timestamps.updatedAt": serverTimestamp(),
  };

  if (targetStage !== "final") {
    roomPatch.mathsAnswers = mathsAnswers;
    roomPatch.mathsAnswersAck = mathsAnswersAck;
  }

  await updateDoc(roomRef(normalizedCode), roomPatch);

  const roundPromises = Object.entries(roundPayloads).map(([r, payload]) => {
    const docRef = doc(roundSubColRef(normalizedCode), String(r));
    return setDoc(docRef, payload, { merge: true });
  });

  const hostPlayerPayload = { role: "host" };
  if (hasOwnData(hostPlayerRounds)) hostPlayerPayload.rounds = hostPlayerRounds;
  if (hasOwnData(hostRetained)) hostPlayerPayload.retainedSnippets = hostRetained;

  const guestPlayerPayload = { role: "guest" };
  if (hasOwnData(guestPlayerRounds)) guestPlayerPayload.rounds = guestPlayerRounds;
  if (hasOwnData(guestRetained)) guestPlayerPayload.retainedSnippets = guestRetained;

  roundPromises.push(
    setDoc(playerDocRef(normalizedCode, hostUid), hostPlayerPayload, { merge: true })
  );
  roundPromises.push(
    setDoc(playerDocRef(normalizedCode, guestUid), guestPlayerPayload, { merge: true })
  );

  await Promise.all(roundPromises);
}

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

    const status = el(
      "div",
      { class: "mono small", style: "margin-top:10px;min-height:18px;" },
      hintedCode ? `Enter ${hintedCode} or pick a new code.` : "Choose a room code to get started."
    );
    card.appendChild(status);

    const stage = {
      base: null,
      questionsOverride: null,
      hostOverride: null,
      guestOverride: null,
      mathsOverride: null,
    };

    let lastPack = null;
    let jumpInFlight = false;
    let jumpBtn = null;
    let jumpStatusEl = null;
    let stageSelectEl = null;
    let roundSelectEl = null;

    const startRow = el("div", {
      class: "mono",
      style: "margin-top:16px;display:flex;justify-content:center;",
    });
    const startBtn = el("button", { class: "btn primary", disabled: "" }, "Start");
    startRow.appendChild(startBtn);
    card.appendChild(startRow);

    const jumpSection = el("div", {
      class: "mono",
      style:
        "margin-top:18px;padding:12px;border:1px solid rgba(0,0,0,0.18);border-radius:10px;display:flex;flex-direction:column;gap:10px;",
    });
    jumpSection.appendChild(el("div", { style: "font-weight:700;" }, "Fast forward"));

    const stageOptions = [
      { value: "countdown", label: "Countdown" },
      { value: "questions", label: "Questions" },
      { value: "marking", label: "Marking" },
      { value: "award", label: "Award" },
      { value: "maths", label: "Maths" },
      { value: "final", label: "Final" },
    ];

    stageSelectEl = el("select", {
      class: "mono",
      style: "padding:6px;border:1px solid rgba(0,0,0,0.2);border-radius:8px;",
    });
    stageOptions.forEach(({ value, label }) => {
      stageSelectEl.appendChild(el("option", { value }, label));
    });

    const stageRow = el("label", {
      class: "mono",
      style: "display:flex;flex-direction:column;gap:6px;",
    }, [el("span", { style: "font-weight:700;" }, "Phase"), stageSelectEl]);
    jumpSection.appendChild(stageRow);

    roundSelectEl = el("select", {
      class: "mono",
      style: "padding:6px;border:1px solid rgba(0,0,0,0.2);border-radius:8px;",
    });
    for (let r = 1; r <= 5; r += 1) {
      roundSelectEl.appendChild(el("option", { value: String(r) }, `Round ${r}`));
    }
    const roundRow = el("label", {
      class: "mono",
      style: "display:flex;flex-direction:column;gap:6px;",
    }, [el("span", { style: "font-weight:700;" }, "Round"), roundSelectEl]);
    jumpSection.appendChild(roundRow);

    jumpBtn = el("button", { class: "btn primary", type: "button", disabled: "" }, "Jump there");
    const jumpBtnRow = el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;" }, [jumpBtn]);
    jumpSection.appendChild(jumpBtnRow);
    jumpBtn.addEventListener("click", () => {
      jumpToPhase();
    });

    jumpStatusEl = el("div", { class: "mono small", style: "min-height:18px;" }, "");
    jumpSection.appendChild(jumpStatusEl);

    card.appendChild(jumpSection);

    const logEl = el("pre", {
      class: "mono small",
      style: "margin-top:14px;background:rgba(0,0,0,0.05);padding:10px;border-radius:10px;min-height:120px;max-height:180px;overflow:auto;",
    });
    card.appendChild(logEl);

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

    function updateRoundForStage() {
      if (!stageSelectEl || !roundSelectEl) return;
      const value = sanitizeStage(stageSelectEl.value);
      if (value === "maths" || value === "final") {
        roundSelectEl.value = "5";
        roundSelectEl.disabled = true;
      } else {
        roundSelectEl.disabled = false;
      }
    }

    if (stageSelectEl) {
      stageSelectEl.addEventListener("change", () => {
        updateRoundForStage();
        reflectStartState();
      });
    }
    if (roundSelectEl) {
      roundSelectEl.addEventListener("change", () => {
        reflectStartState();
      });
    }

    updateRoundForStage();

    function reflectStartState() {
      const code = clampCode(codeInput.value);
      const ready = code.length >= 3;
      startBtn.disabled = !ready;
      startBtn.classList.toggle("throb", ready);
      if (jumpBtn) {
        jumpBtn.disabled = !ready || jumpInFlight;
        jumpBtn.classList.toggle("throb", ready && !jumpInFlight);
      }
      if (!ready) {
        status.textContent = "Enter a 3–5 character code to enable START.";
      } else if (!stage.base && !stage.questionsOverride && !stage.hostOverride && !stage.guestOverride) {
        status.textContent = "Starting without uploads. Placeholders will read <empty>.";
      } else {
        status.textContent = "Press START when you’re ready.";
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

      lastPack = pack;
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
      const pack = assemblePack(code);
      try {
        await seedFirestoreFromPack(db, pack);
        await updateDoc(roomRef(code), {
          state: "coderoom",
          "countdown.startAt": null,
          "links.guestReady": false,
          "timestamps.updatedAt": serverTimestamp(),
        });
        setStoredRole(code, "host");
        log(`room ${code} prepared; waiting in code room.`);
        location.hash = `#/coderoom?code=${code}`;
      } catch (err) {
        console.error("[keyroom] start failed", err);
        status.textContent = err?.message || "Failed to start. Please try again.";
        startBtn.disabled = false;
        reflectStartState();
      }
    }

    async function jumpToPhase() {
      const code = clampCode(codeInput.value);
      if (code.length < 3) {
        status.textContent = "Enter a valid room code first.";
        return;
      }
      if (jumpInFlight) return;
      jumpInFlight = true;
      reflectStartState();

      const stageValue = sanitizeStage(stageSelectEl ? stageSelectEl.value : "countdown");
      const roundRaw = Number(roundSelectEl ? roundSelectEl.value : "1") || 1;
      const roundValue = stageValue === "maths" || stageValue === "final" ? 5 : Math.max(1, Math.min(5, roundRaw));

      status.textContent = "Preparing jump…";
      if (jumpStatusEl) jumpStatusEl.textContent = "Preparing jump…";

      try {
        const pack = assemblePack(code);
        await seedFirestoreFromPack(db, pack);
        await applyJumpState({ code, pack, stage: stageValue, round: roundValue });
        setStoredRole(code, "host");

        const guestLink = `${location.origin}${location.pathname}#/lobby?code=${code}`;
        let copied = false;
        try {
          copied = await copyToClipboard(guestLink);
        } catch (err) {
          console.warn("[keyroom] copy guest link failed", err);
        }

        if (jumpStatusEl) {
          if (copied) {
            jumpStatusEl.textContent = "Guest link copied. Launching phase…";
          } else {
            jumpStatusEl.textContent = `Guest link ready: ${guestLink}`;
          }
        }
        status.textContent = "Launching new phase…";
        log(`jumped to ${stageValue} round ${roundValue}`);

        const target = routeForStage(stageValue, code, roundValue);
        setTimeout(() => {
          location.hash = target;
        }, 250);
      } catch (err) {
        console.error("[keyroom] jump failed", err);
        status.textContent = err?.message || "Jump failed. Please try again.";
        if (jumpStatusEl) jumpStatusEl.textContent = err?.message || "Jump failed. Please try again.";
      } finally {
        jumpInFlight = false;
        reflectStartState();
      }
    }

    startBtn.addEventListener("click", startGame);

    updateProgress();
    reflectStartState();
  },

  async unmount() {},
};
