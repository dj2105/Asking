// /src/views/Marking.js
//
// Marking phase — judge opponent answers with a 30s shared timer.
// • Shows exactly three rows (opponent questions + their chosen answers).
// • Verdict buttons: ✓ (definitely right) / ✕ (absolutely wrong). No "unknown" button; leaving blank defaults to 0.
// • Timer anchored to room.marking.startAt. Host writes it if absent.
// • Submission writes marking.{role}.{round} (array of verdict strings) and markingAck.{role}.{round} = true.
// • Host advances to award once both acks present or timer elapses.

import {
  initFirebase,
  ensureAuth,
  roomRef,
  roundSubColRef,
  doc,
  getDoc,
  onSnapshot,
  updateDoc,
  serverTimestamp,
  runTransaction
} from "../lib/firebase.js";

import * as MathsPaneMod from "../lib/MathsPane.js";
import { clampCode, getHashParams, getStoredRole, timeUntil } from "../lib/util.js";
const mountMathsPane =
  (typeof MathsPaneMod?.default === "function" ? MathsPaneMod.default :
   typeof MathsPaneMod?.mount === "function" ? MathsPaneMod.mount :
   typeof MathsPaneMod?.default?.mount === "function" ? MathsPaneMod.default.mount :
   null);

const VERDICT = { RIGHT: "right", WRONG: "wrong" };
const MARKING_WINDOW_MS = 30_000;

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
    const { db } = await initFirebase();
    const me = await ensureAuth();

    const params = getHashParams();
    const code = clampCode(params.get("code") || "");
    const round = parseInt(params.get("round") || "1", 10) || 1;

    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    container.innerHTML = "";
    const root = el("div", { class: "view view-marking" });
    root.appendChild(el("h1", { class: "title" }, `Round ${round}`));

    const card = el("div", { class: "card" });
    const timerBadge = el("div", { class: "timer-badge mono" }, "30");
    card.appendChild(timerBadge);

    const tag = el("div", { class: "mono", style: "text-align:center;margin-bottom:8px;" }, `Room ${code}`);
    card.appendChild(tag);

    const list = el("div", { class: "qa-list" });
    card.appendChild(list);

    const waitMsg = el("div", {
      class: "mono small",
      style: "text-align:center;margin-top:12px;opacity:.75;display:none;"
    }, "Waiting for opponent…");
    card.appendChild(waitMsg);

    root.appendChild(card);

    const mathsMount = el("div", { class: "jemima-maths-pinned" });
    root.appendChild(mathsMount);

    container.appendChild(root);

    const rRef = roomRef(code);
    const rdRef = doc(roundSubColRef(code), String(round));

    const roomSnap = await getDoc(rRef);
    const roomData0 = roomSnap.data() || {};
    const { hostUid, guestUid } = roomData0.meta || {};
    const storedRole = getStoredRole(code);
    const myRole = storedRole === "host" || storedRole === "guest"
      ? storedRole
      : hostUid === me.uid ? "host" : guestUid === me.uid ? "guest" : "guest";
    const oppRole = myRole === "host" ? "guest" : "host";

    let markingStartAt = Number(roomData0?.marking?.startAt || 0) || 0;
    let published = false;
    let stopRoomWatch = null;
    let tickHandle = null;
    let promoting = false;

    try {
      if (mountMathsPane && roomData0.maths) {
        mountMathsPane(mathsMount, { maths: roomData0.maths, round, mode: "inline" });
      }
    } catch (err) {
      console.warn("[marking] MathsPane mount failed:", err);
    }

    const rdSnap = await getDoc(rdRef);
    const rd = rdSnap.data() || {};
    const oppItems = (oppRole === "host" ? rd.hostItems : rd.guestItems) || [];
    const oppAnswers = (((roomData0.answers || {})[oppRole] || {})[round] || []).map((a) => a?.chosen || "");

    let marks = [null, null, null];
    const disableFns = [];

    const maybeSubmitIfComplete = () => {
      if (!marks.includes(null)) publish();
    };

    const buildRow = (idx, question, chosen) => {
      const row = el("div", { class: "mark-row" });
      row.appendChild(el("div", { class: "q mono" }, `${idx + 1}. ${question || "(missing question)"}`));
      row.appendChild(el("div", { class: "a mono" }, chosen || "(no answer recorded)"));

      const pair = el("div", { class: "verdict-row" });
      const btnRight = el("button", { class: "btn outline choice-tick" }, "✓ He's right");
      const btnWrong = el("button", { class: "btn outline choice-cross" }, "✕ Totally wrong");

      const reflect = () => {
        btnRight.classList.toggle("active", marks[idx] === VERDICT.RIGHT);
        btnWrong.classList.toggle("active", marks[idx] === VERDICT.WRONG);
      };

      btnRight.addEventListener("click", () => {
        marks[idx] = VERDICT.RIGHT;
        reflect();
        maybeSubmitIfComplete();
      });
      btnWrong.addEventListener("click", () => {
        marks[idx] = VERDICT.WRONG;
        reflect();
        maybeSubmitIfComplete();
      });

      pair.appendChild(btnRight);
      pair.appendChild(btnWrong);
      row.appendChild(pair);

      disableFns.push(() => {
        btnRight.disabled = true;
        btnWrong.disabled = true;
        btnRight.classList.remove("throb");
        btnWrong.classList.remove("throb");
      });

      return row;
    };

    list.innerHTML = "";
    for (let i = 0; i < 3; i += 1) {
      const q = oppItems[i]?.question || "";
      const chosen = oppAnswers[i] || "";
      list.appendChild(buildRow(i, q, chosen));
    }

    const publish = async () => {
      if (published) return;
      published = true;

      marks = marks.map((v) => (v === VERDICT.RIGHT ? VERDICT.RIGHT : VERDICT.WRONG));
      disableFns.forEach((fn) => { try { fn(); } catch {} });
      waitMsg.textContent = "Waiting for opponent…";
      waitMsg.style.display = "";

      const patch = {};
      patch[`marking.${myRole}.${round}`] = marks.slice();
      patch[`markingAck.${myRole}.${round}`] = true;
      patch["timestamps.updatedAt"] = serverTimestamp();

      try {
        console.log(`[flow] submit marking | code=${code} round=${round} role=${myRole}`);
        await updateDoc(rRef, patch);
      } catch (err) {
        console.warn("[marking] publish failed:", err);
        published = false;
        waitMsg.style.display = "none";
      }
    };

    const promoteToAward = async (force = false) => {
      if (promoting) return;
      promoting = true;
      try {
        await runTransaction(db, async (tx) => {
          const snap = await tx.get(rRef);
          if (!snap.exists()) return;
          const data = snap.data() || {};
          if ((data.state || "").toLowerCase() !== "marking") return;

          const ackHost = Boolean(((data.markingAck || {}).host || {})[round]);
          const ackGuest = Boolean(((data.markingAck || {}).guest || {})[round]);
          if (!(ackHost && ackGuest) && !force) return;

          const answersHost = (((data.answers || {}).host || {})[round] || []);
          const answersGuest = (((data.answers || {}).guest || {})[round] || []);
          const countCorrect = (arr) => arr.reduce((acc, ans) =>
            acc + (same(ans?.chosen, ans?.correct) ? 1 : 0), 0);
          const roundHost = countCorrect(answersHost);
          const roundGuest = countCorrect(answersGuest);

          const baseScores = ((data.scores || {}).questions) || {};
          const currentHost = Number(baseScores.host || 0);
          const currentGuest = Number(baseScores.guest || 0);

          console.log(`[flow] marking -> award | code=${code} round=${round}`);
          tx.update(rRef, {
            state: "award",
            "scores.questions.host": currentHost + roundHost,
            "scores.questions.guest": currentGuest + roundGuest,
            "marking.startAt": null,
            "timestamps.updatedAt": serverTimestamp(),
          });
        });
      } catch (err) {
        console.warn("[marking] failed to promote to award:", err);
      } finally {
        promoting = false;
      }
    };

    if (Array.isArray(((roomData0.marking || {})[myRole] || {})[round])) {
      // Already submitted earlier — show waiting state immediately
      marks = (((roomData0.marking || {})[myRole] || {})[round] || []).slice();
      marks = marks.map((v) => (v === VERDICT.RIGHT ? VERDICT.RIGHT : VERDICT.WRONG));
      published = true;
      disableFns.forEach((fn) => { try { fn(); } catch {} });
      waitMsg.textContent = "Waiting for opponent…";
      waitMsg.style.display = "";
    }

    if (!markingStartAt && myRole === "host") {
      try {
        markingStartAt = Date.now();
        console.log(`[flow] arm marking timer | code=${code} round=${round} role=${myRole}`);
        await updateDoc(rRef, {
          "marking.startAt": markingStartAt,
          "timestamps.updatedAt": serverTimestamp()
        });
      } catch (err) {
        console.warn("[marking] failed to set startAt:", err);
      }
    }

    stopRoomWatch = onSnapshot(rRef, async (snap) => {
      const data = snap.data() || {};

      if (!markingStartAt && data?.marking?.startAt) {
        markingStartAt = Number(data.marking.startAt);
      }

      if (data.state === "award") {
        setTimeout(() => {
          location.hash = `#/award?code=${code}&round=${round}`;
        }, 80);
        return;
      }

      if (data.state === "countdown") {
        setTimeout(() => {
          location.hash = `#/countdown?code=${code}&round=${data.round || round}`;
        }, 80);
        return;
      }

      if (data.state === "maths") {
        setTimeout(() => { location.hash = `#/maths?code=${code}`; }, 80);
        return;
      }

      if (myRole === "host") {
        const myAck = Boolean(((data.markingAck || {})[myRole] || {})[round]);
        const oppAck = Boolean(((data.markingAck || {})[oppRole] || {})[round]);
        const elapsed = markingStartAt && timeUntil(markingStartAt + MARKING_WINDOW_MS) <= 0;

        if ((myAck && oppAck) || elapsed) {
          promoteToAward(!myAck || !oppAck);
        }
      }
    }, (err) => {
      console.warn("[marking] snapshot error:", err);
    });

    tickHandle = setInterval(async () => {
      if (!markingStartAt) {
        timerBadge.textContent = "—";
        return;
      }

      const remainMs = Math.max(0, timeUntil(markingStartAt + MARKING_WINDOW_MS));
      const secs = Math.ceil(remainMs / 1000);
      timerBadge.textContent = String(secs > 0 ? secs : 0);

      if (remainMs <= 0) {
        await publish();
      }
    }, 200);

    this.unmount = () => {
      try { stopRoomWatch && stopRoomWatch(); } catch {}
      if (tickHandle) { try { clearInterval(tickHandle); } catch {} }
    };
  },

  async unmount() { /* instance cleanup handled above */ }
};
