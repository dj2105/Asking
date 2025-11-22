// /src/lib/SinglePlayerBot.js
// Helpers for single-player (Daniel vs bot) flows.
// - Normalises bot config stored on the room document.
// - Provides utilities to seed guest answers/acks when Jaime is automated.

import { doc, updateDoc, serverTimestamp } from "firebase/firestore";
import { db } from "./firebase.js";
import { clampCode } from "./util.js";

export const BOT_UID = "jaime-bot";
const MIN_CORRECTNESS = 0.5;
const MAX_CORRECTNESS = 0.8;
const DEFAULT_STATE = "coderoom";
const START_STATES = ["coderoom", "countdown", "questions", "marking", "award", "maths", "final"];
const BOT_ACTION_DELAY_MS = 30_000;
const guestAnswerTimers = new Map();
const markingTimers = new Map();

const timerKey = (code, round, label) => `${clampCode(code)}:${round}:${label}`;

function clampRound(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1;
  if (n > 5) return 5;
  return Math.round(n);
}

function clampChance(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_CORRECTNESS, Math.max(MIN_CORRECTNESS, n));
}

function clampStartState(raw) {
  const state = typeof raw === "string" && raw.trim()
    ? raw.trim().toLowerCase()
    : DEFAULT_STATE;
  if (START_STATES.includes(state)) return state;
  return DEFAULT_STATE;
}

function randomChance() {
  return Math.random() * (MAX_CORRECTNESS - MIN_CORRECTNESS) + MIN_CORRECTNESS;
}

export function normaliseBotConfig(raw = {}) {
  const enabled = Boolean(raw?.enabled);
  if (!enabled) return { enabled: false };
  const correctChance = clampChance(raw.correctChance) ?? randomChance();
  const startState = clampStartState(raw.startState);
  const startRound = clampRound(raw.startRound);
  const guestUid = typeof raw.guestUid === "string" && raw.guestUid.trim()
    ? raw.guestUid.trim()
    : BOT_UID;
  return { enabled: true, correctChance, startState, startRound, guestUid };
}

export function buildStartOptions() {
  const options = [{ value: "coderoom:1", label: "Code Room (Round 1)" }];
  for (let i = 1; i <= 5; i += 1) {
    options.push({ value: `countdown:${i}`, label: `Countdown — Round ${i}` });
    options.push({ value: `questions:${i}`, label: `Questions — Round ${i}` });
    options.push({ value: `marking:${i}`, label: `Marking — Round ${i}` });
    options.push({ value: `award:${i}`, label: `Award — Round ${i}` });
  }
  options.push({ value: "maths:5", label: "Maths (after Round 5)" });
  options.push({ value: "final:5", label: "Final room" });
  return options;
}

export function parseStartValue(value) {
  const [rawState, rawRound] = String(value || "").split(":");
  const state = clampStartState(rawState);
  const round = clampRound(rawRound);
  return { state, round };
}

export function startHash(code, bot) {
  const cfg = normaliseBotConfig(bot);
  const round = clampRound(cfg.startRound);
  if (cfg.startState === "countdown") return `#/countdown?code=${code}&round=${round}`;
  if (cfg.startState === "questions") return `#/questions?code=${code}&round=${round}`;
  if (cfg.startState === "marking") return `#/marking?code=${code}&round=${round}`;
  if (cfg.startState === "award") return `#/award?code=${code}&round=${round}`;
  if (cfg.startState === "maths") return `#/maths?code=${code}`;
  if (cfg.startState === "final") return `#/final?code=${code}`;
  return `#/coderoom?code=${code}`;
}

function extractOptionText(item = {}, roundNumber) {
  const fallback = roundNumber % 2 === 0 ? "Right" : "Wrong";
  if (typeof item.correct_answer === "string" && item.correct_answer.trim()) return item.correct_answer.trim();
  return fallback;
}

function pickWrongOption(item = {}, roundNumber) {
  const distractors = item.distractors || {};
  const opts = [distractors.hard, distractors.medium, distractors.easy];
  const pick = opts.find((entry) => typeof entry === "string" && entry.trim());
  if (pick) return pick.trim();
  return roundNumber % 2 === 0 ? "Wrong" : "Right";
}

export async function ensureBotGuestAnswers({ code, round, roomData, roundData }) {
  const bot = normaliseBotConfig(roomData?.bot);
  if (!bot.enabled) return null;
  const answersMap = roomData?.answers || {};
  const existing = (answersMap.guest || {})[round];
  if (Array.isArray(existing) && existing.length >= 3) return null;

  const guestItems = Array.isArray(roundData?.guestItems) ? roundData.guestItems.slice(0, 3) : [];
  if (!guestItems.length) return null;

  const payload = guestItems.map((item, idx) => {
    const correctText = extractOptionText(item, round);
    const wrongText = pickWrongOption(item, round);
    const chooseCorrect = Math.random() <= bot.correctChance;
    return {
      question: typeof item.question === "string" && item.question.trim() ? item.question.trim() : `Question ${idx + 1}`,
      chosen: chooseCorrect ? correctText : wrongText,
      correct: correctText,
    };
  });

  const key = timerKey(code, round, "answers");
  if (guestAnswerTimers.has(key)) return null;

  const rRef = doc(db, "rooms", clampCode(code));
  const timer = setTimeout(async () => {
    try {
      await updateDoc(rRef, {
        [`answers.guest.${round}`]: payload,
        [`submitted.guest.${round}`]: true,
        "links.guestReady": true,
        [`markingReady.guest.${round}`]: true,
        "timestamps.updatedAt": serverTimestamp(),
      });
    } catch (err) {
      console.warn("[bot] failed to seed guest answers", err);
    } finally {
      guestAnswerTimers.delete(key);
    }
  }, BOT_ACTION_DELAY_MS);
  guestAnswerTimers.set(key, timer);
  return null;
}

