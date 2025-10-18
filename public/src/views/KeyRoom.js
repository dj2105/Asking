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
import { applyTheme } from "../lib/theme.js";

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
const playerDocRef = (code, uid) => doc(roomRef(code), "players", uid);
const DEFAULT_HOST_UID = "daniel-001";
const DEFAULT_GUEST_UID = "jaime-001";
const PLACEHOLDER = "<empty>";

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

const HOST_CORRECT_PATTERN = [3, 2, 1, 3, 2];
const GUEST_CORRECT_PATTERN = [2, 3, 1, 2, 3];
const SNIPPET_PATTERN = ["host", "guest", "host", "guest", "tie"];

function stageNeedsRound(stage) {
  return stage === "countdown" || stage === "questions" || stage === "marking" || stage === "award";
}

function computeHostHash(stage, code, round) {
  switch (stage) {
    case "keyroom":
      return `#/keyroom?code=${code}`;
    case "coderoom":
      return `#/coderoom?code=${code}`;
    case "countdown":
      return `#/countdown?code=${code}&round=${round}`;
    case "questions":
      return `#/questions?code=${code}&round=${round}`;
    case "marking":
      return `#/marking?code=${code}&round=${round}`;
    case "award":
      return `#/award?code=${code}&round=${round}`;
    case "maths":
      return `#/maths?code=${code}`;
    case "final":
      return `#/final?code=${code}`;
    default:
      return `#/keyroom?code=${code}`;
  }
}

function buildGuestLink(code) {
  const base = `${location.origin}${location.pathname}#/rejoin`;
  return `${base}?code=${code}&auto=1&role=guest`;
}

