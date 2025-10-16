// /src/views/Final.js
//
// Final scorecard packed with post-game statistics.
// Pulls the finished room + round docs and summarises scoring, marking,
// timings, streaks, difficulty and maths to give Daniel and Jaime a proper
// finale.

import { ensureAuth, db } from "../lib/firebase.js";
import { doc, collection, getDoc, onSnapshot } from "firebase/firestore";
import { clampCode, getHashParams } from "../lib/util.js";

const HOST_NAME = "Daniel";
const GUEST_NAME = "Jaime";

const DIFFICULTY_ORDER = {
  pub: 0,
  easy: 0,
  beginner: 0,
  enthusiast: 1,
  medium: 1,
  intermediate: 1,
  specialist: 2,
  hard: 2,
  expert: 2,
};

const DIFFICULTY_LABEL = {
  [-1]: "None",
  0: "Pub",
  1: "Enthusiast",
  2: "Specialist",
};

const roundSubColRef = (code) => collection(doc(db, "rooms", code), "rounds");

const normalize = (value) => String(value ?? "").trim().toLowerCase();
const sameAnswer = (a, b) => {
  const aa = normalize(a);
  const bb = normalize(b);
  if (!aa && !bb) return true;
  if (!aa || !bb) return false;
  return aa === bb;
};

const resolveCorrect = (answer = {}, fallback = {}) =>
  answer.correct || fallback.correct_answer || "";

const readRoundList = (source = {}, round) => {
  if (!source) return [];
  if (Array.isArray(source)) return source;
  const byNumber = source[round];
  if (Array.isArray(byNumber)) return byNumber;
  const byString = source[String(round)];
  if (Array.isArray(byString)) return byString;
  return [];
};

const difficultyValue = (item = {}) => {
  const raw = normalize(item.difficulty_tier || item.difficulty || item.difficultyTier);
  if (Object.prototype.hasOwnProperty.call(DIFFICULTY_ORDER, raw)) {
    return DIFFICULTY_ORDER[raw];
  }
  return 0;
};

const difficultyLabel = (value) => DIFFICULTY_LABEL[value] || DIFFICULTY_LABEL[0];

const formatSeconds = (ms) => {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const seconds = ms / 1000;
  const precision = seconds >= 10 ? 1 : 2;
  let text = seconds.toFixed(precision);
  text = text.replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1");
  return `${text} s`;
};

const pluralize = (n, singular, plural) => {
  const abs = Math.abs(Number(n) || 0);
  if (abs === 1) return singular;
  return plural || `${singular}s`;
};

const resolveTimingEntry = (timings = {}, targetUid, roleName) => {
  if (!timings || typeof timings !== "object") return null;
  if (targetUid && Object.prototype.hasOwnProperty.call(timings, targetUid)) {
    return { uid: targetUid, info: timings[targetUid] || {} };
  }

  const want = normalize(roleName);
  const entries = Object.entries(timings);
  for (const [uid, infoRaw] of entries) {
    const info = infoRaw || {};
    if (normalize(info.role) === want && want) {
      return { uid, info };
    }
  }

  if (entries.length === 1) {
    const [uid, infoRaw] = entries[0];
    return { uid, info: infoRaw || {} };
  }

  return null;
};

const summarizeTimes = (records = []) => {
  const totals = records.filter((entry) => Number.isFinite(entry.totalMs));
  const fastest = totals.reduce((best, entry) => {
    if (!best || entry.totalMs < best.totalMs) return entry;
    return best;
  }, null);
  const averageTotal = totals.length
    ? totals.reduce((acc, entry) => acc + entry.totalMs, 0) / totals.length
    : null;

  const qDurations = records.filter((entry) => Number.isFinite(entry.questionMs));
  const averageQuestion = qDurations.length
    ? qDurations.reduce((acc, entry) => acc + entry.questionMs, 0) / qDurations.length
    : null;

  const markDurations = records.filter((entry) => Number.isFinite(entry.markMs));
  const averageMark = markDurations.length
    ? markDurations.reduce((acc, entry) => acc + entry.markMs, 0) / markDurations.length
    : null;

  return { fastest, averageTotal, averageQuestion, averageMark, count: totals.length };
};

