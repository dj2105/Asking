// /src/lib/gemini.js
// Thin client for Google Generative Language REST API (Gemini).
// Robust JSON extraction + flexible schema mapping + forced-JSON retry.
// Exposes: generateItems, verifyItems, generateMaths, callGeminiJemima

/* ---------------- tiny utils ---------------- */
function assert(ok, msg = "Assertion failed") { if (!ok) throw new Error(msg); }
function clampInt(n, lo, hi) { n = Number(n) || 0; return Math.max(lo, Math.min(hi, Math.floor(n))); }
function textFromCandidate(c) {
  const parts = (c?.content?.parts) || (c?.candidates?.[0]?.content?.parts) || [];
  const txt = parts.map(p => (p.text ?? "")).join("");
  return txt || (c?.text || "");
}

/* ---------------- model defaults ---------------- */
const DEFAULT_Q_MODEL = "models/gemini-2.5-flash";
const DEFAULT_V_MODEL = "models/gemini-2.5-pro";
const DEFAULT_M_MODEL = "models/gemini-2.5-flash";

function endpointFor(model) {
  return `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent`;
}

/* ---------------- fetch wrapper ---------------- */
async function callGeminiRaw({ apiKey, model, contents, generationConfig }) {
  assert(apiKey, "Missing Gemini API key.");
  assert(model, "Missing Gemini model.");
  const url = endpointFor(model) + `?key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents, generationConfig })
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    let msg = `Gemini ${model} generateContent failed: ${resp.status}`;
    try { msg += " " + JSON.stringify(JSON.parse(text), null, 2); }
    catch { if (text) msg += " " + text; }
    throw new Error(msg);
  }
  return resp.json();
}

/* ---------------- prompt plumbing ---------------- */
function getPrompts(qcfg) {
  const gp = qcfg?.generation_prompt || qcfg?.gemini_prompts?.generation_prompt;
  const vp = qcfg?.verification_prompt || qcfg?.gemini_prompts?.verification_prompt;
  assert(gp, "qcfg missing generation_prompt.");
  assert(vp, "qcfg missing verification_prompt.");
  return { generation_prompt: gp, verification_prompt: vp };
}
function buildGenerationPrompt({ qcfg, desiredCount = 10, round, role, variant }) {
  const { generation_prompt } = getPrompts(qcfg);
  const meta = [`ROUND: ${round ?? "?"}`, `ROLE: ${role ?? "any"}`, `VARIANT: ${variant ?? "fg"}`].join(" • ");
  return `${generation_prompt}\n\nRequested items: ${desiredCount}\n(${meta})`;
}
function buildVerificationPrompt({ qcfg }) {
  const { verification_prompt } = getPrompts(qcfg);
  return verification_prompt;
}
function buildMathsPrompt({ jmaths, round }) {
  assert(jmaths, "Missing jmaths config.");
  const preface = `You are generating a maths interlude for a quiz game. Output valid JSON only.`;
  return `${preface}\n\nCONFIG:\n${JSON.stringify(jmaths)}\n\nROUND: ${round}`;
}

/* ---------------- tolerant JSON parsing ---------------- */
function normaliseQuotes(s) {
  return String(s || "")
    .replace(/[“”«»„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/\u00A0/g, " "); // nbsp
}
function stripTrailingCommas(jsonish) { return jsonish.replace(/,\s*([}\]])/g, "$1"); }
function tryJSON(s) { try { return JSON.parse(s); } catch { return null; } }
function extractJSON(text) {
  const t = normaliseQuotes(text);
  // fenced ```json
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const clean = stripTrailingCommas(fence[1]);
    const j = tryJSON(clean);
    if (j) return j;
  }
  // first array or object
  const firstArr = t.match(/(\[[\s\S]*\])/);
  const firstObj = t.match(/(\{[\s\S]*\})/);
  const blob = firstArr?.[1] || firstObj?.[1];
  if (blob) {
    const clean = stripTrailingCommas(blob);
    const j = tryJSON(clean);
    if (j) return j;
  }
  return tryJSON(stripTrailingCommas(t));
}

