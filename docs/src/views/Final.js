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
import { applyStageTheme } from "../lib/theme.js";

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

function computeTotals(scores = {}, mathsAnswers = {}, speedBonuses = {}) {
  const hostRounds = scores.host || {};
  const guestRounds = scores.guest || {};
  const hostBonuses = speedBonuses.host || {};
  const guestBonuses = speedBonuses.guest || {};
  let hostQuestions = 0;
  let guestQuestions = 0;
  for (let r = 1; r <= 5; r += 1) {
    hostQuestions += Number(hostRounds[r] || 0) + Number(hostBonuses[r] || 0);
    guestQuestions += Number(guestRounds[r] || 0) + Number(guestBonuses[r] || 0);
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

function normaliseTimingEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const seconds = typeof entry.totalSeconds === "number" ? entry.totalSeconds : null;
  if (seconds !== null && !Number.isNaN(seconds)) return seconds;
  const millis = typeof entry.totalMs === "number" ? entry.totalMs : null;
  if (millis !== null && !Number.isNaN(millis)) return millis / 1000;
  const generic = typeof entry.total === "number" ? entry.total : null;
  if (generic !== null && !Number.isNaN(generic)) return generic;
  return null;
}

function formatSeconds(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  if (num < 0.05) return "0.0s";
  return `${num.toFixed(num >= 10 ? 1 : 2)}s`;
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

function collectVerdicts(marking = {}, role) {
  const perRole = marking[role] || {};
  const results = [];
  for (let round = 1; round <= 5; round += 1) {
    const entry = getRoundMapValue(perRole, round);
    if (!Array.isArray(entry)) continue;
    for (const verdict of entry) {
      if (verdict === null || verdict === undefined || verdict === "") continue;
      results.push(String(verdict));
    }
  }
  return results;
}

function collectTimingEntries(timings = {}, role) {
  const perRole = timings[role] || {};
  const values = [];
  for (let round = 1; round <= 5; round += 1) {
    const entry = normaliseTimingEntry(getRoundMapValue(perRole, round));
    if (entry === null || entry === undefined) continue;
    values.push(entry);
  }
  return values;
}

function computeAccuracySummary(role, roomData = {}, roundsData = {}) {
  const answersMap = (roomData.answers || {})[role] || {};
  const itemsKey = role === "host" ? "hostItems" : "guestItems";
  let current = 0;
  let longest = 0;
  let totalCorrect = 0;
  let totalQuestions = 0;
  const perfectRounds = [];

  for (let round = 1; round <= 5; round += 1) {
    const answers = Array.isArray(getRoundMapValue(answersMap, round))
      ? getRoundMapValue(answersMap, round)
      : [];
    const roundItems = Array.isArray((roundsData[round] || {})[itemsKey])
      ? (roundsData[round] || {})[itemsKey]
      : [];
    const questionCount = Math.max(roundItems.length, answers.length, 3);
    let roundCorrect = 0;
    for (let i = 0; i < questionCount; i += 1) {
      const answer = answers[i] || {};
      const item = roundItems[i] || {};
      const chosen = answer.chosen;
      const correct = resolveCorrectAnswer(answer, item);
      const isRight = Boolean(chosen) && Boolean(correct) && same(chosen, correct);
      if (isRight) {
        current += 1;
        roundCorrect += 1;
        totalCorrect += 1;
      } else {
        current = 0;
      }
      longest = Math.max(longest, current);
    }
    totalQuestions += questionCount;
    if (questionCount > 0 && roundCorrect === questionCount) {
      perfectRounds.push(round);
    }
  }

  return { totalCorrect, totalQuestions, longestStreak: longest, perfectRounds };
}

function formatRoundList(rounds = []) {
  if (!Array.isArray(rounds) || rounds.length === 0) return "none";
  return rounds.map((r) => `R${r}`).join(", ");
}

function renderScoreBridge(container, totals) {
  container.innerHTML = "";
  const players = [
    { name: "Daniel", questions: totals.hostQuestions, maths: totals.hostMaths, total: totals.hostTotal },
    { name: "Jaime", questions: totals.guestQuestions, maths: totals.guestMaths, total: totals.guestTotal },
  ];
  players.forEach((player) => {
    const row = el("div", { class: "final-bridge__row" });
    row.appendChild(el("div", { class: "mono final-bridge__player" }, player.name.toUpperCase()));
    const flow = el("div", { class: "final-bridge__flow" });
    const strip = el("div", { class: "final-bridge__step final-bridge__step--strip" }, [
      el("div", { class: "mono final-bridge__label" }, "Score strip"),
      el("div", { class: "mono final-bridge__value" }, String(player.questions)),
    ]);
    const arrow1 = el("div", { class: "final-bridge__arrow" }, "→");
    const maths = el("div", { class: "final-bridge__step final-bridge__step--maths" }, [
      el("div", { class: "mono final-bridge__label" }, "Maths bonus"),
      el("div", { class: "mono final-bridge__value" }, formatSignedPoints(player.maths)),
    ]);
    const arrow2 = el("div", { class: "final-bridge__arrow" }, "→");
    const total = el("div", { class: "final-bridge__step final-bridge__step--total" }, [
      el("div", { class: "mono final-bridge__label" }, "Final total"),
      el("div", { class: "mono final-bridge__value" }, String(player.total)),
    ]);
    flow.appendChild(strip);
    flow.appendChild(arrow1);
    flow.appendChild(maths);
    flow.appendChild(arrow2);
    flow.appendChild(total);
    row.appendChild(flow);
    container.appendChild(row);
  });
}

function renderStatsList(list, roomData = {}, roundsData = {}) {
  list.innerHTML = "";
  const marking = roomData.marking || {};
  const timings = roomData.timings || {};
  const totals = computeTotals(
    roomData.scores || {},
    roomData.mathsAnswers || {},
    roomData.speedBonuses || {}
  );

  const hostVerdicts = collectVerdicts(marking, "host");
  const guestVerdicts = collectVerdicts(marking, "guest");
  const hostRight = hostVerdicts.filter((v) => v === "right").length;
  const guestRight = guestVerdicts.filter((v) => v === "right").length;
  const hostCalls = hostVerdicts.length;
  const guestCalls = guestVerdicts.length;
  let markingLine = "Marking calls: awaiting data.";
  if (hostCalls + guestCalls > 0) {
    let kicker = "Both spotted the same number of right answers.";
    if (hostRight > guestRight) kicker = "Daniel led the spotting stakes.";
    else if (guestRight > hostRight) kicker = "Jaime led the spotting stakes.";
    markingLine = `Marking calls: Daniel ${hostRight}/${hostCalls} right • Jaime ${guestRight}/${guestCalls} right. ${kicker}`;
  }

  const hostTimes = collectTimingEntries(timings, "host");
  const guestTimes = collectTimingEntries(timings, "guest");
  const hostFastest = hostTimes.length ? Math.min(...hostTimes) : null;
  const guestFastest = guestTimes.length ? Math.min(...guestTimes) : null;
  const hostTotalTime = hostTimes.length ? hostTimes.reduce((sum, value) => sum + value, 0) : null;
  const guestTotalTime = guestTimes.length ? guestTimes.reduce((sum, value) => sum + value, 0) : null;
  let speedLine = "Round speed: awaiting data.";
  if (hostTimes.length || guestTimes.length) {
    let speedKicker = "Neck and neck on fastest marks.";
    if (hostFastest !== null && guestFastest !== null) {
      const epsilon = 0.01;
      if (hostFastest + epsilon < guestFastest) speedKicker = "Daniel was the quicker player overall.";
      else if (guestFastest + epsilon < hostFastest) speedKicker = "Jaime was the quicker player overall.";
    }
    speedLine =
      `Round speed: Daniel fastest ${formatSeconds(hostFastest)} (total ${formatSeconds(hostTotalTime)}) • ` +
      `Jaime fastest ${formatSeconds(guestFastest)} (total ${formatSeconds(guestTotalTime)}). ${speedKicker}`;
  }

  const hostAccuracy = computeAccuracySummary("host", roomData, roundsData);
  const guestAccuracy = computeAccuracySummary("guest", roomData, roundsData);
  let accuracyLine = "Accuracy streaks: awaiting answers.";
  if (hostAccuracy.totalQuestions || guestAccuracy.totalQuestions) {
    accuracyLine =
      `Accuracy streaks: Daniel ${hostAccuracy.totalCorrect}/${hostAccuracy.totalQuestions} correct ` +
      `(longest ${hostAccuracy.longestStreak}, perfect ${formatRoundList(hostAccuracy.perfectRounds)}) • ` +
      `Jaime ${guestAccuracy.totalCorrect}/${guestAccuracy.totalQuestions} correct ` +
      `(longest ${guestAccuracy.longestStreak}, perfect ${formatRoundList(guestAccuracy.perfectRounds)}).`;
  }

  const lines = [markingLine, speedLine, accuracyLine,
    `Scoreline: Daniel ${totals.hostTotal} – Jaime ${totals.guestTotal}.`];

  lines.forEach((line) => {
    list.appendChild(el("li", { class: "mono final-stats__item" }, line));
  });
}

function verdictLabel(value) {
  if (value === "right") return "Right";
  if (value === "wrong") return "Wrong";
  if (value === "unknown") return "Unsure";
  return "Not marked";
}

function verdictClass(value) {
  if (value === "right") return "final-round__verdict--right";
  if (value === "wrong") return "final-round__verdict--wrong";
  if (value === "unknown") return "final-round__verdict--unknown";
  return "final-round__verdict--none";
}

function renderRoundReview(container, roomData = {}, roundsData = {}) {
  container.innerHTML = "";
  const timings = roomData.timings || {};
  const marking = roomData.marking || {};
  const answersHostMap = (roomData.answers || {}).host || {};
  const answersGuestMap = (roomData.answers || {}).guest || {};

  for (let round = 1; round <= 5; round += 1) {
    const details = el("details", { class: "final-round" });
    const summary = el("summary", { class: "final-round__summary" });

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
    const speedBonuses = roomData.speedBonuses || {};
    const hostBonus = Number(getRoundMapValue(speedBonuses.host || {}, round) || 0);
    const guestBonus = Number(getRoundMapValue(speedBonuses.guest || {}, round) || 0);

    const hostTiming = formatSeconds(normaliseTimingEntry(getRoundMapValue(timings.host || {}, round)));
    const guestTiming = formatSeconds(normaliseTimingEntry(getRoundMapValue(timings.guest || {}, round)));

    const hostVerdicts = Array.isArray(getRoundMapValue(marking.guest || {}, round))
      ? getRoundMapValue(marking.guest || {}, round)
      : [];
    const guestVerdicts = Array.isArray(getRoundMapValue(marking.host || {}, round))
      ? getRoundMapValue(marking.host || {}, round)
      : [];

    const clue = (() => {
      const direct = getRoundMapValue(roomData.clues || {}, round);
      if (typeof direct === "string" && direct.trim()) return direct.trim();
      const maths = roomData.maths || {};
      const arrIndex = round - 1;
      if (Array.isArray(maths.clues) && maths.clues[arrIndex]) {
        const viaMaths = maths.clues[arrIndex];
        if (typeof viaMaths === "string" && viaMaths.trim()) return viaMaths.trim();
      }
      return "";
    })();

    summary.appendChild(el("span", { class: "mono final-round__summary-label" }, `Round ${round}`));
    summary.appendChild(el(
      "span",
      { class: "mono final-round__summary-score" },
      `Daniel ${hostScore + hostBonus} pts • Jaime ${guestScore + guestBonus} pts`
    ));
    summary.appendChild(el(
      "span",
      { class: "mono final-round__summary-timing" },
      `Round time — Daniel ${hostTiming} • Jaime ${guestTiming}`
    ));
    if (clue) {
      summary.appendChild(el("span", { class: "mono final-round__summary-clue" }, `Clue: ${clue}`));
    }

    const body = el("div", { class: "final-round__content" });

    const renderPlayer = ({ playerName, items, answers, verdicts, markerName, markerTiming }) => {
      const section = el("section", { class: "final-round__player" });
      const header = el("div", { class: "final-round__player-heading" }, [
        el("div", { class: "mono final-round__player-name" }, playerName.toUpperCase()),
        el(
          "div",
          { class: "mono final-round__marker" },
          `Marked by ${markerName} (${markerTiming})`
        ),
      ]);
      section.appendChild(header);
      const list = el("ol", { class: "final-round__qa-list" });
      const questionCount = Math.max(items.length, answers.length, 3);
      for (let i = 0; i < questionCount; i += 1) {
        const item = items[i] || {};
        const answer = answers[i] || {};
        const questionLabel = `Q${(round - 1) * 3 + (i + 1)}`;
        const questionText = normaliseQuestionText(item, answer, questionLabel);
        const chosen = answer.chosen || "";
        const correct = resolveCorrectAnswer(answer, item) || "";
        const wasCorrect = Boolean(chosen) && Boolean(correct) && same(chosen, correct);
        const verdict = verdicts[i];

        const entry = el("li", { class: "final-round__qa-item" });
        entry.appendChild(el("div", { class: "mono final-round__prompt" }, questionText));

        const verdictChip = el(
          "span",
          { class: `mono final-round__verdict ${verdictClass(verdict)}` },
          verdictLabel(verdict)
        );

        const answerLine = (() => {
          if (!chosen) return el("div", { class: "mono final-round__answer final-round__answer--empty" }, "No answer submitted");
          const classes = ["mono", "final-round__answer"];
          classes.push(wasCorrect ? "final-round__answer--correct" : "final-round__answer--wrong");
          const status = wasCorrect ? "✓ correct" : "✕ incorrect";
          return el("div", { class: classes.join(" ") }, `Answer: ${chosen} (${status})`);
        })();

        const correctLine = el(
          "div",
          { class: "mono final-round__correct" },
          `Correct: ${correct || "—"}`
        );

        const verdictLine = el("div", { class: "final-round__verdict-line" }, verdictChip);

        entry.appendChild(answerLine);
        entry.appendChild(correctLine);
        entry.appendChild(verdictLine);
        list.appendChild(entry);
      }
      section.appendChild(list);
      return section;
    };

    body.appendChild(renderPlayer({
      playerName: "Daniel",
      items: hostItems,
      answers: answersHost,
      verdicts: hostVerdicts,
      markerName: "Jaime",
      markerTiming: guestTiming,
    }));

    body.appendChild(renderPlayer({
      playerName: "Jaime",
      items: guestItems,
      answers: answersGuest,
      verdicts: guestVerdicts,
      markerName: "Daniel",
      markerTiming: hostTiming,
    }));

    details.appendChild(summary);
    details.appendChild(body);
    container.appendChild(details);
  }
}

function renderMaths(mathSection, maths = {}, mathsAnswers = {}) {
  const events = Array.isArray(maths.events) ? maths.events : [];
  const targetTotal = Number.isInteger(maths.total)
    ? maths.total
    : events.reduce((sum, evt) => sum + (Number.isInteger(evt?.year) ? evt.year : 0), 0);
  const host = mathsAnswers.host || {};
  const guest = mathsAnswers.guest || {};
  mathSection.innerHTML = "";
  const title = maths.title || maths.question || "Timeline totals";
  mathSection.appendChild(el("div", { class: "mono final-maths__question" }, title));
  if (events.length) {
    const list = el("ol", { class: "final-maths__clues" });
    events.forEach((event, idx) => {
      const row = el("li", { class: "mono final-maths__clue" }, [
        el("div", {}, `Round ${idx + 1}: ${event?.prompt || "Event"}`),
        Number.isInteger(event?.year)
          ? el("div", { class: "small" }, `Year: ${event.year}`)
          : null,
      ].filter(Boolean));
      list.appendChild(row);
    });
    mathSection.appendChild(list);
  }
  if (Number.isInteger(targetTotal)) {
    mathSection.appendChild(
      el("div", { class: "mono final-maths__answer" }, `Correct total: ${targetTotal}`)
    );
    const scoring = maths.scoring || {};
    const sharp = Number.isInteger(scoring.sharpshooterMargin)
      ? scoring.sharpshooterMargin
      : Math.round(targetTotal * 0.02);
    const ball = Number.isInteger(scoring.ballparkMargin)
      ? scoring.ballparkMargin
      : Math.round(targetTotal * 0.05);
    mathSection.appendChild(
      el(
        "div",
        { class: "mono small final-maths__helper" },
        `3 pts within ±${sharp}; 2 pts within ±${ball}; safety net goes to the closest if neither hits those bands.`
      )
    );
  }

  const table = el("table", { class: "final-maths__table" });
  table.appendChild(el("thead", {}, el("tr", {}, [
    el("th", { class: "mono" }, "Player"),
    el("th", { class: "mono" }, "Total"),
    el("th", { class: "mono" }, "Δ"),
    el("th", { class: "mono" }, "Points"),
  ])));
  const tbody = el("tbody");
  tbody.appendChild(el("tr", {}, [
    el("td", { class: "mono" }, "Daniel"),
    el("td", { class: "mono" }, formatPoints(host.total)),
    el("td", { class: "mono" }, formatDelta(host.delta)),
    el("td", { class: "mono" }, formatPoints(host.points)),
  ]));
  tbody.appendChild(el("tr", {}, [
    el("td", { class: "mono" }, "Jaime"),
    el("td", { class: "mono" }, formatPoints(guest.total)),
    el("td", { class: "mono" }, formatDelta(guest.delta)),
    el("td", { class: "mono" }, formatPoints(guest.points)),
  ]));
  table.appendChild(tbody);
  mathSection.appendChild(table);
}

export default {
  async mount(container) {
    await ensureAuth();

    const params = getHashParams();
    const code = clampCode(params.get("code") || "");

    applyStageTheme("final", 5, code);

    container.innerHTML = "";
    const root = el("div", { class: "view view-final" });
    const card = el("div", { class: "card final-card" });
    const heading = el("h1", { class: "title" }, "SCORES");
    const winnerBanner = el("div", { class: "mono final-winner" }, "");

    const scoreBridgeNote = el(
      "div",
      { class: "mono final-bridge__note" },
      "During play the Score Strip froze on question totals. Jemima now parades the marking stamps, adds the maths ledger, and declares the champion."
    );
    const scoreBridgeRows = el("div", { class: "final-bridge__rows" });
    const scoreBridge = el("div", { class: "final-bridge" });
    scoreBridge.appendChild(scoreBridgeNote);
    scoreBridge.appendChild(scoreBridgeRows);

    const statsBlock = el("div", { class: "final-stats-block" });
    const statsList = el("ul", { class: "final-stats__list" });
    statsBlock.appendChild(statsList);

    const mathsSection = el("div", { class: "final-maths" });

    const reviewAccordion = el("div", { class: "final-review" });

    const backBtn = el("button", {
      class: "btn",
      onclick: () => { window.location.hash = "#/lobby"; },
    }, "RETURN TO LOBBY");

    card.appendChild(heading);
    card.appendChild(winnerBanner);
    card.appendChild(el("h2", { class: "mono section-heading" }, "Score reveal"));
    card.appendChild(scoreBridge);
    card.appendChild(el("h2", { class: "mono section-heading" }, "Marking & speed stats"));
    card.appendChild(statsBlock);
    card.appendChild(el("h2", { class: "mono section-heading" }, "Maths challenge"));
    card.appendChild(mathsSection);
    card.appendChild(el("h2", { class: "mono section-heading" }, "Round-by-round review"));
    card.appendChild(reviewAccordion);
    card.appendChild(backBtn);

    root.appendChild(card);
    container.appendChild(root);

    const bridgeRowsContainer = scoreBridgeRows;
    const roundsRef = collection(roomRef(code), "rounds");

    const roundsData = {};
    let latestRoomData = {};

    const refreshAll = () => {
      const roomData = latestRoomData || {};
      const scores = roomData.scores || {};
      const maths = roomData.maths || {};
      const mathsAnswers = roomData.mathsAnswers || {};
      const totals = computeTotals(scores, mathsAnswers, data.speedBonuses || {});
      winnerBanner.textContent = winnerLabel(totals);
      renderScoreBridge(bridgeRowsContainer, totals);
      renderStatsList(statsList, roomData, roundsData);
      renderMaths(mathsSection, maths, mathsAnswers);
      renderRoundReview(reviewAccordion, roomData, roundsData);
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
  }
};
