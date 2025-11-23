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
import { ensureBotMaths } from "../lib/SinglePlayerBot.js";
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
      answers: Array.isArray(parsed.answers)
        ? parsed.answers.map((value) => (typeof value === "string" ? value : String(value ?? "")))
        : [],
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
      answers: Array.isArray(data.answers) ? data.answers : [],
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
  const events = Array.isArray(maths.events) ? maths.events : [];
  if (!events.length) return null;

  const targetTotal = Number.isInteger(maths.total)
    ? maths.total
    : events.reduce((sum, evt) => sum + (Number.isInteger(evt.year) ? evt.year : 0), 0);
  if (!Number.isInteger(targetTotal)) return null;

  const normalizeEntry = (entry = {}) => {
    const values = Array.isArray(entry.events)
      ? entry.events
          .map((value) => Number(value))
          .filter((num) => Number.isInteger(num))
      : [];
    if (!values.length) return { ready: false };
    const total = Number.isInteger(entry.total) ? entry.total : values.reduce((sum, num) => sum + num, 0);
    return { events: values, total, ready: Number.isInteger(total) };
  };

  const hostEntry = normalizeEntry(answers.host);
  const guestEntry = normalizeEntry(answers.guest);

  if (!hostEntry.ready || !guestEntry.ready) return null;
  if (Number.isFinite(answers.host?.points) && Number.isFinite(answers.guest?.points)) return null;

  const scoring = maths.scoring || {};
  const sharpshooterMargin = Number.isInteger(scoring.sharpshooterMargin)
    ? scoring.sharpshooterMargin
    : Math.round(targetTotal * (Number(scoring.sharpshooterPercent) || 0.02));
  const ballparkMargin = Number.isInteger(scoring.ballparkMargin)
    ? scoring.ballparkMargin
    : Math.round(targetTotal * (Number(scoring.ballparkPercent) || 0.05));

  const basePoints = (delta) => {
    if (delta === 0) return scoring.perfectPoints || 5;
    if (delta <= sharpshooterMargin) return scoring.sharpshooterPoints || 3;
    if (delta <= ballparkMargin) return scoring.ballparkPoints || 2;
    return 0;
  };

  const hostDelta = Math.abs(hostEntry.total - targetTotal);
  const guestDelta = Math.abs(guestEntry.total - targetTotal);
  let hostPoints = basePoints(hostDelta);
  let guestPoints = basePoints(guestDelta);

  if (hostPoints === 0 && guestPoints === 0) {
    const safety = scoring.safetyNetPoints || 1;
    if (hostDelta < guestDelta) hostPoints = safety;
    else if (guestDelta < hostDelta) guestPoints = safety;
    else {
      hostPoints = safety;
      guestPoints = safety;
    }
  }

  return {
    host: { events: hostEntry.events, total: hostEntry.total, delta: hostDelta, points: hostPoints },
    guest: { events: guestEntry.events, total: guestEntry.total, delta: guestDelta, points: guestPoints },
    targetTotal,
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

    try {
      window.scrollTo({ top: 0, behavior: "instant" });
    } catch {}
    const root = el("div", { class: "view view-maths" });

    const card = el("div", { class: "card" });
    const heading = el("h2", { class: "view-heading" }, "Jemima’s Maths");
    const questionText = el("div", { class: "mono maths-question__prompt maths-question__prompt--single" }, "");
    const helperNote = el(
      "div",
      { class: "mono small maths-helper" },
      "Single years only (1–4 digits, AD). Drafts save automatically."
    );
    const eventsWrap = el("div", { class: "maths-form maths-form--events" });
    const totalPreview = el("div", { class: "mono small maths-helper maths-helper--total" }, "Your running total: 0");

    const done = el("button", { class: "btn maths-submit", disabled: "" }, "Send to Jemima");
    const waitMsg = el("div", { class: "mono small wait-note" }, "");
    waitMsg.style.display = "none";

    card.appendChild(heading);
    card.appendChild(questionText);
    card.appendChild(helperNote);
    card.appendChild(eventsWrap);
    card.appendChild(totalPreview);
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
    const events = Array.isArray(mathsData.events) && mathsData.events.length
      ? mathsData.events.slice(0, 5)
      : (Array.isArray(mathsData.clues)
          ? mathsData.clues.slice(0, 5).map((prompt) => ({ prompt }))
          : []);
    while (events.length < 5) {
      events.push({ prompt: `Event ${events.length + 1}`, year: null });
    }

    questionText.textContent = mathsData.title || mathsData.question || "Timeline totals";

    if (myRole === "host") {
      await ensureBotMaths({ code, roomData: room0 });
    }

    const draft = loadDraft(code, myRole) || {};
    let answers = events.map((_, idx) => (draft.answers?.[idx] ?? ""));
    const inputs = [];

    const updateDraft = () => {
      saveDraft(code, myRole, { answers });
    };

    const validateInteger = (value) => {
      if (!value) return false;
      const num = Number(value);
      const trimmed = String(Math.trunc(num));
      return (
        Number.isInteger(num) &&
        num >= 1 &&
        num <= 9999 &&
        trimmed.length >= 1 &&
        trimmed.length <= 4
      );
    };

    const updateTotal = () => {
      const total = answers.reduce((sum, value) => {
        const num = Number(value);
        return Number.isInteger(num) ? sum + num : sum;
      }, 0);
      totalPreview.textContent = `Your running total: ${total}`;
    };

    const validate = () => {
      const ready = answers.length === events.length && answers.every((value) => validateInteger(value));
      done.disabled = !ready;
      done.classList.toggle("throb", ready);
      inputs.forEach((input, idx) => {
        input.classList.toggle("input--error", !validateInteger(answers[idx]));
      });
    };

    eventsWrap.innerHTML = "";
    events.forEach((event, idx) => {
      const label = el(
        "label",
        { class: "mono maths-input-label" },
        `${idx + 1}. ${event.prompt || "Event"}`
      );
      const input = el("input", {
        type: "number",
        inputmode: "numeric",
        min: "1",
        max: "9999",
        class: "input maths-input",
        placeholder: "Enter year",
      });
      if (answers[idx]) input.value = answers[idx];
      input.addEventListener("input", () => {
        answers[idx] = input.value.trim();
        updateDraft();
        updateTotal();
        validate();
      });
      inputs.push(input);
      const row = el("div", { class: "maths-event" }, [label, input]);
      eventsWrap.appendChild(row);
    });

    updateTotal();
    validate();

    let submitted = false;
    let computingFinal = false;

    const publish = async () => {
      if (submitted || done.disabled) return;
      if (!answers.every((value) => validateInteger(value))) {
        validate();
        return;
      }
      submitted = true;
      done.disabled = true;
      done.classList.remove("throb");

      const numericAnswers = answers.map((value) => Number(value));
      const payload = { events: numericAnswers, total: numericAnswers.reduce((sum, num) => sum + num, 0) };

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
      if (Array.isArray(entryMine.events) && !submitted) {
        answers = entryMine.events.map((value) => String(value));
        inputs.forEach((input, idx) => {
          input.value = answers[idx] ?? "";
        });
        updateTotal();
        validate();
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
