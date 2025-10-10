// /src/lib/seedUnsealer.js
// Handles sealed-pack decryption, validation, and Firestore seeding.

import {
  canonicalJSONStringify,
  clampCode,
  sha256Hex,
} from "./util.js";
import {
  roomRef,
  roundSubColRef,
  doc,
  setDoc,
  runTransaction,
  serverTimestamp,
} from "./firebase.js";

const TEXT_DECODER = new TextDecoder();
const PASSWORD_DEMO = "DEMO-ONLY"; // TODO: externalise to env/config.
const PACK_VERSION = "jemima-pack-1";
const COUNTDOWN_LEAD_MS = 7_000;
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

function validatePack(pack) {
  assert(pack && typeof pack === "object", "Decrypted pack empty.");
  assert(pack.version === PACK_VERSION, `Unsupported pack version: ${pack.version || "unknown"}.`);

  const meta = pack.meta || {};
  assert(meta && typeof meta === "object", "Pack meta missing.");
  const code = clampCode(meta.roomCode);
  assert(code && code.length === 3, "Pack room code invalid.");
  assert(code === meta.roomCode, "Pack room code must be uppercase alphanumeric (3 chars).");
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
  assert(typeof maths.location === "string" && maths.location.trim(), "Maths location missing.");
  assert(Array.isArray(maths.beats) && maths.beats.length >= 1, "Maths beats missing.");
  assert(Array.isArray(maths.questions) && maths.questions.length === 2, "Maths requires two questions.");
  assert(Array.isArray(maths.answers) && maths.answers.length === 2, "Maths requires two answers.");
  maths.answers.forEach((ans, idx) => {
    assert(Number.isInteger(ans), `Maths answer ${idx + 1} must be an integer.`);
  });

  const integrity = pack.integrity || {};
  assert(typeof integrity.checksum === "string" && /^[0-9a-f]{64}$/i.test(integrity.checksum), "Integrity checksum invalid.");
  if ("verified" in integrity) {
    assert(Boolean(integrity.verified), "Integrity flag must be true.");
  }

  return { code };
}

export async function unsealFile(file, { password = PASSWORD_DEMO } = {}) {
  assert(file && typeof file.text === "function", "Invalid file supplied.");
  const envelopeText = await file.text();
  let envelope;
  try {
    envelope = JSON.parse(envelopeText);
  } catch (err) {
    throw new Error("Sealed pack is not valid JSON.");
  }

  const pack = await decryptEnvelope(envelope, password || PASSWORD_DEMO);
  const { code } = validatePack(pack);

  const { integrity, ...withoutIntegrity } = pack;
  const canonical = canonicalJSONStringify(withoutIntegrity);
  const checksum = await sha256Hex(canonical);
  assert(checksum === integrity.checksum, "Pack integrity checksum mismatch.");

  return { pack, verified: true, code };
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

export async function seedFirestoreFromPack(db, pack) {
  assert(db, "Firestore database handle required.");
  validatePack(pack);
  const code = clampCode(pack.meta.roomCode);
  const startAt = Date.now() + COUNTDOWN_LEAD_MS;

  const roomDoc = roomRef(code);
  const countdown = { startAt };
  const maths = clonePlain(pack.maths);

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(roomDoc);
    if (!snap.exists()) {
      tx.set(roomDoc, {
        meta: {
          hostUid: pack.meta.hostUid,
          guestUid: pack.meta.guestUid,
        },
        state: "countdown",
        round: 1,
        maths,
        countdown,
        answers: { host: {}, guest: {} },
        submitted: { host: {}, guest: {} },
        marking: { host: {}, guest: {}, startAt: null },
        markingAck: { host: {}, guest: {} },
        award: { startAt: null },
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
        state: "countdown",
        round: 1,
        maths,
        countdown,
        answers: { host: {}, guest: {} },
        submitted: { host: {}, guest: {} },
        marking: { host: {}, guest: {}, startAt: null },
        markingAck: { host: {}, guest: {} },
        award: { startAt: null },
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

  return { code, startAt };
}

export const DEMO_PACK_PASSWORD = PASSWORD_DEMO;
