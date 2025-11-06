// /src/views/Final.js
//
// Final summary — aggregates per-round scores and maths outcome.
// • Shows round-by-round question totals.
// • Displays maths answers, deltas, and awarded points.
// • Highlights the overall winner (question totals + maths points).
// • Offers a button to return to the lobby.

import { ensureAuth, db } from "../lib/firebase.js";
import { doc, collection, onSnapshot } from "firebase/firestore";

import { clampCode, getHashParams } from "../lib/util.js";

const roomRef = (code) => doc(db, "rooms", code);

function el(tag, attrs = {}, kids = []) {
  const node = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  });
  (Array.isArray(kids) ? kids : [kids]).forEach((child) => {
    if (child === null || child === undefined) return;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  });
  return node;
}

function formatPoints(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "0";
  return String(num);
}

function formatDelta(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  if (num > 0) return `+${num}`;
  if (num < 0) return `−${Math.abs(num)}`;
  return "0";
}

function computeTotals(scores = {}, mathsAnswers = {}) {
  const hostRounds = scores.host || {};
  const guestRounds = scores.guest || {};
  let hostQuestions = 0;
  let guestQuestions = 0;
  for (let r = 1; r <= 5; r += 1) {
    hostQuestions += Number(hostRounds[r] || 0);
    guestQuestions += Number(guestRounds[r] || 0);
  }
  const hostMaths = Number((mathsAnswers.host || {}).points || 0);
  const guestMaths = Number((mathsAnswers.guest || {}).points || 0);
  return {
    hostQuestions,
    guestQuestions,
    hostMaths,
    guestMaths,
    hostTotal: hostQuestions + hostMaths,
    guestTotal: guestQuestions + guestMaths,
  };
}

function winnerLabel(totals) {
  if (totals.hostTotal > totals.guestTotal) return "Daniel wins!";
  if (totals.guestTotal > totals.hostTotal) return "Jaime wins!";
  return "It’s a tie!";
}

function same(a, b) {
  return String(a || "").trim() === String(b || "").trim();
}

function getRoundMapValue(map = {}, roundNumber) {
  if (!map || typeof map !== "object") return undefined;
  if (map[roundNumber] !== undefined) return map[roundNumber];
  const key = String(roundNumber);
  if (map[key] !== undefined) return map[key];
  return undefined;
}

function resolveCorrectAnswer(answer = {}, fallbackItem = {}) {
  if (answer.correct) return answer.correct;
  if (fallbackItem.correct_answer) return fallbackItem.correct_answer;
  return "";
}

function formatSignedPoints(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num === 0) return num === 0 ? "+0" : "0";
  if (num > 0) return `+${num}`;
  return `−${Math.abs(num)}`;
}

function normaliseQuestionText(item = {}, answer = {}, fallbackLabel = "") {
  const text =
    (typeof item.question === "string" && item.question.trim()) ||
    (typeof item.prompt === "string" && item.prompt.trim()) ||
    (typeof answer.question === "string" && answer.question.trim()) ||
    "";
  if (text) return text;
  return fallbackLabel;
}

function countCorrectAnswers(answers = [], items = []) {
  let total = 0;
  const count = Math.max(items.length, answers.length, 3);
  for (let i = 0; i < count; i += 1) {
    const answer = answers[i] || {};
    const item = items[i] || {};
    const chosen = answer.chosen;
    const correct = resolveCorrectAnswer(answer, item);
    if (chosen && correct && same(chosen, correct)) total += 1;
  }
  return total;
}

function formatScore(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "0";
  return Number(value).toLocaleString();
}

