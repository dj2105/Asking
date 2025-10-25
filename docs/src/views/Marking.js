// /src/views/Marking.js
//
// Marking phase — judge opponent answers while a hidden timer keeps running.
// • Tabbed layout mirrors the questions view for consistency.
// • Submission writes marking.{role}.{round}, timings.{role}.{round}, markingAck.{role}.{round} = true.
// • Host advances to Award once both acknowledgements are present.

import { ensureAuth, db } from "../lib/firebase.js";
import {
  doc,
  collection,
  getDoc,
  onSnapshot,
  updateDoc,
  serverTimestamp,
  runTransaction,
} from "firebase/firestore";

import { resumeRoundTimer, pauseRoundTimer, getRoundTimerTotal, clearRoundTimer } from "../lib/RoundTimer.js";
import { clampCode, getHashParams, getStoredRole } from "../lib/util.js";

const VERDICT = { RIGHT: "right", WRONG: "wrong", UNKNOWN: "unknown" };

const TAB_PALETTES = [
  { base: "hsl(272, 68%, 94%)", muted: "hsl(272, 68%, 97%)", strong: "hsl(272, 58%, 80%)" },
  { base: "hsl(204, 72%, 93%)", muted: "hsl(204, 72%, 97%)", strong: "hsl(204, 62%, 79%)" },
  { base: "hsl(44, 86%, 94%)", muted: "hsl(44, 86%, 97%)", strong: "hsl(44, 76%, 82%)" },
];

