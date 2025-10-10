// /src/views/SeedProgress.js
//
// Seeding (host-driven only).
// • Host generates Round 1 (exactly 3 items each for host & guest), writes maths payload,
//   then starts background generation for rounds 2–5. Guest only *watches* progress.
// • If a guest lands here mid-seed, they DO NOT trigger fallbacks or duplicate writes.
// • When Round 1 + maths are ready, host flips state → "countdown" (round=1, countdown.startAt set by Award/Countdown later).
//
// Inputs: ?code=ABC
//
// Firestore I/O:
//   rooms/{code} -> seeds.progress/message/counters/error, meta.hostUid/guestUid, maths, state, round
//   rooms/{code}/rounds/1 -> hostItems[3], guestItems[3], interlude
//
// Local storage keys (optional, for live Gen):
//   geminiKey, qcfgJson, jmathsJson
//
// Visuals: minimal progress card + log; Courier; no ScoreStrip.

import {
  initFirebase, ensureAuth, usingEmu,
  roomRef, roundSubColRef, doc, getDoc, setDoc, updateDoc, onSnapshot, serverTimestamp
} from "../lib/firebase.js";
import * as Gemini from "../lib/gemini.js";
import { startBackgroundQuestionGen } from "../lib/bgGenerator.js";

const clampCode = s => String(s||"").trim().toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,3);
const hp = () => new URLSearchParams((location.hash.split("?")[1]||""));

function el(tag, attrs = {}, kids = []) {
  const n = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (k === "class") n.className = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  (Array.isArray(kids) ? kids : [kids]).forEach(c =>
    n.appendChild(typeof c === "string" ? document.createTextNode(c) : c)
  );
  return n;
}

function readText(...keys){
  for (const k of keys){
    try {
      const v = localStorage.getItem(k);
      if (v && v.trim()) return v.trim();
    } catch {}
  }
  return "";
}

async function ensureRoomSkeleton(code, hostUid) {
  const ref = roomRef(code);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      state: "seeding",
      round: 1,
      meta: { hostUid: hostUid || "", guestUid: "" },
      seeds: { progress: 0, message: "", counters: { approved: 0, rejected: 0 } },
      timestamps: { createdAt: serverTimestamp(), updatedAt: serverTimestamp() }
    }, { merge: true });
  } else if (snap.data()?.state !== "seeding") {
    // reset to seeding if we came back here intentionally
    await updateDoc(ref, {
      state: "seeding",
      "timestamps.updatedAt": serverTimestamp()
    }).catch(()=>{});
  }
}

async function setProgress(code, value, message){
  await updateDoc(roomRef(code), {
    "seeds.progress": value,
    "seeds.message": message || "",
  }).catch(()=>{});
}
async function setCounters(code, patch){
  await updateDoc(roomRef(code), {
    "seeds.counters": patch
  }).catch(()=>{});
}

