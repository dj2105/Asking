// /src/views/Final.js
//
// Grand finale screen: show question-round totals, animated "true" final score,
// full round-by-round breakdown, maths reveal, and a return button.
// The layout follows the Courier, centered-column design set in styles.css.

import { ensureAuth, db } from "../lib/firebase.js";
import { doc, onSnapshot } from "firebase/firestore";
import { clampCode, getHashParams, getLastRoomCode } from "../lib/util.js";

const ROUND_COUNT = 5;

const STATUS_CONFIG = {
  right: { icon: "✓", className: "right" },
  wrong: { icon: "✕", className: "wrong" },
  dunno: { icon: "?", className: "dunno" },
  blank: { icon: "?", className: "dunno" },
};

const viewState = {
  alive: false,
  code: "",
  roomData: null,
  rounds: {},
  unsubscribers: [],
  timeline: [],
  questionTotals: { daniel: 0, jaime: 0 },
  finalTotals: { daniel: 0, jaime: 0 },
  animationPlayed: false,
  animationRunning: false,
  lastSignature: "",
  dom: {
    root: null,
    scoreboard: {
      card: null,
      title: null,
      subtitle: null,
      danielValue: null,
      jaimeValue: null,
      note: null,
      step: null,
      button: null,
      winner: null,
    },
    breakdownList: null,
    statsList: null,
    roundSections: [],
    mathsSection: null,
    mathsPanel: null,
    returnButton: null,
  },
};

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const key in attrs) {
    if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
    const value = attrs[key];
    if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  }
  const arr = Array.isArray(children) ? children : [children];
  for (const child of arr) {
    if (child == null) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function normalise(value) {
  return String(value ?? "").trim().toLowerCase();
}

function detectStatus(chosen, correct) {
  const chosenNorm = normalise(chosen);
  const correctNorm = normalise(correct);
  if (!chosenNorm) return "blank";
  if (chosenNorm.includes("dunno")) return "dunno";
  if (chosenNorm === "?" || chosenNorm === "idk") return "dunno";
  if (correctNorm && chosenNorm === correctNorm) return "right";
  return "wrong";
}

function formatChosen(status, chosen) {
  if (status === "blank") return "No answer";
  if (status === "dunno") return "I dunno";
  const raw = String(chosen ?? "").trim();
  return raw || "—";
}

function toArrayMaybe(value) {
  return Array.isArray(value) ? value : [];
}

function getAnswerList(source = {}, round) {
  if (!source) return [];
  const direct = source[round];
  if (Array.isArray(direct)) return direct;
  const stringKey = source[String(round)];
  if (Array.isArray(stringKey)) return stringKey;
  const prefixed = source[`r${round}`];
  if (Array.isArray(prefixed)) return prefixed;
  return [];
}

function buildPlayerAnswers(items = [], answers = []) {
  const entries = [];
  const length = Math.max(items.length, answers.length, 3);
  for (let i = 0; i < length; i += 1) {
    const item = items[i] || {};
    const answer = answers[i] || {};
    const question = (answer.question || item.question || "").trim();
    const correct = answer.correct || item.correct_answer || "";
    const chosenRaw = answer.chosen != null ? String(answer.chosen) : "";
    const status = detectStatus(chosenRaw, correct);
    const chosen = formatChosen(status, chosenRaw);
    const correctDisplay = correct ? String(correct) : "—";
    entries.push({
      index: i + 1,
      question: question || `Question ${i + 1}`,
      correct: correctDisplay,
      status,
      chosen,
      points: status === "right" ? 1 : 0,
    });
  }
  return entries;
}

function summariseRounds(roomData = {}, roundsMap = {}) {
  const answers = roomData.answers || {};
  const hostAnswersAll = answers.host || {};
  const guestAnswersAll = answers.guest || {};
  const summaries = [];

  for (let round = 1; round <= ROUND_COUNT; round += 1) {
    const roundDoc = roundsMap[round] || {};
    const hostItems = toArrayMaybe(roundDoc.hostItems);
    const guestItems = toArrayMaybe(roundDoc.guestItems);
    const hostAnswers = toArrayMaybe(getAnswerList(hostAnswersAll, round));
    const guestAnswers = toArrayMaybe(getAnswerList(guestAnswersAll, round));

    const danielEntries = buildPlayerAnswers(hostItems, hostAnswers);
    const jaimeEntries = buildPlayerAnswers(guestItems, guestAnswers);

    const danielScore = danielEntries.reduce((acc, item) => acc + (item.points || 0), 0);
    const jaimeScore = jaimeEntries.reduce((acc, item) => acc + (item.points || 0), 0);
    const danielDunno = danielEntries.filter((item) => item.status === "dunno" || item.status === "blank").length;
    const jaimeDunno = jaimeEntries.filter((item) => item.status === "dunno" || item.status === "blank").length;
    const hasContent = hostItems.length > 0 || guestItems.length > 0 || hostAnswers.length > 0 || guestAnswers.length > 0;

    summaries.push({
      round,
      hasContent,
      daniel: {
        items: danielEntries,
        score: danielScore,
        dunno: danielDunno,
      },
      jaime: {
        items: jaimeEntries,
        score: jaimeScore,
        dunno: jaimeDunno,
      },
    });
  }

  return summaries;
}

function computeMaths(roomData = {}) {
  const maths = roomData.maths || {};
  const answers = roomData.mathsAnswers || {};
  const correctRaw = toArrayMaybe(maths.answers);
  const hostRaw = toArrayMaybe(answers.host);
  const guestRaw = toArrayMaybe(answers.guest);
  const questions = toArrayMaybe(maths.questions);

  const length = Math.max(correctRaw.length, hostRaw.length, guestRaw.length);
  const entries = [];
  let hostScore = 0;
  let guestScore = 0;

  for (let i = 0; i < length; i += 1) {
    const correctValue = Number(correctRaw[i]);
    const hostValue = Number(hostRaw[i]);
    const guestValue = Number(guestRaw[i]);
    const hostExact = Number.isFinite(hostValue) && Number.isFinite(correctValue) && hostValue === correctValue;
    const guestExact = Number.isFinite(guestValue) && Number.isFinite(correctValue) && guestValue === correctValue;
    if (hostExact) hostScore += 1;
    if (guestExact) guestScore += 1;

    const diffHost = Number.isFinite(hostValue) && Number.isFinite(correctValue)
      ? hostValue - correctValue : null;
    const diffGuest = Number.isFinite(guestValue) && Number.isFinite(correctValue)
      ? guestValue - correctValue : null;

    const correctDisplay = Number.isFinite(correctValue)
      ? correctValue
      : (correctRaw[i] != null ? String(correctRaw[i]) : "—");
    const hostDisplay = Number.isFinite(hostValue)
      ? hostValue
      : (hostRaw[i] != null ? String(hostRaw[i]) : "—");
    const guestDisplay = Number.isFinite(guestValue)
      ? guestValue
      : (guestRaw[i] != null ? String(guestRaw[i]) : "—");

    entries.push({
      index: i + 1,
      question: questions[i] || `Question ${i + 1}`,
      correct: correctDisplay,
      host: hostDisplay,
      guest: guestDisplay,
      hostExact,
      guestExact,
      hostDiff: diffHost,
      guestDiff: diffGuest,
    });
  }

  return {
    entries,
    location: maths.location || "",
    beats: toArrayMaybe(maths.beats),
    hostScore,
    guestScore,
    correctCount: correctRaw.length,
    ready: length > 0,
  };
}

function buildTimeline(roundSummaries, mathsData) {
  const steps = [];
  let runningDaniel = 0;
  let runningJaime = 0;

  for (const entry of roundSummaries) {
    if (!entry.hasContent) continue;
    runningDaniel += entry.daniel.score;
    runningJaime += entry.jaime.score;
    steps.push({
      label: `Round ${entry.round}`,
      danielTotal: runningDaniel,
      jaimeTotal: runningJaime,
      delta: { daniel: entry.daniel.score, jaime: entry.jaime.score },
    });
  }

  if (mathsData.ready && (mathsData.hostScore || mathsData.guestScore)) {
    runningDaniel += mathsData.hostScore;
    runningJaime += mathsData.guestScore;
    steps.push({
      label: "Maths finale",
      danielTotal: runningDaniel,
      jaimeTotal: runningJaime,
      delta: { daniel: mathsData.hostScore, jaime: mathsData.guestScore },
    });
  }

  return steps;
}

function buildBreakdown(roundSummaries, mathsData, finalTotals) {
  const breakdown = roundSummaries.map((entry) => ({
    label: `Round ${entry.round}`,
    detail: entry.hasContent
      ? `Daniel +${entry.daniel.score} · Jaime +${entry.jaime.score}`
      : "Waiting for scores",
  }));

  if (mathsData.ready) {
    breakdown.push({
      label: "Maths finale",
      detail: `Daniel +${mathsData.hostScore} · Jaime +${mathsData.guestScore}`,
    });
  }

  breakdown.push({
    label: "True final",
    detail: `Daniel ${finalTotals.daniel} · Jaime ${finalTotals.jaime}`,
  });

  return breakdown;
}

function buildHighlights(roundSummaries, mathsData) {
  const highlights = [];
  let highestRound = null;
  let danielPerfect = 0;
  let jaimePerfect = 0;
  let danielWins = 0;
  let jaimeWins = 0;
  let danielDunno = 0;
  let jaimeDunno = 0;

  for (const entry of roundSummaries) {
    if (!entry.hasContent) continue;
    const total = entry.daniel.score + entry.jaime.score;
    if (!highestRound || total > highestRound.total) {
      highestRound = {
        round: entry.round,
        total,
        daniel: entry.daniel.score,
        jaime: entry.jaime.score,
      };
    }
    if (entry.daniel.score === 3) danielPerfect += 1;
    if (entry.jaime.score === 3) jaimePerfect += 1;
    if (entry.daniel.score > entry.jaime.score) danielWins += 1;
    else if (entry.jaime.score > entry.daniel.score) jaimeWins += 1;
    danielDunno += entry.daniel.dunno;
    jaimeDunno += entry.jaime.dunno;
  }

  if (highestRound) {
    highlights.push(
      `Highest scoring round — Round ${highestRound.round} (${highestRound.daniel} · ${highestRound.jaime})`
    );
  }

  highlights.push(`Perfect rounds — Daniel ${danielPerfect}, Jaime ${jaimePerfect}`);
  highlights.push(`Rounds won — Daniel ${danielWins}, Jaime ${jaimeWins}`);
  highlights.push(`“I dunno” or blank — Daniel ${danielDunno}, Jaime ${jaimeDunno}`);

  if (mathsData.ready && mathsData.correctCount > 0) {
    highlights.push(
      `Maths accuracy — Daniel ${mathsData.hostScore}/${mathsData.correctCount}, Jaime ${mathsData.guestScore}/${mathsData.correctCount}`
    );
  }

  return highlights;
}

function computeSignature(roundSummaries, mathsData) {
  const key = {
    rounds: roundSummaries.map((entry) => ({
      round: entry.round,
      daniel: entry.daniel.score,
      jaime: entry.jaime.score,
      has: entry.hasContent,
    })),
    maths: { host: mathsData.hostScore, guest: mathsData.guestScore },
  };
  try {
    return JSON.stringify(key);
  } catch (err) {
    console.warn("[final] signature stringify failed", err);
    return String(Date.now());
  }
}

function determineWinner(totals) {
  if (totals.daniel > totals.jaime) return { name: "Daniel", text: "DANIEL WINS!" };
  if (totals.jaime > totals.daniel) return { name: "Jaime", text: "JAIME WINS!" };
  return { name: "Tie", text: "IT’S A TIE!" };
}

function updateWinnerDisplay() {
  const { winner } = viewState.dom.scoreboard;
  if (!winner) return;
  if (!viewState.animationPlayed) {
    winner.textContent = "";
    winner.classList.remove("final-winner--visible", "final-winner--tie");
    return;
  }

  const result = determineWinner(viewState.finalTotals);
  winner.textContent = result.text;
  winner.classList.add("final-winner--visible");
  winner.classList.toggle("final-winner--tie", result.name === "Tie");
}

function renderRoundPanel(sectionRef, data) {
  const { panel, score } = sectionRef;
  if (!panel) return;

  const danielScoreText = data.hasContent ? data.daniel.score : "—";
  const jaimeScoreText = data.hasContent ? data.jaime.score : "—";
  if (score) score.textContent = `${danielScoreText} · ${jaimeScoreText}`;

  panel.innerHTML = "";

  if (!data.hasContent) {
    panel.appendChild(el("div", { class: "final-round__empty mono small" }, "Waiting for round data…"));
    return;
  }

  const summary = el(
    "div",
    { class: "final-round__summary mono" },
    `Score this round — Daniel +${data.daniel.score} · Jaime +${data.jaime.score}`
  );
  panel.appendChild(summary);

  const pairCount = Math.max(data.daniel.items.length, data.jaime.items.length);
  for (let i = 0; i < pairCount; i += 1) {
    const pair = el("div", { class: "final-question-pair" });
    pair.appendChild(renderPlayerQuestion("Daniel", data.daniel.items[i], "daniel"));
    pair.appendChild(renderPlayerQuestion("Jaime", data.jaime.items[i], "jaime"));
    panel.appendChild(pair);
  }
}

function renderPlayerQuestion(name, info, role) {
  const wrap = el("div", { class: `final-question final-question--${role}` });
  const statusKey = info ? info.status : "blank";
  const config = STATUS_CONFIG[statusKey] || STATUS_CONFIG.blank;
  const statusEl = el(
    "div",
    { class: `final-question__status final-status final-status--${config.className}` },
    config.icon
  );
  const body = el("div", { class: "final-question__body" });
  body.appendChild(el("div", { class: "final-question__name mono small" }, `${name} · Q${info ? info.index : "?"}`));
  body.appendChild(el("div", { class: "final-question__prompt mono" }, info ? info.question : "Question not available."));
  if (info) {
    body.appendChild(
      el(
        "div",
        { class: `final-question__answer final-question__answer--${config.className}` },
        `Answer: ${info.chosen}`
      )
    );
    body.appendChild(
      el(
        "div",
        { class: "final-question__correct mono small" },
        `Correct: ${info.correct}`
      )
    );
    body.appendChild(
      el(
        "div",
        { class: "final-question__points mono small" },
        info.points === 1 ? "+1 point" : "0 points"
      )
    );
  } else {
    body.appendChild(el("div", { class: "final-question__answer final-question__answer--dunno" }, "Awaiting data"));
  }
  wrap.appendChild(statusEl);
  wrap.appendChild(body);
  return wrap;
}

function updateBreakdownList(breakdown) {
  const list = viewState.dom.breakdownList;
  if (!list) return;
  list.innerHTML = "";
  for (const entry of breakdown) {
    const item = el("div", { class: "final-breakdown__item" });
    item.appendChild(el("div", { class: "final-breakdown__label mono" }, entry.label));
    item.appendChild(el("div", { class: "final-breakdown__value mono" }, entry.detail));
    list.appendChild(item);
  }
}

function updateHighlights(highlights) {
  const list = viewState.dom.statsList;
  if (!list) return;
  list.innerHTML = "";
  if (!highlights.length) {
    list.appendChild(el("li", { class: "mono" }, "Highlights will appear once rounds complete."));
    return;
  }
  for (const text of highlights) {
    list.appendChild(el("li", { class: "mono" }, text));
  }
}

function formatDiff(value) {
  if (!Number.isFinite(value)) return "";
  if (value === 0) return "±0";
  return value > 0 ? `+${value}` : `${value}`;
}

function updateMathsPanel(mathsData) {
  const panel = viewState.dom.mathsPanel;
  if (!panel) return;
  panel.innerHTML = "";

  if (!mathsData.ready) {
    panel.appendChild(el("div", { class: "final-maths__empty mono small" }, "Maths answers will appear here once both players submit."));
    return;
  }

  if (mathsData.location) {
    panel.appendChild(
      el("div", { class: "final-maths__location mono" }, `Location: ${mathsData.location}`)
    );
  }

  if (mathsData.beats.length) {
    const beatList = el("ul", { class: "final-maths__beats" });
    mathsData.beats.forEach((beat) => {
      beatList.appendChild(el("li", { class: "mono" }, beat));
    });
    panel.appendChild(beatList);
  }

  for (const entry of mathsData.entries) {
    const row = el("div", { class: "final-maths__row" });
    row.appendChild(el("div", { class: "final-maths__question mono" }, `Q${entry.index}. ${entry.question}`));

    const answers = el("div", { class: "final-maths__answers" });
    const daniel = el("div", { class: "final-maths__player final-maths__player--daniel mono" });
    daniel.textContent = `Daniel: ${entry.hostExact ? "✓" : "✕"} ${entry.host ?? "—"}`;
    if (Number.isFinite(entry.hostDiff) && !entry.hostExact) {
      daniel.appendChild(el("span", { class: "final-maths__delta" }, ` (${formatDiff(entry.hostDiff)})`));
    }
    const jaime = el("div", { class: "final-maths__player final-maths__player--jaime mono" });
    jaime.textContent = `Jaime: ${entry.guestExact ? "✓" : "✕"} ${entry.guest ?? "—"}`;
    if (Number.isFinite(entry.guestDiff) && !entry.guestExact) {
      jaime.appendChild(el("span", { class: "final-maths__delta" }, ` (${formatDiff(entry.guestDiff)})`));
    }

    const correct = el("div", { class: "final-maths__correct mono" }, `Correct: ${entry.correct}`);

    answers.appendChild(daniel);
    answers.appendChild(jaime);
    answers.appendChild(correct);
    row.appendChild(answers);
    panel.appendChild(row);
  }

  panel.appendChild(
    el(
      "div",
      { class: "final-maths__totals mono" },
      `Maths score — Daniel ${mathsData.hostScore} · Jaime ${mathsData.guestScore}`
    )
  );
}

async function animateCounters(step) {
  const { danielValue, jaimeValue, step: stepLabel } = viewState.dom.scoreboard;
  if (!danielValue || !jaimeValue) return;

  if (stepLabel) {
    stepLabel.textContent = `${step.label} · Daniel +${step.delta.daniel} · Jaime +${step.delta.jaime}`;
  }

  const startDaniel = Number(danielValue.textContent) || 0;
  const startJaime = Number(jaimeValue.textContent) || 0;

  await Promise.all([
    animateOneCounter(danielValue, startDaniel, step.danielTotal),
    animateOneCounter(jaimeValue, startJaime, step.jaimeTotal),
  ]);
}

async function animateOneCounter(element, start, target) {
  const diff = target - start;
  const steps = Math.abs(diff);
  if (steps === 0) {
    element.textContent = String(target);
    await new Promise((resolve) => setTimeout(resolve, 240));
    return;
  }
  const direction = diff > 0 ? 1 : -1;
  let current = start;
  element.classList.add("final-score-card__value--pulse");
  for (let i = 0; i < steps; i += 1) {
    if (!viewState.alive) break;
    current += direction;
    element.textContent = String(current);
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  element.classList.remove("final-score-card__value--pulse");
}

async function playFinalAnimation() {
  if (viewState.animationRunning) return;
  if (!viewState.timeline.length) return;
  viewState.animationRunning = true;

  const { danielValue, jaimeValue, note, step: stepLabel, button, winner } = viewState.dom.scoreboard;
  if (button) button.disabled = true;
  if (winner) {
    winner.textContent = "";
    winner.classList.remove("final-winner--visible", "final-winner--tie");
  }
  viewState.animationPlayed = false;

  if (note) note.textContent = "Reckoning…";
  if (danielValue) danielValue.textContent = "0";
  if (jaimeValue) jaimeValue.textContent = "0";
  if (stepLabel) stepLabel.textContent = "";

  for (const step of viewState.timeline) {
    if (!viewState.alive) break;
    await animateCounters(step);
    await new Promise((resolve) => setTimeout(resolve, 160));
  }

  if (note) note.textContent = "True final score (questions + maths)";
  if (stepLabel) stepLabel.textContent = "";
  if (danielValue) danielValue.textContent = String(viewState.finalTotals.daniel);
  if (jaimeValue) jaimeValue.textContent = String(viewState.finalTotals.jaime);

  viewState.animationPlayed = true;
  viewState.animationRunning = false;
  if (button) {
    button.disabled = false;
    button.textContent = "Replay the finish";
    button.classList.remove("throb-soft");
  }

  updateWinnerDisplay();
}

function updateScoreboardDisplay() {
  const { danielValue, jaimeValue, note, subtitle, button } = viewState.dom.scoreboard;
  const totals = viewState.animationPlayed ? viewState.finalTotals : viewState.questionTotals;

  if (danielValue) danielValue.textContent = String(totals.daniel);
  if (jaimeValue) jaimeValue.textContent = String(totals.jaime);
  if (note) {
    note.textContent = viewState.animationPlayed
      ? "True final score (questions + maths)"
      : "Questions total (before maths)";
  }
  if (subtitle) subtitle.textContent = viewState.code ? `Room ${viewState.code}` : "Final room";
  if (button) {
    button.disabled = viewState.timeline.length === 0;
    button.textContent = viewState.animationPlayed ? "Replay the finish" : "IT’S A WINNER!";
    button.classList.toggle("throb-soft", !viewState.animationPlayed && viewState.timeline.length > 0 && !button.disabled);
  }
  updateWinnerDisplay();
}

function updateView() {
  if (!viewState.dom.root) return;
  if (!viewState.roomData) {
    if (viewState.dom.scoreboard.note) {
      viewState.dom.scoreboard.note.textContent = "Waiting for room data…";
    }
    if (viewState.dom.scoreboard.button) viewState.dom.scoreboard.button.disabled = true;
    return;
  }

  const roundSummaries = summariseRounds(viewState.roomData, viewState.rounds);
  const mathsData = computeMaths(viewState.roomData);

  const questionTotals = roundSummaries.reduce((acc, entry) => ({
    daniel: acc.daniel + entry.daniel.score,
    jaime: acc.jaime + entry.jaime.score,
  }), { daniel: 0, jaime: 0 });

  const finalTotals = {
    daniel: questionTotals.daniel + mathsData.hostScore,
    jaime: questionTotals.jaime + mathsData.guestScore,
  };

  const timeline = buildTimeline(roundSummaries, mathsData);
  const breakdown = buildBreakdown(roundSummaries, mathsData, finalTotals);
  const highlights = buildHighlights(roundSummaries, mathsData);
  const signature = computeSignature(roundSummaries, mathsData);

  const dataChanged = signature !== viewState.lastSignature;
  viewState.lastSignature = signature;
  viewState.timeline = timeline;
  viewState.questionTotals = questionTotals;
  viewState.finalTotals = finalTotals;

  if (dataChanged) {
    viewState.animationPlayed = false;
  }

  updateScoreboardDisplay();
  updateBreakdownList(breakdown);
  updateHighlights(highlights);

  const roundMap = new Map(roundSummaries.map((entry) => [entry.round, entry]));
  for (const ref of viewState.dom.roundSections) {
    const data = roundMap.get(ref.round) || {
      round: ref.round,
      hasContent: false,
      daniel: { items: [], score: 0, dunno: 0 },
      jaime: { items: [], score: 0, dunno: 0 },
    };
    renderRoundPanel(ref, data);
  }

  updateMathsPanel(mathsData);
}

function clearWatchers() {
  for (const fn of viewState.unsubscribers) {
    try { fn && fn(); } catch (err) { console.warn("[final] failed to unsubscribe", err); }
  }
  viewState.unsubscribers = [];
}

function createRoundSections(container) {
  const sections = [];
  for (let round = 1; round <= ROUND_COUNT; round += 1) {
    const section = el("div", { class: "final-accordion" });
    const label = el("span", { class: "final-accordion__label" }, `Round ${round}`);
    const score = el("span", { class: "final-accordion__score mono" }, "— · —");
    const header = el("button", { class: "final-accordion__header", type: "button" }, [label, score]);
    const panel = el("div", { class: "final-accordion__panel" });
    panel.style.display = "none";
    section.appendChild(header);
    section.appendChild(panel);
    container.appendChild(section);

    const ref = { round, section, header, panel, score };
    sections.push(ref);
  }
  viewState.dom.roundSections = sections;

  let openIndex = -1;
  sections.forEach((ref, idx) => {
    ref.header.addEventListener("click", () => {
      const shouldOpen = openIndex !== idx;
      openIndex = shouldOpen ? idx : -1;
      sections.forEach((entry, entryIdx) => {
        const open = entryIdx === openIndex;
        entry.section.classList.toggle("final-accordion--open", open);
        entry.panel.style.display = open ? "block" : "none";
      });
    });
  });
}

function buildMathsAccordion(container) {
  const section = el("div", { class: "final-accordion final-accordion--maths" });
  const label = el("span", { class: "final-accordion__label" }, "Maths & snippets");
  const header = el("button", { class: "final-accordion__header", type: "button" }, [label]);
  const panel = el("div", { class: "final-accordion__panel final-maths__panel" });
  panel.style.display = "none";
  section.appendChild(header);
  section.appendChild(panel);
  container.appendChild(section);

  header.addEventListener("click", () => {
    const open = !section.classList.contains("final-accordion--open");
    section.classList.toggle("final-accordion--open", open);
    panel.style.display = open ? "block" : "none";
  });

  viewState.dom.mathsSection = section;
  viewState.dom.mathsPanel = panel;
}

function buildLayout(container, code) {
  const root = el("div", { class: "view view-final" });

  const scoreCard = el("div", { class: "card final-score-card" });
  const title = el("h2", { class: "final-score-card__title" }, "Final showdown");
  const subtitle = el("div", { class: "final-score-card__subtitle mono" }, code ? `Room ${code}` : "Final room");
  const scores = el("div", { class: "final-score-card__scores" });

  const danielBlock = el("div", { class: "final-score-card__player" }, [
    el("div", { class: "final-score-card__name mono" }, "Daniel"),
    el("div", { class: "final-score-card__value" }, "0"),
  ]);
  const jaimeBlock = el("div", { class: "final-score-card__player" }, [
    el("div", { class: "final-score-card__name mono" }, "Jaime"),
    el("div", { class: "final-score-card__value" }, "0"),
  ]);
  scores.appendChild(danielBlock);
  scores.appendChild(el("div", { class: "final-score-card__divider" }, "vs"));
  scores.appendChild(jaimeBlock);

  const note = el("div", { class: "final-score-card__note mono" }, "Questions total (before maths)");
  const step = el("div", { class: "final-score-card__step mono small" }, "");
  const button = el("button", { class: "btn big final-score-card__button", type: "button", disabled: "" }, "IT’S A WINNER!");
  const winner = el("div", { class: "final-winner" }, "");

  scoreCard.appendChild(title);
  scoreCard.appendChild(subtitle);
  scoreCard.appendChild(scores);
  scoreCard.appendChild(note);
  scoreCard.appendChild(step);
  scoreCard.appendChild(button);
  scoreCard.appendChild(winner);

  const breakdownCard = el("div", { class: "card final-breakdown-card" });
  breakdownCard.appendChild(el("div", { class: "section-title final-section-title" }, "Score breakdown"));
  const breakdownList = el("div", { class: "final-breakdown__grid" });
  breakdownCard.appendChild(breakdownList);
  breakdownCard.appendChild(el("div", { class: "section-title final-section-title" }, "Highlights"));
  const statsList = el("ul", { class: "final-stats__list" });
  breakdownCard.appendChild(statsList);

  const roundsHeading = el("div", { class: "final-rounds__heading" }, [
    el("div", { class: "section-title final-section-title" }, "Rounds"),
    el("div", { class: "section-note mono" }, "Tap to reveal the questions, answers, and scores."),
  ]);
  const roundsContainer = el("div", { class: "final-rounds" });

  const mathsContainer = el("div", { class: "final-maths" });

  const returnWrap = el("div", { class: "final-return" });
  const returnBtn = el("button", { class: "btn big", type: "button" }, "Return to lobby");
  returnWrap.appendChild(returnBtn);

  root.appendChild(scoreCard);
  root.appendChild(breakdownCard);
  root.appendChild(roundsHeading);
  root.appendChild(roundsContainer);
  root.appendChild(mathsContainer);
  root.appendChild(returnWrap);

  container.innerHTML = "";
  container.appendChild(root);

  viewState.dom.root = root;
  viewState.dom.scoreboard = {
    card: scoreCard,
    title,
    subtitle,
    danielValue: danielBlock.querySelector(".final-score-card__value"),
    jaimeValue: jaimeBlock.querySelector(".final-score-card__value"),
    note,
    step,
    button,
    winner,
  };
  viewState.dom.breakdownList = breakdownList;
  viewState.dom.statsList = statsList;
  viewState.dom.returnButton = returnBtn;

  createRoundSections(roundsContainer);
  buildMathsAccordion(mathsContainer);

  button.addEventListener("click", playFinalAnimation);
  returnBtn.addEventListener("click", () => { location.hash = "#/lobby"; });
}

export default {
  async mount(container) {
    viewState.alive = true;
    viewState.roomData = null;
    viewState.rounds = {};
    viewState.timeline = [];
    viewState.questionTotals = { daniel: 0, jaime: 0 };
    viewState.finalTotals = { daniel: 0, jaime: 0 };
    viewState.animationPlayed = false;
    viewState.animationRunning = false;
    viewState.lastSignature = "";
    clearWatchers();

    await ensureAuth();

    const params = getHashParams();
    const rawCode = params.get("code") || getLastRoomCode();
    const code = clampCode(rawCode || "");
    viewState.code = code;

    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    buildLayout(container, code);
    updateScoreboardDisplay();

    if (!code) {
      if (viewState.dom.scoreboard.note) {
        viewState.dom.scoreboard.note.textContent = "No room code supplied.";
      }
      return;
    }

    const roomRef = doc(db, "rooms", code);
    const unsubRoom = onSnapshot(roomRef, (snap) => {
      viewState.roomData = snap.exists() ? snap.data() || {} : null;
      updateView();
    }, (err) => {
      console.warn("[final] room snapshot failed", err);
    });
    viewState.unsubscribers.push(unsubRoom);

    for (let round = 1; round <= ROUND_COUNT; round += 1) {
      const roundRef = doc(db, "rooms", code, "rounds", String(round));
      const unsubRound = onSnapshot(roundRef, (snap) => {
        viewState.rounds[round] = snap.exists() ? snap.data() || {} : {};
        updateView();
      }, (err) => {
        console.warn(`[final] round ${round} snapshot failed`, err);
      });
      viewState.unsubscribers.push(unsubRound);
    }
  },

  async unmount() {
    viewState.alive = false;
    clearWatchers();
    viewState.dom = {
      root: null,
      scoreboard: {
        card: null,
        title: null,
        subtitle: null,
        danielValue: null,
        jaimeValue: null,
        note: null,
        step: null,
        button: null,
        winner: null,
      },
      breakdownList: null,
      statsList: null,
      roundSections: [],
      mathsSection: null,
      mathsPanel: null,
      returnButton: null,
    };
  },
};
