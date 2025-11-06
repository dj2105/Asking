import { initializeApp } from "firebase/app";
import {
  getAuth,
  connectAuthEmulator,
  signInAnonymously,
} from "firebase/auth";
import {
  getFirestore,
  connectFirestoreEmulator,
  collection,
  doc,
  addDoc,
  getDoc,
  deleteDoc,
  query,
  where,
  getDocs,
  getCountFromServer,
  serverTimestamp,
} from "firebase/firestore";

const FALLBACK_CONFIG = {
  apiKey: "AIzaSy*****YOUR_REAL_KEY*****",
  authDomain: "asking-6d3d45.firebaseapp.com",
  projectId: "asking-6d3d45",
  storageBucket: "asking-6d3d45.appspot.com",
  messagingSenderId: "397557111515",
  appId: "1:397557111515:web:XXXXXXX",
};

const injectedConfig =
  typeof window !== "undefined" && window.__FIREBASE_CONFIG__ && typeof window.__FIREBASE_CONFIG__ === "object"
    ? window.__FIREBASE_CONFIG__
    : null;

const firebaseConfig = { ...FALLBACK_CONFIG };
if (injectedConfig) {
  for (const [key, value] of Object.entries(injectedConfig)) {
    if (value != null && value !== "") {
      firebaseConfig[key] = value;
    }
  }
} else if (typeof FALLBACK_CONFIG.apiKey === "string" && FALLBACK_CONFIG.apiKey.includes("YOUR_REAL_KEY")) {
  console.error(
    "[firebase] Missing Firebase credentials. Copy docs/firebase.config.sample.js to docs/firebase.config.js (or inject window.__FIREBASE_CONFIG__) before deploying."
  );
}

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

const qs = new URLSearchParams(window.location.search);
const isLocal = ["localhost", "127.0.0.1"].includes(window.location.hostname) || qs.get("emu") === "1";

if (isLocal) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8081);
}

export async function ensureAuth() {
  if (auth.currentUser) return auth.currentUser;
  try {
    const credential = await signInAnonymously(auth);
    return credential?.user || auth.currentUser;
  } catch (error) {
    console.error("[firebase] Anonymous sign-in failed", error);
    return auth.currentUser;
  }
}

const COLLECTION_MAP = {
  questions: () => collection(db, "packs_questions"),
  maths: () => collection(db, "packs_maths"),
};

const USED_COLLECTION_MAP = {
  questions: () => collection(db, "packs_questions_used"),
  maths: () => collection(db, "packs_maths_used"),
};

function resolveCollection(kind, map) {
  const getter = map[kind];
  if (typeof getter !== "function") {
    throw new Error(`Unknown pack kind: ${kind}`);
  }
  return getter();
}

export const packsQuestionsRef = () => resolveCollection("questions", COLLECTION_MAP);
export const packsMathsRef = () => resolveCollection("maths", COLLECTION_MAP);
export const packsQuestionsUsedRef = () => resolveCollection("questions", USED_COLLECTION_MAP);
export const packsMathsUsedRef = () => resolveCollection("maths", USED_COLLECTION_MAP);

function withBasePackFields(kind, data = {}, sourceName = "") {
  const safeName = typeof sourceName === "string" && sourceName.trim() ? sourceName.trim() : "Uploaded pack";
  return {
    ...data,
    kind,
    sourceName: safeName,
    status: "available",
    uploadedAt: serverTimestamp(),
  };
}

export async function createPackDoc(kind, data, sourceName = "") {
  const target = resolveCollection(kind, COLLECTION_MAP);
  const payload = withBasePackFields(kind, data, sourceName);
  const docRef = await addDoc(target, payload);
  return { id: docRef.id };
}

export async function countAvailable(kind) {
  try {
    const target = resolveCollection(kind, COLLECTION_MAP);
    const q = query(target, where("status", "==", "available"));
    const snapshot = await getCountFromServer(q);
    return snapshot.data().count || 0;
  } catch (err) {
    console.warn("[firebase] countAvailable failed", kind, err);
    return 0;
  }
}

export async function pickRandomAvailable(kind) {
  try {
    const target = resolveCollection(kind, COLLECTION_MAP);
    const q = query(target, where("status", "==", "available"));
    const snap = await getDocs(q);
    if (snap.empty) return null;
    const docs = snap.docs;
    const idx = Math.floor(Math.random() * docs.length);
    const chosen = docs[idx];
    return { id: chosen.id, data: chosen.data() };
  } catch (err) {
    console.warn("[firebase] pickRandomAvailable failed", kind, err);
    return null;
  }
}

export async function movePackToUsed(kind, id, extra = {}) {
  if (!id) return null;
  try {
    const sourceCollection = resolveCollection(kind, COLLECTION_MAP);
    const docRef = doc(sourceCollection, id);
    const snap = await getDoc(docRef);
    if (!snap.exists()) return null;
    const data = snap.data() || {};
    const payload = {
      ...data,
      ...extra,
      usedAt: serverTimestamp(),
    };
    const usedCollection = resolveCollection(kind, USED_COLLECTION_MAP);
    const writeRef = await addDoc(usedCollection, payload);
    await deleteDoc(docRef);
    return { usedId: writeRef.id };
  } catch (err) {
    console.warn("[firebase] movePackToUsed failed", kind, id, err);
    return null;
  }
}