function renderScoreboard(section, totals) {
  const cards = section.querySelectorAll(".final-scoreboard__value");
  const deltaCards = section.querySelectorAll(".final-scoreboard__delta");
  const [hostValue, guestValue] = cards;
  if (hostValue) hostValue.textContent = formatScore(totals.hostQuestions);
  if (guestValue) guestValue.textContent = formatScore(totals.guestQuestions);
  if (deltaCards.length === 2) {
    const [hostDelta, guestDelta] = deltaCards;
    const diff = totals.hostQuestions - totals.guestQuestions;
    if (hostDelta) hostDelta.textContent = diff === 0 ? "Level" : diff > 0 ? `+${diff}` : "";
    if (guestDelta) guestDelta.textContent = diff === 0 ? "Level" : diff < 0 ? `${diff}` : "";
  }
}

function renderMathsAnswers(stage, mathsAnswers = {}) {
  const host = mathsAnswers.host || {};
  const guest = mathsAnswers.guest || {};
  const hostValue = stage.querySelector("[data-role=host][data-field=value]");
  const guestValue = stage.querySelector("[data-role=guest][data-field=value]");
  const hostDelta = stage.querySelector("[data-role=host][data-field=delta]");
  const guestDelta = stage.querySelector("[data-role=guest][data-field=delta]");
  if (hostValue) hostValue.textContent = formatPoints(host.value);
  if (guestValue) guestValue.textContent = formatPoints(guest.value);
  if (hostDelta) hostDelta.textContent = formatDelta(host.delta);
  if (guestDelta) guestDelta.textContent = formatDelta(guest.delta);
}

function renderMathsScores(stage, totals, mathsAnswers = {}) {
  const host = mathsAnswers.host || {};
  const guest = mathsAnswers.guest || {};
  const hostPoints = Number(host.points) || 0;
  const guestPoints = Number(guest.points) || 0;
  const hostLine = stage.querySelector("[data-role=host]");
  const guestLine = stage.querySelector("[data-role=guest]");
  if (hostLine) hostLine.textContent = `Daniel banks ${formatSignedPoints(hostPoints)} maths points for ${formatScore(totals.hostTotal)} overall.`;
  if (guestLine) guestLine.textContent = `Jaime banks ${formatSignedPoints(guestPoints)} maths points for ${formatScore(totals.guestTotal)} overall.`;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "0%";
  return `${Math.round(value)}%`;
}

function computeMarkingNarrative(role, roomData = {}, roundsData = {}) {
  const markerName = role === "host" ? "Daniel" : "Jaime";
  const subjectName = role === "host" ? "Jaime" : "Daniel";
  const markingMap = ((roomData.marking || {})[role]) || {};
  const answersMap = ((roomData.answers || {})[role === "host" ? "guest" : "host"]) || {};
  const itemsKey = role === "host" ? "guestItems" : "hostItems";
  let rightCalls = 0;
  let wrongCalls = 0;
  let judged = 0;
  let accurate = 0;
  for (let round = 1; round <= 5; round += 1) {
    const verdicts = Array.isArray(getRoundMapValue(markingMap, round)) ? getRoundMapValue(markingMap, round) : [];
    const answers = Array.isArray(getRoundMapValue(answersMap, round)) ? getRoundMapValue(answersMap, round) : [];
    const items = Array.isArray((roundsData[round] || {})[itemsKey]) ? (roundsData[round] || {})[itemsKey] : [];
    const count = Math.max(verdicts.length, answers.length, items.length, 3);
    for (let i = 0; i < count; i += 1) {
      const verdict = verdicts[i];
      if (verdict !== "right" && verdict !== "wrong") continue;
      const answer = answers[i] || {};
      const item = items[i] || {};
      const chosen = answer.chosen;
      const correct = resolveCorrectAnswer(answer, item);
      const actual = Boolean(chosen) && Boolean(correct) && same(chosen, correct);
      judged += 1;
      if (verdict === "right") rightCalls += 1;
      if (verdict === "wrong") wrongCalls += 1;
      if ((verdict === "right" && actual) || (verdict === "wrong" && !actual)) {
        accurate += 1;
      }
    }
  }
  const accuracyPercent = judged > 0 ? (accurate / judged) * 100 : 0;
  return {
    markerName,
    subjectName,
    rightCalls,
    wrongCalls,
    accuracyPercent,
  };
}

