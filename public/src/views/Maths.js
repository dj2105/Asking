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
import { PACK_VERSION_MATHS, PACK_VERSION_MATHS_CHAIN } from "../lib/seedUnsealer.js";
import { clampCode, getHashParams, getStoredRole, isChainMaths, isLegacyMaths } from "../lib/util.js";
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

    const card = el("div", { class:"card" });
    const heading = el("h2", { class:"view-heading" }, "Jemima’s Maths");
    const metaStrip = el("div", { class:"meta-strip" });
    const roomChip = el("span", { class:"meta-chip" }, code || "Room" );
    metaStrip.appendChild(roomChip);
    const introNote = el("div", { class:"view-note" }, "Solve both beats, then send them to Jemima." );

    const form = el("div", { class:"maths-form" });

    const chainRow = el("div", { class:"maths-question", style:"display:none;" });
    const chainPrompt = el("div", { class:"mono maths-question__prompt" }, "");
    const chainInput = el("input", { type:"number", class:"input", placeholder:"Final answer (integer)" });
    chainRow.appendChild(chainPrompt);
    chainRow.appendChild(chainInput);

    const row1 = el("div", { class:"maths-question" });
    const q1 = el("div", { class:"mono maths-question__prompt" }, "");
    const i1 = el("input", { type:"number", class:"input", placeholder:"Answer 1 (integer)" });
    row1.appendChild(q1);
    row1.appendChild(i1);

    const row2 = el("div", { class:"maths-question" });
    const q2 = el("div", { class:"mono maths-question__prompt" }, "");
    const i2 = el("input", { type:"number", class:"input", placeholder:"Answer 2 (integer)" });
    row2.appendChild(q2);
    row2.appendChild(i2);

    form.appendChild(chainRow);
    form.appendChild(row1);
    form.appendChild(row2);

    const done = el("button", { class:"btn maths-submit", disabled:"" }, "Send to Jemima");
    const waitMsg = el("div", { class:"mono small wait-note" }, "");
    waitMsg.style.display = "none";

    card.appendChild(heading);
    card.appendChild(metaStrip);
    card.appendChild(introNote);
    card.appendChild(form);
    card.appendChild(done);
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
    const readableName = myRole === "host" ? "Daniel" : "Jaime";
    heading.textContent = `${readableName} — Jemima’s Maths`;
    introNote.textContent = `Finish both answers so ${oppName} can compare.`;
    done.textContent = "Send to Jemima";
    roomChip.textContent = code || "Room";
    waitMsg.textContent = `Waiting for ${oppName}…`;

    // Mount maths pane in "maths" mode; it shows location + both questions
    const mathsData = room0.maths || {};
    let mathsVersion = String(room0?.meta?.mathsVersion || mathsData.version || "").trim();
    if (mathsVersion !== PACK_VERSION_MATHS && mathsVersion !== PACK_VERSION_MATHS_CHAIN) {
      if (isChainMaths(mathsData)) mathsVersion = PACK_VERSION_MATHS_CHAIN;
      else if (isLegacyMaths(mathsData)) mathsVersion = PACK_VERSION_MATHS;
      else mathsVersion = PACK_VERSION_MATHS;
    }

    try {
      if (mountMathsPane && room0.maths) {
        mountMathsPane(mathsMount, {
          maths: room0.maths,
          mode:"maths",
          roomCode: code,
          userUid: me.uid,
          version: mathsVersion,
        });
      }
    }
    catch(e){ console.warn("[maths] MathsPane mount failed:", e); }

    const isChain = mathsVersion === PACK_VERSION_MATHS_CHAIN;
    const M = mathsData;

    if (isChain) {
      heading.textContent = "Jemima’s Maths — Final";
      introNote.textContent = `Put the final number so ${oppName} can compare.`;
      chainRow.style.display = "";
      row1.style.display = "none";
      row2.style.display = "none";
      chainPrompt.textContent = M.question || "";
      chainInput.value = "";
    } else {
      heading.textContent = `${readableName} — Jemima’s Maths`;
      introNote.textContent = `Finish both answers so ${oppName} can compare.`;
      chainRow.style.display = "none";
      row1.style.display = "";
      row2.style.display = "";
      q1.textContent = M.questions?.[0] || "";
      q2.textContent = M.questions?.[1] || "";
      i1.value = "";
      i2.value = "";
    }

    // Enable DONE when required inputs filled
    function validate() {
      if (isChain) {
        const value = chainInput.value.trim();
        const ok = value !== "" && Number.isInteger(Number(value));
        done.disabled = !ok || submitted;
        done.classList.toggle("throb", ok && !submitted);
      } else {
        const a = i1.value.trim();
        const b = i2.value.trim();
        const ok = a !== "" && b !== "" && Number.isInteger(Number(a)) && Number.isInteger(Number(b));
        done.disabled = !ok || submitted;
        done.classList.toggle("throb", ok && !submitted);
      }
    }
    chainInput.addEventListener("input", validate);
    i1.addEventListener("input", validate);
    i2.addEventListener("input", validate);

    let submitted = false;

    async function publish() {
      if (submitted) return;
      submitted = true;

      const patch = {};
      if (isChain) {
        const chainValue = parseInt(chainInput.value.trim(), 10);
        patch[`mathsAnswersChain.${myRole}`] = {
          value: chainValue,
          submittedAt: serverTimestamp(),
        };
      } else {
        const a1 = parseInt(i1.value.trim(), 10);
        const a2 = parseInt(i2.value.trim(), 10);
        patch[`mathsAnswers.${myRole}`] = [a1, a2];
      }
      patch[`mathsAnswersAck.${myRole}`] = true;
      patch["timestamps.updatedAt"] = serverTimestamp();

      try {
        console.log(`[flow] submit maths | code=${code} role=${myRole}`);
        await updateDoc(rRef, patch);
        done.disabled = true;
        done.classList.remove("throb");
        waitMsg.style.display = "";
      } catch (e) {
        console.warn("[maths] publish failed:", e);
        submitted = false; // allow retry
        validate();
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

    validate();
  },

  async unmount() { /* no-op */ }
};