// /src/lib/seedUnsealer.js
// Handles sealed-pack decryption, validation, and Firestore seeding.

import {
  canonicalJSONStringify,
  clampCode,
  sha256Hex,
  isChainMaths,
  isLegacyMaths,
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
export const PACK_VERSION_MATHS = "jemima-maths-1";
export const PACK_VERSION_MATHS_CHAIN = "jemima-maths-chain-1";
const PBKDF2_ITERATIONS = 150_000;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertStrNonEmpty(value, message) {
  assert(typeof value === "string" && value.trim(), message);
}

function hasBlank(value) {
  return typeof value === "string" && value.includes("___");
}

function validateMathsPayload(maths = {}, versionHint = "") {
  const candidate = String(versionHint || "").trim();
  const beats = Array.isArray(maths.beats) ? maths.beats : [];

  assertStrNonEmpty(maths.location, "Maths location missing.");

  const decideVersion = () => {
    if (candidate) return candidate;
    if (isChainMaths(maths)) return PACK_VERSION_MATHS_CHAIN;
    if (isLegacyMaths(maths)) return PACK_VERSION_MATHS;
    if (typeof maths.question === "string" && "answer" in maths) {
      return PACK_VERSION_MATHS_CHAIN;
    }
    if (Array.isArray(maths.questions) && Array.isArray(maths.answers)) {
      return PACK_VERSION_MATHS;
    }
    return "";
  };

  const version = decideVersion();

  if (version === PACK_VERSION_MATHS_CHAIN) {
    assert(Array.isArray(maths.beats) && beats.length === 5, "Maths requires five beats.");
    assert(hasBlank(maths.question), "Maths question missing or invalid.");
    assert(Number.isInteger(maths.answer), "Maths answer must be an integer.");
    beats.forEach((beat, idx) => {
      assert(typeof beat === "string" && beat.trim(), `Maths beat ${idx + 1} missing.`);
    });
    return version;
  }

  if (version === PACK_VERSION_MATHS) {
    assert(Array.isArray(maths.beats) && beats.length >= 1, "Maths beats missing.");
    assert(Array.isArray(maths.questions) && maths.questions.length === 2, "Maths requires two questions.");
    assert(Array.isArray(maths.answers) && maths.answers.length === 2, "Maths requires two answers.");
    maths.answers.forEach((ans, idx) => {
      assert(Number.isInteger(ans), `Maths answer ${idx + 1} must be an integer.`);
    });
    return version;
  }

  assert(false, "Unsupported maths pack version.");
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

function validatePack(pack) {
  assert(pack && typeof pack === "object", "Decrypted pack empty.");
  assert(pack.version === PACK_VERSION_FULL, "Unsupported sealed version.");

  const meta = pack.meta || {};
  assert(meta && typeof meta === "object", "Pack meta missing.");
  const code = clampCode(meta.roomCode);
  assert(code && code.length >= 3 && code.length <= 5, "Pack room code invalid.");
  assert(code === meta.roomCode, "Pack room code must be uppercase alphanumeric (3–5 chars).");
  assert(typeof meta.hostUid === "string" && meta.hostUid.trim(), "Pack hostUid missing.");
  assert(typeof meta.guestUid === "string" && meta.guestUid.trim(), "Pack guestUid missing.");
  assert(typeof meta.generatedAt === "string" && !Number.isNaN(Date.parse(meta.generatedAt)), "Pack generatedAt invalid.");

  const rounds = Array.isArray(pack.rounds) ? pack.rounds : [];
  assert(rounds.length === 5, "Pack must contain 5 rounds.");
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

    assert(typeof round.interlude === "string" && round.interlude.trim(), `Round ${rnum} interlude missing.`);
  });
  assert(seenRounds.size === 5, "Pack rounds must cover 1–5 exactly.");
  for (let i = 1; i <= 5; i += 1) {
    assert(seenRounds.has(i), "Pack rounds must cover 1–5 exactly.");
  }

  const maths = pack.maths || {};
  const mathsVersion = validateMathsPayload(maths, maths.version || pack.meta?.mathsVersion);

  const integrity = pack.integrity || {};
  assert(typeof integrity.checksum === "string" && /^[0-9a-f]{64}$/i.test(integrity.checksum), "Integrity checksum invalid.");
  if ("verified" in integrity) {
    assert(Boolean(integrity.verified), "Integrity flag must be true.");
  }

  return { code, mathsVersion };
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

    assert(typeof round.interlude === "string" && round.interlude.trim(), `Round ${rnum} interlude missing.`);
  });

  assert(seenRounds.size === 5, "Pack rounds must cover 1–5 exactly.");
  for (let i = 1; i <= 5; i += 1) {
    assert(seenRounds.has(i), "Pack rounds must cover 1–5 exactly.");
  }

  return { code, which: meta.which };
}

