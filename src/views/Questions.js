// /src/views/Questions.js
//
// Questions phase — local-only until the 3rd selection.
// • Shows exactly the player’s three questions from rooms/{code}/rounds/{round}/{role}Items.
// • Two large buttons per question. Selecting the 3rd answer auto-submits once.
// • Submission writes answers.{role}.{round} = [{ chosen }, …] and timestamps.updatedAt.
// • Host watches both submissions and flips state → "marking".
// • Local UI keeps selections in memory only; Firestore only written on submission.

import {
  initFirebase,
  ensureAuth,
  roomRef,
  roundSubColRef,
  doc,
  getDoc,
  updateDoc,
  onSnapshot,
  serverTimestamp
} from "../lib/firebase.js";

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

export default {
  async mount(container) {
    await initFirebase();
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

    const qText = el("textarea", {
      class: "mono question-area",
      readonly: "",
      style: "font-weight:600;min-height:64px;resize:vertical;padding:12px;border-radius:12px;border:1px solid rgba(0,0,0,0.25);background:rgba(0,0,0,0.02);width:100%;",
    }, "");
    card.appendChild(qText);

    const btnWrap = el("div", { style: "display:flex;gap:10px;justify-content:center;margin-top:12px;flex-wrap:wrap;width:100%;align-items:stretch;" });
    const btn1 = el("button", { class: "btn big outline" }, "");
    const btn2 = el("button", { class: "btn big outline" }, "");
    btnWrap.appendChild(btn1);
    btnWrap.appendChild(btn2);
    card.appendChild(btnWrap);

    function syncButtonWidths() {
      requestAnimationFrame(() => {
        if (!btnWrap || btnWrap.offsetParent === null) return;
        btn1.style.minWidth = "";
        btn2.style.minWidth = "";
        const w1 = btn1.getBoundingClientRect().width;
        const w2 = btn2.getBoundingClientRect().width;
        const max = Math.max(w1, w2);
        if (max > 0) {
          const target = Math.ceil(max);
          btn1.style.minWidth = `${target}px`;
          btn2.style.minWidth = `${target}px`;
        }
      });
    }

    const handleResize = () => syncButtonWidths();
    window.addEventListener("resize", handleResize);

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
      window.removeEventListener("resize", handleResize);
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
    const { hostUid, guestUid } = room0.meta || {};
    const storedRole = getStoredRole(code);
    const myRole = storedRole === "host" || storedRole === "guest"
      ? storedRole
      : hostUid === me.uid ? "host" : guestUid === me.uid ? "guest" : "guest";
    const oppRole = myRole === "host" ? "guest" : "host";

    try {
      if (mountMathsPane && room0.maths) {
        mountMathsPane(mathsMount, { maths: room0.maths, round, mode: "inline" });
      }
    } catch (err) {
      console.warn("[questions] MathsPane mount failed:", err);
    }

    const existingAns = (((room0.answers || {})[myRole] || {})[round] || []);

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
    const normalizedItems = Array.isArray(myItems) ? myItems.filter(Boolean) : [];
    const safeItems = normalizedItems.length ? normalizedItems.slice() : [{}, {}, {}];
    if (!normalizedItems.length) {
      safeItems[0] = {};
      safeItems[1] = {};
      safeItems[2] = {};
    }
    while (safeItems.length < 3) {
      const src = normalizedItems.length
        ? normalizedItems[safeItems.length % normalizedItems.length] || {}
        : {};
      safeItems.push(src ? { ...src } : {});
    }

    const fillerQuestion = (slot) => `Jemima spins a filler challenge ${round}-${slot + 1}.`;
    const fillerOption = (slot, label) => `Choice ${label} ${round}-${slot + 1}`;

    const triplet = [0, 1, 2].map((i) => {
      const it = safeItems[i] || {};
      const baseQuestion = typeof it.question === "string" ? it.question.trim() : "";
      const question = baseQuestion || fillerQuestion(i);
      const distractors = it.distractors || {};
      const baseCorrect = typeof it.correct_answer === "string" ? it.correct_answer.trim() : "";
      const correct = baseCorrect || fillerOption(i, "A");
      let wrong = "";
      const maybe = [distractors[tier], distractors.medium, distractors.easy, distractors.hard];
      for (const candidate of maybe) {
        if (typeof candidate === "string" && candidate.trim()) {
          wrong = candidate.trim();
          break;
        }
      }
      if (!wrong || wrong === correct) {
        wrong = wrong === correct ? fillerOption(i, "B+") : fillerOption(i, "B");
        if (wrong === correct) wrong = `${wrong} alt`;
      }
      const [optA, optB] = shuffle2(correct, wrong);
      return { question, options: [optA, optB], correct };
    });

    let idx = 0;
    const chosen = [];
    let published = false;
    let submitting = false;

    function renderIndex() {
      const cur = triplet[idx] || { question: "", options: ["", ""], correct: "" };
      counter.textContent = `${Math.min(idx + 1, 3)} / 3`;
      qText.value = cur.question || "";
      qText.scrollTop = 0;
      btn1.textContent = cur.options?.[0] || "";
      btn2.textContent = cur.options?.[1] || "";
      btnWrap.style.display = "flex";
      waitMsg.style.display = "none";
      setButtonsEnabled(true);
      syncButtonWidths();
    }

    const showWaitingState = (text = "Waiting for opponent…") => {
      btnWrap.style.display = "none";
      waitMsg.textContent = text;
      waitMsg.style.display = "";
      setButtonsEnabled(false);
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
      } catch (err) {
        console.warn("[questions] publish failed:", err);
        submitting = false;
        setButtonsEnabled(true);
      }
    }

    function onPick(text) {
      if (published || submitting) return;
      chosen[idx] = text;
      idx += 1;
      if (idx >= 3) {
        counter.textContent = "3 / 3";
        setButtonsEnabled(false);
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
      qText.value = triplet[2]?.question || "";
      syncButtonWidths();
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
