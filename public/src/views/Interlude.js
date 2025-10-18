// /src/views/Interlude.js
//
// Interlude view — brief break between marking and next round
// - Displays one-liner Jemima interlude from Firestore (rounds/{round}.interlude)
// - Host controls the flow: NEXT -> sets state:"countdown", round++
// - Guests just watch for the state change and follow automatically
// - MathsPane pinned at bottom with inverted scheme for continuity

import { ensureAuth, db } from "../lib/firebase.js";
import {
  doc,
  collection,
  getDoc,
  updateDoc,
  onSnapshot,
  serverTimestamp,
} from "firebase/firestore";
import * as MathsPaneMod from "../lib/MathsPane.js";
import { applyTheme } from "../lib/theme.js";

const mountMathsPane =
  (typeof MathsPaneMod?.default === "function" ? MathsPaneMod.default :
   typeof MathsPaneMod?.mount === "function" ? MathsPaneMod.mount :
   typeof MathsPaneMod?.default?.mount === "function" ? MathsPaneMod.default.mount :
   null);

const clampCode = s => String(s||"").trim().toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,3);
const hp = () => new URLSearchParams((location.hash.split("?")[1]||""));

function el(tag, attrs={}, kids=[]){
  const n=document.createElement(tag);
  for(const k in attrs){
    const v=attrs[k];
    if(k==="class")n.className=v;
    else if(k.startsWith("on")&&typeof v==="function")n.addEventListener(k.slice(2),v);
    else n.setAttribute(k,v);
  }
  (Array.isArray(kids)?kids:[kids]).forEach(c=>n.appendChild(typeof c==="string"?document.createTextNode(c):c));
  return n;
}

const roomRef = (code) => doc(db, "rooms", code);
const roundSubColRef = (code) => collection(roomRef(code), "rounds");

export default {
  async mount(container){
    const me = await ensureAuth();

    const qs = hp();
    const code  = clampCode(qs.get("code") || "");
    const round = parseInt(qs.get("round") || "1", 10) || 1;

    applyTheme({ phase: "interlude", round });

    container.innerHTML="";
    const root = el("div",{class:"view view-interlude"});
    root.appendChild(el("h1",{class:"title",style:"text-align:center;font-weight:700"},`Round ${round}`));
    const card = el("div",{class:"card",style:"text-align:center"});
    root.appendChild(card);

    const msg = el("div",{class:"mono",style:"font-size:1.1em;line-height:1.4;margin:20px auto;max-width:400px;white-space:pre-wrap"}, "Loading interlude…");
    card.appendChild(msg);

    const nextBtn = el("button",{class:"btn",disabled:""}, "NEXT");
    card.appendChild(el("div",{style:"text-align:center;margin-top:18px;"},nextBtn));

    // maths pinned below
    const mathsMount = el("div",{class:"jemima-maths-pinned"});
    root.appendChild(mathsMount);
    container.appendChild(root);

    const rRef  = roomRef(code);
    const r1Ref = doc(roundSubColRef(code), String(round));
    const roomSnap = await getDoc(rRef);
    const roomData = roomSnap.data() || {};
    const { hostUid, guestUid } = roomData.meta || {};
    const myRole = (hostUid===me.uid)?"host":(guestUid===me.uid)?"guest":"guest";

    // mount maths if exists
    try {
      if (mountMathsPane && roomData.maths) {
        mountMathsPane(mathsMount, { maths: roomData.maths, round, mode:"inline", roomCode: code, userUid: me.uid });
      }
    } catch(e){ console.warn("MathsPane mount fail", e); }

    // load interlude text
    let interludeText = "Round "+round+" awaits Jemima’s next challenge.";
    try {
      const r1 = await getDoc(r1Ref);
      const d1 = r1.data() || {};
      if (d1.interlude) interludeText = d1.interlude;
      else if (roomData.interlude) interludeText = roomData.interlude;
      else if (roomData.maths?.interlude) interludeText = roomData.maths.interlude;
    } catch(e){ console.warn("Interlude load failed:", e); }

    msg.textContent = interludeText;

    // host can click next
    if (myRole === "host") {
      nextBtn.disabled = false;
      nextBtn.classList.add("throb");
      nextBtn.addEventListener("click", async () => {
        nextBtn.disabled = true;
        nextBtn.classList.remove("throb");

        try {
          const nextRound = round + 1;
          // Determine next state: after round 5 → maths, else countdown
          const nextState = nextRound > 5 ? "maths" : "countdown";
          const patch = {
            state: nextState,
            round: nextRound,
            "timestamps.updatedAt": serverTimestamp()
          };
          // Remove any leftover countdown.startAt
          patch["countdown"] = {};
          await updateDoc(rRef, patch);
        } catch(e){
          console.error("Host NEXT failed:", e);
          nextBtn.disabled = false;
          nextBtn.classList.add("throb");
        }
      });
    } else {
      // guests wait
      nextBtn.disabled = true;
      nextBtn.textContent = "WAITING…";
    }

    // watch room for state flips
    const stop = onSnapshot(rRef, s => {
      const d = s.data() || {};
      const st = d.state;
      const r  = d.round;
      if (st === "countdown") {
        setTimeout(()=>location.hash=`#/countdown?code=${code}&round=${r}`,100);
      } else if (st === "maths") {
        setTimeout(()=>location.hash=`#/maths?code=${code}`,100);
      }
    });

    this.unmount = ()=>{ try{stop();}catch{} };
  },
  async unmount(){}
};
