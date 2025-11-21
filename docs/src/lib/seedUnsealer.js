// /src/lib/seedUnsealer.js
// Handles sealed-pack decryption, validation, and Firestore seeding.

import {
  canonicalJSONStringify,
  clampCode,
  sha256Hex,
} from "./util.js";
import { db } from "./firebase.js";
import {
  doc,
  collection,
  setDoc,
  runTransaction,
  serverTimestamp,
} from "firebase/firestore";

const roomRef = (code) => doc(db, "rooms", code);
const roundSubColRef = (code) => collection(roomRef(code), "rounds");

const TEXT_DECODER = new TextDecoder();
const PASSWORD_DEMO = "DEMO-ONLY"; // TODO: externalise to env/config.
export const PACK_VERSION_FULL = "jemima-pack-1";
export const PACK_VERSION_HALF = "jemima-halfpack-1";
export const PACK_VERSION_QUESTIONS = "jemima-questionpack-1";
export const PACK_VERSION_MATHS = "jemima-maths-timeline-1";
const PBKDF2_ITERATIONS = 150_000;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function base64ToBytes(b64) {
  try {
    const normalized = String(b64 || "").replace(/\s+/g, "");
    const bin = atob(normalized);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch (err) {
    throw new Error("Invalid base64 payload in sealed pack.");
  }
}

async function deriveKey(password, saltBytes) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
}

async function decryptEnvelope(envelope, password) {
  const { alg, salt_b64, nonce_b64, ct_b64 } = envelope || {};
  assert(alg && typeof alg === "string", "Missing algorithm descriptor.");
  assert(/aes/i.test(alg), "Unsupported sealed pack algorithm.");

  const salt = base64ToBytes(salt_b64);
  const nonce = base64ToBytes(nonce_b64);
  const ciphertext = base64ToBytes(ct_b64);

  assert(salt.length >= 16, "Salt too short.");
  assert(nonce.length === 12, "Nonce must be 12 bytes for AES-GCM.");
  assert(ciphertext.length > 0, "Encrypted payload empty.");

  const key = await deriveKey(password, salt);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext);
  return JSON.parse(TEXT_DECODER.decode(decrypted));
}

