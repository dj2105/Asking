// /src/lib/gemini.js
// Legacy (unused in sealed flow).
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

// callGeminiJemima -> returns { clue: "..." }
export async function callGeminiJemima({ apiKey, round = 1, model = DEFAULT_M_MODEL }) {
  const prompt = `Write a single, playful one-line maths clue for Round ${round} of a head-to-head quiz. Keep it short, British, and hinting at a number. Output plain text only.`;
  const contents = [{ role: "user", parts: [{ text: prompt }] }];

  const result = await callGeminiRaw({
    apiKey, model, contents,
    generationConfig: { temperature: 0.8, maxOutputTokens: 120, candidateCount: 1 }
  });

  const clue =
    textFromCandidate(result.candidates?.[0]) ||
    textFromCandidate(result) ||
    `Round ${round} begins.`;

  return { clue: String(clue).trim() };
}

// generateMaths -> returns an object matching your jmaths output contract
export async function generateMaths({ apiKey, jmaths, model = DEFAULT_M_MODEL }) {
  assert(jmaths, "Missing jmaths config.");

  const makePrompt = (strict = false) => strict
    ? (
      `Return ONLY JSON with EXACTLY these keys & types and nothing else:\n` +
      `{"clues":["c1","c2","c3","c4","c5"],"reveals":["r1","r2","r3","r4","r5"],"question":"string","answer":123}\n` +
      `Rules:\n` +
      `- clues: five short sentences (1–2), each hinting at a number used in the final maths.\n` +
      `- reveals: five short sentences sharing concrete numeric facts aligned to the clues.\n` +
      `- question: playful British English, contains a blank ___ tying all clues together.\n` +
      `- answer: single whole number (integer).\n` +
      `No markdown, no commentary.\n` +
      `CONFIG:\n${JSON.stringify(jmaths)}`
    )
    : (
      `You are generating Jemima's five-round maths chain.\n` +
      `Return ONLY JSON with keys: clues[5], reveals[5], question, answer.\n` +
      `- Each clue is 1–2 sentences hinting at one numeric step (integers only).\n` +
      `- Each reveal is 1 sentence sharing the actual number for that clue.\n` +
      `- The question references the story and includes a visible blank ___ .\n` +
      `- The answer is the exact final integer.\n` +
      `Use British English, Jemima's warm tone, and keep numbers integer-friendly.\n\n` +
      `CONFIG:\n${JSON.stringify(jmaths)}`
    );

  const normaliseReveal = (entry) => {
    if (typeof entry === "string") return entry.trim();
    if (entry && typeof entry === "object") {
      const txt = entry.prompt || entry.text || entry.value;
      if (typeof txt === "string") return txt.trim();
    }
    return "";
  };

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

    const clues = Array.isArray(parsed.clues) ? parsed.clues.map((c) => String(c || "").trim()) : [];
    const revealsRaw = Array.isArray(parsed.reveals) ? parsed.reveals : [];
    const reveals = revealsRaw.map(normaliseReveal);
    const question = typeof parsed.question === "string" ? parsed.question.trim() : "";
    const answer = Number.isInteger(parsed.answer)
      ? parsed.answer
      : Number.isFinite(parseInt(parsed.answer, 10))
      ? parseInt(parsed.answer, 10)
      : null;

    if (clues.length !== 5 || clues.some((c) => !c)) return null;
    if (reveals.length !== 5 || reveals.some((r) => !r)) return null;
    if (!question) return null;
    if (!Number.isInteger(answer)) return null;

    return { clues, reveals, question, answer };
  };

  const models = ["models/gemini-2.5-pro", "models/gemini-2.5-flash"];
  for (const mdl of models) {
    const a1 = await tryOnce(mdl, makePrompt(false), `${mdl} attempt#1`);
    if (a1) return a1;
    const a2 = await tryOnce(mdl, makePrompt(true), `${mdl} attempt#2`);
    if (a2) return a2;
  }

  console.warn("[gemini.generateMaths] Falling back to local synthesis.");
  const safeClues = [
    "I start with the 360 degrees of a perfect circle on Jemima's sketchpad.",
    "She halves it neatly because only two directions matter tonight.",
    "Then she adds the 42 kilometres she cycled this week.",
    "She multiplies by the 8 letters in 'WHISKERS' for luck.",
    "Finally she subtracts the 88 keys of her favourite piano."
  ];
  const safeReveals = [
    "A circle has 360 degrees.",
    "Halving brings the running total to 180.",
    "Adding 42 lifts the total to 222.",
    "Multiplying by 8 vaults it to 1776.",
    "Subtracting 88 leaves the final answer." 
  ];
  const safeQuestion = "All tallied, what number does Jemima finish on? ___";
  const safeAnswer = 1688;
  return { clues: safeClues, reveals: safeReveals, question: safeQuestion, answer: safeAnswer };
}