function renderMarkingNarration(stage, roomData = {}, roundsData = {}, totals = {}) {
  const hostLine = stage.querySelector("[data-role=host]");
  const guestLine = stage.querySelector("[data-role=guest]");
  const hostSummary = computeMarkingNarrative("host", roomData, roundsData);
  const guestSummary = computeMarkingNarrative("guest", roomData, roundsData);
  const hostFinal = formatScore(totals.hostTotal);
  const guestFinal = formatScore(totals.guestTotal);
  if (hostLine) {
    hostLine.textContent = `${hostSummary.markerName} was sure ${hostSummary.subjectName} got ${hostSummary.rightCalls} right and ${hostSummary.wrongCalls} wrong. He was right ${formatPercent(hostSummary.accuracyPercent)} of the time, giving a final score of ${hostFinal}.`;
  }
  if (guestLine) {
    guestLine.textContent = `${guestSummary.markerName} was sure ${guestSummary.subjectName} got ${guestSummary.rightCalls} right and ${guestSummary.wrongCalls} wrong. He was right ${formatPercent(guestSummary.accuracyPercent)} of the time, giving a final score of ${guestFinal}.`;
  }
}

function renderNumberRollStage(stage, maths = {}) {
  const prompt = stage.querySelector(".final-number-roll__prompt");
  const target = stage.querySelector(".final-number-roll__target");
  if (prompt) {
    const question = typeof maths.question === "string" && maths.question.trim()
      ? maths.question.trim()
      : "Jemima’s final question";
    prompt.textContent = question;
  }
  if (target) {
    const value = Number.isFinite(Number(maths.answer)) ? Number(maths.answer) : null;
    target.dataset.targetValue = value !== null ? String(value) : "";
    target.textContent = value !== null ? formatScore(value) : "Awaiting final total";
  }
}

function renderWinner(stage, totals) {
  const label = stage.querySelector(".final-winner__label");
  if (label) label.textContent = winnerLabel(totals);
}

function buildQuestionList(playerName, items, answers, round, role) {
  const section = el("section", { class: "final-round-panel__player" });
  section.appendChild(el("h3", { class: "mono final-round-panel__player-name" }, playerName));
  const list = el("ul", { class: "final-round-panel__question-list" });
  const questionCount = Math.max(items.length, answers.length, 3);
  for (let i = 0; i < questionCount; i += 1) {
    const item = items[i] || {};
    const answer = answers[i] || {};
    const questionLabel = `Q${(round - 1) * 3 + (i + 1)}`;
    const questionText = normaliseQuestionText(item, answer, questionLabel);
    const chosen = answer.chosen || "";
    const correct = resolveCorrectAnswer(answer, item) || "";
    const wasCorrect = Boolean(chosen) && Boolean(correct) && same(chosen, correct);

    const entry = el("li", { class: "final-question-entry" });
    entry.appendChild(el("div", { class: "mono final-question-entry__prompt" }, questionText));

    const answersWrap = el("div", { class: "final-question-entry__answers" });
    if (chosen) {
      const answerClasses = ["mono", "final-answer", wasCorrect ? "final-answer--correct" : "final-answer--wrong"];
      answersWrap.appendChild(el("div", { class: answerClasses.join(" ") }, `${playerName} answered: ${chosen}`));
    } else {
      answersWrap.appendChild(el("div", { class: "mono final-answer final-answer--empty" }, `${playerName} left this blank.`));
    }
    answersWrap.appendChild(el("div", { class: "mono final-answer final-answer--key" }, `Correct answer: ${correct || "—"}`));
    entry.appendChild(answersWrap);
    list.appendChild(entry);
  }
  section.appendChild(list);
  section.dataset.role = role;
  return section;
}