export async function ensureBotMarking({ code, round, roomData, roundData }) {
  const bot = normaliseBotConfig(roomData?.bot);
  if (!bot.enabled) return null;
  const existing = (((roomData?.marking || {}).guest || {})[round]) || [];
  if (Array.isArray(existing) && existing.length >= 3) return existing;

  const hostAnswers = (((roomData?.answers || {}).host || {})[round]) || [];
  if (!hostAnswers.length) return null;

  const hostItems = Array.isArray(roundData?.hostItems) ? roundData.hostItems.slice(0, 3) : [];
  const marks = hostAnswers.map((entry, idx) => {
    const ans = entry || {};
    const item = hostItems[idx] || {};
    const correctText = extractOptionText(item, round);
    const isRight = ans.chosen && ans.chosen === (ans.correct || correctText);
    return isRight ? "right" : "wrong";
  });

  const mathsYear = Number(roomData?.maths?.events?.[round - 1]?.year);
  const guessedYear = Number.isInteger(mathsYear) ? mathsYear : 2000 + round;

  const key = timerKey(code, round, "marking");
  if (markingTimers.has(key)) return marks;

  const rRef = doc(db, "rooms", clampCode(code));
  const timer = setTimeout(async () => {
    try {
      await updateDoc(rRef, {
        [`marking.guest.${round}`]: marks,
        [`markingAck.guest.${round}`]: true,
        [`mathsGuesses.guest.${round}`]: guessedYear,
        [`timings.guest.${round}`]: { totalSeconds: 0 },
        "timestamps.updatedAt": serverTimestamp(),
      });
    } catch (err) {
      console.warn("[bot] failed to mark host answers", err);
    } finally {
      markingTimers.delete(key);
    }
  }, BOT_ACTION_DELAY_MS);
  markingTimers.set(key, timer);
  return marks;
}

export async function ensureBotAwardAck({ code, round, roomData }) {
  const bot = normaliseBotConfig(roomData?.bot);
  if (!bot.enabled) return false;
  const ack = (((roomData?.awardAck || {}).guest || {})[round]);
  if (ack) return false;
  const rRef = doc(db, "rooms", clampCode(code));
  try {
    await updateDoc(rRef, {
      [`awardAck.guest.${round}`]: true,
      "timestamps.updatedAt": serverTimestamp(),
    });
    return true;
  } catch (err) {
    console.warn("[bot] failed to ack award", err);
    return false;
  }
}

export async function ensureBotCountdown(code, roomData, round) {
  const bot = normaliseBotConfig(roomData?.bot);
  if (!bot.enabled) return false;
  const startAt = Number(roomData?.countdown?.startAt) || 0;
  const state = String(roomData?.state || "").toLowerCase();
  const needsCountdown = (state === "coderoom" || state === "countdown") && !startAt;
  if (!needsCountdown) return false;
  const rRef = doc(db, "rooms", clampCode(code));
  try {
    await updateDoc(rRef, {
      state: "countdown",
      round,
      "countdown.startAt": Date.now() + 3_000,
      "links.guestReady": true,
      "timestamps.updatedAt": serverTimestamp(),
    });
    return true;
  } catch (err) {
    console.warn("[bot] failed to arm countdown", err);
    return false;
  }
}

export async function ensureBotMaths({ code, roomData }) {
  const bot = normaliseBotConfig(roomData?.bot);
  if (!bot.enabled) return null;
  const existing = roomData?.mathsAnswers?.guest;
  if (existing && Array.isArray(existing.events)) return existing;

  const events = Array.isArray(roomData?.maths?.events)
    ? roomData.maths.events
    : [];
  const targetTotal = Number.isInteger(roomData?.maths?.total)
    ? roomData.maths.total
    : events.reduce((sum, evt) => sum + (Number.isInteger(evt?.year) ? evt.year : 0), 0);

  const chooseCorrect = Math.random() <= bot.correctChance;
  const guessEvents = events.length
    ? events.map((evt) => {
        const baseYear = Number.isInteger(evt?.year) ? evt.year : 1;
        if (chooseCorrect) return baseYear;
        const jitter = 1 + Math.floor(Math.random() * 15);
        return Math.max(1, baseYear + (Math.random() < 0.5 ? -jitter : jitter));
      })
    : [1000, 1100, 1200, 1300, 1400];
  const guessTotal = guessEvents.reduce((sum, year) => sum + year, 0);
  const payload = { events: guessEvents, total: guessTotal || targetTotal || 0 };

  const rRef = doc(db, "rooms", clampCode(code));
  try {
    await updateDoc(rRef, {
      "mathsAnswers.guest": payload,
      "mathsAnswersAck.guest": true,
      "timestamps.updatedAt": serverTimestamp(),
    });
    return payload;
  } catch (err) {
    console.warn("[bot] failed to write maths answer", err);
    return null;
  }
}

export function hasBot(roomData = {}) {
  return normaliseBotConfig(roomData.bot).enabled;
}