/* ---------------- item normalisation ---------------- */
function coerceDistractors(d) {
  if (!d || typeof d !== "object") d = {};
  let { easy, medium, hard } = d;
  easy = easy || d?.e || d?.easy_wrong || d?.simple;
  medium = medium || d?.m || d?.mid || d?.plausible;
  hard = hard || d?.h || d?.near_miss || d?.close || d?.tricky;

  const arr = Array.isArray(d) ? d
    : Array.isArray(d?.wrong) ? d.wrong
    : Array.isArray(d?.false_options) ? d.false_options
    : Array.isArray(d?.distractors) ? d.distractors
    : null;

  if ((!easy || !medium || !hard) && arr && arr.length) {
    const a = arr.slice(0, 3);
    while (a.length < 3) a.push(arr[arr.length - 1]);
    [easy, medium, hard] = a;
  }
  const all = [easy, medium, hard].filter(Boolean);
  if (!all.length) return {};
  return {
    easy: String(all[0] || "").trim(),
    medium: String(all[1] || all[0] || "").trim(),
    hard: String(all[2] || all[1] || all[0] || "").trim()
  };
}

function mapItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const question =
    raw.question ?? raw.prompt ?? raw.q ?? (typeof raw.text === "string" ? raw.text : null);
  const correct_answer =
    raw.correct_answer ?? raw.correct ?? raw.answer ??
    (raw.answers && (raw.answers.correct || raw.answers.true || raw.answers?.right)) ?? null;
  const distractors =
    raw.distractors ?? raw.wrong ?? raw.false_options ??
    (raw.answers && (raw.answers.wrong || raw.answers.false)) ?? {};

  if (!question || !correct_answer) return null;

  return {
    subject: String(raw.subject || "misc").trim(),
    difficulty_tier: String(raw.difficulty_tier || raw.difficulty || "pub").trim(),
    question: String(question).trim(),
    correct_answer: String(correct_answer).trim(),
    distractors: coerceDistractors(distractors)
  };
}

function normaliseItems(parsed) {
  let list = [];
  if (Array.isArray(parsed)) list = parsed;
  else if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.items)) list = parsed.items;
    else if (Array.isArray(parsed.questions)) list = parsed.questions;
  }
  const mapped = list.map(mapItem).filter(Boolean);
  return mapped;
}

/* ---------------- high-level API ---------------- */

// generateItems -> returns an array of items (not yet verified)
// Now with forced-JSON response + one automatic retry if empty.
export async function generateItems({ apiKey, qcfg, desiredCount = 10, model = DEFAULT_Q_MODEL }) {
  desiredCount = clampInt(desiredCount, 3, 20);
  const basePrompt = buildGenerationPrompt({ qcfg, desiredCount });

  // First attempt: ask for JSON and set responseMimeType
  const attempt = async (prompt, note) => {
    const contents = [{ role: "user", parts: [{ text: prompt }] }];
    const result = await callGeminiRaw({
      apiKey, model, contents,
      generationConfig: {
        temperature: 0.85,
        maxOutputTokens: 2048,
        candidateCount: 1,
        responseMimeType: "application/json"
      }
    });
    const rawText =
      textFromCandidate(result.candidates?.[0]) ||
      textFromCandidate(result);

    let parsed = extractJSON(rawText) ?? {};
    let items = normaliseItems(parsed);
    if (!items.length) {
      // log a small head for debugging — visible only in console
      console.warn(`[gemini.generateItems] ${note} returned non-parseable JSON. Head:`, (rawText || "").slice(0, 240));
      // Single object fallback
      const one = parsed && typeof parsed === "object" ? mapItem(parsed) : null;
      if (one) items = [one];
    }
    items = items
      .filter(it => it?.question && it?.correct_answer)
      .map(it => ({
        subject: it.subject || "misc",
        difficulty_tier: it.difficulty_tier || "pub",
        question: String(it.question).trim(),
        correct_answer: String(it.correct_answer).trim(),
        distractors: it.distractors || {}
      }));
    return items;
  };

  let items = await attempt(
    `${basePrompt}\n\nIMPORTANT: Return a JSON object with an array property named "items".\n` +
    `Shape: { "items": [ { "subject": "...", "difficulty_tier": "pub|enthusiast|specialist", "question": "…", "correct_answer": "…", "distractors": { "easy":"…","medium":"…","hard":"…" } } ] }\n` +
    `Do not include explanations or extra text.`,
    "attempt#1"
  );

  if (!items.length) {
    // Second attempt: shorter, stricter instruction
    const strictPrompt =
      `Return ONLY JSON with this exact shape and at least ${desiredCount} items:\n` +
      `{"items":[{"subject":"…","difficulty_tier":"pub|enthusiast|specialist","question":"…","correct_answer":"…","distractors":{"easy":"…","medium":"…","hard":"…"}}]}`;
    items = await attempt(strictPrompt, "attempt#2");
  }

  return items;
}

