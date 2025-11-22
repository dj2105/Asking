// /src/lib/localPackStore.js
// Loads local pack JSON files from docs/packs and manages lifecycle.

const READY_QUESTION_MODULES = import.meta.glob("../../packs/ready/*-questions.json", { eager: true });
const READY_MATHS_MODULES = import.meta.glob("../../packs/ready/*-maths.json", { eager: true });
const PLACEHOLDER_QUESTION_MODULES = import.meta.glob("../../packs/placeholder/*-questions.json", { eager: true });
const PLACEHOLDER_MATHS_MODULES = import.meta.glob("../../packs/placeholder/*-maths.json", { eager: true });

const STORAGE_KEY = "jemima.usedReadyPacks";

function normaliseModule(mod) {
  if (!mod) return null;
  if (mod.default) return mod.default;
  return mod;
}

function deriveId(path) {
  try {
    const leaf = path.split("/").pop();
    return leaf ? leaf.replace(/\.json$/i, "") : path;
  } catch (_err) {
    return path;
  }
}

function buildPackList(modules, kind) {
  return Object.entries(modules).map(([path, mod]) => {
    const data = normaliseModule(mod) || {};
    const id = deriveId(path);
    const notes = typeof data.notes === "string" && data.notes.trim() ? data.notes.trim() : undefined;
    return { id, data, kind, notes, origin: "local" };
  });
}

const readyCache = {
  questions: buildPackList(READY_QUESTION_MODULES, "questions"),
  maths: buildPackList(READY_MATHS_MODULES, "maths"),
};

const placeholderCache = {
  questions: buildPackList(PLACEHOLDER_QUESTION_MODULES, "questions"),
  maths: buildPackList(PLACEHOLDER_MATHS_MODULES, "maths"),
};

function hasStorage() {
  return typeof localStorage !== "undefined";
}

function loadUsed() {
  if (!hasStorage()) return { questions: [], maths: [] };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { questions: [], maths: [] };
    const parsed = JSON.parse(raw);
    return {
      questions: Array.isArray(parsed.questions) ? parsed.questions : [],
      maths: Array.isArray(parsed.maths) ? parsed.maths : [],
    };
  } catch (_err) {
    return { questions: [], maths: [] };
  }
}

function persistUsed(used) {
  if (!hasStorage()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(used));
  } catch (_err) {
    // ignore storage failures (private mode)
  }
}

function getAvailableReady(kind) {
  const used = loadUsed();
  const usedSet = new Set(kind === "maths" ? used.maths : used.questions);
  return readyCache[kind].filter((pack) => !usedSet.has(pack.id));
}

export function listReadyPacks(kind) {
  return getAvailableReady(kind);
}

export function listPlaceholderPacks(kind) {
  return placeholderCache[kind];
}

export function findReadyPack(kind, id) {
  return getAvailableReady(kind).find((pack) => pack.id === id) || null;
}

export function pickRandomReady(kind) {
  const available = getAvailableReady(kind);
  if (!available.length) return null;
  const idx = Math.floor(Math.random() * available.length);
  return available[idx];
}

export function markReadyPackUsed(kind, id) {
  const pack = readyCache[kind].find((entry) => entry.id === id);
  if (!pack) return null;
  const used = loadUsed();
  const target = kind === "maths" ? used.maths : used.questions;
  if (!target.includes(id)) target.push(id);
  persistUsed(used);
  if (!placeholderCache[kind].some((entry) => entry.id === id)) {
    placeholderCache[kind].push(pack);
  }
  return pack;
}

export function pickRandomPlaceholder(kind) {
  const pool = placeholderCache[kind];
  if (!Array.isArray(pool) || !pool.length) return null;
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx];
}

export function resetUsedForTests() {
  persistUsed({ questions: [], maths: [] });
}