function validateItem(item, label) {
  assert(item && typeof item === "object", `${label} missing.`);
  assert(typeof item.subject === "string" && item.subject.trim(), `${label} subject missing.`);
  assert(typeof item.difficulty_tier === "string" && item.difficulty_tier.trim(), `${label} difficulty missing.`);
  assert(typeof item.question === "string" && item.question.trim(), `${label} question missing.`);
  assert(typeof item.correct_answer === "string" && item.correct_answer.trim(), `${label} correct answer missing.`);
  const distractors = item.distractors || {};
  assert(typeof distractors.easy === "string" && distractors.easy.trim(), `${label} distractor easy missing.`);
  assert(typeof distractors.medium === "string" && distractors.medium.trim(), `${label} distractor medium missing.`);
  assert(typeof distractors.hard === "string" && distractors.hard.trim(), `${label} distractor hard missing.`);
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

async function readSealedContent(file, password) {
  assert(file && typeof file.text === "function", "Invalid file supplied.");
  const envelopeText = await file.text();
  let envelope;
  try {
    envelope = JSON.parse(envelopeText);
  } catch (err) {
    throw new Error("Sealed pack is not valid JSON.");
  }

  return decryptEnvelope(envelope, password || PASSWORD_DEMO);
}

async function verifyIntegrity(pack, mismatchMessage = "Pack integrity checksum mismatch.") {
  const integrity = pack.integrity || {};
  assert(typeof integrity.checksum === "string" && /^[0-9a-f]{64}$/i.test(integrity.checksum), "Integrity checksum invalid.");
  if ("verified" in integrity) {
    assert(Boolean(integrity.verified), "Integrity flag must be true.");
  }

  const { integrity: _, ...withoutIntegrity } = pack;
  const canonical = canonicalJSONStringify(withoutIntegrity);
  const checksum = await sha256Hex(canonical);
  assert(checksum === integrity.checksum, mismatchMessage);
}

function validateHalfpack(pack) {
  assert(pack && typeof pack === "object", "Decrypted pack empty.");
  assert(pack.version === PACK_VERSION_HALF, "Unsupported sealed version.");

  const meta = pack.meta || {};
  assert(meta && typeof meta === "object", "Pack meta missing.");
  const code = clampCode(meta.roomCode);
  assert(code && code.length >= 3 && code.length <= 5, "Pack room code invalid.");
  assert(code === meta.roomCode, "Pack room code must be uppercase alphanumeric (3–5 chars).");
  assert(typeof meta.generatedAt === "string" && !Number.isNaN(Date.parse(meta.generatedAt)), "Pack generatedAt invalid.");
  assert(meta.which === "host" || meta.which === "guest", "Halfpack meta.which invalid.");

  const expectedSide = meta.which === "host" ? "hostItems" : "guestItems";
  const otherSide = meta.which === "host" ? "guestItems" : "hostItems";
  const rounds = Array.isArray(pack.rounds) ? pack.rounds : [];
  assert(rounds.length === 5, "Halfpack must contain 5 rounds.");

  const seenRounds = new Set();
  rounds.forEach((round, idx) => {
    assert(round && typeof round === "object", `Round entry ${idx + 1} invalid.`);
    const rnum = Number(round.round);
    assert(Number.isInteger(rnum) && rnum >= 1 && rnum <= 5, `Round number invalid at index ${idx}.`);
    seenRounds.add(rnum);

    const activeItems = Array.isArray(round[expectedSide]) ? round[expectedSide] : [];
    const inactiveItems = Array.isArray(round[otherSide]) ? round[otherSide] : [];
    if (activeItems.length !== 3 || inactiveItems.length !== 0) {
      throw new Error("Halfpack invalid: each round needs exactly 3 items for its side.");
    }
    activeItems.forEach((item, i) => validateItem(item, `Round ${rnum} ${meta.which} item ${i + 1}`));
  });

  assert(seenRounds.size === 5, "Pack rounds must cover 1–5 exactly.");
  for (let i = 1; i <= 5; i += 1) {
    assert(seenRounds.has(i), "Pack rounds must cover 1–5 exactly.");
  }

  return { code, which: meta.which };
}

function validateQuestionPack(pack) {
  assert(pack && typeof pack === "object", "Decrypted pack empty.");
const OK_QUESTION_VERSIONS = ["jemima-questionpack-1", "jemima-questions-1"];
assert(OK_QUESTION_VERSIONS.includes(pack.version), "Unsupported sealed version.");
if (pack.version === "jemima-questions-1") {
  console.warn("Using legacy question pack format (jemima-questions-1).");
}
  const meta = pack.meta || {};
  assert(meta && typeof meta === "object", "Pack meta missing.");
  const code = clampCode(meta.roomCode);
  assert(code && code.length === 3, "Pack room code invalid.");
  assert(code === meta.roomCode, "Pack room code must be uppercase alphanumeric (3 chars).");
  if (typeof meta.generatedAt === "string" && meta.generatedAt.trim()) {
    assert(!Number.isNaN(Date.parse(meta.generatedAt)), "Pack generatedAt invalid.");
  }

  const rounds = Array.isArray(pack.rounds) ? pack.rounds : [];
  assert(rounds.length === 5, "Question pack must contain 5 rounds.");

  const seenRounds = new Set();
  rounds.forEach((round, idx) => {
    assert(round && typeof round === "object", `Round entry ${idx + 1} invalid.`);
    const rnum = Number(round.round);
    assert(Number.isInteger(rnum) && rnum >= 1 && rnum <= 5, `Round number invalid at index ${idx}.`);
    seenRounds.add(rnum);

    const hostItems = Array.isArray(round.hostItems) ? round.hostItems : [];
    const guestItems = Array.isArray(round.guestItems) ? round.guestItems : [];
    assert(hostItems.length === 3, `Round ${rnum} hostItems must be 3.`);
    assert(guestItems.length === 3, `Round ${rnum} guestItems must be 3.`);
    hostItems.forEach((item, i) => validateItem(item, `Round ${rnum} host item ${i + 1}`));
    guestItems.forEach((item, i) => validateItem(item, `Round ${rnum} guest item ${i + 1}`));
  });

  assert(seenRounds.size === 5, "Question pack rounds must cover 1–5 exactly.");
  for (let i = 1; i <= 5; i += 1) {
    assert(seenRounds.has(i), "Question pack rounds must cover 1–5 exactly.");
  }

  return { code };
}

function validateMaths(pack) {
  assert(pack && typeof pack === "object", "Decrypted pack empty.");
  assert(pack.version === PACK_VERSION_MATHS, "Unsupported sealed version.");

  const meta = pack.meta || {};
  assert(meta && typeof meta === "object", "Pack meta missing.");
  const code = clampCode(meta.roomCode);
  assert(code && code.length >= 3 && code.length <= 5, "Pack room code invalid.");
  assert(code === meta.roomCode, "Pack room code must be uppercase alphanumeric (3–5 chars).");
  assert(typeof meta.generatedAt === "string" && !Number.isNaN(Date.parse(meta.generatedAt)), "Pack generatedAt invalid.");

  const maths = pack.maths || {};
  assert(Array.isArray(maths.events) && maths.events.length === 5, "Maths events must contain 5 entries.");
  let lastYear = 0;
  maths.events.forEach((event, idx) => {
    assert(event && typeof event === "object", `Maths event ${idx + 1} missing.`);
    assert(typeof event.prompt === "string" && event.prompt.trim(), `Maths event ${idx + 1} prompt missing.`);
    assert(Number.isInteger(event.year) && event.year >= 1 && event.year <= 2025, `Maths event ${idx + 1} year invalid.`);
    assert(
      idx === 0 || event.year > lastYear,
      "Maths events must be in chronological order (each newer than the last)."
    );
    lastYear = event.year;
  });

  const sumYears = maths.events.reduce((total, event) => total + (Number.isInteger(event.year) ? event.year : 0), 0);
  if (maths.total != null) {
    assert(Number.isInteger(maths.total) && maths.total === sumYears, "Maths total must match summed event years.");
  }

  if (maths.scoring) {
    const scoring = maths.scoring;
    const { sharpshooterPercent, ballparkPercent, sharpshooterMargin, ballparkMargin, safetyNetPoints } = scoring;
    assert(typeof scoring === "object", "Maths scoring must be an object.");
    if (sharpshooterPercent != null) assert(Number(scoring.sharpshooterPercent) > 0, "Scoring sharpshooterPercent invalid.");
    if (ballparkPercent != null) assert(Number(scoring.ballparkPercent) > 0, "Scoring ballparkPercent invalid.");
    if (sharpshooterMargin != null) assert(Number.isInteger(sharpshooterMargin) && sharpshooterMargin >= 0, "Sharpshooter margin invalid.");
    if (ballparkMargin != null) assert(Number.isInteger(ballparkMargin) && ballparkMargin >= 0, "Ballpark margin invalid.");
    if (safetyNetPoints != null) assert(Number.isInteger(safetyNetPoints), "Safety-net points invalid.");
  }

  if (Array.isArray(maths.clues)) {
    maths.clues.forEach((clue, idx) => {
      assert(typeof clue === "string" && clue.trim(), `Maths clue ${idx + 1} missing.`);
    });
  }

  return { code };
}

function validatePack(pack) {
  assert(pack && typeof pack === "object", "Decrypted pack empty.");
  const v = String(pack.version || "");

  if (v === PACK_VERSION_FULL) {
    return { code: clampCode(pack.meta?.roomCode || "") };
  }
  if (v === PACK_VERSION_HALF) {
    return validateHalfpack(pack);
  }
  if (["jemima-questionpack-1", "jemima-questions-1"].includes(v)) {
    return validateQuestionPack(pack);
  }
  if (v === PACK_VERSION_MATHS) {
    return validateMaths(pack);
  }

  throw new Error("Unsupported sealed version.");
}

export async function unsealFile(file, { password = PASSWORD_DEMO } = {}) {
  const pack = await readSealedContent(file, password);
  const { code } = validatePack(pack);
  await verifyIntegrity(pack, "Pack integrity checksum mismatch.");
  return { pack, verified: true, code };
}

export async function unsealHalfpack(file, { password = PASSWORD_DEMO } = {}) {
  const pack = await readSealedContent(file, password);
  const { code, which } = validateHalfpack(pack);
  await verifyIntegrity(pack, "Pack integrity checksum mismatch.");
  return { halfpack: clonePlain(pack), which, code };
}

export async function unsealQuestionPack(file, { password = PASSWORD_DEMO } = {}) {
  const pack = await readSealedContent(file, password);
  const { code } = validateQuestionPack(pack);
  await verifyIntegrity(pack, "Pack integrity checksum mismatch.");
  return { questions: clonePlain(pack), code };
}

export async function unsealMaths(file, { password = PASSWORD_DEMO } = {}) {
  const pack = await readSealedContent(file, password);
  const { code } = validateMaths(pack);
  await verifyIntegrity(pack, "Pack integrity checksum mismatch.");
  return { maths: clonePlain(pack.maths), code };
}

export async function seedFirestoreFromPack(db, pack) {
  assert(db, "Firestore database handle required.");
  validatePack(pack);
  const code = clampCode(pack.meta.roomCode);
  const roomDoc = roomRef(code);
  const countdown = { startAt: null };
  const maths = clonePlain(pack.maths);
  const clueMap = {};
  if (Array.isArray(maths?.clues)) {
    maths.clues.forEach((clue, idx) => {
      if (typeof clue === "string" && clue.trim()) {
        clueMap[idx + 1] = clue;
      }
    });
  }
  const revealMap = {};
  if (Array.isArray(maths?.reveals)) {
    maths.reveals.forEach((reveal, idx) => {
      let text = "";
      if (typeof reveal === "string") text = reveal;
      else if (reveal && typeof reveal === "object") {
        if (typeof reveal.prompt === "string") text = reveal.prompt;
        else if (typeof reveal.text === "string") text = reveal.text;
        else if (typeof reveal.value === "string") text = reveal.value;
      }
      if (text) {
        revealMap[idx + 1] = text;
      }
    });
  }

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(roomDoc);
    if (!snap.exists()) {
      tx.set(roomDoc, {
        meta: {
          hostUid: pack.meta.hostUid,
          guestUid: pack.meta.guestUid,
        },
        state: "keyroom",
        round: 1,
        maths,
        clues: clueMap,
        reveals: revealMap,
        countdown,
        answers: { host: {}, guest: {} },
        submitted: { host: {}, guest: {} },
        marking: { host: {}, guest: {}, startAt: null },
        markingAck: { host: {}, guest: {} },
        award: { startAt: null },
        awardAck: { host: {}, guest: {} },
        scores: { host: {}, guest: {} },
        timings: { host: {}, guest: {} },
        seeds: { progress: 100, message: "Pack ready." },
        timestamps: {
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
      });
    } else {
      const data = snap.data() || {};
      const meta = { ...(data.meta || {}) };
      if (!meta.hostUid && pack.meta.hostUid) meta.hostUid = pack.meta.hostUid;
      if (!meta.guestUid && pack.meta.guestUid) meta.guestUid = pack.meta.guestUid;

      tx.update(roomDoc, {
        meta,
        state: "keyroom",
        round: 1,
        maths,
        clues: clueMap,
        reveals: revealMap,
        countdown,
        answers: { host: {}, guest: {} },
        submitted: { host: {}, guest: {} },
        marking: { host: {}, guest: {}, startAt: null },
        markingAck: { host: {}, guest: {} },
        award: { startAt: null },
        awardAck: { host: {}, guest: {} },
        scores: { host: {}, guest: {} },
        timings: { host: {}, guest: {} },
        seeds: { progress: 100, message: "Pack ready." },
        "timestamps.updatedAt": serverTimestamp(),
      });
    }
  });

  const rounds = Array.isArray(pack.rounds) ? pack.rounds : [];
  const roundsRef = roundSubColRef(code);
  await Promise.all(rounds.map((round) => {
    const rnum = Number(round.round) || 0;
    const docRef = doc(roundsRef, String(rnum));
    const payload = {
      round: rnum,
      hostItems: clonePlain(round.hostItems),
      guestItems: clonePlain(round.guestItems),
    };
    return setDoc(docRef, payload);
  }));

  return { code };
}

export const DEMO_PACK_PASSWORD = PASSWORD_DEMO;
