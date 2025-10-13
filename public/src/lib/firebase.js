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

console.log("[firebase] script loaded");

// --- Detect local environment (only use emulator if running locally)
const qs = new URLSearchParams(location.search);
const isLocal =
  location.hostname === "localhost" ||
  location.hostname === "127.0.0.1" ||
  qs.get("emu") === "1";

// --- Real Firebase config (replace with your actual keys)
const firebaseConfig = {
  apiKey: "AIzaSy*****YOUR_REAL_KEY*****",
  authDomain: "asking-6d3d45.firebaseapp.com",
  projectId: "asking-6d3d45",
  storageBucket: "asking-6d3d45.appspot.com",
  messagingSenderId: "397557111515",
  appId: "1:397557111515:web:XXXXXXX" // from Firebase console → project settings
};

// --- Initialise
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// --- Connect emulators only when local
if (isLocal) {
  console.log("[firebase] Using emulator mode");
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8081);
} else {
  console.log("[firebase] Using real Firebase project");
}

// --- Ensure anon auth
export async function ensureAuth() {
  try {
    await signInAnonymously(auth);
    console.log("[firebase] Signed in anonymously");
  } catch (err) {
    console.error("[firebase] Sign-in failed:", err);
  }
  return auth.currentUser;
}