const computeStreaks = (events = []) => {
  let bestCorrect = 0;
  let bestWrong = 0;
  let currentCorrect = 0;
  let currentWrong = 0;

  events.forEach((event) => {
    if (event.correct) {
      currentCorrect += 1;
      bestCorrect = Math.max(bestCorrect, currentCorrect);
      currentWrong = 0;
    } else {
      currentWrong += 1;
      bestWrong = Math.max(bestWrong, currentWrong);
      currentCorrect = 0;
    }
  });

  return { correct: bestCorrect, wrong: bestWrong };
};

const fetchAllRounds = async (code) => {
  const tasks = [];
  for (let r = 1; r <= 5; r += 1) {
    const ref = doc(roundSubColRef(code), String(r));
    tasks.push(
      getDoc(ref)
        .then((snap) => ({ round: r, data: snap.exists() ? snap.data() || {} : {} }))
        .catch(() => ({ round: r, data: {} })),
    );
  }

  const results = await Promise.all(tasks);
  const map = {};
  results.forEach(({ round, data }) => {
    map[round] = data;
  });
  return map;
};

const computeGameStats = (roomData = {}, rounds = {}) => {
  const meta = roomData.meta || {};
  const hostUid = meta.hostUid || "";
  const guestUid = meta.guestUid || "";

  const answers = roomData.answers || {};
  const marking = roomData.marking || {};

  const mathsBlock = roomData.maths || {};
  const mathsSolutionsRaw = Array.isArray(mathsBlock.answers) ? mathsBlock.answers : [];
  const mathsSolutions = mathsSolutionsRaw.map((value) => Number(value));
  const mathsTotal = mathsSolutions.length || 2;

  const mathsAnswers = roomData.mathsAnswers || {};
  const hostMathsAnswers = Array.isArray(mathsAnswers.host) ? mathsAnswers.host : [];
  const guestMathsAnswers = Array.isArray(mathsAnswers.guest) ? mathsAnswers.guest : [];

  const hostEvents = [];
  const guestEvents = [];

  const hostMarkingStats = {
    correctRight: 0,
    correctWrong: 0,
    falseRight: 0,
    falseWrong: 0,
    unknown: 0,
  };
  const guestMarkingStats = {
    correctRight: 0,
    correctWrong: 0,
    falseRight: 0,
    falseWrong: 0,
    unknown: 0,
  };

  const hostTimeRecords = [];
  const guestTimeRecords = [];

  let snippetHost = 0;
  let snippetGuest = 0;
  let snippetTie = 0;

  for (let round = 1; round <= 5; round += 1) {
    const roundData = rounds[round] || {};
    const hostItems = Array.isArray(roundData.hostItems) ? roundData.hostItems : [];
    const guestItems = Array.isArray(roundData.guestItems) ? roundData.guestItems : [];

    const hostAnswers = readRoundList(answers.host, round);
    const guestAnswers = readRoundList(answers.guest, round);
    const hostMarks = readRoundList(marking.host, round);
    const guestMarks = readRoundList(marking.guest, round);

    const hostCount = Math.max(hostItems.length, hostAnswers.length, 3);
    const guestCount = Math.max(guestItems.length, guestAnswers.length, 3);

    for (let i = 0; i < hostCount; i += 1) {
      const item = hostItems[i] || {};
      const answer = hostAnswers[i] || {};
      const chosen = answer.chosen;
      const correct = resolveCorrect(answer, item);
      const answered = Boolean(normalize(chosen));
      const success = answered && sameAnswer(chosen, correct);
      const diffValue = difficultyValue(item);
      hostEvents.push({
        round,
        index: i,
        correct: success,
        answered,
        difficultyValue: diffValue,
      });
    }

    for (let i = 0; i < guestCount; i += 1) {
      const item = guestItems[i] || {};
      const answer = guestAnswers[i] || {};
      const chosen = answer.chosen;
      const correct = resolveCorrect(answer, item);
      const answered = Boolean(normalize(chosen));
      const success = answered && sameAnswer(chosen, correct);
      const diffValue = difficultyValue(item);
      guestEvents.push({
        round,
        index: i,
        correct: success,
        answered,
        difficultyValue: diffValue,
      });
    }

    const guestAnswerCount = Math.max(guestAnswers.length, 3);
    for (let i = 0; i < guestAnswerCount; i += 1) {
      const answer = guestAnswers[i] || {};
      const verdict = normalize(hostMarks[i] || "");
      const correct = sameAnswer(answer.chosen, resolveCorrect(answer, guestItems[i] || {}));
      if (verdict === "right") {
        if (correct) hostMarkingStats.correctRight += 1;
        else hostMarkingStats.falseRight += 1;
      } else if (verdict === "wrong") {
        if (!correct) hostMarkingStats.correctWrong += 1;
        else hostMarkingStats.falseWrong += 1;
      } else {
        hostMarkingStats.unknown += 1;
      }
    }

    const hostAnswerCount = Math.max(hostAnswers.length, 3);
    for (let i = 0; i < hostAnswerCount; i += 1) {
      const answer = hostAnswers[i] || {};
      const verdict = normalize(guestMarks[i] || "");
      const correct = sameAnswer(answer.chosen, resolveCorrect(answer, hostItems[i] || {}));
      if (verdict === "right") {
        if (correct) guestMarkingStats.correctRight += 1;
        else guestMarkingStats.falseRight += 1;
      } else if (verdict === "wrong") {
        if (!correct) guestMarkingStats.correctWrong += 1;
        else guestMarkingStats.falseWrong += 1;
      } else {
        guestMarkingStats.unknown += 1;
      }
    }

    const timings = roundData.timings || {};
    const timingsMeta = roundData.timingsMeta || {};
    const questionStart = Number(timingsMeta.questionsStartAt) || null;

    const hostTiming = resolveTimingEntry(timings, hostUid, "host");
    if (hostTiming) {
      const info = hostTiming.info || {};
      let totalMs = Number(info.totalMs);
      const qDone = Number(info.qDoneMs);
      const markDone = Number(info.markDoneMs);
      let questionMs = null;
      if (Number.isFinite(qDone) && Number.isFinite(questionStart)) {
        questionMs = Math.max(0, qDone - questionStart);
      }
      if (!Number.isFinite(totalMs) && Number.isFinite(markDone) && Number.isFinite(questionStart)) {
        totalMs = Math.max(0, markDone - questionStart);
      }
      let markMs = null;
      if (Number.isFinite(totalMs) && Number.isFinite(questionMs)) {
        markMs = Math.max(0, totalMs - questionMs);
      }
      hostTimeRecords.push({ round, totalMs, questionMs, markMs });
    }

    const guestTiming = resolveTimingEntry(timings, guestUid, "guest");
    if (guestTiming) {
      const info = guestTiming.info || {};
      let totalMs = Number(info.totalMs);
      const qDone = Number(info.qDoneMs);
      const markDone = Number(info.markDoneMs);
      let questionMs = null;
      if (Number.isFinite(qDone) && Number.isFinite(questionStart)) {
        questionMs = Math.max(0, qDone - questionStart);
      }
      if (!Number.isFinite(totalMs) && Number.isFinite(markDone) && Number.isFinite(questionStart)) {
        totalMs = Math.max(0, markDone - questionStart);
      }
      let markMs = null;
      if (Number.isFinite(totalMs) && Number.isFinite(questionMs)) {
        markMs = Math.max(0, totalMs - questionMs);
      }
      guestTimeRecords.push({ round, totalMs, questionMs, markMs });
    }

    if (roundData.snippetTie) {
      snippetTie += 1;
    } else if (roundData.snippetWinnerUid) {
      const winner = roundData.snippetWinnerUid;
      if (winner === hostUid) snippetHost += 1;
      else if (winner === guestUid) snippetGuest += 1;
    } else {
      const hostTotal = hostTimeRecords[hostTimeRecords.length - 1]?.totalMs;
      const guestTotal = guestTimeRecords[guestTimeRecords.length - 1]?.totalMs;
      if (Number.isFinite(hostTotal) && Number.isFinite(guestTotal)) {
        if (Math.abs(hostTotal - guestTotal) <= 1) snippetTie += 1;
        else if (hostTotal < guestTotal) snippetHost += 1;
        else snippetGuest += 1;
      }
    }
  }

  const hostQuestionCorrect = hostEvents.filter((event) => event.correct).length;
  const guestQuestionCorrect = guestEvents.filter((event) => event.correct).length;
  const hostQuestionTotal = hostEvents.length;
  const guestQuestionTotal = guestEvents.length;

  const hostMathsCorrect = mathsSolutions.reduce(
    (acc, target, idx) => acc + (Number(hostMathsAnswers[idx]) === Number(target) ? 1 : 0),
    0,
  );
  const guestMathsCorrect = mathsSolutions.reduce(
    (acc, target, idx) => acc + (Number(guestMathsAnswers[idx]) === Number(target) ? 1 : 0),
    0,
  );

  const hostHasCorrect = hostEvents.some((event) => event.correct);
  const guestHasCorrect = guestEvents.some((event) => event.correct);
  const hostHardValue = hostHasCorrect
    ? hostEvents.reduce((max, event) => (event.correct ? Math.max(max, event.difficultyValue) : max), -1)
    : -1;
  const guestHardValue = guestHasCorrect
    ? guestEvents.reduce((max, event) => (event.correct ? Math.max(max, event.difficultyValue) : max), -1)
    : -1;

  const hostHardCount = hostHardValue >= 0
    ? hostEvents.filter((event) => event.correct && event.difficultyValue === hostHardValue).length
    : 0;
  const guestHardCount = guestHardValue >= 0
    ? guestEvents.filter((event) => event.correct && event.difficultyValue === guestHardValue).length
    : 0;

  hostMarkingStats.availableRight = guestEvents.filter((event) => event.correct).length;
  hostMarkingStats.availableWrong = guestEvents.filter((event) => !event.correct).length;
  hostMarkingStats.opportunities = hostMarkingStats.availableRight + hostMarkingStats.availableWrong;
  hostMarkingStats.correctTotal = hostMarkingStats.correctRight + hostMarkingStats.correctWrong;

  guestMarkingStats.availableRight = hostEvents.filter((event) => event.correct).length;
  guestMarkingStats.availableWrong = hostEvents.filter((event) => !event.correct).length;
  guestMarkingStats.opportunities = guestMarkingStats.availableRight + guestMarkingStats.availableWrong;
  guestMarkingStats.correctTotal = guestMarkingStats.correctRight + guestMarkingStats.correctWrong;

  const hostTotalPoints = hostQuestionCorrect + hostMathsCorrect;
  const guestTotalPoints = guestQuestionCorrect + guestMathsCorrect;

  const scoreboard = {
    host: {
      name: HOST_NAME,
      questionsCorrect: hostQuestionCorrect,
      questionsTotal: hostQuestionTotal,
      mathsCorrect: hostMathsCorrect,
      mathsTotal,
      total: hostTotalPoints,
    },
    guest: {
      name: GUEST_NAME,
      questionsCorrect: guestQuestionCorrect,
      questionsTotal: guestQuestionTotal,
      mathsCorrect: guestMathsCorrect,
      mathsTotal,
      total: guestTotalPoints,
    },
    winner: hostTotalPoints > guestTotalPoints
      ? `${HOST_NAME} wins`
      : guestTotalPoints > hostTotalPoints
        ? `${GUEST_NAME} wins`
        : "Dead heat",
  };

  return {
    scoreboard,
    maths: {
      total: mathsTotal,
      host: { correct: hostMathsCorrect, answers: hostMathsAnswers },
      guest: { correct: guestMathsCorrect, answers: guestMathsAnswers },
    },
    marking: { host: hostMarkingStats, guest: guestMarkingStats },
    streaks: { host: computeStreaks(hostEvents), guest: computeStreaks(guestEvents) },
    difficulty: {
      host: { value: hostHardValue, label: difficultyLabel(hostHardValue), count: hostHardCount },
      guest: { value: guestHardValue, label: difficultyLabel(guestHardValue), count: guestHardCount },
      overall: {
        value: Math.max(hostHardValue, guestHardValue),
        label: difficultyLabel(Math.max(hostHardValue, guestHardValue)),
      },
    },
    timings: {
      host: summarizeTimes(hostTimeRecords),
      guest: summarizeTimes(guestTimeRecords),
    },
    snippets: { host: snippetHost, guest: snippetGuest, ties: snippetTie },
  };
};

