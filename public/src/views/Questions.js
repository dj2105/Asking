// /src/views/Questions.js
//
// Questions phase — local-only until the 3rd selection.
// • Shows exactly the player’s three questions from rooms/{code}/rounds/{round}/{role}Items.
// • Two large buttons per question. Selecting the 3rd answer auto-submits once.
// • Submission writes answers.{role}.{round} = [{ chosen }, …] and timestamps.updatedAt.
// • Host watches both submissions and flips state → "marking".
// • Local UI keeps selections in memory only; Firestore only written on submission.

import { ensureAuth, db } from "../lib/firebase.js";
import {
  doc,
  collection,
  getDoc,
  setDoc,
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

const roundTier = (r) => (r <= 1 ? "easy" : r === 2 ? "medium" : "hard");

function el(tag, attrs = {}, kids = []) {
  const n = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (k === "class") n.className = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  (Array.isArray(kids) ? kids : [kids]).forEach((c) =>
    n.appendChild(typeof c === "string" ? document.createTextNode(c) : c)
  );
  return n;
}

function shuffle2(a, b) {
  return Math.random() < 0.5 ? [a, b] : [b, a];
}

const roomRef = (code) => doc(db, "rooms", code);
const roundSubColRef = (code) => collection(roomRef(code), "rounds");

export default {
  async mount(container) {
    const me = await ensureAuth();

    const params = getHashParams();
    const code = clampCode(params.get("code") || "");
    const requestedRound = parseInt(params.get("round") || "", 10);
    let round = Number.isFinite(requestedRound) && requestedRound > 0 ? requestedRound : null;

    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    container.innerHTML = "";
    const root = el("div", { class: "view view-questions" });
    const title = el("h1", { class: "title" }, `Round ${round || "—"}`);
    root.appendChild(title);

    const card = el("div", { class: "card" });
    const topRow = el("div", { class: "mono", style: "display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;" });
    const roomTag = el("div", {}, `Room ${code}`);
    const counter = el("div", { class: "mono" }, "1 / 3");
    topRow.appendChild(roomTag);
    topRow.appendChild(counter);
    card.appendChild(topRow);

    const qText = el("div", { class: "mono", style: "font-weight:600; white-space:pre-wrap; min-height:56px;" }, "");
    card.appendChild(qText);

    const btnWrap = el("div", { style: "display:flex;gap:10px;justify-content:center;margin-top:12px;flex-wrap:wrap;" });
    const btn1 = el("button", { class: "btn big outline" }, "");
    const btn2 = el("button", { class: "btn big outline" }, "");
    btnWrap.appendChild(btn1);
    btnWrap.appendChild(btn2);
    card.appendChild(btnWrap);

    const waitMsg = el("div", { class: "mono", style: "text-align:center;opacity:.8;margin-top:12px;display:none;" }, "Waiting for opponent…");
    card.appendChild(waitMsg);

    root.appendChild(card);

    const mathsMount = el("div", { class: "jemima-maths-pinned" });
    root.appendChild(mathsMount);

    container.appendChild(root);

    let stopWatcher = null;
    let alive = true;
    this.unmount = () => {
      alive = false;
      try { stopWatcher && stopWatcher(); } catch {}
    };

    const rRef = roomRef(code);

    const roomSnap0 = await getDoc(rRef);
    const room0 = roomSnap0.data() || {};
    if (!round) {
      const roomRound = Number(room0.round);
      round = Number.isFinite(roomRound) && roomRound > 0 ? roomRound : 1;
    }
    title.textContent = `Round ${round}`;
    roomTag.textContent = `Room ${code}`;

    const rdRef = doc(roundSubColRef(code), String(round));
    const playerRef = doc(roomRef(code), "players", me.uid);
    const { hostUid, guestUid } = room0.meta || {};
    const storedRole = getStoredRole(code);
    const myRole = storedRole === "host" || storedRole === "guest"
      ? storedRole
      : hostUid === me.uid ? "host" : guestUid === me.uid ? "guest" : "guest";
    const oppRole = myRole === "host" ? "guest" : "host";
    const roleName = (role) => (role === "host" ? "Daniel" : "Jaime");
    const oppName = roleName(oppRole);

    try {
      if (mountMathsPane && room0.maths) {
        mountMathsPane(mathsMount, { maths: room0.maths, round, mode: "inline", roomCode: code, userUid: me.uid });
      }
    } catch (err) {
      console.warn("[questions] MathsPane mount failed:", err);
    }

    const existingAns = (((room0.answers || {})[myRole] || {})[round] || []);
    let qDoneMsLocal = null;

    const setButtonsEnabled = (enabled) => {
      btn1.disabled = !enabled;
      btn2.disabled = !enabled;
      btn1.classList.toggle("throb", enabled);
      btn2.classList.toggle("throb", enabled);
    };

    const waitForRoundData = async () => {
      let firstWait = true;
      while (alive) {
        try {
          const snap = await getDoc(rdRef);
          if (snap.exists()) return snap.data() || {};
        } catch (err) {
          console.warn("[questions] failed to load round doc:", err);
        }
        if (firstWait) {
          waitMsg.textContent = "Waiting for round data…";
          waitMsg.style.display = "";
          btnWrap.style.display = "none";
          setButtonsEnabled(false);
          firstWait = false;
        }
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      return {};
    };

    const rd = await waitForRoundData();
    if (!alive) return;

    const myItems = (myRole === "host" ? rd.hostItems : rd.guestItems) || [];

    const tier = roundTier(round);
    const triplet = [0, 1, 2].map((i) => {
      const it = myItems[i] || {};
      const correct = it.correct_answer || "";
      const distractors = it.distractors || {};
      const wrong = distractors[tier] || distractors.medium || distractors.easy || distractors.hard || "";
      const [optA, optB] = shuffle2(correct, wrong);
      return { question: it.question || "", options: [optA, optB], correct };
    });

    let idx = 0;
    const chosen = [];
    let published = false;
    let submitting = false;

    function renderIndex() {
      const cur = triplet[idx];
      counter.textContent = `${Math.min(idx + 1, 3)} / 3`;
      qText.textContent = cur?.question || "";
      btn1.textContent = cur?.options?.[0] || "";
      btn2.textContent = cur?.options?.[1] || "";
    }

    const showWaitingState = (text = "Waiting for opponent…") => {
      btnWrap.style.display = "none";
      waitMsg.textContent = text;
      waitMsg.style.display = "";
      setButtonsEnabled(false);
    };

    const updateWaitingCopy = (roomData = {}) => {
      if (!published) return;
      const submittedOpp = Boolean(((roomData.submitted || {})[oppRole] || {})[round])
        || (Array.isArray(((roomData.answers || {})[oppRole] || {})[round])
          && (((roomData.answers || {})[oppRole] || {})[round]).length === 3);
      if (!submittedOpp) {
        waitMsg.textContent = `You finished first, waiting for ${oppName}…`;
      } else {
        waitMsg.textContent = "Waiting for opponent…";
      }
    };

    async function publishAnswers() {
      if (submitting || published) return;
      submitting = true;

      const payload = triplet.map((entry, idx) => ({
        question: entry.question || "",
        chosen: chosen[idx] || "",
        correct: entry.correct || "",
      }));
      const patch = {
        [`answers.${myRole}.${round}`]: payload,
        [`submitted.${myRole}.${round}`]: true,
        "timestamps.updatedAt": serverTimestamp()
      };

      try {
        console.log(`[flow] submit answers | code=${code} round=${round} role=${myRole}`);
        await updateDoc(rRef, patch);
        published = true;
        showWaitingState();
        updateWaitingCopy(room0);
      } catch (err) {
        console.warn("[questions] publish failed:", err);
        submitting = false;
        setButtonsEnabled(true);
      }
    }

    const recordQuestionTiming = (ms) => {
      if (!ms) return;
      qDoneMsLocal = ms;
      const roundTimingPatch = { timings: { [me.uid]: { qDoneMs: ms, role: myRole } } };
      setDoc(rdRef, roundTimingPatch, { merge: true }).catch((err) => {
        console.warn("[questions] failed to write round timing:", err);
      });
      const playerTimingPatch = { rounds: { [round]: { timings: { qDoneMs: ms, role: myRole } } } };
      setDoc(playerRef, playerTimingPatch, { merge: true }).catch((err) => {
        console.warn("[questions] failed to mirror player timing:", err);
      });
    };

    function onPick(text) {
      if (published || submitting) return;
      chosen[idx] = text;
      idx += 1;
      if (idx >= 3) {
        counter.textContent = "3 / 3";
        setButtonsEnabled(false);
        if (!qDoneMsLocal) {
          const stamp = Date.now();
          recordQuestionTiming(stamp);
        }
        publishAnswers();
      } else {
        renderIndex();
      }
    }

    btn1.addEventListener("click", () => onPick(btn1.textContent));
    btn2.addEventListener("click", () => onPick(btn2.textContent));

    const tripletReady = triplet.every((entry) =>
      entry.question && entry.options && entry.options.length === 2
    );

    if (!tripletReady) {
      btnWrap.style.display = "none";
      waitMsg.textContent = "Preparing questions…";
      waitMsg.style.display = "";
    } else if (existingAns.length === 3) {
      published = true;
      showWaitingState("Submitted. Waiting for opponent…");
      counter.textContent = "3 / 3";
      qText.textContent = triplet[2]?.question || "";
    } else {
      btnWrap.style.display = "flex";
      waitMsg.style.display = "none";
      setButtonsEnabled(true);
      renderIndex();
    }

    stopWatcher = onSnapshot(rRef, async (snap) => {
      const data = snap.data() || {};

      if (data.state === "marking") {
        setTimeout(() => {
          location.hash = `#/marking?code=${code}&round=${round}`;
        }, 80);
        return;
      }

      if (data.state === "countdown") {
        setTimeout(() => {
          location.hash = `#/countdown?code=${code}&round=${data.round || round}`;
        }, 80);
        return;
      }

      if (data.state === "award") {
        setTimeout(() => {
          location.hash = `#/award?code=${code}&round=${round}`;
        }, 80);
      }

      updateWaitingCopy(data);

      // Host monitors opponent completion to flip state (idempotent)
      if (myRole === "host" && data.state === "questions") {
        const myDone = Boolean(((data.submitted || {})[myRole] || {})[round]) || (Array.isArray(((data.answers || {})[myRole] || {})[round]) && (((data.answers || {})[myRole] || {})[round]).length === 3);
        const oppDone = Boolean(((data.submitted || {})[oppRole] || {})[round]) || (Array.isArray(((data.answers || {})[oppRole] || {})[round]) && (((data.answers || {})[oppRole] || {})[round]).length === 3);
        if (myDone && oppDone) {
          try {
            console.log(`[flow] questions -> marking | code=${code} round=${round} role=${myRole}`);
            await updateDoc(rRef, {
              state: "marking",
              "marking.startAt": Date.now(),
              "timestamps.updatedAt": serverTimestamp()
            });
          } catch (err) {
            console.warn("[questions] failed to flip to marking:", err);
          }
        }
      }
    }, (err) => {
      console.warn("[questions] snapshot error:", err);
    });

    this.unmount = () => {
      alive = false;
      try { stopWatcher && stopWatcher(); } catch {}
    };
  },

  async unmount() { /* instance handles cleanup */ }
};
