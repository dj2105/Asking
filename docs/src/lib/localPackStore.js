// /src/lib/localPackStore.js
// Loads local pack JSON files from docs/packs and manages lifecycle.

const STORAGE_KEY = "jemima.usedReadyPacks";

const DEFAULT_MANIFEST = {
  ready: {
    questions: ["PRX-questions.json"],
    maths: ["PRX-maths.json"],
  },
  placeholder: {
    questions: ["LUM-questions.json", "MRT-questions.json"],
    maths: ["LUM-maths.json", "MRT-maths.json"],
  },
};

const readyCache = {
  questions: [],
  maths: [],
};

const placeholderCache = {
  questions: [],
  maths: [],
};

let loadPromise = null;

function deriveId(path) {
  try {
    const leaf = path.split("/").pop();
    return leaf ? leaf.replace(/\.json$/i, "") : path;
  } catch (_err) {
    return path;
  }
}

function buildEntry(kind, id, data) {
  if (!data) return null;
  const notes = typeof data.notes === "string" && data.notes.trim() ? data.notes.trim() : undefined;
  return { id, data, kind, notes, origin: "local" };
}

async function fetchJson(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch (_err) {
    return null;
  }
}

async function loadManifest() {
  const manifestUrl = new URL("../../packs/manifest.json", import.meta.url);
  const manifest = await fetchJson(manifestUrl);
  if (!manifest || typeof manifest !== "object") return DEFAULT_MANIFEST;
  const toList = (value) => (Array.isArray(value) ? value : []);
  return {
    ready: {
      questions: toList(manifest.ready?.questions),
      maths: toList(manifest.ready?.maths),
    },
    placeholder: {
      questions: toList(manifest.placeholder?.questions),
      maths: toList(manifest.placeholder?.maths),
    },
  };
}

async function loadPacks() {
  const manifest = await loadManifest();

  const buckets = [
    { cache: readyCache, entries: manifest.ready, folder: "ready" },
    { cache: placeholderCache, entries: manifest.placeholder, folder: "placeholder" },
  ];

  await Promise.all(
    buckets.map(async ({ cache, entries, folder }) => {
      const { questions = [], maths = [] } = entries || {};
      cache.questions = [];
      cache.maths = [];

      const loadOne = async (file, kind) => {
        const url = new URL(`../../packs/${folder}/${file}`, import.meta.url);
        const data = await fetchJson(url);
        const entry = buildEntry(kind, deriveId(file), data);
        if (entry) cache[kind].push(entry);
      };

      await Promise.all([
        ...questions.map((file) => loadOne(file, "questions")),
        ...maths.map((file) => loadOne(file, "maths")),
      ]);
    })
  );
}

export async function ensureLocalPackCache() {
  if (!loadPromise) {
    loadPromise = loadPacks();
  }
  await loadPromise;
}

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