const renderStats = (container, stats) => {
  if (!container) return;
  if (!stats) {
    container.innerHTML = '<h2>Final</h2><section class="panel"><p class="status">No stats available.</p></section>';
    return;
  }

  const { scoreboard, maths, marking, streaks, difficulty, timings, snippets } = stats;
  const host = scoreboard.host;
  const guest = scoreboard.guest;

  const winnerHeading = scoreboard.winner.toUpperCase();

  const hostOpportunities = marking.host.opportunities || 0;
  const guestOpportunities = marking.guest.opportunities || 0;
  const hostAccuracy = hostOpportunities
    ? Math.round((marking.host.correctTotal / hostOpportunities) * 100)
    : 0;
  const guestAccuracy = guestOpportunities
    ? Math.round((marking.guest.correctTotal / guestOpportunities) * 100)
    : 0;

  const markRightHost = marking.host.correctRight;
  const markRightGuest = marking.guest.correctRight;
  const markWrongHost = marking.host.correctWrong;
  const markWrongGuest = marking.guest.correctWrong;

  const markRightSentence = markRightHost === markRightGuest
    ? `${HOST_NAME} and ${GUEST_NAME} each upheld ${markRightHost} correct answers`
    : `${markRightHost > markRightGuest ? HOST_NAME : GUEST_NAME} led the right calls ${Math.max(markRightHost, markRightGuest)} to ${Math.min(markRightHost, markRightGuest)}`;

  const markWrongSentence = markWrongHost === markWrongGuest
    ? `Both spotted ${markWrongHost} wrong answers`
    : `${markWrongHost > markWrongGuest ? HOST_NAME : GUEST_NAME} caught more wrong picks (${Math.max(markWrongHost, markWrongGuest)} vs ${Math.min(markWrongHost, markWrongGuest)})`;

  const unknownBits = [];
  if (marking.host.unknown > 0) {
    unknownBits.push(`${HOST_NAME} left ${marking.host.unknown} ${pluralize(marking.host.unknown, "call", "calls")} blank`);
  }
  if (marking.guest.unknown > 0) {
    unknownBits.push(`${GUEST_NAME} left ${marking.guest.unknown}`);
  }
  const unknownPart = unknownBits.length ? ` ${unknownBits.join("; ")}.` : "";

  const markingText = `${HOST_NAME} nailed ${marking.host.correctTotal}/${hostOpportunities || 0} verdicts (${hostAccuracy}%) while ${GUEST_NAME} hit ${marking.guest.correctTotal}/${guestOpportunities || 0} (${guestAccuracy}%). ${markRightSentence}. ${markWrongSentence}.${unknownPart}`;

  const hostHasSpeed = Number.isFinite(timings.host.averageTotal);
  const guestHasSpeed = Number.isFinite(timings.guest.averageTotal);
  let speedText = "";
  if (hostHasSpeed) {
    let part = `${HOST_NAME} averaged ${formatSeconds(timings.host.averageTotal)} per snippet`;
    if (timings.host.fastest && Number.isFinite(timings.host.fastest.totalMs)) {
      part += ` (fastest ${formatSeconds(timings.host.fastest.totalMs)} in Round ${timings.host.fastest.round})`;
    }
    speedText += `${part}.`;
  }
  if (guestHasSpeed) {
    let part = `${GUEST_NAME} averaged ${formatSeconds(timings.guest.averageTotal)} per snippet`;
    if (timings.guest.fastest && Number.isFinite(timings.guest.fastest.totalMs)) {
      part += ` (fastest ${formatSeconds(timings.guest.fastest.totalMs)} in Round ${timings.guest.fastest.round})`;
    }
    speedText += ` ${part}.`;
  }
  if (!speedText) speedText = "Timing data unavailable.";

  const hostDiff = difficulty.host;
  const guestDiff = difficulty.guest;
  const overallDiff = difficulty.overall;
  let hardestText = "";
  if (overallDiff.value < 0) {
    hardestText = "No correct answers were recorded.";
  } else if (hostDiff.value === guestDiff.value) {
    hardestText = `${HOST_NAME} and ${GUEST_NAME} both peaked at ${overallDiff.label}-tier wins (${hostDiff.count} vs ${guestDiff.count}).`;
  } else if (hostDiff.value > guestDiff.value) {
    const guestTail = guestDiff.value >= 0
      ? `the ${guestDiff.label} tier`
      : "any tier";
    hardestText = `${HOST_NAME} conquered the ${hostDiff.label} tier (${hostDiff.count} ${pluralize(hostDiff.count, "clear", "clears")}), while ${GUEST_NAME} topped out at ${guestTail}.`;
  } else {
    const hostTail = hostDiff.value >= 0
      ? `the ${hostDiff.label} tier`
      : "any tier";
    hardestText = `${GUEST_NAME} conquered the ${guestDiff.label} tier (${guestDiff.count} ${pluralize(guestDiff.count, "clear", "clears")}), while ${HOST_NAME} topped out at ${hostTail}.`;
  }

  const hostStreak = streaks.host;
  const guestStreak = streaks.guest;
  const correctLeader = hostStreak.correct === guestStreak.correct
    ? `Both strung together ${hostStreak.correct} ${pluralize(hostStreak.correct, "correct answer", "correct answers")}`
    : `${hostStreak.correct > guestStreak.correct ? HOST_NAME : GUEST_NAME} posted the longest run with ${Math.max(hostStreak.correct, guestStreak.correct)} straight ${pluralize(Math.max(hostStreak.correct, guestStreak.correct), "answer", "answers")} right`;
  const wrongLeader = hostStreak.wrong === guestStreak.wrong
    ? `Each kept their roughest spell to ${hostStreak.wrong} ${pluralize(hostStreak.wrong, "miss", "misses")}`
    : `${hostStreak.wrong > guestStreak.wrong ? HOST_NAME : GUEST_NAME} endured the longer wobble at ${Math.max(hostStreak.wrong, guestStreak.wrong)} ${pluralize(Math.max(hostStreak.wrong, guestStreak.wrong), "miss", "misses")}, while ${hostStreak.wrong > guestStreak.wrong ? GUEST_NAME : HOST_NAME} stopped at ${Math.min(hostStreak.wrong, guestStreak.wrong)}`;
  const streakText = `${correctLeader}. ${wrongLeader}.`;

  const mathsText = `${HOST_NAME} solved ${maths.host.correct}/${maths.total} beats; ${GUEST_NAME} managed ${maths.guest.correct}/${maths.total}.`;

  const snippetParts = [
    `${HOST_NAME} kept ${snippets.host} ${pluralize(snippets.host, "snippet", "snippets")}`,
    `${GUEST_NAME} kept ${snippets.guest} ${pluralize(snippets.guest, "snippet", "snippets")}`,
  ];
  if (snippets.ties) {
    snippetParts.push(`${snippets.ties} ${pluralize(snippets.ties, "round", "rounds")} ended level`);
  }
  const snippetText = `${snippetParts.join("; ")}.`;

  container.innerHTML = `
    <h2>Final</h2>
    <section class="panel final-summary">
      <h3 class="final-heading mono">${winnerHeading}</h3>
      <p class="status mono final-score-line">${host.name} ${host.total} · ${guest.name} ${guest.total}</p>
      <div class="final-breakdown">
        <div class="final-breakdown__col">
          <div class="final-breakdown__name">${host.name}</div>
          <div class="final-breakdown__line">Questions <span>${host.questionsCorrect}/${host.questionsTotal}</span></div>
          <div class="final-breakdown__line">Maths <span>${host.mathsCorrect}/${maths.total}</span></div>
          <div class="final-breakdown__line">Snippets <span>${snippets.host}</span></div>
        </div>
        <div class="final-breakdown__col">
          <div class="final-breakdown__name">${guest.name}</div>
          <div class="final-breakdown__line">Questions <span>${guest.questionsCorrect}/${guest.questionsTotal}</span></div>
          <div class="final-breakdown__line">Maths <span>${guest.mathsCorrect}/${maths.total}</span></div>
          <div class="final-breakdown__line">Snippets <span>${snippets.guest}</span></div>
        </div>
      </div>
    </section>
    <section class="panel final-stats">
      <h3 class="final-subheading mono">Highlights</h3>
      <ul class="final-stat-list mono">
        <li><strong>Marking calls.</strong> ${markingText}</li>
        <li><strong>Speed run.</strong> ${speedText}</li>
        <li><strong>Hardest wins.</strong> ${hardestText}</li>
        <li><strong>Streaks.</strong> ${streakText}</li>
        <li><strong>Maths duel.</strong> ${mathsText}</li>
        <li><strong>Jemima’s snippets.</strong> ${snippetText}</li>
      </ul>
    </section>
  `;
};