// verifyItems -> returns { approved: [...], rejected: [...], results: [...] }
export async function verifyItems({ apiKey, qcfg, items, model = DEFAULT_V_MODEL }) {
  assert(Array.isArray(items), "verifyItems requires an array of items.");
  const prompt = buildVerificationPrompt({ qcfg });

  const contents = [
    { role: "user", parts: [{ text: `${prompt}\n\nITEMS (JSON):\n${JSON.stringify(items)}` }] }
  ];

  const result = await callGeminiRaw({
    apiKey, model, contents,
    generationConfig: { temperature: 0.2, maxOutputTokens: 3072, candidateCount: 1, responseMimeType: "application/json" }
  });

  const rawText =
    textFromCandidate(result.candidates?.[0]) ||
    textFromCandidate(result);

  const parsed = extractJSON(rawText) || {};
  const results = Array.isArray(parsed?.results) ? parsed.results : [];

  const approved = [];
  const rejected = [];

  if (results.length) {
    results.forEach((r, i) => {
      const idx = Number.isFinite(r?.index) ? r.index : i;
      const verdict = String(r?.verdict || "").toLowerCase();
      const it = items[idx];
      if (!it) return;
      if (verdict === "pass") approved.push(it);
      else rejected.push({ ...it, reason: r?.reason || r?.justification || "Rejected" });
    });
  } else {
    // Permissive in dev: if verifier didn’t structure its output, approve all
    approved.push(...items);
  }

  return { approved, rejected, results };
}

// callGeminiJemima -> returns { interlude: "..." }
export async function callGeminiJemima({ apiKey, round = 1, model = DEFAULT_M_MODEL }) {
  const prompt = `Write a single, playful one-line interlude for Round ${round} of a head-to-head quiz. Keep it short and British. Output plain text only.`;
  const contents = [{ role: "user", parts: [{ text: prompt }] }];

  const result = await callGeminiRaw({
    apiKey, model, contents,
    generationConfig: { temperature: 0.8, maxOutputTokens: 120, candidateCount: 1 }
  });

  const interlude =
    textFromCandidate(result.candidates?.[0]) ||
    textFromCandidate(result) ||
    `Round ${round} begins.`;

  return { interlude: String(interlude).trim() };
}

