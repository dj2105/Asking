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