function validateQuestionPack(pack) {
  assert(pack && typeof pack === "object", "Decrypted pack empty.");
  assert(pack.version === PACK_VERSION_QUESTIONS, "Unsupported sealed version.");

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

    assert(typeof round.interlude === "string" && round.interlude.trim(), `Round ${rnum} interlude missing.`);
  });

  assert(seenRounds.size === 5, "Question pack rounds must cover 1–5 exactly.");
  for (let i = 1; i <= 5; i += 1) {
    assert(seenRounds.has(i), "Question pack rounds must cover 1–5 exactly.");
  }

  return { code };
}

function validateMaths(pack) {
  assert(pack && typeof pack === "object", "Decrypted pack empty.");
  const version = validateMathsPayload(pack.maths || {}, pack.version);

  const meta = pack.meta || {};
  assert(meta && typeof meta === "object", "Pack meta missing.");
  const code = clampCode(meta.roomCode);
  assert(code && code.length >= 3 && code.length <= 5, "Pack room code invalid.");
  assert(code === meta.roomCode, "Pack room code must be uppercase alphanumeric (3–5 chars).");
  assert(typeof meta.generatedAt === "string" && !Number.isNaN(Date.parse(meta.generatedAt)), "Pack generatedAt invalid.");

  return { code, version };
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
  const { code, version } = validateMaths(pack);
  await verifyIntegrity(pack, "Pack integrity checksum mismatch.");
  return { maths: clonePlain(pack.maths), version, code };
}

export async function seedFirestoreFromPack(db, pack) {
  assert(db, "Firestore database handle required.");
  const { code, mathsVersion } = validatePack(pack);
  const resolvedMathsVersion = mathsVersion || PACK_VERSION_MATHS;
  const roomDoc = roomRef(code);
  const countdown = { startAt: null };
  const maths = clonePlain(pack.maths);

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(roomDoc);
    if (!snap.exists()) {
      tx.set(roomDoc, {
        meta: {
          hostUid: pack.meta.hostUid,
          guestUid: pack.meta.guestUid,
          mathsVersion: resolvedMathsVersion,
        },
        state: "keyroom",
        round: 1,
        maths,
        countdown,
        answers: { host: {}, guest: {} },
        submitted: { host: {}, guest: {} },
        marking: { host: {}, guest: {}, startAt: null },
        markingAck: { host: {}, guest: {} },
        award: { startAt: null },
        awardAck: { host: {}, guest: {} },
        scores: { questions: { host: 0, guest: 0 } },
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
      meta.mathsVersion = resolvedMathsVersion;

      tx.update(roomDoc, {
        meta,
        state: "keyroom",
        round: 1,
        maths,
        countdown,
        answers: { host: {}, guest: {} },
        submitted: { host: {}, guest: {} },
        marking: { host: {}, guest: {}, startAt: null },
        markingAck: { host: {}, guest: {} },
        award: { startAt: null },
        awardAck: { host: {}, guest: {} },
        scores: { questions: { host: 0, guest: 0 } },
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
      interlude: round.interlude,
    };
    return setDoc(docRef, payload);
  }));

  return { code };
}

export const DEMO_PACK_PASSWORD = PASSWORD_DEMO;