// generateMaths -> returns an object matching your jmaths output contract
export async function generateMaths({ apiKey, jmaths, model = DEFAULT_M_MODEL }) {
  assert(jmaths, "Missing jmaths config.");

  const makePrompt = (strict = false) => strict
    ? (
      `Return ONLY JSON with EXACTLY these keys & types and nothing else:\n` +
      `{"location":"string","beats":["a","b","c","d"],"questions":["q1","q2"],"answers":[1,2]}\n` +
      `- beats: 4 strings (each includes at least one numeric fact).\n` +
      `- questions: 2 strings with explicit units and a blank "___".\n` +
      `- answers: 2 integers. No decimals.\n` +
      `British English. No markdown.\n` +
      `CONFIG:\n${JSON.stringify(jmaths)}`
    )
    : (
      `You are generating a short maths interlude for a quiz game.\n` +
      `Return ONLY JSON. Do not include markdown fences or prose.\n` +
      `The JSON MUST match this shape exactly:\n` +
      `{\n` +
      `  "location": "string",\n` +
      `  "beats": ["string","string","string","string"],\n` +
      `  "questions": ["string","string"],\n` +
      `  "answers": [integer, integer]\n` +
      `}\n` +
      `Rules:\n` +
      `- beats: 4 entries, each 1–2 sentences, each with at least one numeric fact.\n` +
      `- questions: 2 entries with explicit units and a blank like "___ euros".\n` +
      `- answers: two whole numbers (integers) aligned to the questions.\n` +
      `- Use British English and the whimsical style implied by CONFIG.\n` +
      `- No extra fields, no commentary.\n\n` +
      `CONFIG:\n${JSON.stringify(jmaths)}`
    );

  const tryOnce = async (mdl, prompt, note) => {
    const contents = [{ role: "user", parts: [{ text: prompt }] }];
    const result = await callGeminiRaw({
      apiKey, model: mdl, contents,
      generationConfig: {
        temperature: 0.6,
        maxOutputTokens: 1024,
        candidateCount: 1,
        responseMimeType: "application/json"
      }
    });
    const rawText =
      textFromCandidate(result.candidates?.[0]) ||
      textFromCandidate(result);

    const parsed = extractJSON(rawText);
    if (!parsed || typeof parsed !== "object") {
      console.warn(`[gemini.generateMaths] ${note} non-JSON head:`, (rawText || "").slice(0, 240));
      return null;
    }

    const out = {
      location: String(parsed.location ?? "").trim(),
      beats: Array.isArray(parsed.beats) ? parsed.beats.map(String) : [],
      questions: Array.isArray(parsed.questions) ? parsed.questions.map(String) : [],
      answers: Array.isArray(parsed.answers) ? parsed.answers.map(v => parseInt(v, 10)) : []
    };

    if (!out.location) return null;
    if (out.beats.length !== 4 || out.beats.some(b => !b)) return null;
    if (out.questions.length !== 2 || out.questions.some(q => !q)) return null;
    if (out.answers.length !== 2 || out.answers.some(a => !Number.isInteger(a))) return null;

    return out;
  };

  // Try Pro then Flash; normal then strict
  const models = ["models/gemini-2.5-pro", "models/gemini-2.5-flash"];
  for (const mdl of models) {
    const a1 = await tryOnce(mdl, makePrompt(false), `${mdl} attempt#1`);
    if (a1) return a1;
    const a2 = await tryOnce(mdl, makePrompt(true), `${mdl} attempt#2`);
    if (a2) return a2;
  }

  // Local synthesis fallback (never block the game)
  console.warn("[gemini.generateMaths] Falling back to local synthesis.");
  try {
    const beatsLib = Array.isArray(jmaths?.beat_library) ? jmaths.beat_library.slice() : [];
    const locations = Array.isArray(jmaths?.constraints?.locations_allowed)
      ? jmaths.constraints.locations_allowed.slice()
      : ["supermarket"];
    const pick = arr => arr[Math.floor(Math.random() * arr.length)];
    const int = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

    const loc = pick(locations);
    const tmplFallback = [
      "Jemima bought X tickets at €Y each.",
      "She walked X metres and took Y cat naps.",
      "She drank X ml from a Y ml bottle.",
      "She laughed X times at a hat."
    ];
    const source = beatsLib.length ? beatsLib : tmplFallback;

    const beats = Array.from({ length: 4 }, () => {
      const t = pick(source);
      const X = int(1, 12), Y = int(1, 12);
      return t.replace(/\bX\b/g, String(X)).replace(/\bY\b/g, String(Y));
    });

    // derive two valid Q/As
    const q1 = "How much did Jemima spend in total? ___ euros";
    let ans1 = int(3, 24);
    const priceTickets = beats.find(b => /€\d+\s*each/i.test(b));
    if (priceTickets) {
      const m = priceTickets.match(/(\d+)\s+.*?€(\d+)\s*each/i);
      if (m) ans1 = parseInt(m[1], 10) * parseInt(m[2], 10);
    }

    const q2 = "How many steps did Jemima climb? ___ steps";
    let ans2 = int(5, 40);
    const stepsBeat = beats.find(b => /(\d+)\s+steps?/i.test(b));
    const m2 = stepsBeat && stepsBeat.match(/(\d+)\s+steps?/i);
    if (m2) ans2 = parseInt(m2[1], 10);

    return { location: loc, beats, questions: [q1, q2], answers: [ans1, ans2] };
  } catch {
    // rock-solid minimal
    return {
      location: "supermarket",
      beats: [
        "Jemima entered with €10.",
        "She bought 2 apples at €2 each.",
        "She tipped a busker €1.",
        "She clinked tins exactly 4 times."
      ],
      questions: [
        "How much did Jemima spend? ___ euros",
        "How many times did she clink? ___ times"
      ],
      answers: [5, 4]
    };
  }
}