function renderRoundReview(container, roomData = {}, roundsData = {}) {
  container.innerHTML = "";
  const answersHostMap = (roomData.answers || {}).host || {};
  const answersGuestMap = (roomData.answers || {}).guest || {};

  for (let round = 1; round <= 5; round += 1) {
    const hostItems = Array.isArray((roundsData[round] || {}).hostItems)
      ? (roundsData[round] || {}).hostItems
      : [];
    const guestItems = Array.isArray((roundsData[round] || {}).guestItems)
      ? (roundsData[round] || {}).guestItems
      : [];
    const answersHost = Array.isArray(getRoundMapValue(answersHostMap, round))
      ? getRoundMapValue(answersHostMap, round)
      : [];
    const answersGuest = Array.isArray(getRoundMapValue(answersGuestMap, round))
      ? getRoundMapValue(answersGuestMap, round)
      : [];
    const hostScore = countCorrectAnswers(answersHost, hostItems);
    const guestScore = countCorrectAnswers(answersGuest, guestItems);

    const panel = el("div", { class: "final-round-panel" });
    const header = el("button", {
      class: "mono final-round-panel__header",
      type: "button",
      "aria-expanded": "false",
    }, [
      el("span", { class: "final-round-panel__round" }, `ROUND ${round}`),
      el("span", { class: "final-round-panel__score" }, `Daniel ${hostScore}/3 • Jaime ${guestScore}/3`),
    ]);
    const body = el("div", { class: "final-round-panel__body" });
    body.appendChild(buildQuestionList("Daniel", hostItems, answersHost, round, "host"));
    body.appendChild(buildQuestionList("Jaime", guestItems, answersGuest, round, "guest"));

    header.addEventListener("click", () => {
      const isOpen = panel.classList.toggle("is-open");
      header.setAttribute("aria-expanded", isOpen ? "true" : "false");
      if (isOpen) {
        body.style.maxHeight = `${body.scrollHeight}px`;
      } else {
        body.style.maxHeight = "0px";
      }
    });

    panel.appendChild(header);
    panel.appendChild(body);
    container.appendChild(panel);
  }
}

function createNumberRollController(targetEl, targetValue) {
  if (!targetEl || !Number.isFinite(Number(targetValue))) return null;
  const finalValue = Number(targetValue);
  const duration = 4000;
  const amplitude = Math.max(1, Math.abs(finalValue) * 0.1);
  let frame = null;
  const start = performance.now();

  const step = (timestamp) => {
    const elapsed = timestamp - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const swing = Math.sin(elapsed / 80) * amplitude * (1 - eased);
    const displayValue = Math.round(finalValue + swing);
    targetEl.textContent = formatScore(displayValue);
    if (progress < 1) {
      frame = requestAnimationFrame(step);
    } else {
      targetEl.textContent = formatScore(finalValue);
    }
  };

  frame = requestAnimationFrame(step);

  return {
    cancel() {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      targetEl.textContent = formatScore(finalValue);
    },
  };
}

