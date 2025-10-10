// /src/views/Award.js
//
// Award phase — show the player’s three questions with ✓ / ✕ markers and arm the next phase.
// • 30 s timer (bold Courier badge, top-right of card).
// • Displays only the viewer’s own questions (host → hostItems, guest → guestItems) and their chosen answers.
// • Host advances flow when the timer elapses:
//     - Rounds 1–4 → set round+1, countdown.startAt = now + 3000, state:"countdown".
//     - Round 5     → state:"maths".
// • ScoreStrip remains mounted globally, so we only worry about per-round display here.
// • Timer anchor: room.award.startAt (ms epoch). Host writes it once if missing.

import {
  initFirebase,
  ensureAuth,
  roomRef,
  roundSubColRef,
  doc,
  getDoc,
  onSnapshot,
  updateDoc,
  serverTimestamp
} from "../lib/firebase.js";

import * as MathsPaneMod from "../lib/MathsPane.js";
const mountMathsPane =
  (typeof MathsPaneMod?.default === "function" ? MathsPaneMod.default :
   typeof MathsPaneMod?.mount === "function" ? MathsPaneMod.mount :
   typeof MathsPaneMod?.default?.mount === "function" ? MathsPaneMod.default.mount :
   null);

const clampCode = (s) => String(s || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
const hp = () => new URLSearchParams((location.hash.split("?")[1] || ""));

const AWARD_WINDOW_MS = 30_000;

function el(tag, attrs = {}, kids = []) {
  const node = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (k === "class") node.className = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  (Array.isArray(kids) ? kids : [kids]).forEach((child) =>
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child)
  );
  return node;
}

function same(a, b) {
  return String(a || "").trim() === String(b || "").trim();
}