function sameNormalized(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function pickWrongAnswer(item) {
  const correct = typeof item?.correct_answer === "string" ? item.correct_answer : "";
  const pool = [item?.distractors?.easy, item?.distractors?.medium, item?.distractors?.hard]
    .map((value) => (typeof value === "string" ? value : ""))
    .filter((value) => value && value.trim() && value.trim().toLowerCase() !== correct.trim().toLowerCase());
  if (pool.length) return pool[0];
  if (correct) return `${correct} (wrong)`;
  return PLACEHOLDER;
}

function buildCorrectIndexSet(count, seed) {
  const safe = Math.max(0, Math.min(3, Number(count) || 0));
  if (safe >= 3) return [0, 1, 2];
  if (safe === 2) {
    const mod = seed % 3;
    if (mod === 0) return [0, 1];
    if (mod === 1) return [1, 2];
    return [0, 2];
  }
  if (safe === 1) {
    return [seed % 3];
  }
  return [];
}

function buildAnswerSet(items, correctCount, seed) {
  const normalized = padItems(items);
  const indices = new Set(buildCorrectIndexSet(correctCount, seed));
  return normalized.map((item, idx) => {
    const question = typeof item?.question === "string" ? item.question : PLACEHOLDER;
    const correct = typeof item?.correct_answer === "string" ? item.correct_answer : PLACEHOLDER;
    const chosen = indices.has(idx) ? correct : pickWrongAnswer(item);
    return { question, chosen, correct };
  });
}

function simulateRounds(pack) {
  const hostUid = pack?.meta?.hostUid || DEFAULT_HOST_UID;
  const guestUid = pack?.meta?.guestUid || DEFAULT_GUEST_UID;
  const baseNow = Date.now();
  const rounds = {};

  (pack?.rounds || []).forEach((entry) => {
    const roundNumber = Number(entry?.round) || 0;
    if (!roundNumber) return;
    const hostAnswers = buildAnswerSet(entry?.hostItems || [], HOST_CORRECT_PATTERN[roundNumber - 1] ?? 2, roundNumber);
    const guestAnswers = buildAnswerSet(entry?.guestItems || [], GUEST_CORRECT_PATTERN[roundNumber - 1] ?? 2, roundNumber + 10);
    const startAt = baseNow - (6 - roundNumber) * 120_000 - 45_000;
    const hostQuestionSegment = 11_000 + roundNumber * 1_000;
    const guestQuestionSegment = 12_500 + roundNumber * 900;
    let hostTotal = 23_000 + roundNumber * 1_400;
    let guestTotal = hostTotal + 2_200;
    const outcome = SNIPPET_PATTERN[roundNumber - 1] || "host";
    let snippetWinnerUid = null;
    let snippetTie = false;

    if (outcome === "host") {
      snippetWinnerUid = hostUid;
      if (!(hostTotal < guestTotal - 1)) guestTotal = hostTotal + 2_200;
    } else if (outcome === "guest") {
      snippetWinnerUid = guestUid;
      if (!(guestTotal < hostTotal - 1)) hostTotal = guestTotal + 2_400;
    } else {
      snippetTie = true;
      guestTotal = hostTotal + 1;
    }

    const hostMarkSegment = Math.max(5_000, hostTotal - hostQuestionSegment);
    const guestMarkSegment = Math.max(5_000, guestTotal - guestQuestionSegment);
    const qDoneHost = startAt + hostQuestionSegment;
    const qDoneGuest = startAt + guestQuestionSegment;
    const markDoneHost = qDoneHost + hostMarkSegment;
    const markDoneGuest = qDoneGuest + guestMarkSegment;

    const hostCorrect = hostAnswers.filter((ans) => sameNormalized(ans.chosen, ans.correct)).length;
    const guestCorrect = guestAnswers.filter((ans) => sameNormalized(ans.chosen, ans.correct)).length;
    const hostMarking = guestAnswers.map((ans) => (sameNormalized(ans.chosen, ans.correct) ? "right" : "wrong"));
    const guestMarking = hostAnswers.map((ans) => (sameNormalized(ans.chosen, ans.correct) ? "right" : "wrong"));

    rounds[roundNumber] = {
      hostAnswers,
      guestAnswers,
      hostCorrect,
      guestCorrect,
      hostMarking,
      guestMarking,
      timings: {
        startAt,
        host: { role: "host", qDoneMs: qDoneHost, markDoneMs: markDoneHost, totalMs: hostTotal },
        guest: { role: "guest", qDoneMs: qDoneGuest, markDoneMs: markDoneGuest, totalMs: guestTotal },
      },
      snippetWinnerUid,
      snippetTie,
    };
  });

  return { rounds, hostUid, guestUid };
}

function summarizeRounds(rounds, limit, selector) {
  let total = 0;
  for (let i = 1; i <= limit; i += 1) {
    const entry = rounds[i];
    if (!entry) continue;
    total += Number(selector(entry)) || 0;
  }
  return total;
}

function prepareStageState(pack, stageName, requestedRound) {
  const { rounds, hostUid, guestUid } = simulateRounds(pack);
  let round = Number.isFinite(Number(requestedRound)) ? Number(requestedRound) : 1;
  round = Math.max(1, Math.min(5, round));

  let answeredRounds = 0;
  let completedRounds = 0;
  let mathsStage = false;

  switch (stageName) {
    case "keyroom":
      round = 1;
      answeredRounds = 0;
      completedRounds = 0;
      break;
    case "coderoom":
      round = Math.max(1, round);
      answeredRounds = 0;
      completedRounds = 0;
      break;
    case "countdown":
      answeredRounds = Math.max(0, round - 1);
      completedRounds = Math.max(0, round - 1);
      break;
    case "questions":
      answeredRounds = Math.max(0, round - 1);
      completedRounds = Math.max(0, round - 1);
      break;
    case "marking":
      answeredRounds = round;
      completedRounds = Math.max(0, round - 1);
      break;
    case "award":
      answeredRounds = round;
      completedRounds = round;
      break;
    case "maths":
      round = 5;
      answeredRounds = 5;
      completedRounds = 5;
      mathsStage = true;
      break;
    case "final":
      round = 5;
      answeredRounds = 5;
      completedRounds = 5;
      mathsStage = true;
      break;
    default:
      round = 1;
      answeredRounds = 0;
      completedRounds = 0;
      break;
  }

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
  const roundPatches = [];
  const playerPatches = [];

  for (let i = 1; i <= answeredRounds; i += 1) {
    const info = rounds[i];
    if (!info) continue;
    answersHost[i] = info.hostAnswers;
    answersGuest[i] = info.guestAnswers;
    submittedHost[i] = true;
    submittedGuest[i] = true;
  }

  for (let i = 1; i <= completedRounds; i += 1) {
    const info = rounds[i];
    if (!info) continue;
    markingHost[i] = info.hostMarking;
    markingGuest[i] = info.guestMarking;
    markingAckHost[i] = true;
    markingAckGuest[i] = true;
  }

  let awardAckLimit = 0;
  if (stageName === "maths" || stageName === "final") {
    awardAckLimit = 5;
  } else if (stageName === "award") {
    awardAckLimit = Math.max(0, round - 1);
  } else {
    awardAckLimit = Math.max(0, round - 1);
  }

  for (let i = 1; i <= awardAckLimit; i += 1) {
    awardAckHost[i] = true;
    awardAckGuest[i] = true;
  }

  const questionsHostTotal = summarizeRounds(rounds, answeredRounds, (entry) => entry.hostCorrect);
  const questionsGuestTotal = summarizeRounds(rounds, answeredRounds, (entry) => entry.guestCorrect);

  const mathsAnswers = {};
  const mathsAnswersAck = {};
  if (stageName === "final") {
    const source = Array.isArray(pack?.maths?.answers) ? pack.maths.answers.slice(0, 2) : [0, 0];
    const safe = source.map((value) => (Number.isInteger(value) ? value : 0));
    mathsAnswers.host = safe;
    mathsAnswers.guest = safe.map((value, idx) => value + (idx === 0 ? -1 : 1));
    mathsAnswersAck.host = true;
    mathsAnswersAck.guest = true;
  }

  for (let i = 1; i <= 5; i += 1) {
    const info = rounds[i];
    if (!info) continue;
    if (i <= answeredRounds || i <= completedRounds) {
      const patch = { timingsMeta: { questionsStartAt: info.timings.startAt } };
      const timings = {};
      timings[hostUid] = { role: "host", qDoneMs: info.timings.host.qDoneMs };
      timings[guestUid] = { role: "guest", qDoneMs: info.timings.guest.qDoneMs };
      if (i <= completedRounds) {
        timings[hostUid].markDoneMs = info.timings.host.markDoneMs;
        timings[hostUid].totalMs = info.timings.host.totalMs;
        timings[guestUid].markDoneMs = info.timings.guest.markDoneMs;
        timings[guestUid].totalMs = info.timings.guest.totalMs;
        patch.snippetWinnerUid = info.snippetWinnerUid || null;
        patch.snippetTie = Boolean(info.snippetTie);
      }
      patch.timings = timings;
      roundPatches.push({ round: i, data: patch });
    }
  }

  if (completedRounds > 0) {
    const retainedHost = {};
    const retainedGuest = {};
    for (let i = 1; i <= completedRounds; i += 1) {
      const info = rounds[i];
      if (!info) continue;
      const hostWon = info.snippetTie || info.snippetWinnerUid === hostUid;
      const guestWon = info.snippetTie || info.snippetWinnerUid === guestUid;
      retainedHost[i] = Boolean(hostWon);
      retainedGuest[i] = Boolean(guestWon);
    }
    playerPatches.push({ id: hostUid, data: { retainedSnippets: retainedHost } });
    playerPatches.push({ id: guestUid, data: { retainedSnippets: retainedGuest } });
  }

  const guestReady = stageName !== "keyroom";
  const countdownStart = stageName === "countdown" ? Date.now() + 5_000 : null;
  const markingStartAt = stageName === "marking" ? Date.now() : null;

  const roomPatch = {
    state: stageName,
    round: mathsStage ? 5 : round,
    countdown: { startAt: countdownStart },
    answers: { host: answersHost, guest: answersGuest },
    submitted: { host: submittedHost, guest: submittedGuest },
    marking: { host: markingHost, guest: markingGuest, startAt: markingStartAt },
    markingAck: { host: markingAckHost, guest: markingAckGuest },
    awardAck: { host: awardAckHost, guest: awardAckGuest },
    scores: { questions: { host: questionsHostTotal, guest: questionsGuestTotal } },
    links: { guestReady },
    mathsAnswers,
    mathsAnswersAck,
    award: { startAt: null },
  };

  return {
    roomPatch,
    roundPatches,
    playerPatches,
    hostUid,
    guestUid,
    round,
    mathsStage,
  };
}

export default {
  async mount(container) {
    await ensureAuth();
    applyTheme({ phase: "keyroom" });

    const params = getHashParams();
    const hintedCode = clampCode(params.get("code") || "");
    const seededCode = hintedCode || generateRandomCode();

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
      value: seededCode,
      oninput: (event) => {
        event.target.value = clampCode(event.target.value);
        reflectStartState();
        reflectJumpState();
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
          reflectJumpState();
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
        "margin-top:18px;padding-top:16px;border-top:1px solid rgba(0,0,0,0.15);display:flex;flex-direction:column;gap:10px;",
    });
    jumpSection.appendChild(el("div", { style: "font-weight:700;text-align:center;" }, "Jump to stage"));
    const stageRow = el("div", {
      style: "display:flex;justify-content:center;align-items:center;gap:10px;flex-wrap:wrap;",
    });
    stageRow.appendChild(el("span", { style: "font-weight:600;" }, "Stage"));
    const jumpStageSelect = el("select", {
      class: "mono",
      style: "padding:6px 10px;border:1px solid rgba(0,0,0,0.2);border-radius:8px;",
    });
    [
      { value: "keyroom", label: "Key Room" },
      { value: "coderoom", label: "Code Room" },
      { value: "countdown", label: "Countdown" },
      { value: "questions", label: "Questions" },
      { value: "marking", label: "Marking" },
      { value: "award", label: "Award" },
      { value: "maths", label: "Maths" },
      { value: "final", label: "Final" },
    ].forEach(({ value, label }) => {
      jumpStageSelect.appendChild(el("option", { value }, label));
    });
    stageRow.appendChild(jumpStageSelect);
    jumpSection.appendChild(stageRow);

    const roundRow = el("div", {
      style: "display:flex;justify-content:center;align-items:center;gap:10px;flex-wrap:wrap;",
    });
    roundRow.appendChild(el("span", { style: "font-weight:600;" }, "Round"));
    const jumpRoundInput = el("input", {
      type: "number",
      min: "1",
      max: "5",
      value: "1",
      class: "mono",
      style: "width:80px;padding:6px 8px;border:1px solid rgba(0,0,0,0.2);border-radius:8px;text-align:center;",
    });
    roundRow.appendChild(jumpRoundInput);
    jumpSection.appendChild(roundRow);

    const jumpBtn = el(
      "button",
      { class: "btn primary", type: "button", disabled: "" },
      "Jump & prepare"
    );
    jumpSection.appendChild(el("div", { style: "display:flex;justify-content:center;" }, jumpBtn));

    const goHostBtn = el(
      "button",
      { class: "btn outline", type: "button", disabled: "", style: "width:100%;" },
      "Go as Daniel"
    );
    jumpSection.appendChild(el("div", { style: "display:flex;" }, goHostBtn));

    const guestRow = el("div", {
      style:
        "display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:center;",
    });
    const guestLinkInput = el("input", {
      type: "text",
      class: "mono",
      readonly: "",
      value: "",
      style: "flex:1 1 220px;padding:6px 8px;border:1px solid rgba(0,0,0,0.2);border-radius:8px;",
    });
    const guestCopyBtn = el(
      "button",
      { class: "btn outline", type: "button", disabled: "" },
      "Copy guest link"
    );
    guestRow.appendChild(guestLinkInput);
    guestRow.appendChild(guestCopyBtn);
    jumpSection.appendChild(guestRow);

    const jumpStatus = el("div", {
      class: "mono small",
      style: "text-align:center;min-height:18px;",
    }, "");
    jumpSection.appendChild(jumpStatus);

    card.appendChild(jumpSection);

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

    let lastHostHash = null;
    let lastGuestLink = "";
    let jumpInFlight = false;

    const clampRoundValue = (value) => {
      const num = parseInt(String(value || "1"), 10);
      if (!Number.isFinite(num)) return 1;
      return Math.max(1, Math.min(5, num));
    };

    const stageLabel = (name, r) => {
      const base = `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`;
      if (name === "maths" || name === "final") return base;
      if (stageNeedsRound(name)) return `${base} · Round ${r}`;
      return base;
    };

    const updateJumpRoundVisibility = () => {
      const stageName = jumpStageSelect.value;
      if (stageNeedsRound(stageName)) {
        roundRow.style.display = "flex";
      } else {
        roundRow.style.display = "none";
        jumpRoundInput.value = stageName === "maths" || stageName === "final" ? "5" : "1";
      }
    };

    const reflectJumpState = () => {
      const code = clampCode(codeInput.value);
      const stageName = jumpStageSelect.value;
      let ready = code.length >= 3;
      if (stageNeedsRound(stageName)) {
        const next = clampRoundValue(jumpRoundInput.value);
        jumpRoundInput.value = String(next);
        ready = ready && next >= 1 && next <= 5;
      }
      if (jumpInFlight) ready = false;
      jumpBtn.disabled = !ready;
      jumpBtn.classList.toggle("throb", ready);
    };

    jumpStageSelect.value = "countdown";
    jumpStageSelect.addEventListener("change", () => {
      updateJumpRoundVisibility();
      reflectJumpState();
    });
    jumpRoundInput.addEventListener("input", (event) => {
      event.target.value = String(clampRoundValue(event.target.value));
      reflectJumpState();
    });

    goHostBtn.addEventListener("click", () => {
      if (!lastHostHash) return;
      location.hash = lastHostHash;
    });

    guestCopyBtn.addEventListener("click", async () => {
      if (!lastGuestLink) return;
      const ok = await copyToClipboard(lastGuestLink);
      if (ok) jumpStatus.textContent = "Guest link copied.";
    });

    const jumpToStage = async () => {
      if (jumpInFlight) return;
      const code = clampCode(codeInput.value);
      const stageName = jumpStageSelect.value;
      if (code.length < 3) {
        jumpStatus.textContent = "Enter a room code first.";
        return;
      }
      let roundValue = clampRoundValue(jumpRoundInput.value);
      if (!stageNeedsRound(stageName)) {
        roundValue = stageName === "maths" || stageName === "final" ? 5 : 1;
      }

      jumpInFlight = true;
      jumpBtn.disabled = true;
      jumpBtn.classList.remove("throb");
      goHostBtn.disabled = true;
      guestCopyBtn.disabled = true;
      guestLinkInput.value = "";
      lastHostHash = null;
      lastGuestLink = "";
      jumpStatus.textContent = "Preparing jump…";
      status.textContent = "Seeding Firestore…";

      try {
        const pack = assemblePack(code);
        await seedFirestoreFromPack(db, pack);
        const prepared = prepareStageState(pack, stageName, roundValue);
        prepared.roomPatch["timestamps.updatedAt"] = serverTimestamp();
        const writes = [];
        prepared.roundPatches.forEach(({ round: r, data }) => {
          writes.push(setDoc(doc(roundSubColRef(code), String(r)), data, { merge: true }));
        });
        prepared.playerPatches.forEach(({ id, data }) => {
          writes.push(setDoc(playerDocRef(code, id), data, { merge: true }));
        });
        writes.push(updateDoc(roomRef(code), prepared.roomPatch));
        await Promise.all(writes);

        setStoredRole(code, "host");
        const hostHash = computeHostHash(stageName, code, prepared.round);
        const guestLink = buildGuestLink(code);
        lastHostHash = hostHash;
        lastGuestLink = guestLink;
        guestLinkInput.value = guestLink;
        goHostBtn.disabled = false;
        guestCopyBtn.disabled = false;
        const label = stageLabel(stageName, prepared.round);
        status.textContent = `Room ${code} staged for ${label}.`;
        jumpStatus.textContent = `Ready • ${label}`;
        log(`jumped to ${label.toLowerCase()}`);
      } catch (err) {
        console.error("[keyroom] jump failed", err);
        status.textContent = "Jump failed. See log.";
        jumpStatus.textContent = err?.message || "Failed to prepare jump.";
        log(`jump error: ${err?.message || err}`);
      } finally {
        jumpInFlight = false;
        reflectJumpState();
      }
    };

    jumpBtn.addEventListener("click", jumpToStage);

    updateJumpRoundVisibility();
    reflectJumpState();

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
      if (!ready) {
        status.textContent = "Enter a 3–5 character code to enable START.";
      } else if (!stage.base && !stage.questionsOverride && !stage.hostOverride && !stage.guestOverride) {
        status.textContent = "Starting without uploads. Placeholders will read <empty>.";
      } else {
        status.textContent = "Press START when you’re ready.";
      }
      reflectJumpState();
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

    startBtn.addEventListener("click", startGame);

    updateProgress();
    reflectStartState();
  },

  async unmount() {},
};
