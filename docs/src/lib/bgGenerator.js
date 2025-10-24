// /src/lib/bgGenerator.js
// Legacy (unused in sealed flow).
// Background generator for Rounds 2–5.
// Provides: startBackgroundQuestionGen({ apiKey, code, startRound=2, endRound=5, onTick })
// It streams progress via onTick and writes each round's items + round clue.

import { db } from "./firebase.js";
import {
  doc,
  collection,
  setDoc,
  updateDoc,
  serverTimestamp,
} from "firebase/firestore";
import * as Gemini from "./gemini.js";

function clampCode(s){ return String(s||"").trim().toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,3); }

const roomRef = (code) => doc(db, "rooms", code);
const roundSubColRef = (code) => collection(roomRef(code), "rounds");

async function writeProgress(code, progress, message){
  try{
    await updateDoc(roomRef(code), {
      "seeds.progress": progress,
      "seeds.message": message,
      "timestamps.updatedAt": serverTimestamp()
    });
  }catch(e){ /* non-fatal */ }
}

async function writeCounters(code, patch){
  try{
    await updateDoc(roomRef(code), {
      "seeds.counters": patch,
      "timestamps.updatedAt": serverTimestamp()
    });
  }catch(e){}
}

export async function startBackgroundQuestionGen({
  apiKey, code, startRound = 2, endRound = 5, onTick = () => {}
}){
  const theCode = clampCode(code);
  let rejectedTotal = 0;

  for (let round = startRound; round <= endRound; round++){
    const basePct = 70 + (round-startRound) * 5; // stagger progress a bit
    const emit = (p,msg) => { onTick({progress:p, round, message:msg}); };

    emit(basePct, `Round ${round}: generating`);
    await writeProgress(theCode, basePct, `Generating Round ${round}…`);

    // 1) generate pool
    const qcfg = { round, variant: "bg" };
    const pool = await Gemini.generateItems({ apiKey, qcfg, desiredCount: 8 });

    // 2) verify
    emit(basePct+2, `Round ${round}: verifying`);
    const ver = await Gemini.verifyItems({ apiKey, qcfg, items: pool });

    // 3) minimal shape check
    const ok = [];
    for (const it of (ver?.approved || pool || [])){
      const q = (it?.question||"").trim();
      const a = (it?.correct_answer||"").trim();
      if (!q || !a) continue;
      ok.push(it);
    }
    const final3 = ok.slice(0,3);
    if (final3.length < 3){
      rejectedTotal += (ver?.rejected?.length || 0);
      await writeCounters(theCode, { approved: ok.length, rejected: rejectedTotal });
      continue; // don’t block dev flow
    }

    // 4) clue for the round
    emit(basePct+3, `Round ${round}: clue`);
    const clue = await Gemini.callGeminiJemima({ apiKey, round, model:"gemini-2.5-flash" });

    // 5) write round doc
    await setDoc(doc(roundSubColRef(theCode), String(round)), {
      items: final3,
      clue: clue?.clue || `Round ${round} awaits.`,
      createdAt: serverTimestamp()
    }, { merge: true });

    // 6) update counters+progress
    await writeCounters(theCode, { approved: (round-1)*3 + final3.length, rejected: rejectedTotal });
    await writeProgress(theCode, basePct+5, `Round ${round} ready`);
  }

  await writeProgress(code, 95, "All background rounds written.");
}
