// /src/views/Maths.js
//
// Final “Jemima’s Maths” round (after Award of round 5).
// • Shows two integer-answer inputs (no timer per your spec).
// • The pinned MathsPane (inverted) lists the location + both questions consistently.
// • Local-first: user types both answers, presses DONE (throbbing after both filled).
// • Writes once, then waits for opponent. Host flips state → "final" when both present.
// • ScoreStrip remains visible (router keeps it mounted).
//
// Firestore reads:
//   rooms/{code} -> meta(hostUid,guestUid), maths, mathsAnswers.*, state
//
// Firestore writes (on submit):
//   mathsAnswers.{role} = [int,int]
//   mathsAnswersAck.{role} = true
//   timestamps.updatedAt
//
// Navigation:
//   • When host detects both acks, host sets state:"final"; both navigate to /final?code=...
//
// Query: ?code=ABC

import { ensureAuth, db } from "../lib/firebase.js";
import {
  doc,
  getDoc,
  updateDoc,
  onSnapshot,
  serverTimestamp,
} from "firebase/firestore";

import * as MathsPaneMod from "../lib/MathsPane.js";
import { clampCode, getHashParams, getStoredRole } from "../lib/util.js";
const mountMathsPane =
  (typeof MathsPaneMod?.default === "function" ? MathsPaneMod.default :
   typeof MathsPaneMod?.mount === "function" ? MathsPaneMod.mount :
   typeof MathsPaneMod?.default?.mount === "function" ? MathsPaneMod.default.mount :
   null);

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

const roomRef = (code) => doc(db, "rooms", code);

export default {
  async mount(container) {
    const me = await ensureAuth();

    const params = getHashParams();
    const code = clampCode(params.get("code") || "");

    // Per-view ink hue
    const hue = Math.floor(Math.random()*360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    // Skeleton
    container.innerHTML = "";
    const root = el("div", { class:"view view-maths" });
    root.appendChild(el("h1", { class:"title" }, "Jemima’s Maths"));

    const card = el("div", { class:"card" });

    const form = el("div", {});
    const row1 = el("div", { class:"mono", style:"margin-top:6px;" });
    const row2 = el("div", { class:"mono", style:"margin-top:10px;" });

    const q1 = el("div", { class:"mono", style:"font-weight:600; white-space:pre-wrap;" }, "");
    const i1 = el("input", { type:"number", class:"input", placeholder:"Answer 1 (integer)" });
    row1.appendChild(q1);
    row1.appendChild(i1);

    const q2 = el("div", { class:"mono", style:"font-weight:600; white-space:pre-wrap; margin-top:10px;" }, "");
    const i2 = el("input", { type:"number", class:"input", placeholder:"Answer 2 (integer)" });
    row2.appendChild(q2);
    row2.appendChild(i2);

    form.appendChild(row1);
    form.appendChild(row2);

    const done = el("button", { class:"btn", style:"width:100%;margin-top:12px;", disabled:"" }, "DONE");
    card.appendChild(form);
    card.appendChild(done);

    const waitMsg = el("div", { class:"mono", style:"text-align:center;opacity:.8;margin-top:10px;display:none;" }, "");
    card.appendChild(waitMsg);

    root.appendChild(card);

    // Pinned maths box
    const mathsMount = el("div", { class:"jemima-maths-pinned" });
    root.appendChild(mathsMount);

    container.appendChild(root);

    // Room + role + maths payload
    const rRef = roomRef(code);
    const roomSnap0 = await getDoc(rRef);
    const room0 = roomSnap0.data() || {};
    const { hostUid, guestUid } = room0.meta || {};
    const storedRole = getStoredRole(code);
    const myRole  = (storedRole === "host" || storedRole === "guest")
      ? storedRole
      : (hostUid === me.uid) ? "host" : (guestUid === me.uid) ? "guest" : "guest";
    const oppRole = myRole === "host" ? "guest" : "host";
    const oppName = oppRole === "host" ? "Daniel" : "Jaime";
    waitMsg.textContent = `Waiting for ${oppName}…`;

    // Mount maths pane in "maths" mode; it shows location + both questions
    try {
      if (mountMathsPane && room0.maths) {
        mountMathsPane(mathsMount, { maths: room0.maths, mode:"maths", roomCode: code, userUid: me.uid });
      }
    }
    catch(e){ console.warn("[maths] MathsPane mount failed:", e); }

    const M = room0.maths || { questions: ["", ""] };
    q1.textContent = M.questions?.[0] || "";
    q2.textContent = M.questions?.[1] || "";

    // Enable DONE when both filled
    function validate() {
      const a = i1.value.trim();
      const b = i2.value.trim();
      const ok = a !== "" && b !== "" && Number.isInteger(Number(a)) && Number.isInteger(Number(b));
      done.disabled = !ok;
      done.classList.toggle("throb", ok);
    }
    i1.addEventListener("input", validate);
    i2.addEventListener("input", validate);

    let submitted = false;

    async function publish() {
      if (submitted) return;
      submitted = true;

      const a1 = parseInt(i1.value.trim(), 10);
      const a2 = parseInt(i2.value.trim(), 10);

      const patch = {};
      patch[`mathsAnswers.${myRole}`] = [a1, a2];
      patch[`mathsAnswersAck.${myRole}`] = true;
      patch["timestamps.updatedAt"] = serverTimestamp();

      try {
        console.log(`[flow] submit maths | code=${code} role=${myRole}`);
        await updateDoc(rRef, patch);
        done.disabled = true;
        done.classList.remove("throb");
        waitMsg.textContent = `Waiting for ${oppName}…`;
        waitMsg.style.display = "";
      } catch (e) {
        console.warn("[maths] publish failed:", e);
        submitted = false; // allow retry
      }
    }

    done.addEventListener("click", publish);

    // Watch to proceed to Final when both acks present (host-only flip)
    const stop = onSnapshot(rRef, async (s) => {
      const d = s.data() || {};
      if (d.state === "final") {
        setTimeout(() => { location.hash = `#/final?code=${code}`; }, 80);
        return;
      }
      if (myRole === "host") {
        const myAck  = !!(((d.mathsAnswersAck||{})[myRole]) );
        const oppAck = !!(((d.mathsAnswersAck||{})[oppRole]) );
        if (myAck && oppAck && d.state !== "final") {
          try {
            await updateDoc(rRef, { state: "final", "timestamps.updatedAt": serverTimestamp() });
          } catch {}
        }
      }
    });

    this.unmount = () => { try { stop(); } catch{} };
  },

  async unmount() { /* no-op */ }
};