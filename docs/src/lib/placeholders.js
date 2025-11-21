export const PLACEHOLDER = "<empty>";

const FALLBACK_QUESTION_PACK_PATHS = [
  "../../packs/out/DOI-questions.json",
  "../../packs/out/FKH-questions.json",
  "../../packs/out/HBR-questions.json",
];

const FALLBACK_MATHS_PACK_PATHS = [
  "../../packs/out/DOI-maths.json",
  "../../packs/out/FKH-maths.json",
  "../../packs/out/HBR-maths.json",
];

const FALLBACK_SUBJECT = "General Knowledge";
const FALLBACK_DIFFICULTY = "medium";

let fallbackQuestionPoolPromise = null;
let fallbackMathsOptionsPromise = null;

function sameNormalized(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function resolveStaticUrl(relativePath) {
  try {
    return new URL(relativePath, import.meta.url).href;
  } catch (_err) {
    return null;
  }
}

async function fetchJsonMaybe(relativePath) {
  const url = resolveStaticUrl(relativePath);
  if (!url) return null;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn("[placeholders] failed to fetch", relativePath, err);
    return null;
  }
}

function normalizeFallbackOptions(options = []) {
  return options
    .map((opt) => (typeof opt === "string" ? opt.trim() : typeof opt === "number" ? String(opt) : ""))
    .filter((opt) => opt);
}

function resolveCorrectIndex(raw = {}, options = []) {
  const tryIndexFromValue = (value) => {
    if (value == null) return null;
    const str = String(value).trim();
    if (!str) return null;
    const first = str[0]?.toUpperCase();
    if (first && first >= "A" && first <= "Z") {
      const idx = first.charCodeAt(0) - 65;
      if (idx >= 0 && idx < options.length) return idx;
    }
    const asNumber = Number(str);
    if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= options.length) {
      return asNumber - 1;
    }
    const matchIdx = options.findIndex((opt) => sameNormalized(opt, str));
    return matchIdx >= 0 ? matchIdx : null;
  };

  const direct = tryIndexFromValue(raw.correct);
  if (direct !== null) return direct;
  if (Array.isArray(raw.correct)) {
    for (const entry of raw.correct) {
      const idx = tryIndexFromValue(entry);
      if (idx !== null) return idx;
    }
  }
  if (typeof raw.answer === "string") {
    const idx = options.findIndex((opt) => sameNormalized(opt, raw.answer));
    if (idx >= 0) return idx;
  }
  if (typeof raw.correctIndex === "number" && raw.correctIndex >= 0 && raw.correctIndex < options.length) {
    return raw.correctIndex;
  }
  return 0;
}

function convertFallbackQuestionItem(raw = {}) {
  const question =
    typeof raw.question === "string" && raw.question.trim()
      ? raw.question.trim()
      : typeof raw.prompt === "string" && raw.prompt.trim()
      ? raw.prompt.trim()
      : "";
  const options = normalizeFallbackOptions(raw.options);
  if (!question || options.length < 2) return null;
  const correctIndex = resolveCorrectIndex(raw, options);
  const correctText = options[correctIndex] || options[0] || PLACEHOLDER;
  const wrongCandidates = options.filter((_, idx) => idx !== correctIndex);
  const wrongPrimary = wrongCandidates[0] || (correctText ? `${correctText} (wrong)` : PLACEHOLDER);
  const wrongSecondary = wrongCandidates[1] || wrongPrimary;
  const subject =
    typeof raw.subject === "string" && raw.subject.trim()
      ? raw.subject.trim()
      : typeof raw.category === "string" && raw.category.trim()
      ? raw.category.trim()
      : FALLBACK_SUBJECT;
  const difficulty =
    typeof raw.difficulty === "string" && raw.difficulty.trim()
      ? raw.difficulty.trim()
      : typeof raw.tier === "string" && raw.tier.trim()
      ? raw.tier.trim()
      : typeof raw.difficulty_tier === "string" && raw.difficulty_tier.trim()
      ? raw.difficulty_tier.trim()
      : FALLBACK_DIFFICULTY;

  return {
    subject,
    difficulty_tier: difficulty,
    question,
    correct_answer: correctText || PLACEHOLDER,
    distractors: {
      easy: wrongPrimary || PLACEHOLDER,
      medium: wrongSecondary || wrongPrimary || PLACEHOLDER,
      hard: wrongSecondary || wrongPrimary || PLACEHOLDER,
    },
  };
}

function convertFallbackQuestionPack(raw = {}) {
  const rounds = {};
  for (let i = 1; i <= 5; i += 1) {
    rounds[i] = { hostItems: [], guestItems: [] };
  }
  const sourceRounds = raw?.rounds || {};
  Object.entries(sourceRounds).forEach(([key, value]) => {
    const roundNum = Number.parseInt(key, 10);
    if (!Number.isInteger(roundNum) || roundNum < 1 || roundNum > 5) return;
    const hostItems = Array.isArray(value?.hostItems) ? value.hostItems : [];
    const guestItems = Array.isArray(value?.guestItems) ? value.guestItems : [];
    hostItems.forEach((item) => {
      const converted = convertFallbackQuestionItem(item);
      if (converted) rounds[roundNum].hostItems.push(converted);
    });
    guestItems.forEach((item) => {
      const converted = convertFallbackQuestionItem(item);
      if (converted) rounds[roundNum].guestItems.push(converted);
    });
  });
  return rounds;
}

function makeEmptyRolePool() {
  const perRound = {};
  for (let i = 1; i <= 5; i += 1) perRound[i] = [];
  return { perRound, all: [] };
}

function shuffleInPlace(list) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