export default {
  async mount(container){
    await initFirebase();
    const me = await ensureAuth();

    const code = clampCode(hp().get("code") || "");
    // per-view hue
    const hue = Math.floor(Math.random()*360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    // UI
    container.innerHTML = "";
    const root = el("div", { class:"view view-seeding" });
    root.appendChild(el("h1", { class:"title" }, "Preparing your game…"));

    const card = el("div", { class:"card" });
    const status = el("div", { class:"mono", style:"text-align:center;margin-bottom:8px;" }, `Room ${code} • ${usingEmu ? "Emulator" : "Live"}`);
    const progWrap = el("div", { class:"progress-wrap" });
    const prog = el("div", { class:"progress" }, el("div",{class:"bar-bg"}, el("div",{class:"bar"})));
    const percent = el("div", { class:"status mono" }, "0%");
    progWrap.appendChild(prog);
    progWrap.appendChild(percent);
    const logEl = el("pre", { class:"log mono small" });

    const retry = el("button", { class:"btn outline", disabled:"" }, "Retry");
    retry.style.marginTop = "8px";

    card.appendChild(status);
    card.appendChild(progWrap);
    card.appendChild(logEl);
    card.appendChild(retry);
    root.appendChild(card);
    container.appendChild(root);

    const setBar = (v)=>{ const b = card.querySelector(".bar"); b.style.width = `${v}%`; percent.textContent = `${v}%`; };
    const log = (m)=>{ logEl.textContent += (m+"\n"); logEl.scrollTop = logEl.scrollHeight; };

    // Room skeleton
    await ensureRoomSkeleton(code, me.uid);

    // Live follow progress + host/guest attach
    let stop = onSnapshot(roomRef(code), (s) => {
      const d = s.data() || {};
      // attach guest if empty
      const meta = d.meta || {};
      if (!meta.guestUid && me.uid !== meta.hostUid) {
        updateDoc(roomRef(code), { "meta.guestUid": me.uid, "timestamps.updatedAt": serverTimestamp() }).catch(()=>{});
      }
      // progress bar
      const p = Number(d?.seeds?.progress || 0);
      if (!isNaN(p)) setBar(p);
      if (typeof d?.seeds?.message === "string") status.textContent = `Room ${code} • ${usingEmu ? "Emulator" : "Live"} • ${d.seeds.message}`;

      // advance when host flips
      if (d.state === "countdown") {
        setTimeout(()=> location.hash = `#/countdown?code=${code}&round=1`, 150);
      }
    });

    // Host-only seeding run
    const run = async () => {
      retry.disabled = true;

      const ref = roomRef(code);
      const snap = await getDoc(ref);
      const d = snap.data() || {};
      const hostUid = d?.meta?.hostUid || me.uid;
      const amHost = hostUid === me.uid;

      // Guests never seed; they only watch.
      if (!amHost) {
        log("Waiting for host to complete seeding…");
        return;
      }

      // Read local config
      const apiKey = readText("geminiKey", "gemini_key", "gemini_key_pro");
      const qcfgText = readText("qcfgJson","qcfg","seed_questions");
      const jmsText  = readText("jmathsJson","jmaths","seed_maths");

      let qcfg=null, jmaths=null;
      try { qcfg = qcfgText ? JSON.parse(qcfgText) : null; } catch {}
      try { jmaths = jmsText ? JSON.parse(jmsText) : null; } catch {}

      const useGemini = Boolean(apiKey && qcfg && jmaths);

      // Status reset
      await updateDoc(ref, {
        state: "seeding",
        "seeds.progress": 5,
        "seeds.message": "Starting…",
        "seeds.error": "",
        "seeds.counters": { approved: 0, rejected: 0 },
        "timestamps.updatedAt": serverTimestamp()
      }).catch(()=>{});

      try {
        // Round 1 — generate a pool then split into host/guest sets
        await setProgress(code, 10, "Generating Round 1…");
        log("[host] Generating Round 1…");

        let itemsPool = [];
        if (useGemini) {
          const pool = await Gemini.generateItems({ apiKey, qcfg, desiredCount: 12 });
          const ver  = await Gemini.verifyItems({ apiKey, qcfg, items: pool });
          const ok = (ver?.approved || pool || []).filter(it => it?.question && it?.correct_answer);
          if (ok.length < 6) throw new Error("Not enough approved items for Round 1.");
          itemsPool = ok.slice(0, 6);
        } else {
          // Fallback only if host has *no* configs — but keep it host-only, never guest-triggered.
          log("⚠️ Missing key/config — using demo items for Round 1.");
          itemsPool = [
            { question:"Which metal is liquid at room temp?", correct_answer:"Mercury", distractors:{easy:"Iron",medium:"Tin",hard:"Gallium"} },
            { question:"Capital of Canada’s largest province by area?", correct_answer:"Quebec City", distractors:{easy:"Toronto",medium:"Ottawa",hard:"Montreal"} },
            { question:"Largest internal organ?", correct_answer:"Liver", distractors:{easy:"Heart",medium:"Lung",hard:"Spleen"} },
            { question:"Pi rounded to 3 decimal places?", correct_answer:"3.142", distractors:{easy:"3.124",medium:"3.241",hard:"3.132"} },
            { question:"Primary gas in Earth’s atmosphere?", correct_answer:"Nitrogen", distractors:{easy:"Oxygen",medium:"CO₂",hard:"Argon"} },
            { question:"Author of '1984'?", correct_answer:"George Orwell", distractors:{easy:"Huxley",medium:"Steinbeck",hard:"Kafka"} }
          ];
        }

        // Split 3+3 deterministically so players see different questions
        const hostItems  = itemsPool.slice(0,3);
        const guestItems = itemsPool.slice(3,6);

        await setProgress(code, 55, "Writing Round 1…");
        await setDoc(doc(roundSubColRef(code), "1"), {
          hostItems, guestItems,
          interlude: "Round 1 set.",
          createdAt: serverTimestamp()
        }, { merge: true });

        await setCounters(code, { approved: itemsPool.length, rejected: 0 });

        // Maths
        await setProgress(code, 70, "Preparing maths…");
        let maths = null;
        if (useGemini) {
          maths = await Gemini.generateMaths({ apiKey, jmaths, model:"gemini-2.5-flash" });
        } else {
          maths = { location:"DIY shop", beats:["A","B","C","D"], questions:["How many hooks? ___","How much change? ___ euros"], answers:[2,4] };
        }
        await updateDoc(ref, { maths, "timestamps.updatedAt": serverTimestamp() });

        // Background rounds (2–5), fire-and-forget; host-only.
        await setProgress(code, 78, "Starting background rounds…");
        startBackgroundQuestionGen({
          apiKey, code, startRound:2, endRound:5,
          onTick: ({progress, round, message}) => log(`r${round}: ${message} (${progress}%)`)
        }).catch(e => log(`bg error: ${e?.message || e}`));

        // Seed complete → move to countdown (round 1)
        await setProgress(code, 92, "Seeding complete.");
        await updateDoc(ref, {
          state: "countdown",
          round: 1,
          "timestamps.updatedAt": serverTimestamp()
        });

      } catch (e) {
        const msg = e?.message || String(e);
        log(`❌ ${msg}`);
        await updateDoc(ref, { "seeds.error": msg, "timestamps.updatedAt": serverTimestamp() }).catch(()=>{});
        retry.disabled = false;
      }
    };

    retry.addEventListener("click", run);

    // Kick off run if I am host; guests just watch
    try {
      const rs = await getDoc(roomRef(code));
      const hostUid = rs.data()?.meta?.hostUid || "";
      if (hostUid === me.uid) run();
      else log("Waiting for host…");
    } catch {
      log("Waiting for host…");
    }

    this.unmount = () => { try { stop && stop(); } catch{} };
  },

  async unmount(){ /* no-op */ }
};