export default {
  async mount(container) {
    await initFirebase();
    const me = await ensureAuth();

    const qs = hp();
    const code = clampCode(qs.get("code") || "");
    let round = parseInt(qs.get("round") || "1", 10) || 1;

    // per-view hue
    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    container.innerHTML = "";
    const root = el("div", { class: "view view-award" });
    const title = el("h1", { class: "title" }, `Round ${round}`);
    root.appendChild(title);

    const card = el("div", { class: "card" });
    const timerBadge = el("div", { class: "timer-badge mono" }, "30");
    card.appendChild(timerBadge);

    const tag = el("div", { class: "mono", style: "text-align:center;margin-bottom:8px;" }, `Room ${code}`);
    card.appendChild(tag);

    const list = el("div", { class: "qa-list" });
    card.appendChild(list);

    root.appendChild(card);

    const mathsMount = el("div", { class: "jemima-maths-pinned" });
    root.appendChild(mathsMount);

    container.appendChild(root);

    const rRef = roomRef(code);
    const rdRef = doc(roundSubColRef(code), String(round));

    const roomSnap = await getDoc(rRef);
    const roomData0 = roomSnap.data() || {};
    const { hostUid, guestUid } = roomData0.meta || {};
    const myRole = hostUid === me.uid ? "host" : guestUid === me.uid ? "guest" : "guest";

    let awardStartAt = Number(roomData0?.award?.startAt || 0) || 0;
    let advanced = false;

    if (Number(roomData0.round)) {
      round = Number(roomData0.round);
      title.textContent = `Round ${round}`;
    }

    try {
      if (mountMathsPane && roomData0.maths) {
        mountMathsPane(mathsMount, { maths: roomData0.maths, round, mode: "inline" });
      }
    } catch (err) {
      console.warn("[award] MathsPane mount failed:", err);
    }

    const rdSnap = await getDoc(rdRef);
    const rd = rdSnap.data() || {};
    const items = (myRole === "host" ? rd.hostItems : rd.guestItems) || [];
    const answers = (((roomData0.answers || {})[myRole] || {})[round] || []).map((a) => a?.chosen || "");

    list.innerHTML = "";
    for (let i = 0; i < 3; i += 1) {
      const q = items[i]?.question || "(missing question)";
      const chosen = answers[i] || "(no answer)";
      const correct = items[i]?.correct_answer || "";
      const truth = correct ? same(chosen, correct) : false;

      const row = el("div", { class: "mark-row" });
      const qEl = el("div", { class: "q mono" }, `${i + 1}. ${q}`);
      const aEl = el("div", { class: "a mono" }, chosen);

      const badge = el("span", {
        class: "mono",
        style: `margin-left:8px;font-weight:700;${truth ? "color:var(--ok);" : "color:var(--bad);"}`
      }, truth ? "✓" : "✕");
      aEl.appendChild(badge);

      row.appendChild(qEl);
      row.appendChild(aEl);

      if (!truth && correct) {
        const corr = el("div", { class: "mono small", style: "margin-top:4px;opacity:.8" }, `Correct: ${correct}`);
        row.appendChild(corr);
      }

      list.appendChild(row);
    }

    const ensureStartAt = async () => {
      if (myRole !== "host") return;
      const now = Date.now();
      const stale = !awardStartAt || now - awardStartAt > AWARD_WINDOW_MS * 2;
      if (!stale) return;

      awardStartAt = Date.now();
      try {
        console.log(`[flow] arm award timer | code=${code} round=${round} role=${myRole}`);
        await updateDoc(rRef, {
          "award.startAt": awardStartAt,
          "timestamps.updatedAt": serverTimestamp()
        });
      } catch (err) {
        console.warn("[award] failed to set startAt:", err);
      }
    };

    await ensureStartAt();

    const advance = async () => {
      if (advanced || myRole !== "host") return;
      advanced = true;

      const patch = { "timestamps.updatedAt": serverTimestamp(), "award.startAt": null };
      if (round >= 5) {
        patch.state = "maths";
        console.log(`[flow] award -> maths | code=${code} round=${round} role=${myRole}`);
      } else {
        const nextRound = round + 1;
        const nextStart = Date.now() + 3_000;
        patch.state = "countdown";
        patch.round = nextRound;
        patch["countdown.startAt"] = nextStart;
        console.log(`[flow] award -> countdown | code=${code} round=${round} role=${myRole} next=${nextRound}`);
      }

      try {
        await updateDoc(rRef, patch);
      } catch (err) {
        console.warn("[award] failed to advance:", err);
        advanced = false; // retry on next tick
      }
    };

    const stop = onSnapshot(rRef, (snap) => {
      const data = snap.data() || {};

      if (Number(data.round) && Number(data.round) !== round) {
        round = Number(data.round);
        title.textContent = `Round ${round}`;
      }

      const remoteStart = Number(data?.award?.startAt || 0) || 0;
      if (remoteStart && remoteStart !== awardStartAt) {
        awardStartAt = remoteStart;
      }

      if (data.state === "countdown") {
        const nextRound = Number(data.round || round + 1);
        setTimeout(() => {
          location.hash = `#/countdown?code=${code}&round=${nextRound}`;
        }, 100);
        return;
      }

      if (data.state === "maths") {
        setTimeout(() => { location.hash = `#/maths?code=${code}`; }, 100);
        return;
      }

      if (data.state === "final") {
        setTimeout(() => { location.hash = `#/final?code=${code}`; }, 100);
        return;
      }

      if (data.state === "marking") {
        // If we landed late, go back to marking for this round.
        setTimeout(() => { location.hash = `#/marking?code=${code}&round=${round}`; }, 100);
      }
    }, (err) => {
      console.warn("[award] snapshot error:", err);
    });

    const tick = setInterval(async () => {
      if (!awardStartAt) {
        timerBadge.textContent = "—";
        await ensureStartAt();
        return;
      }

      const now = Date.now();
      const remainMs = Math.max(0, (awardStartAt + AWARD_WINDOW_MS) - now);
      const secs = Math.ceil(remainMs / 1000);
      timerBadge.textContent = String(secs > 0 ? secs : 0);

      if (remainMs <= 0) {
        await advance();
      }
    }, 200);

    this.unmount = () => {
      try { stop && stop(); } catch {}
      try { clearInterval(tick); } catch {}
    };
  },

  async unmount() { /* instance handles cleanup */ }
};
