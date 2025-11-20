// /src/views/Maths.js
//
// Final “Jemima’s Maths” round (after Award of round 5).
// • Shows the combined maths question and two integer inputs.
// • Primary answer is required; the second box is optional working/backup.
// • Drafts autosave locally until submission succeeds.
// • Host evaluates both answers against the correct result and assigns points.
// • Maths points are stored in mathsAnswers.{role} = { value, delta, points }.

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

const DRAFT_PREFIX = "jemima-maths-draft";

const roomRef = (code) => doc(db, "rooms", code);

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

function draftKey(code, role) {
  return `${DRAFT_PREFIX}:${clampCode(code)}:${role}`;
}

function loadDraft(code, role) {
  try {
    const store = window.localStorage;
    if (!store) return null;
    const raw = store.getItem(draftKey(code, role));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      answer: typeof parsed.answer === "string" ? parsed.answer : "",
      backup: typeof parsed.backup === "string" ? parsed.backup : "",
    };
  } catch (err) {
    return null;
  }
}

function saveDraft(code, role, data) {
  try {
    const store = window.localStorage;
    if (!store) return;
    store.setItem(draftKey(code, role), JSON.stringify({
      answer: data.answer ?? "",
      backup: data.backup ?? "",
    }));
  } catch (err) {
    // ignore storage errors
  }
}

function clearDraft(code, role) {
  try {
    const store = window.localStorage;
    if (!store) return;
    store.removeItem(draftKey(code, role));
  } catch (err) {
    // ignore
  }
}

function playerName(role) {
  return role === "host" ? "Daniel" : "Jaime";
}

function ensureMathsResults(roomData = {}) {
  const maths = roomData.maths || {};
  const answers = roomData.mathsAnswers || {};
  const expected = Number(maths.answer);
  const hostEntry = answers.host || {};
  const guestEntry = answers.guest || {};

  if (!Number.isFinite(expected)) return null;
  const hostValue = Number(hostEntry.value);
  const guestValue = Number(guestEntry.value);
  if (!Number.isFinite(hostValue) || !Number.isFinite(guestValue)) return null;
  if (Number.isFinite(hostEntry.delta) && Number.isFinite(guestEntry.delta)) return null;

  const hostDelta = Math.abs(hostValue - expected);
  const guestDelta = Math.abs(guestValue - expected);

  let hostPoints = 0;
  let guestPoints = 0;
  if (hostDelta === 0 && guestDelta === 0) {
    hostPoints = 3;
    guestPoints = 3;
  } else if (hostDelta === 0) {
    hostPoints = 3;
  } else if (guestDelta === 0) {
    guestPoints = 3;
  } else if (hostDelta < guestDelta) {
    hostPoints = 1;
  } else if (guestDelta < hostDelta) {
    guestPoints = 1;
  } else {
    hostPoints = 1;
    guestPoints = 1;
  }

  return {
    host: { value: hostValue, delta: hostDelta, points: hostPoints },
    guest: { value: guestValue, delta: guestDelta, points: guestPoints },
  };
}