export async function loadFallbackQuestionPool() {
  if (!fallbackQuestionPoolPromise) {
    fallbackQuestionPoolPromise = (async () => {
      const pool = { host: makeEmptyRolePool(), guest: makeEmptyRolePool() };
      const seen = { host: new Set(), guest: new Set() };
      for (const path of FALLBACK_QUESTION_PACK_PATHS) {
        const json = await fetchJsonMaybe(path);
        if (!json) continue;
        const converted = convertFallbackQuestionPack(json);
        for (let round = 1; round <= 5; round += 1) {
          const hostItems = converted[round]?.hostItems || [];
          const guestItems = converted[round]?.guestItems || [];
          hostItems.forEach((item) => {
            const key = `${round}|host|${item.question}|${item.correct_answer}`;
            if (seen.host.has(key)) return;
            seen.host.add(key);
            pool.host.perRound[round].push(item);
            pool.host.all.push(item);
          });
          guestItems.forEach((item) => {
            const key = `${round}|guest|${item.question}|${item.correct_answer}`;
            if (seen.guest.has(key)) return;
            seen.guest.add(key);
            pool.guest.perRound[round].push(item);
            pool.guest.all.push(item);
          });
        }
      }
      return pool;
    })();
  }
  return fallbackQuestionPoolPromise;
}

export function drawFallbackItems(pool, role, round, count) {
  const rolePool = pool?.[role];
  if (!rolePool) return [];
  const roundItems = Array.isArray(rolePool.perRound?.[round]) ? rolePool.perRound[round] : [];
  const combined = [...roundItems];
  rolePool.all.forEach((item) => {
    if (!combined.includes(item)) combined.push(item);
  });
  if (!combined.length) return [];
  const shuffled = shuffleInPlace([...combined]);
  const selected = [];
  while (shuffled.length && selected.length < count) {
    const next = shuffled.shift();
    selected.push(clone(next));
  }
  return selected;
}

export async function loadFallbackMathsOptions() {
  if (!fallbackMathsOptionsPromise) {
    fallbackMathsOptionsPromise = (async () => {
      const options = [];
      for (const path of FALLBACK_MATHS_PACK_PATHS) {
        const json = await fetchJsonMaybe(path);
        const maths = json?.maths;
        if (maths && typeof maths === "object") {
          options.push(clone(maths));
        }
      }
      return options;
    })();
  }
  return fallbackMathsOptionsPromise;
}

export async function pickFallbackMaths() {
  const options = await loadFallbackMathsOptions();
  if (!Array.isArray(options) || options.length === 0) return null;
  const idx = Math.floor(Math.random() * options.length);
  return clone(options[idx]);
}

export function clone(value) {
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

export function padItems(list = []) {
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

function normalizeMaths(maths = null) {
  const src = maths && typeof maths === "object" ? maths : {};
  const rawEvents = Array.isArray(src.events) ? src.events.slice(0, 5) : [];
  const events = rawEvents.map((evt, idx) => {
    const prompt = typeof evt?.prompt === "string" && evt.prompt.trim() ? evt.prompt.trim() : PLACEHOLDER;
    const year = Number.isInteger(evt?.year) ? evt.year : 0;
    return { prompt, year, order: idx + 1 };
  });
  while (events.length < 5) {
    events.push({ prompt: PLACEHOLDER, year: 0, order: events.length + 1 });
  }

  const clues = events.map((evt) => evt.prompt);
  const reveals = Array.isArray(src.reveals)
    ? src.reveals.slice(0, 5).map((reveal, idx) =>
        typeof reveal === "string" && reveal.trim()
          ? reveal.trim()
          : typeof reveal === "object" && reveal?.prompt
          ? String(reveal.prompt).trim()
          : clues[idx]
      )
    : clues;

  const question =
    typeof src.question === "string" && src.question.trim()
      ? src.question.trim()
      : "Enter the year for each event (1–4 digits).";
  const totalFromEvents = events.reduce((sum, evt) => sum + (Number.isInteger(evt.year) ? evt.year : 0), 0);
  const total = Number.isInteger(src.total) ? src.total : totalFromEvents;
  const answer = Number.isInteger(src.answer) ? src.answer : total;

  const scoring = src.scoring && typeof src.scoring === "object" ? { ...src.scoring } : {};
  if (!Number.isInteger(scoring.sharpshooterMargin)) scoring.sharpshooterMargin = Math.round(total * 0.02);
  if (!Number.isInteger(scoring.ballparkMargin)) scoring.ballparkMargin = Math.round(total * 0.05);
  if (!Number.isInteger(scoring.perfectPoints)) scoring.perfectPoints = 5;
  if (!Number.isInteger(scoring.sharpshooterPoints)) scoring.sharpshooterPoints = 3;
  if (!Number.isInteger(scoring.ballparkPoints)) scoring.ballparkPoints = 2;
  if (!Number.isInteger(scoring.safetyNetPoints)) scoring.safetyNetPoints = 1;
  if (!Number.isFinite(scoring.sharpshooterPercent)) scoring.sharpshooterPercent = 0.02;
  if (!Number.isFinite(scoring.ballparkPercent)) scoring.ballparkPercent = 0.05;
  scoring.targetTotal = Number.isInteger(scoring.targetTotal) ? scoring.targetTotal : total;

  return { clues, reveals, question, answer, total, events, scoring };
}

export async function buildPlaceholderRounds() {
  const pool = await loadFallbackQuestionPool();
  const rounds = [];
  for (let round = 1; round <= 5; round += 1) {
    const hostItems = padItems(drawFallbackItems(pool, "host", round, 3));
    const guestItems = padItems(drawFallbackItems(pool, "guest", round, 3));
    rounds.push({ round, hostItems, guestItems });
  }
  return rounds;
}

export async function buildPlaceholderMaths() {
  const maths = await pickFallbackMaths();
  return normalizeMaths(maths);
}

export { normalizeMaths };