function el(tag, attrs = {}, kids = []) {
  const node = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (k === "class") node.className = v;
    else if (k === "style" && v && typeof v === "object") {
      for (const sk in v) node.style[sk] = v[sk];
    } else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
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

function resolveCorrectAnswer(answer = {}, fallbackItem = {}) {
  if (answer.correct) return answer.correct;
  if (fallbackItem.correct_answer) return fallbackItem.correct_answer;
  return "";
}

function countCorrectAnswers(answers = [], items = []) {
  let total = 0;
  for (let i = 0; i < answers.length; i += 1) {
    const answer = answers[i] || {};
    const chosen = answer.chosen || "";
    if (!chosen) continue;
    const correct = resolveCorrectAnswer(answer, items[i] || {});
    if (correct && same(chosen, correct)) total += 1;
  }
  return total;
}

const roomRef = (code) => doc(db, "rooms", code);
const roundSubColRef = (code) => collection(roomRef(code), "rounds");

export default {
  async mount(container) {
    const me = await ensureAuth();

    const params = getHashParams();
    const code = clampCode(params.get("code") || "");
    let round = parseInt(params.get("round") || "1", 10) || 1;

    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    container.innerHTML = "";
    const root = el("div", { class: "view view-marking stage-center" });

    const heading = el("h1", { class: "view-heading" }, "Marking");
    root.appendChild(heading);

    const roundShell = el("div", { class: "round-shell" });

    const card = el("div", { class: "card round-card mark-card" });
    const cardSurface = el("div", { class: "round-card__surface" });
    card.appendChild(cardSurface);

    const tabRow = el("div", { class: "round-tabs" });
    const panelWrap = el("div", { class: "round-panels" });

    cardSurface.appendChild(tabRow);
    cardSurface.appendChild(panelWrap);

    roundShell.appendChild(card);

    const submitBtn = el("button", {
      class: "btn big round-submit-btn",
      type: "button",
    }, "Submit review");
    submitBtn.disabled = true;
    const submitRow = el("div", { class: "round-submit-row" }, submitBtn);
    roundShell.appendChild(submitRow);

    let waitMessageDefault = "Waiting…";
    const waitMsg = el("div", { class: "mono small wait-note" }, waitMessageDefault);
    waitMsg.style.display = "none";
    roundShell.appendChild(waitMsg);

    root.appendChild(roundShell);

    const overlay = el("div", { class: "stage-overlay stage-overlay--hidden" });
    const overlayTitle = el("div", { class: "mono stage-overlay__title" }, "");
    const overlayNote = el("div", { class: "mono small stage-overlay__note" }, "");
    overlay.appendChild(overlayTitle);
    overlay.appendChild(overlayNote);
    root.appendChild(overlay);

    container.appendChild(root);

    const showOverlay = (title, note) => {
      overlayTitle.textContent = title || "";
      overlayNote.textContent = note || "";
      overlay.classList.remove("stage-overlay--hidden");
      roundShell.style.visibility = "hidden";
    };

    const hideOverlay = () => {
      overlay.classList.add("stage-overlay--hidden");
      roundShell.style.visibility = "";
    };

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
    const oppName = oppRole === "host" ? "Daniel" : "Jaime";

    waitMessageDefault = `Waiting for ${oppName}…`;
    waitMsg.textContent = waitMessageDefault;

    const timerContext = { code, role: myRole, round };

    const rdSnap = await getDoc(rdRef);
    const rd = rdSnap.data() || {};
    const oppItems = (oppRole === "host" ? rd.hostItems : rd.guestItems) || [];
    const oppAnswers = (((roomData0.answers || {})[oppRole] || {})[round] || []).map((a) => a?.chosen || "");
    const markCount = 3;
    const totalMarks = markCount;

    const tabButtons = [];
    const panelNodes = [];
    const verdictButtons = [];

    let marks = new Array(markCount).fill(null);
    let published = false;
    let submitting = false;
    let alive = true;
    let stopRoomWatch = null;
    let finalizing = false;

    function applyPalette(index) {
      const palette = TAB_PALETTES[index % TAB_PALETTES.length];
      cardSurface.style.setProperty("--round-card-color", palette.base);
      cardSurface.style.setProperty("--round-card-strong", palette.strong);
    }

    function markValue(value) {
      if (value === VERDICT.RIGHT) return VERDICT.RIGHT;
      if (value === VERDICT.WRONG) return VERDICT.WRONG;
      return VERDICT.UNKNOWN;
    }

    function updateSubmitState() {
      const ready = marks.every((value) => value === VERDICT.RIGHT || value === VERDICT.WRONG || value === VERDICT.UNKNOWN);
      const disable = !ready || submitting || published;
      submitBtn.disabled = disable;
      submitBtn.classList.toggle("throb", ready && !submitting && !published);
    }

    function updateTabStates(activeIndex) {
      tabButtons.forEach((btn, idx) => {
        btn.classList.toggle("is-active", idx === activeIndex);
        btn.classList.toggle("is-answered", Boolean(marks[idx]));
      });
      panelNodes.forEach((panel, idx) => {
        panel.classList.toggle("is-active", idx === activeIndex);
      });
    }

    function updateVerdictStyles(index) {
      const value = marks[index];
      (verdictButtons[index] || []).forEach((btn) => {
        const btnValue = btn.getAttribute("data-verdict");
        btn.classList.toggle("is-selected", value === btnValue);
      });
    }

    function refreshAllVerdicts() {
      verdictButtons.forEach((_, idx) => updateVerdictStyles(idx));
    }

    function setInteractionEnabled(enabled) {
      tabButtons.forEach((btn) => {
        btn.disabled = !enabled;
      });
      verdictButtons.forEach((list) => {
        list.forEach((btn) => {
          btn.disabled = !enabled;
        });
      });
      if (enabled) {
        updateSubmitState();
      } else {
        submitBtn.disabled = true;
        submitBtn.classList.remove("throb");
      }
    }

    let activeIndex = 0;

    function setActiveTab(index) {
      if (index < 0) index = 0;
      if (index >= totalMarks) index = totalMarks - 1;
      activeIndex = index;
      applyPalette(index);
      updateTabStates(index);
      updateVerdictStyles(index);
    }

    for (let idx = 0; idx < markCount; idx += 1) {
      const item = oppItems[idx] || {};
      const palette = TAB_PALETTES[idx % TAB_PALETTES.length];
      const tab = el("button", { class: "round-tab", type: "button" }, String(idx + 1));
      tab.style.setProperty("--tab-color-base", palette.base);
      tab.style.setProperty("--tab-color-muted", palette.muted);
      tabRow.appendChild(tab);
      tabButtons.push(tab);

      const panel = el("div", { class: "round-panel round-panel--marking" });
      panel.style.setProperty("--tab-color-base", palette.base);
      panel.style.setProperty("--round-panel-strong", palette.strong);
      panelNodes.push(panel);

      const prompt = el("div", { class: "round-panel__prompt mono" }, `${idx + 1}. ${item?.question || "(missing question)"}`);
      panel.appendChild(prompt);

      const answerBox = el("div", { class: "round-answer" });
      const answerLabel = el("div", { class: "round-answer__label mono small" }, `${oppName}’s answer`);
      const answerText = el("div", { class: "round-answer__text" }, oppAnswers[idx] || "(no answer recorded)");
      answerBox.appendChild(answerLabel);
      answerBox.appendChild(answerText);
      panel.appendChild(answerBox);

      const verdictGroup = el("div", { class: "round-verdicts" });
      const verdictSet = [
        { label: "✓", value: VERDICT.RIGHT, title: "Mark as correct" },
        { label: "?", value: VERDICT.UNKNOWN, title: "Mark as unsure" },
        { label: "✕", value: VERDICT.WRONG, title: "Mark as incorrect" },
      ];
      const buttonRefs = verdictSet.map(({ label, value, title }) => {
        const btn = el("button", {
          class: "round-option round-option--verdict",
          type: "button",
          title,
          "data-verdict": value,
          "aria-pressed": "false",
        }, label);
        btn.addEventListener("click", () => {
          if (published || submitting) return;
          waitMsg.style.display = "none";
          setActiveTab(idx);
          marks[idx] = markValue(value);
          updateVerdictStyles(idx);
          updateTabStates(activeIndex);
          updateSubmitState();
        });
        verdictGroup.appendChild(btn);
        return btn;
      });
      verdictButtons.push(buttonRefs);
      panel.appendChild(verdictGroup);

      panelWrap.appendChild(panel);

      tab.addEventListener("click", () => {
        if (submitting || published) return;
        setActiveTab(idx);
      });
    }

    const existingMarks = (((roomData0.marking || {})[myRole] || {})[round] || []);
    if (Array.isArray(existingMarks) && existingMarks.length >= markCount) {
      marks = marks.map((_, i) => markValue(existingMarks[i]));
      published = true;
      setInteractionEnabled(false);
      refreshAllVerdicts();
      updateTabStates(activeIndex);
      pauseRoundTimer(timerContext);
      clearRoundTimer(timerContext);
      showOverlay(`Waiting for ${oppName}`, "Review submitted");
    } else {
      setInteractionEnabled(true);
      resumeRoundTimer(timerContext);
    }

    setActiveTab(0);
    refreshAllVerdicts();

    function showWaitingOverlay(note) {
      showOverlay(`Waiting for ${oppName}`, note || "Waiting for opponent");
    }

    async function submitMarks() {
      if (published || submitting) return;
      submitting = true;
      const safeMarks = marks.map((value) => markValue(value));
      setInteractionEnabled(false);
      pauseRoundTimer(timerContext);
      const totalSecondsRaw = getRoundTimerTotal(timerContext) / 1000;
      const totalSeconds = Math.max(0, Math.round(totalSecondsRaw * 100) / 100);
      const patch = {
        [`marking.${myRole}.${round}`]: safeMarks,
        [`markingAck.${myRole}.${round}`]: true,
        [`timings.${myRole}.${round}`]: { totalSeconds },
        "timestamps.updatedAt": serverTimestamp(),
      };

      showOverlay("Submitting", "Saving your review…");

      try {
        await updateDoc(rRef, patch);
        published = true;
        submitting = false;
        marks = safeMarks;
        showWaitingOverlay("Review submitted");
        clearRoundTimer(timerContext);
      } catch (err) {
        console.warn("[marking] submit failed:", err);
        submitting = false;
        hideOverlay();
        waitMsg.textContent = "Retrying…";
        waitMsg.style.display = "";
        setInteractionEnabled(true);
        resumeRoundTimer(timerContext);
      }
    }

    submitBtn.addEventListener("click", () => {
      if (submitBtn.disabled) return;
      submitMarks();
    });

    const finalizeRound = async () => {
      if (finalizing) return;
      finalizing = true;
      try {
        await runTransaction(db, async (tx) => {
          const roomSnapCur = await tx.get(rRef);
          if (!roomSnapCur.exists()) return;
          const roomData = roomSnapCur.data() || {};
          if ((roomData.state || "").toLowerCase() !== "marking") return;

          const ackHost = Boolean(((roomData.markingAck || {}).host || {})[round]);
          const ackGuest = Boolean(((roomData.markingAck || {}).guest || {})[round]);
          if (!(ackHost && ackGuest)) return;

          const roundSnapCur = await tx.get(rdRef);
          const roundData = roundSnapCur.exists() ? (roundSnapCur.data() || {}) : {};
          const answersHost = (((roomData.answers || {}).host || {})[round] || []);
          const answersGuest = (((roomData.answers || {}).guest || {})[round] || []);
          const hostItems = roundData.hostItems || [];
          const guestItems = roundData.guestItems || [];

          const roundHostScore = countCorrectAnswers(answersHost, hostItems);
          const roundGuestScore = countCorrectAnswers(answersGuest, guestItems);
          const currentRound = Number(roomData.round) || round;

          tx.update(rRef, {
            state: "award",
            round: currentRound,
            [`scores.host.${currentRound}`]: roundHostScore,
            [`scores.guest.${currentRound}`]: roundGuestScore,
            "timestamps.updatedAt": serverTimestamp(),
          });
        });
      } catch (err) {
        console.warn("[marking] finalize failed:", err);
      } finally {
        finalizing = false;
      }
    };

    stopRoomWatch = onSnapshot(rRef, (snap) => {
      const data = snap.data() || {};
      const stateName = (data.state || "").toLowerCase();

      if (Number.isFinite(Number(data.round))) {
        const nextRound = Number(data.round);
        if (nextRound !== round) {
          round = nextRound;
          timerContext.round = round;
        }
      }

      if (stateName === "countdown") {
        setTimeout(() => {
          location.hash = `#/countdown?code=${code}&round=${data.round || round}`;
        }, 80);
        return;
      }

      if (stateName === "questions") {
        setTimeout(() => {
          location.hash = `#/questions?code=${code}&round=${data.round || round}`;
        }, 80);
        return;
      }

      if (stateName === "award") {
        setTimeout(() => {
          location.hash = `#/award?code=${code}&round=${data.round || round}`;
        }, 80);
        return;
      }

      if (stateName === "maths") {
        setTimeout(() => { location.hash = `#/maths?code=${code}`; }, 80);
        return;
      }

      const markingAck = data.markingAck || {};
      const ackMine = Boolean(((markingAck[myRole] || {})[round]));
      const ackOpp = Boolean(((markingAck[oppRole] || {})[round]));

      if (ackMine && !published) {
        const incomingMarks = (((data.marking || {})[myRole] || {})[round] || marks);
        marks = marks.map((_, i) => markValue(incomingMarks[i]));
        published = true;
        submitting = false;
        setInteractionEnabled(false);
        refreshAllVerdicts();
        updateTabStates(activeIndex);
        pauseRoundTimer(timerContext);
        clearRoundTimer(timerContext);
        showWaitingOverlay(ackOpp ? "Waiting for opponent" : "Review submitted");
      }

      if (myRole === "host" && stateName === "marking" && ackMine && ackOpp) {
        finalizeRound();
      }
    }, (err) => {
      console.warn("[marking] room snapshot error:", err);
    });

    this.unmount = () => {
      try { stopRoomWatch && stopRoomWatch(); } catch {}
      pauseRoundTimer(timerContext);
    };
  },

  async unmount() { /* instance handles cleanup */ }
};