export default {
  async mount(container) {
    await ensureAuth();

    const params = getHashParams();
    const code = clampCode(params.get("code") || "");

    container.innerHTML = "";
    const root = el("div", { class: "view view-final" });
    const card = el("div", { class: "card final-card" });
    const heading = el("h1", { class: "title final-title" }, "FINAL REVEAL");

    const sequence = el("div", { class: "final-sequence" });

    const createScoreCard = (name, role) => el("div", { class: `final-scoreboard__card final-scoreboard__card--${role}` }, [
      el("span", { class: "mono final-scoreboard__player" }, name),
      el("span", { class: "mono final-scoreboard__value" }, "0"),
      el("span", { class: "mono final-scoreboard__delta" }, ""),
    ]);

    const scoreboardStage = el("section", { class: "final-stage final-stage--scoreboard" }, [
      el("h2", { class: "mono final-stage__heading" }, "Scoreboard"),
      el("p", { class: "mono final-stage__subtitle" }, "Question rounds only"),
      el("div", { class: "final-scoreboard" }, [
        createScoreCard("Daniel", "host"),
        createScoreCard("Jaime", "guest"),
      ]),
    ]);

    const createMathCard = (name, role) =>
      el("div", { class: `final-maths-card final-maths-card--${role}` }, [
        el("span", { class: "mono final-maths-card__name" }, name),
        el("div", { class: "final-maths-card__metric" }, [
          el("span", { class: "mono final-maths-card__label" }, "Answer"),
          el("span", { class: "mono final-maths-card__value", "data-role": role, "data-field": "value" }, "—"),
        ]),
        el("div", { class: "final-maths-card__metric" }, [
          el("span", { class: "mono final-maths-card__label" }, "Δ"),
          el("span", { class: "mono final-maths-card__value", "data-role": role, "data-field": "delta" }, "—"),
        ]),
      ]);

    const mathsAnswersStage = el("section", { class: "final-stage final-stage--maths-answers" }, [
      el("h2", { class: "mono final-stage__heading" }, "Maths answers"),
      el("div", { class: "final-maths-cards" }, [
        createMathCard("Daniel", "host"),
        createMathCard("Jaime", "guest"),
      ]),
    ]);

    const numberRollStage = el("section", { class: "final-stage final-stage--number-roll" }, [
      el("h2", { class: "mono final-stage__heading" }, "The final figure"),
      el("p", { class: "mono final-number-roll__prompt" }, ""),
      el("div", { class: "final-number-roll__target" }, "—"),
    ]);

    const mathsScoresStage = el("section", { class: "final-stage final-stage--maths-scores" }, [
      el("h2", { class: "mono final-stage__heading" }, "Maths scoring"),
      el("p", { class: "mono final-stage__line", "data-role": "host" }, ""),
      el("p", { class: "mono final-stage__line", "data-role": "guest" }, ""),
    ]);

    const markingStage = el("section", { class: "final-stage final-stage--marking" }, [
      el("h2", { class: "mono final-stage__heading" }, "Marking verdicts"),
      el("p", { class: "mono final-marking__line", "data-role": "host" }, ""),
      el("p", { class: "mono final-marking__line", "data-role": "guest" }, ""),
    ]);

    const winnerStage = el("section", { class: "final-stage final-stage--winner" }, [
      el("div", { class: "final-winner__label" }, ""),
    ]);

    sequence.appendChild(scoreboardStage);
    sequence.appendChild(mathsAnswersStage);
    sequence.appendChild(numberRollStage);
    sequence.appendChild(mathsScoresStage);
    sequence.appendChild(markingStage);
    sequence.appendChild(winnerStage);

    const reviewIntro = el("p", { class: "mono final-post__intro" }, "All questions and answers can be found below.");
    const reviewAccordion = el("div", { class: "final-round-panels" });
    const postRevealSection = el("section", { class: "final-post" }, [reviewIntro, reviewAccordion]);

    const backBtn = el("button", {
      class: "btn final-return",
      onclick: () => { window.location.hash = "#/lobby"; },
    }, "RETURN TO LOBBY");

    card.appendChild(heading);
    card.appendChild(sequence);
    card.appendChild(postRevealSection);
    card.appendChild(backBtn);

    root.appendChild(card);
    container.appendChild(root);

    const roundsRef = collection(roomRef(code), "rounds");

    const roundsData = {};
    let latestRoomData = {};

    this._sequenceTimeouts = [];
    this._sequenceStarted = false;
    this._rollController = null;

    const stageElements = [scoreboardStage, mathsAnswersStage, numberRollStage, mathsScoresStage, markingStage, winnerStage];

    const activateStage = (stage) => {
      stage.classList.add("final-stage--active");
    };

    const startRoll = () => {
      const targetEl = numberRollStage.querySelector(".final-number-roll__target");
      const value = targetEl ? Number(targetEl.dataset.targetValue || "") : NaN;
      if (!Number.isFinite(value)) return;
      if (this._rollController && typeof this._rollController.cancel === "function") {
        this._rollController.cancel();
      }
      this._rollController = createNumberRollController(targetEl, value);
    };

    const startSequence = () => {
      if (this._sequenceStarted) return;
      this._sequenceStarted = true;
      postRevealSection.classList.remove("final-post--visible");
      const schedule = (fn, delay) => {
        const id = setTimeout(fn, delay);
        this._sequenceTimeouts.push(id);
      };
      stageElements.forEach((stage) => stage.classList.remove("final-stage--active"));
      schedule(() => activateStage(scoreboardStage), 0);
      schedule(() => activateStage(mathsAnswersStage), 3000);
      schedule(() => {
        activateStage(numberRollStage);
        startRoll();
      }, 7000);
      schedule(() => activateStage(mathsScoresStage), 11000);
      schedule(() => activateStage(markingStage), 14000);
      schedule(() => activateStage(winnerStage), 18000);
      schedule(() => {
        postRevealSection.classList.add("final-post--visible");
      }, 20000);
    };

    const refreshAll = () => {
      const roomData = latestRoomData || {};
      const scores = roomData.scores || {};
      const maths = roomData.maths || {};
      const mathsAnswers = roomData.mathsAnswers || {};
      const totals = computeTotals(scores, mathsAnswers);

      renderScoreboard(scoreboardStage, totals);
      renderMathsAnswers(mathsAnswersStage, mathsAnswers);
      renderNumberRollStage(numberRollStage, maths);
      renderMathsScores(mathsScoresStage, totals, mathsAnswers);
      renderMarkingNarration(markingStage, roomData, roundsData, totals);
      renderWinner(winnerStage, totals);
      renderRoundReview(reviewAccordion, roomData, roundsData);

      const mathsTargetReady = Number.isFinite(Number(maths.answer));
      const hostReady = mathsAnswers.host && mathsAnswers.host.value !== undefined && mathsAnswers.host.value !== null;
      const guestReady = mathsAnswers.guest && mathsAnswers.guest.value !== undefined && mathsAnswers.guest.value !== null;
      if (!this._sequenceStarted && mathsTargetReady && hostReady && guestReady) {
        startSequence();
      }
    };

    const updateView = (roomData = {}) => {
      latestRoomData = roomData;
      refreshAll();
    };

    this._stop = onSnapshot(roomRef(code), (snap) => {
      if (!snap.exists()) return;
      updateView(snap.data() || {});
    }, (err) => {
      console.warn("[final] snapshot error:", err);
    });

    this._stopRounds = onSnapshot(roundsRef, (snapshot) => {
      Object.keys(roundsData).forEach((key) => { delete roundsData[key]; });
      snapshot.forEach((docSnap) => {
        const id = docSnap.id;
        const roundNum = Number(id);
        const data = docSnap.data() || {};
        if (Number.isFinite(roundNum)) roundsData[roundNum] = data;
      });
      refreshAll();
    }, (err) => {
      console.warn("[final] rounds snapshot error:", err);
    });
  },

  async unmount() {
    if (this._stop) {
      try { this._stop(); } catch {}
      this._stop = null;
    }
    if (this._stopRounds) {
      try { this._stopRounds(); } catch {}
      this._stopRounds = null;
    }
    if (this._sequenceTimeouts) {
      try {
        this._sequenceTimeouts.forEach((id) => clearTimeout(id));
      } catch {}
      this._sequenceTimeouts = [];
    }
    if (this._rollController && typeof this._rollController.cancel === "function") {
      try { this._rollController.cancel(); } catch {}
      this._rollController = null;
    }
    this._sequenceStarted = false;
  }
};
