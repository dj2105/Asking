// /src/views/KeyRoom.js
// Host-only sealed-pack upload flow (revamped).
// - Host chooses a room code manually (or via Random button) and presses START to seed Firestore.
// - Any sealed file title can be uploaded in any order; we no longer require matching codes.
// - Full packs provide the baseline; optional question/maths overrides replace matching sections.
// - When START fires we build a composite pack, filling missing content with "<empty>",
//   seed Firestore, then optionally fast-forward the room to any phase.

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
const roundDocRef = (code, round) => doc(roomRef(code), "rounds", String(round));
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

function sameText(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

function ensureString(value, fallback = PLACEHOLDER) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function extractWrongOption(item, fallback = PLACEHOLDER) {
  const distractors = item?.distractors || {};
  const pool = [distractors.easy, distractors.medium, distractors.hard];
  const correct = ensureString(item?.correct_answer, fallback);
  for (const opt of pool) {
    if (typeof opt === "string" && opt.trim() && !sameText(opt, correct)) {
      return opt;
    }
  }
  if (typeof item?.question === "string" && item.question.trim()) {
    return `${item.question.trim()} — guess`;
  }
  if (correct && !sameText(correct, fallback)) {
    return `${correct} (??)`;
  }
  return fallback;
}

function craftAnswers(items = [], pattern = [true, true, false]) {
  const trio = Array.isArray(items) ? items.slice(0, 3) : [];
  while (trio.length < 3) trio.push(buildEmptyItem());
  const answers = [];
  let correctTotal = 0;
  for (let i = 0; i < 3; i += 1) {
    const raw = trio[i] || {};
    const wantCorrect = Boolean(pattern[i]);
    const question = ensureString(raw.question);
    const correct = ensureString(raw.correct_answer);
    const wrong = extractWrongOption(raw, PLACEHOLDER);
    const chosen = wantCorrect ? correct : wrong;
    if (wantCorrect && !sameText(chosen, PLACEHOLDER) && sameText(chosen, correct)) {
      correctTotal += 1;
    }
    answers.push({
      question,
      chosen,
      correct,
    });
  }
  return { answers, correctTotal };
}

function generateRoundSimulations(pack, { hostUid, guestUid }) {
  const rounds = Array.isArray(pack?.rounds) ? pack.rounds : [];
  const hostPatterns = [
    [true, true, false],
    [true, false, true],
    [true, true, true],
    [false, true, true],
    [true, false, false],
  ];
  const guestPatterns = [
    [false, true, false],
    [true, true, false],
    [false, true, true],
    [true, true, true],
    [false, false, true],
  ];
  const baseStart = Date.now() - 1000 * 60 * 20; // twenty minutes ago
  const gap = 1000 * 60 * 3; // three minutes between rounds

  const sims = {};
  for (let i = 0; i < 5; i += 1) {
    const roundNumber = i + 1;
    const src = rounds[i] || {};
    const hostItems = Array.isArray(src.hostItems) ? src.hostItems : [];
    const guestItems = Array.isArray(src.guestItems) ? src.guestItems : [];
    const startAt = baseStart + i * gap;

    const hostRes = craftAnswers(hostItems, hostPatterns[i] || [true, true, false]);
    const guestRes = craftAnswers(guestItems, guestPatterns[i] || [false, true, false]);

    const hostQuestionDuration = 12000 + i * 1400 + (hostRes.correctTotal < 2 ? 1800 : 0);
    const guestQuestionDuration = 13000 + i * 1300 + (guestRes.correctTotal < 2 ? 1600 : 0);
    const hostMarkDuration = 8000 + i * 900;
    const guestMarkDuration = 8600 + i * 840;

    const hostQDone = startAt + hostQuestionDuration;
    const guestQDone = startAt + guestQuestionDuration;
    const hostMarkDone = hostQDone + hostMarkDuration;
    const guestMarkDone = guestQDone + guestMarkDuration;

    const hostTotal = hostMarkDone - startAt;
    const guestTotal = guestMarkDone - startAt;
    const tie = Math.abs(hostTotal - guestTotal) <= 250;
    const winnerUid = tie ? null : hostTotal < guestTotal ? hostUid : guestUid;

    sims[roundNumber] = {
      round: roundNumber,
      hostAnswers: hostRes.answers,
      guestAnswers: guestRes.answers,
      hostCorrect: hostRes.correctTotal,
      guestCorrect: guestRes.correctTotal,
      hostMarks: guestRes.answers.map((ans, idx) =>
        sameText(ans?.chosen, ans?.correct) ? "right" : "wrong"
      ),
      guestMarks: hostRes.answers.map((ans, idx) =>
        sameText(ans?.chosen, ans?.correct) ? "right" : "wrong"
      ),
      timings: {
        [hostUid]: {
          role: "host",
          qDoneMs: hostQDone,
          markDoneMs: hostMarkDone,
          totalMs: hostTotal,
        },
        [guestUid]: {
          role: "guest",
          qDoneMs: guestQDone,
          markDoneMs: guestMarkDone,
          totalMs: guestTotal,
        },
      },
      questionsStartAt: startAt,
      snippetWinnerUid: winnerUid,
      snippetTie: tie,
    };
  }
  return sims;
}

function needsRoundSelection(phase) {
  return ["countdown", "questions", "marking", "award"].includes(String(phase || "").toLowerCase());
}

function normalizeRound(phase, raw) {
  const value = Number(raw) || 1;
  if (String(phase || "").toLowerCase() === "maths" || String(phase || "").toLowerCase() === "final") {
    return 5;
  }
  if (value < 1) return 1;
  if (value > 5) return 5;
  return value;
}

function computeHostRoute(code, phase, round) {
  const safe = String(phase || "").toLowerCase();
  if (!code) return "#/keyroom";
  if (safe === "coderoom") return `#/coderoom?code=${code}`;
  if (safe === "countdown") return `#/countdown?code=${code}&round=${round}`;
  if (safe === "questions") return `#/questions?code=${code}&round=${round}`;
  if (safe === "marking") return `#/marking?code=${code}&round=${round}`;
  if (safe === "award") return `#/award?code=${code}&round=${round}`;
  if (safe === "maths") return `#/maths?code=${code}`;
  if (safe === "final") return `#/final?code=${code}`;
  return `#/coderoom?code=${code}`;
}

function computeGuestPath(code) {
  if (!code) return "";
  return `#/rejoin?code=${code}&role=guest&auto=1`;
}

function determineRoundStatus(phase, targetRound, roundNumber) {
  const safe = String(phase || "").toLowerCase();
  if (safe === "maths" || safe === "final") return "complete";
  if (safe === "award") {
    if (roundNumber < targetRound) return "complete";
    if (roundNumber === targetRound) return "award";
    return "pending";
  }
  if (safe === "marking") {
    if (roundNumber < targetRound) return "complete";
    if (roundNumber === targetRound) return "marking";
    return "pending";
  }
  if (safe === "questions") {
    if (roundNumber < targetRound) return "complete";
    if (roundNumber === targetRound) return "questions";
    return "pending";
  }
  if (safe === "countdown") {
    if (roundNumber < targetRound) return "complete";
    if (roundNumber === targetRound) return "countdown";
    return "pending";
  }
  if (safe === "coderoom" || safe === "keyroom" || safe === "seeding") return "pending";
  return "pending";
}

async function applyJumpState({
  code,
  pack,
  phase,
  round,
}) {
  const normalizedPhase = String(phase || "").toLowerCase();
  const targetRound = normalizeRound(phase, round);
  const hostUid = pack?.meta?.hostUid || DEFAULT_HOST_UID;
  const guestUid = pack?.meta?.guestUid || DEFAULT_GUEST_UID;
  const simulations = generateRoundSimulations(pack, { hostUid, guestUid });

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
  const retainedHost = {};
  const retainedGuest = {};
  const playerRoundsHost = {};
  const playerRoundsGuest = {};
  const roundWrites = [];

  let totalHostScore = 0;
  let totalGuestScore = 0;

  for (let r = 1; r <= 5; r += 1) {
    const status = determineRoundStatus(normalizedPhase, targetRound, r);
    const sim = simulations[r];
    if (!sim) continue;
    const roundPatch = {};
    if (status === "complete" || status === "award" || status === "marking") {
      answersHost[r] = sim.hostAnswers;
      answersGuest[r] = sim.guestAnswers;
      submittedHost[r] = true;
      submittedGuest[r] = true;
      roundPatch.timings = sim.timings;
      roundPatch.timingsMeta = { questionsStartAt: sim.questionsStartAt };

      playerRoundsHost[r] = { timings: { qDoneMs: sim.timings[hostUid]?.qDoneMs || null, totalMs: sim.timings[hostUid]?.totalMs || null, role: "host" } };
      playerRoundsGuest[r] = { timings: { qDoneMs: sim.timings[guestUid]?.qDoneMs || null, totalMs: sim.timings[guestUid]?.totalMs || null, role: "guest" } };

      totalHostScore += sim.hostCorrect;
      totalGuestScore += sim.guestCorrect;
    }

    if (status === "complete" || status === "award") {
      markingHost[r] = sim.hostMarks;
      markingGuest[r] = sim.guestMarks;
      markingAckHost[r] = true;
      markingAckGuest[r] = true;
      roundPatch.snippetWinnerUid = sim.snippetWinnerUid || null;
      roundPatch.snippetTie = Boolean(sim.snippetTie);
      if (sim.snippetTie || sim.snippetWinnerUid === hostUid) retainedHost[r] = true;
      if (sim.snippetTie || sim.snippetWinnerUid === guestUid) retainedGuest[r] = true;
      if (status === "complete") {
        awardAckHost[r] = true;
        awardAckGuest[r] = true;
      } else {
        awardAckHost[r] = false;
        awardAckGuest[r] = false;
      }
    } else if (status === "marking") {
      markingAckHost[r] = false;
      markingAckGuest[r] = false;
    }

    if (Object.keys(roundPatch).length > 0) {
      roundWrites.push(setDoc(roundDocRef(code, r), roundPatch, { merge: true }));
    }
  }

  const countdownStartAt = normalizedPhase === "countdown"
    ? Date.now() + 4000
    : null;
  const markingStartAt = normalizedPhase === "marking"
    ? Date.now()
    : null;

  const mathsAnswers = {};
  const mathsAnswersAck = {};
  if (normalizedPhase === "final") {
    const maths = pack?.maths || {};
    const baseAnswers = Array.isArray(maths.answers) ? maths.answers : [];
    const hostMaths = [
      Number.isInteger(baseAnswers[0]) ? baseAnswers[0] : 42,
      Number.isInteger(baseAnswers[1]) ? baseAnswers[1] : 108,
    ];
    const guestMaths = [
      Number.isInteger(baseAnswers[0]) ? baseAnswers[0] : 40,
      Number.isInteger(baseAnswers[1]) ? baseAnswers[1] + 1 : 88,
    ];
    mathsAnswers.host = hostMaths;
    mathsAnswers.guest = guestMaths;
    mathsAnswersAck.host = true;
    mathsAnswersAck.guest = true;
  }

  const roomPatch = {
    state: normalizedPhase === "coderoom" ? "coderoom" : normalizedPhase,
    round: targetRound,
    "countdown.startAt": countdownStartAt,
    "marking.startAt": markingStartAt,
    "links.guestReady": true,
    "timestamps.updatedAt": serverTimestamp(),
  };

  if (Object.keys(answersHost).length > 0 || Object.keys(answersGuest).length > 0) {
    roomPatch.answers = { host: answersHost, guest: answersGuest };
  }
  if (Object.keys(submittedHost).length > 0 || Object.keys(submittedGuest).length > 0) {
    roomPatch.submitted = { host: submittedHost, guest: submittedGuest };
  }
  roomPatch.marking = {
    host: markingHost,
    guest: markingGuest,
    startAt: markingStartAt,
  };
  roomPatch.markingAck = { host: markingAckHost, guest: markingAckGuest };
  roomPatch.awardAck = { host: awardAckHost, guest: awardAckGuest };
  roomPatch.scores = {
    questions: {
      host: totalHostScore,
      guest: totalGuestScore,
    },
  };
  if (normalizedPhase === "final") {
    roomPatch.mathsAnswers = mathsAnswers;
    roomPatch.mathsAnswersAck = mathsAnswersAck;
  } else if (normalizedPhase === "maths") {
    roomPatch.mathsAnswers = { host: null, guest: null };
    roomPatch.mathsAnswersAck = { host: false, guest: false };
  }

  await updateDoc(roomRef(code), roomPatch);

  if (roundWrites.length > 0) {
    await Promise.all(roundWrites);
  }

  const playerWrites = [];
  if (Object.keys(playerRoundsHost).length > 0 || Object.keys(retainedHost).length > 0) {
    playerWrites.push(
      setDoc(
        playerDocRef(code, hostUid),
        {
          rounds: playerRoundsHost,
          retainedSnippets: retainedHost,
        },
        { merge: true }
      )
    );
  }
  if (Object.keys(playerRoundsGuest).length > 0 || Object.keys(retainedGuest).length > 0) {
    playerWrites.push(
      setDoc(
        playerDocRef(code, guestUid),
        {
          rounds: playerRoundsGuest,
          retainedSnippets: retainedGuest,
        },
        { merge: true }
      )
    );
  }
  if (playerWrites.length > 0) await Promise.all(playerWrites);

  return {
    hostRoute: computeHostRoute(code, normalizedPhase, targetRound),
    guestLink: `${location.origin}${location.pathname}${computeGuestPath(code)}`,
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
    let currentGuestLink = "";
    const copyLinkBtn = el(
      "button",
      {
        class: "btn outline",
        type: "button",
        onclick: async () => {
          const code = clampCode(codeInput.value);
          if (!code || !currentGuestLink) return;
          const ok = await copyToClipboard(currentGuestLink);
          if (ok) status.textContent = "Jaime’s link copied.";
        },
      },
      "Copy Jaime link"
    );
    codeRow.appendChild(el("span", { style: "font-weight:700;" }, "Room code"));
    codeRow.appendChild(codeInput);
    codeRow.appendChild(randomBtn);
    codeRow.appendChild(copyLinkBtn);
    card.appendChild(codeRow);

    const jumpWrap = el("div", {
      class: "mono",
      style: "display:flex;flex-direction:column;gap:8px;margin-bottom:12px;",
    });
    jumpWrap.appendChild(el("span", { style: "font-weight:700;" }, "Jump to phase"));

    const phaseSelect = el("select", { class: "input mono" });
    const phaseOptions = [
      { value: "coderoom", label: "Code Room" },
      { value: "countdown", label: "Countdown" },
      { value: "questions", label: "Questions" },
      { value: "marking", label: "Marking" },
      { value: "award", label: "Award" },
      { value: "maths", label: "Maths" },
      { value: "final", label: "Final" },
    ];
    phaseOptions.forEach(({ value, label }) => {
      phaseSelect.appendChild(el("option", { value }, label));
    });

    const roundWrap = el("div", { style: "display:flex;gap:8px;align-items:center;" });
    const roundLabel = el("span", {}, "Round");
    const roundSelect = el("select", { class: "input mono", style: "max-width:120px;" });
    for (let i = 1; i <= 5; i += 1) {
      roundSelect.appendChild(el("option", { value: String(i) }, `Round ${i}`));
    }
    roundWrap.appendChild(roundLabel);
    roundWrap.appendChild(roundSelect);

    jumpWrap.appendChild(phaseSelect);
    jumpWrap.appendChild(roundWrap);
    card.appendChild(jumpWrap);

    const linkPreview = el(
      "div",
      {
        class: "mono small",
        style: "min-height:18px;text-align:center;margin-bottom:6px;opacity:0.85;word-break:break-all;",
      },
      "Jaime link: —"
    );
    card.appendChild(linkPreview);

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

    const jumpState = {
      phase: "coderoom",
      round: 1,
    };

    const refreshRoundVisibility = () => {
      const needsRound = needsRoundSelection(jumpState.phase);
      roundWrap.style.display = needsRound ? "flex" : "none";
      if (!needsRound) {
        jumpState.round = normalizeRound(jumpState.phase, jumpState.round);
        roundSelect.value = String(jumpState.round);
      }
    };

    const updateGuestLinkPreview = () => {
      const code = clampCode(codeInput.value);
      if (!code) {
        currentGuestLink = "";
        linkPreview.textContent = "Jaime link: —";
        copyLinkBtn.disabled = true;
        return;
      }
      currentGuestLink = `${location.origin}${location.pathname}${computeGuestPath(code)}`;
      linkPreview.textContent = `Jaime link: ${currentGuestLink}`;
      copyLinkBtn.disabled = false;
    };

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
        const phaseName = phaseOptions.find((opt) => opt.value === jumpState.phase)?.label || jumpState.phase;
        const roundText = needsRoundSelection(jumpState.phase) ? ` (Round ${jumpState.round})` : "";
        status.textContent = `Press START to jump to ${phaseName}${roundText}.`;
      }
      updateGuestLinkPreview();
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

    phaseSelect.addEventListener("change", (event) => {
      jumpState.phase = event.target.value;
      jumpState.round = normalizeRound(jumpState.phase, jumpState.round);
      roundSelect.value = String(jumpState.round);
      refreshRoundVisibility();
      reflectStartState();
    });

    roundSelect.addEventListener("change", (event) => {
      const value = parseInt(event.target.value || "1", 10) || 1;
      jumpState.round = normalizeRound(jumpState.phase, value);
      roundSelect.value = String(jumpState.round);
      reflectStartState();
    });

    startBtn.addEventListener("click", async () => {
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
        const jump = await applyJumpState({ code, pack, phase: jumpState.phase, round: jumpState.round });
        setStoredRole(code, "host");
        log(`room ${code} prepared → ${jumpState.phase} (round ${jumpState.round}).`);
        status.textContent = "Room ready. Navigating…";
        if (jump?.guestLink) {
          currentGuestLink = jump.guestLink;
          linkPreview.textContent = `Jaime link: ${currentGuestLink}`;
          copyLinkBtn.disabled = false;
        }
        const route = jump?.hostRoute || computeHostRoute(code, jumpState.phase, jumpState.round);
        setTimeout(() => {
          location.hash = route;
        }, 120);
      } catch (err) {
        console.error("[keyroom] start failed", err);
        status.textContent = err?.message || "Failed to start. Please try again.";
        startBtn.disabled = false;
        reflectStartState();
      }
    });

    updateProgress();
    refreshRoundVisibility();
    reflectStartState();
  },

  async unmount() {},
};
