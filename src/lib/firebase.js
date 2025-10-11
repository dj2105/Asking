// /src/lib/firebase.js
//
// Centralised Firebase init + helpers with robust emulator fallback.
// - Emulator turns on if:
//    • URL has ?emu=1  OR
//    • localStorage.forceEmu === "1"  OR
//    • host is localhost AND config looks like demo
// - If anon sign-in fails with API_KEY error, we auto-switch to emulator and retry.
//
// Exports:
//   initFirebase, ensureAuth, usingEmu (boolean), roomRef, roundSubColRef,
//   doc, getDoc, setDoc, updateDoc, onSnapshot, serverTimestamp, collection,
//   safeSetState, claimRoleIfEmpty, getRole
//
// IMPORTANT: Lock this with proper Security Rules before going live.

let _app = null;
let _db = null;
let _auth = null;
let _fb = null;

// mutable export so views see updated value if we flip at runtime
export let usingEmu = false;

const firebaseCDN = "https://www.gstatic.com/firebasejs/10.12.0";

// ---------- dynamic loader ----------
async function loadFirebase() {
  const [
    { initializeApp },
    { getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, updateDoc, onSnapshot, serverTimestamp, collection, runTransaction },
    { getAuth, connectAuthEmulator, signInAnonymously }
  ] = await Promise.all([
    import(`${firebaseCDN}/firebase-app.js`),
    import(`${firebaseCDN}/firebase-firestore.js`),
    import(`${firebaseCDN}/firebase-auth.js`)
  ]);
  return {
    initializeApp,
    getFirestore, connectFirestoreEmulator,
    getAuth, connectAuthEmulator, signInAnonymously,
    doc, getDoc, setDoc, updateDoc, onSnapshot, serverTimestamp, collection, runTransaction
  };
}

// ---------- config helpers ----------
function readInjectedConfig() {
  try {
    if (window.__FIREBASE_CONFIG__ && typeof window.__FIREBASE_CONFIG__ === "object") {
      return window.__FIREBASE_CONFIG__;
    }
  } catch {}
  // demo fallback for emulator/dev
  return {
    apiKey: "demo",
    authDomain: "localhost",
    projectId: "demo-jemimas-asking",
    appId: "demo-jemima-app"
  };
}

function computeShouldUseEmu(cfg) {
  const urlHasEmu = /\bemu=1\b/.test(location.search || "") || /\bemu=1\b/.test(location.hash || "");
  const forceEmuLS = (localStorage.getItem("forceEmu") || "") === "1";
  const looksDemo = !cfg || cfg.apiKey === "demo" || !cfg.apiKey;
  const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  return urlHasEmu || forceEmuLS || (isLocal && looksDemo);
}

// ---------- init ----------
export async function initFirebase() {
  if (_app) return { app: _app, db: _db, auth: _auth };

  _fb = await loadFirebase();
  const config = readInjectedConfig();
  usingEmu = computeShouldUseEmu(config);
  console.log("Firebase config injected", config);
  console.log("[firebase] usingEmu =", usingEmu);

  _app = _fb.initializeApp(config);
  _db  = _fb.getFirestore(_app);
  _auth= _fb.getAuth(_app);

  if (usingEmu) {
    try {
      _fb.connectFirestoreEmulator(_db, "127.0.0.1", 8081);
      _fb.connectAuthEmulator(_auth, "http://127.0.0.1:9099", { disableWarnings: true });
    } catch (e) {
      console.warn("[firebase] emulator connect failed; continuing live?", e);
    }
  }
  bindExports();
  return { app: _app, db: _db, auth: _auth };
}