export default function Final() {
  const el = document.createElement("section");
  el.className = "wrap";

  const summary = document.createElement("div");
  summary.id = "summary";
  summary.innerHTML = '<h2>Final</h2><section class="panel"><p class="status">Loading…</p></section>';
  el.appendChild(summary);

  const params = getHashParams();
  const hintedCode = clampCode(params.get("code") || "")
    || clampCode((localStorage.getItem("lastGameCode") || ""));
  const code = hintedCode;

  let roundsPromise = null;
  const ensureRounds = async () => {
    if (!code) return {};
    if (!roundsPromise) {
      roundsPromise = fetchAllRounds(code).catch((err) => {
        console.warn("[final] failed to load rounds:", err);
        roundsPromise = null;
        throw err;
      });
    }
    return roundsPromise;
  };

  const renderWaiting = (text) => {
    summary.innerHTML = `<h2>Final</h2><section class="panel"><p class="status">${text}</p></section>`;
  };

  const render = (stats) => {
    renderStats(summary, stats);
  };

  (async () => {
    await ensureAuth();
    if (!code) {
      renderWaiting("No game code found.");
      return;
    }

    const roomRef = doc(db, "rooms", code);
    onSnapshot(roomRef, async (snap) => {
      if (!snap.exists()) {
        renderWaiting("Room not found.");
        return;
      }
      const data = snap.data() || {};
      if (String(data.state || "").toLowerCase() !== "final") {
        renderWaiting("Waiting for Jemima…");
        return;
      }
      try {
        const rounds = await ensureRounds();
        const stats = computeGameStats(data, rounds);
        render(stats);
      } catch (err) {
        console.warn("[final] render failed:", err);
        renderWaiting("Stats loading failed — retrying…");
      }
    }, (err) => {
      console.warn("[final] room snapshot error:", err);
      renderWaiting("Unable to load final stats.");
    });
  })();

  return el;
}