export default {
  async mount(container) {
    const me = await ensureAuth();

    const params = getHashParams();
    const code = clampCode(params.get("code") || "");

    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    container.innerHTML = "";
    const root = el("div", { class: "view view-maths" });

    const card = el("div", { class: "card" });
    const heading = el("h2", { class: "view-heading" }, "Jemima’s Maths");
    const questionText = el("div", { class: "mono maths-question__prompt maths-question__prompt--single" }, "");
    const answerLabel = el("label", { class: "mono maths-input-label" }, "Your answer");
    const answerInput = el("input", { type: "number", class: "input maths-input", placeholder: "Enter answer" });
    const backupLabel = el("label", { class: "mono maths-input-label" }, "Backup / working (optional)");
    const backupInput = el("input", { type: "number", class: "input maths-input", placeholder: "Optional second number" });
    const helperNote = el("div", { class: "mono small maths-helper" }, "Integers only. Drafts save automatically.");
    const inputsWrap = el("div", { class: "maths-form" }, [
      answerLabel,
      answerInput,
      backupLabel,
      backupInput,
    ]);

    const done = el("button", { class: "btn maths-submit", disabled: "" }, "Send to Jemima");
    const waitMsg = el("div", { class: "mono small wait-note" }, "");
    waitMsg.style.display = "none";

    card.appendChild(heading);
    card.appendChild(questionText);
    card.appendChild(helperNote);
    card.appendChild(inputsWrap);
    card.appendChild(done);
    card.appendChild(waitMsg);

    root.appendChild(card);

    const mathsMount = el("div", { class: "jemima-maths-pinned" });
    root.appendChild(mathsMount);

    container.appendChild(root);

    const rRef = roomRef(code);
    const roomSnap0 = await getDoc(rRef);
    const room0 = roomSnap0.data() || {};
    const { hostUid, guestUid } = room0.meta || {};
    const storedRole = getStoredRole(code);
    const myRole = storedRole === "host" || storedRole === "guest"
      ? storedRole
      : hostUid === me.uid ? "host" : guestUid === me.uid ? "guest" : "guest";
    const oppRole = myRole === "host" ? "guest" : "host";
    const oppName = playerName(oppRole);
    const myName = playerName(myRole);
    heading.textContent = `${myName} — Jemima’s Maths`;
    waitMsg.textContent = `Waiting for ${oppName}…`;

    try {
      if (mountMathsPane && room0.maths) {
        mountMathsPane(mathsMount, { maths: room0.maths, mode: "maths", roomCode: code, userUid: me.uid, round: 5 });
      }
    } catch (err) {
      console.warn("[maths] MathsPane mount failed:", err);
    }

    const mathsData = room0.maths || {};
    questionText.textContent = mathsData.question || "";

    const draft = loadDraft(code, myRole) || {};
    if (typeof draft.answer === "string") answerInput.value = draft.answer;
    if (typeof draft.backup === "string") backupInput.value = draft.backup;

    const updateDraft = () => {
      saveDraft(code, myRole, {
        answer: answerInput.value,
        backup: backupInput.value,
      });
    };

    answerInput.addEventListener("input", () => {
      updateDraft();
      validate();
    });
    backupInput.addEventListener("input", () => {
      updateDraft();
      validate();
    });

    const validateInteger = (value, required) => {
      if (!value && !required) return true;
      if (!value && required) return false;
      const num = Number(value);
      return Number.isInteger(num);
    };

    const validate = () => {
      const answerOk = validateInteger(answerInput.value.trim(), true);
      const backupOk = validateInteger(backupInput.value.trim(), false);
      const ready = answerOk && backupOk;
      done.disabled = !ready;
      done.classList.toggle("throb", ready);
      backupInput.classList.toggle("input--error", !backupOk);
      answerInput.classList.toggle("input--error", !answerOk);
    };

    validate();

    let submitted = false;
    let computingFinal = false;

    const publish = async () => {
      if (submitted || done.disabled) return;
      const rawAnswer = answerInput.value.trim();
      const rawBackup = backupInput.value.trim();
      if (!validateInteger(rawAnswer, true) || !validateInteger(rawBackup, false)) {
        validate();
        return;
      }
      submitted = true;
      done.disabled = true;
      done.classList.remove("throb");

      const payload = { value: Number(rawAnswer) };
      if (rawBackup) payload.backup = Number(rawBackup);

      const patch = {
        [`mathsAnswers.${myRole}`]: payload,
        [`mathsAnswersAck.${myRole}`]: true,
        "timestamps.updatedAt": serverTimestamp(),
      };

      try {
        console.log(`[flow] submit maths | code=${code} role=${myRole}`);
        await updateDoc(rRef, patch);
        waitMsg.style.display = "";
        clearDraft(code, myRole);
      } catch (err) {
        console.warn("[maths] publish failed:", err);
        submitted = false;
        done.disabled = false;
        validate();
      }
    };

    done.addEventListener("click", publish);

    const stop = onSnapshot(rRef, async (snap) => {
      const data = snap.data() || {};
      const state = data.state || "";
      if (state === "final") {
        setTimeout(() => { location.hash = `#/final?code=${code}`; }, 80);
        return;
      }

      const answersMap = data.mathsAnswers || {};
      const entryMine = answersMap[myRole] || {};
      if (Number.isFinite(entryMine.value) && !submitted) {
        answerInput.value = String(entryMine.value);
        if (Number.isFinite(entryMine.backup)) backupInput.value = String(entryMine.backup);
        submitted = true;
        done.disabled = true;
        done.classList.remove("throb");
        waitMsg.style.display = "";
        clearDraft(code, myRole);
      }

      const ackData = data.mathsAnswersAck || {};
      const myAck = Boolean(ackData[myRole]);
      const oppAck = Boolean(ackData[oppRole]);
      if (myAck && !submitted) {
        submitted = true;
        done.disabled = true;
        done.classList.remove("throb");
        waitMsg.style.display = "";
      }

      if (myRole === "host" && myAck && oppAck && !computingFinal) {
        computingFinal = true;
        try {
          const results = ensureMathsResults(data);
          if (results) {
            await updateDoc(rRef, {
              "mathsAnswers.host": results.host,
              "mathsAnswers.guest": results.guest,
              "timestamps.updatedAt": serverTimestamp(),
            });
          }
          if (data.state !== "final") {
            await updateDoc(rRef, { state: "final", "timestamps.updatedAt": serverTimestamp() });
          }
        } catch (err) {
          console.warn("[maths] finalise failed:", err);
        } finally {
          computingFinal = false;
        }
      }
    }, (err) => {
      console.warn("[maths] snapshot error:", err);
    });

    this.unmount = () => {
      try { stop && stop(); } catch {}
    };
  },

  async unmount() { /* no-op */ }
};