// ---------- auth with auto-emulator fallback ----------
export async function ensureAuth() {
  await initFirebase();
  if (_auth.currentUser) return _auth.currentUser;
  try {
    const cred = await _exports.signInAnonymously(_auth);
    return cred.user;
  } catch (e) {
    const msg = String(e?.code || e?.message || e);
    const apiKeyBad = /API[_-]?KEY.*INVALID/i.test(msg) || /auth\/api-key-not-valid/i.test(msg);
    // If we're not on emulator yet and the API key is bad, flip to emulator and retry
    if (!usingEmu && apiKeyBad) {
      console.warn("[firebase] API key invalid; switching to emulator and retrying anon auth…");
      try {
        usingEmu = true;
        _fb.connectFirestoreEmulator(_db, "127.0.0.1", 8081);
        _fb.connectAuthEmulator(_auth, "http://127.0.0.1:9099", { disableWarnings: true });
        const cred2 = await _exports.signInAnonymously(_auth);
        return cred2.user;
      } catch (e2) {
        console.error("Anon sign-in failed after emulator fallback:", e2);
        throw e2;
      }
    }
    console.error("Anon sign-in failed:", e);
    throw e;
  }
}

// ---------- refs ----------
export function roomRef(code) {
  const c = String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
  return _exports.doc(_exports.collection(_db, "rooms"), c);
}
export function roundSubColRef(code) {
  const c = String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
  return _exports.collection(roomRef(c), "rounds");
}

// ---------- helpers ----------
export async function safeSetState(code, nextState, extra = {}) {
  const ref = roomRef(code);
  const snap = await _exports.getDoc(ref);
  if (!snap.exists()) return;
  const d = snap.data() || {};
  if (d.state === nextState) return;
  const patch = { state: nextState, "timestamps.updatedAt": _exports.serverTimestamp(), ...extra };
  await _exports.updateDoc(ref, patch);
}

// transactional role claim
export async function claimRoleIfEmpty(code, uid, role = "guest") {
  await initFirebase();
  const ref = roomRef(code);
  const slot = role === "host" ? "host" : "guest";
  let status = "error";
  let reason = "unknown";

  try {
    await _exports.runTransaction(_db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) {
        status = "error";
        reason = "missing";
        return;
      }

      const data = snap.data() || {};
      const meta = data.meta || {};
      const current = meta[`${slot}Uid`] || "";

      if (!current) {
        tx.update(ref, {
          [`meta.${slot}Uid`]: uid,
          "timestamps.updatedAt": _exports.serverTimestamp(),
        });
        status = "ok";
        reason = "claimed";
        return;
      }

      if (current === uid) {
        status = "already-set";
        reason = "same-uid";
        return;
      }

      status = "error";
      reason = "occupied";
    });
  } catch (err) {
    console.error(`[firebase] claimRoleIfEmpty(${code}, ${slot}) failed:`, err);
    return { status: "error", reason: "exception", role: slot, code, error: err };
  }

  return { status, reason, role: slot, code };
}

export async function getRole(code, uid) {
  const snap = await _exports.getDoc(roomRef(code));
  const d = snap.data() || {};
  const hostUid = d?.meta?.hostUid || "";
  const guestUid = d?.meta?.guestUid || "";
  if (uid && uid === hostUid) return "host";
  if (uid && uid === guestUid) return "guest";
  return "guest";
}

// ---------- re-exports (bound post-init) ----------
const _exports = {
  doc: null, getDoc: null, setDoc: null, updateDoc: null, onSnapshot: null, serverTimestamp: null, collection: null, runTransaction: null,
  signInAnonymously: null
};
function bindExports() {
  const e = _exports;
  e.doc = _fb.doc;
  e.getDoc = _fb.getDoc;
  e.setDoc = _fb.setDoc;
  e.updateDoc = _fb.updateDoc;
  e.onSnapshot = _fb.onSnapshot;
  e.serverTimestamp = _fb.serverTimestamp;
  e.collection = _fb.collection;
  e.runTransaction = _fb.runTransaction;
  e.signInAnonymously = _fb.signInAnonymously;
}
export const doc = (...a) => _exports.doc(...a);
export const getDoc = (...a) => _exports.getDoc(...a);
export const setDoc = (...a) => _exports.setDoc(...a);
export const updateDoc = (...a) => _exports.updateDoc(...a);
export const onSnapshot = (...a) => _exports.onSnapshot(...a);
export const serverTimestamp = (...a) => _exports.serverTimestamp(...a);
export const collection = (...a) => _exports.collection(...a);
export const runTransaction = (...a) => _exports.runTransaction(...a);