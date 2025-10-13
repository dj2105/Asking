// src/lib/firebase.js
import { initializeApp } from "firebase/app";
import {
  getAuth,
  connectAuthEmulator,
  signInAnonymously,
} from "firebase/auth";
import {
  getFirestore,
  connectFirestoreEmulator,
} from "firebase/firestore";

const qs = new URLSearchParams(location.search);
const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname) || qs.get("emu") === "1";

const FALLBACK_CONFIG = {
  apiKey: "AIzaSy*****YOUR_REAL_KEY*****",
  authDomain: "asking-6d3d45.firebaseapp.com",
  projectId: "asking-6d3d45",
  storageBucket: "asking-6d3d45.appspot.com",
  messagingSenderId: "397557111515",
  appId: "1:397557111515:web:XXXXXXX",
};

const PLACEHOLDER_RE = /YOUR_REAL_KEY|XXXX|REPLACE|example|demo/i;

function mergeConfig(base, injected) {
  if (!injected || typeof injected !== "object") return { ...base };
  const out = { ...base };
  for (const [key, value] of Object.entries(injected)) {
    if (value == null) continue;
    const current = out[key];
    const currentStr = typeof current === "string" ? current : "";
    const shouldOverride =
      current == null ||
      (typeof current === "string" && PLACEHOLDER_RE.test(currentStr));
    if (shouldOverride) {
      out[key] = value;
    }
  }
  return out;
}

const injectedConfig = typeof window !== "undefined" ? window.__FIREBASE_CONFIG__ : null;
const firebaseConfig = mergeConfig(FALLBACK_CONFIG, injectedConfig);

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

if (isLocal) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8081);
}

export async function ensureAuth() {
  if (auth.currentUser) return auth.currentUser;
  try {
    const cred = await signInAnonymously(auth);
    return cred?.user || auth.currentUser;
  } catch (err) {
    console.error("[firebase] Anonymous sign-in failed", err);
    return auth.currentUser;
  }
}
