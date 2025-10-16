// /src/views/Final.js
import { ensureAuth, db } from "../lib/firebase.js";
import {
  collection,
  doc,
  getDocs,
  onSnapshot,
} from "firebase/firestore";

const PLAYER_NAMES = { host: "Daniel", guest: "Jaime" };
const DIFFICULTY_ORDER = { pub: 0, enthusiast: 1, specialist: 2 };

const sameAnswer = (a, b) => {
  const norm = (v) => String(v || "").trim().toLowerCase();
  return norm(a) === norm(b) && norm(a) !== "";
};

const asArray = (value) => (Array.isArray(value) ? value : []);

const resolveTimingForRole = (timings = {}, role, fallbackIds = []) => {
  const want = String(role || "").toLowerCase();
  if (!want) return null;
  const entries = Object.entries(timings || {});
  for (const [uid, infoRaw] of entries) {
    const info = infoRaw || {};
    if (String(info.role || "").toLowerCase() === want) {
      return { uid, info };
    }
  }
  for (const id of fallbackIds) {
    if (!id) continue;
    if (Object.prototype.hasOwnProperty.call(timings, id)) {
      return { uid: id, info: timings[id] || {} };
    }
  }
  if (entries.length === 1) {
    const [uid, infoRaw] = entries[0];
    return { uid, info: infoRaw || {} };
  }
  return null;
};

const msToText = (ms) => {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const secs = ms / 1000;
  if (secs >= 10) return `${secs.toFixed(1).replace(/\.0$/, "")} s`;
  return `${secs.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")} s`;
};

const plural = (value, unit) => {
  const n = Number(value) || 0;
  if (n === 1) return `1 ${unit}`;
  return `${n} ${unit}s`;
};

const streakLabel = (value, kind) => {
  if (!value) return "—";
  return `${value} ${kind}`;
};

const formatDifficulty = (tier = "") => {
  const normal = String(tier || "").trim().toLowerCase();
  if (!normal) return "";
  return normal.replace(/\b\w/g, (c) => c.toUpperCase());
};

const describeHardest = (record) => {
  if (!record) return "None logged.";
  const { question, round, tier, subject } = record;
  const tierLabel = formatDifficulty(tier);
  const parts = [];
  if (subject) parts.push(subject);
  if (tierLabel) parts.push(`${tierLabel}`);
  parts.push(`Round ${round}`);
  const heading = parts.join(" · ");
  return `${heading}: ${question || "(question missing)"}`;
};

const computeMarkingStats = (marks = [], opponentAnswers = []) => {
  let caughtWrong = 0;
  let missedWrong = 0;
  let confirmedRight = 0;
  let falseRight = 0;
  let unknown = 0;
  let totalJudged = 0;

  const totalItems = Math.max(marks.length, opponentAnswers.length);
  for (let i = 0; i < totalItems; i += 1) {
    const mark = marks[i];
    const ans = opponentAnswers[i] || {};
    const chosen = ans.chosen || "";
    const correct = ans.correct || ans.correct_answer || "";
    const actuallyCorrect = sameAnswer(chosen, correct);
    const actuallyWrong = !actuallyCorrect && Boolean(chosen);

    if (mark === "right") {
      totalJudged += 1;
      if (actuallyCorrect) confirmedRight += 1;
      else if (actuallyWrong) falseRight += 1;
    } else if (mark === "wrong") {
      totalJudged += 1;
      if (actuallyWrong || !chosen) caughtWrong += 1;
      else missedWrong += 1;
    } else {
      unknown += 1;
    }
  }

  return { caughtWrong, missedWrong, confirmedRight, falseRight, unknown, totalJudged };
};

const longestRun = (values = [], predicate = (v) => Boolean(v)) => {
  let best = 0;
  let current = 0;
  for (const value of values) {
    if (predicate(value)) {
      current += 1;
      if (current > best) best = current;
    } else {
      current = 0;
    }
  }
  return best;
};

const computeStats = (roomData, roundsByNumber = {}) => {
  const answers = roomData.answers || {};
  const marking = roomData.marking || {};
  const maths = roomData.maths || {};
  const mathsAnswers = roomData.mathsAnswers || {};
  const hostAnswersAll = answers.host || {};
  const guestAnswersAll = answers.guest || {};
  const hostMarkingAll = marking.host || {};
  const guestMarkingAll = marking.guest || {};
  const snippetTotals = { host: 0, guest: 0, ties: 0 };

  const questionSequences = { host: [], guest: [] };
  const perRoundBreakdown = [];

  let hostHardest = null;
  let guestHardest = null;

  const accumulateHardest = (record, existing) => {
    if (!record) return existing;
    if (!existing) return record;
    if (record.score > existing.score) return record;
    return existing;
  };

  for (let round = 1; round <= 5; round += 1) {
    const roundDoc = roundsByNumber[round] || {};
    const hostItems = asArray(roundDoc.hostItems);
    const guestItems = asArray(roundDoc.guestItems);
    const roundTimings = roundDoc.timings || {};
    const snippetWinnerUid = roundDoc.snippetWinnerUid || null;
    const snippetTie = Boolean(roundDoc.snippetTie);

    const hostAnswers = asArray(hostAnswersAll[round]);
    const guestAnswers = asArray(guestAnswersAll[round]);
    const hostMarks = asArray(hostMarkingAll[round]);
    const guestMarks = asArray(guestMarkingAll[round]);

    const evaluateQuestion = (items, answersArr, side) => {
      const flags = [];
      let count = 0;
      let hardestRecord = side === "host" ? hostHardest : guestHardest;
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i] || {};
        const answer = answersArr[i] || {};
        const chosen = answer.chosen || "";
        const correct = answer.correct || item.correct_answer || "";
        const isCorrect = sameAnswer(chosen, correct);
        flags.push(isCorrect);
        if (isCorrect) {
          count += 1;
          const tier = String(item.difficulty_tier || "").toLowerCase();
          const tierScore = (DIFFICULTY_ORDER[tier] ?? -1) + 1;
          const recordScore = tierScore * 100 + round * 10 + (i + 1);
          const record = {
            score: recordScore,
            question: item.question || answer.question || "",
            tier,
            subject: item.subject || "",
            round,
          };
          hardestRecord = accumulateHardest(record, hardestRecord);
        }
      }
      return { flags, count, hardest: hardestRecord };
    };

    const hostEval = evaluateQuestion(hostItems, hostAnswers, "host");
    const guestEval = evaluateQuestion(guestItems, guestAnswers, "guest");

    questionSequences.host.push(...hostEval.flags);
    questionSequences.guest.push(...guestEval.flags);
    hostHardest = hostEval.hardest;
    guestHardest = guestEval.hardest;

    const hostTimingEntry = resolveTimingForRole(roundTimings, "host");
    const guestTimingEntry = resolveTimingForRole(roundTimings, "guest");
    const hostTotalMs = Number(hostTimingEntry?.info?.totalMs);
    const guestTotalMs = Number(guestTimingEntry?.info?.totalMs);

    if (snippetTie) {
      snippetTotals.ties += 1;
      snippetTotals.host += 1;
      snippetTotals.guest += 1;
    } else if (snippetWinnerUid) {
      if (snippetWinnerUid === hostTimingEntry?.uid) snippetTotals.host += 1;
      else if (snippetWinnerUid === guestTimingEntry?.uid) snippetTotals.guest += 1;
    }

    perRoundBreakdown.push({
      round,
      hostTiming: Number.isFinite(hostTotalMs) ? hostTotalMs : null,
      guestTiming: Number.isFinite(guestTotalMs) ? guestTotalMs : null,
      hostMarking: computeMarkingStats(hostMarks, guestAnswers),
      guestMarking: computeMarkingStats(guestMarks, hostAnswers),
    });
  }

  const hostCorrectTotal = questionSequences.host.filter(Boolean).length;
  const guestCorrectTotal = questionSequences.guest.filter(Boolean).length;
  const hostWrongTotal = questionSequences.host.length - hostCorrectTotal;
  const guestWrongTotal = questionSequences.guest.length - guestCorrectTotal;

  const hostStreaks = {
    correct: longestRun(questionSequences.host, (v) => v === true),
    wrong: longestRun(questionSequences.host, (v) => v === false),
  };
  const guestStreaks = {
    correct: longestRun(questionSequences.guest, (v) => v === true),
    wrong: longestRun(questionSequences.guest, (v) => v === false),
  };

  const gatherTimingStats = (role) => {
    const totals = perRoundBreakdown
      .map((entry) => (role === "host" ? entry.hostTiming : entry.guestTiming))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (totals.length === 0) {
      return { average: null, fastest: null, total: null };
    }
    const sum = totals.reduce((acc, value) => acc + value, 0);
    const average = sum / totals.length;
    let fastestMs = totals[0];
    let fastestRound = 1;
    perRoundBreakdown.forEach((entry) => {
      const value = role === "host" ? entry.hostTiming : entry.guestTiming;
      if (Number.isFinite(value) && value > 0 && value < fastestMs) {
        fastestMs = value;
        fastestRound = entry.round;
      }
    });
    return {
      average,
      fastest: Number.isFinite(fastestMs)
        ? { round: fastestRound, ms: fastestMs }
        : null,
      total: sum,
    };
  };

  const hostTimingStats = gatherTimingStats("host");
  const guestTimingStats = gatherTimingStats("guest");

  const mathsCorrect = Array.isArray(maths.answers)
    ? maths.answers.map((value) => Number(value)).filter((value) => Number.isFinite(value))
    : [];
  const mathsHost = asArray(mathsAnswers.host);
  const mathsGuest = asArray(mathsAnswers.guest);
  const mathsCount = mathsCorrect.length;
  const countMathsCorrect = (arr) => {
    let tally = 0;
    for (let i = 0; i < mathsCount; i += 1) {
      const want = mathsCorrect[i];
      const got = Number(arr[i]);
      if (Number.isFinite(want) && Number.isFinite(got) && want === got) tally += 1;
    }
    return tally;
  };
  const mathsHostCorrect = countMathsCorrect(mathsHost);
  const mathsGuestCorrect = countMathsCorrect(mathsGuest);

  const totalHostScore = hostCorrectTotal + mathsHostCorrect;
  const totalGuestScore = guestCorrectTotal + mathsGuestCorrect;

  const markingTotalsHost = perRoundBreakdown.reduce(
    (acc, round) => ({
      caughtWrong: acc.caughtWrong + round.hostMarking.caughtWrong,
      confirmedRight: acc.confirmedRight + round.hostMarking.confirmedRight,
    }),
    { caughtWrong: 0, confirmedRight: 0 }
  );
  const markingTotalsGuest = perRoundBreakdown.reduce(
    (acc, round) => ({
      caughtWrong: acc.caughtWrong + round.guestMarking.caughtWrong,
      confirmedRight: acc.confirmedRight + round.guestMarking.confirmedRight,
    }),
    { caughtWrong: 0, confirmedRight: 0 }
  );

  const pickLeader = (hostValue, guestValue) => {
    if (hostValue > guestValue) return PLAYER_NAMES.host;
    if (guestValue > hostValue) return PLAYER_NAMES.guest;
    return "Dead heat";
  };

  const fastestOverall = (() => {
    const hostFast = hostTimingStats.fastest;
    const guestFast = guestTimingStats.fastest;
    if (!hostFast && !guestFast) return null;
    if (hostFast && guestFast) {
      if (hostFast.ms === guestFast.ms) {
        return { label: "Dead heat", ms: hostFast.ms, round: hostFast.round, tie: true };
      }
      if (hostFast.ms < guestFast.ms) {
        return { label: PLAYER_NAMES.host, ms: hostFast.ms, round: hostFast.round };
      }
      return { label: PLAYER_NAMES.guest, ms: guestFast.ms, round: guestFast.round };
    }
    if (hostFast) return { label: PLAYER_NAMES.host, ms: hostFast.ms, round: hostFast.round };
    return { label: PLAYER_NAMES.guest, ms: guestFast.ms, round: guestFast.round };
  })();

  return {
    totals: {
      questions: {
        host: hostCorrectTotal,
        guest: guestCorrectTotal,
        count: questionSequences.host.length,
        hostWrong: hostWrongTotal,
        guestWrong: guestWrongTotal,
      },
      maths: {
        count: mathsCount,
        host: mathsHostCorrect,
        guest: mathsGuestCorrect,
      },
      final: {
        host: totalHostScore,
        guest: totalGuestScore,
      },
      snippets: snippetTotals,
      markingLeaders: {
        wrong: pickLeader(markingTotalsHost.caughtWrong, markingTotalsGuest.caughtWrong),
        right: pickLeader(markingTotalsHost.confirmedRight, markingTotalsGuest.confirmedRight),
      },
      fastestOverall,
    },
    players: {
      host: {
        name: PLAYER_NAMES.host,
        streaks: hostStreaks,
        hardest: hostHardest,
        marking: markingTotalsHost,
        timings: hostTimingStats,
      },
      guest: {
        name: PLAYER_NAMES.guest,
        streaks: guestStreaks,
        hardest: guestHardest,
        marking: markingTotalsGuest,
        timings: guestTimingStats,
      },
    },
  };
};

export default {
  async mount(container) {
    await ensureAuth();

    const root = document.createElement("div");
    root.className = "view view-final";

    const summaryCard = document.createElement("div");
    summaryCard.className = "card final-card";
    const summaryHeading = document.createElement("h2");
    summaryHeading.className = "view-heading";
    summaryHeading.textContent = "Final Reckoning";
    const summaryBody = document.createElement("div");
    summaryBody.className = "final-summary";
    summaryBody.innerHTML = "<p class=\"mono\">Loading Jemima's notes…</p>";
    summaryCard.appendChild(summaryHeading);
    summaryCard.appendChild(summaryBody);

    const markingCard = document.createElement("div");
    markingCard.className = "card final-card";
    const markingTitle = document.createElement("h3");
    markingTitle.className = "section-title";
    markingTitle.textContent = "Marking Room Verdicts";
    const markingBody = document.createElement("div");
    markingBody.className = "final-section";
    markingBody.innerHTML = "<p class=\"mono\">Waiting for totals…</p>";
    markingCard.appendChild(markingTitle);
    markingCard.appendChild(markingBody);

    const questionCard = document.createElement("div");
    questionCard.className = "card final-card";
    const questionTitle = document.createElement("h3");
    questionTitle.className = "section-title";
    questionTitle.textContent = "Question Arcs";
    const questionBody = document.createElement("div");
    questionBody.className = "final-section";
    questionBody.innerHTML = "<p class=\"mono\">Crunching streaks…</p>";
    questionCard.appendChild(questionTitle);
    questionCard.appendChild(questionBody);

    const tempoCard = document.createElement("div");
    tempoCard.className = "card final-card";
    const tempoTitle = document.createElement("h3");
    tempoTitle.className = "section-title";
    tempoTitle.textContent = "Tempo & Snippets";
    const tempoBody = document.createElement("div");
    tempoBody.className = "final-section";
    tempoBody.innerHTML = "<p class=\"mono\">Timing the finale…</p>";
    tempoCard.appendChild(tempoTitle);
    tempoCard.appendChild(tempoBody);

    root.appendChild(summaryCard);
    root.appendChild(markingCard);
    root.appendChild(questionCard);
    root.appendChild(tempoCard);

    container.innerHTML = "";
    container.appendChild(root);

    const params = new URLSearchParams(location.hash.split("?")[1] || "");
    const code = (params.get("code") || "").trim().toUpperCase();
    if (!code) {
      summaryBody.innerHTML = "<p class=\"mono\">No room code found.</p>";
      return;
    }

    const roomRef = doc(db, "rooms", code);
    const roundsRef = collection(roomRef, "rounds");

    let roundsCache = null;

    const ensureRounds = async () => {
      if (roundsCache) return roundsCache;
      const querySnap = await getDocs(roundsRef);
      const map = {};
      querySnap.forEach((docSnap) => {
        const num = parseInt(docSnap.id, 10);
        if (Number.isFinite(num)) map[num] = docSnap.data() || {};
      });
      roundsCache = map;
      return map;
    };

    const renderStats = (roomData) => {
      if (!roomData) {
        summaryBody.innerHTML = "<p class=\"mono\">Room missing.</p>";
        return;
      }

      if ((roomData.state || "").toLowerCase() !== "final") {
        summaryBody.innerHTML = "<p class=\"mono\">Waiting for Jemima to finish scoring…</p>";
        markingBody.innerHTML = "<p class=\"mono\">Waiting…</p>";
        questionBody.innerHTML = "<p class=\"mono\">Waiting…</p>";
        tempoBody.innerHTML = "<p class=\"mono\">Waiting…</p>";
        return;
      }

      const stats = computeStats(roomData, roundsCache || {});

      const totalHost = stats.totals.final.host;
      const totalGuest = stats.totals.final.guest;
      const winLabel = totalHost > totalGuest
        ? `${PLAYER_NAMES.host} wins`
        : totalGuest > totalHost
        ? `${PLAYER_NAMES.guest} wins`
        : "Dead heat";

      const questionCount = stats.totals.questions.count || 15;
      const questionsHost = stats.totals.questions.host;
      const questionsGuest = stats.totals.questions.guest;
      const mathsCount = stats.totals.maths.count;
      const mathsHost = stats.totals.maths.host;
      const mathsGuest = stats.totals.maths.guest;
      const snippetTotals = stats.totals.snippets;

      const mathsLine = mathsCount > 0
        ? `<li>Maths answers: ${PLAYER_NAMES.host} ${mathsHost}/${mathsCount} · ${PLAYER_NAMES.guest} ${mathsGuest}/${mathsCount}</li>`
        : "";

      summaryBody.innerHTML = `
        <div class="final-score-line final-score-line--lead">${winLabel.toUpperCase()}</div>
        <div class="final-score-line final-score-line--total">${PLAYER_NAMES.host} ${totalHost} · ${PLAYER_NAMES.guest} ${totalGuest}</div>
        <ul class="final-score-list">
          <li>Questions correct: ${PLAYER_NAMES.host} ${questionsHost}/${questionCount} · ${PLAYER_NAMES.guest} ${questionsGuest}/${questionCount}</li>
          ${mathsLine}
          <li>Snippets kept: ${PLAYER_NAMES.host} ${snippetTotals.host} · ${PLAYER_NAMES.guest} ${snippetTotals.guest}${snippetTotals.ties ? ` (with ${snippetTotals.ties} dead heat${snippetTotals.ties === 1 ? "" : "s"})` : ""}</li>
        </ul>
      `;

      const markingLines = [
        `<li>${PLAYER_NAMES.host} caught ${plural(stats.players.host.marking.caughtWrong, "wrong answer")} and confirmed ${plural(stats.players.host.marking.confirmedRight, "correct")}</li>`,
        `<li>${PLAYER_NAMES.guest} caught ${plural(stats.players.guest.marking.caughtWrong, "wrong answer")} and confirmed ${plural(stats.players.guest.marking.confirmedRight, "correct")}</li>`,
        `<li>Most wrong answers spotted: ${stats.totals.markingLeaders.wrong}</li>`,
        `<li>Most right answers confirmed: ${stats.totals.markingLeaders.right}</li>`,
      ];
      markingBody.innerHTML = `<ul class="final-list">${markingLines.join("")}</ul>`;

      const hostStreak = streakLabel(stats.players.host.streaks.correct, "right in a row");
      const guestStreak = streakLabel(stats.players.guest.streaks.correct, "right in a row");
      const hostDrop = streakLabel(stats.players.host.streaks.wrong, "missed consecutively");
      const guestDrop = streakLabel(stats.players.guest.streaks.wrong, "missed consecutively");

      questionBody.innerHTML = `
        <ul class="final-list">
          <li>${PLAYER_NAMES.host}: longest run ${hostStreak}; wobble ${hostDrop}</li>
          <li>${PLAYER_NAMES.guest}: longest run ${guestStreak}; wobble ${guestDrop}</li>
          <li>Hardest answer from ${PLAYER_NAMES.host}: ${describeHardest(stats.players.host.hardest)}</li>
          <li>Hardest answer from ${PLAYER_NAMES.guest}: ${describeHardest(stats.players.guest.hardest)}</li>
        </ul>
      `;

      const fastestOverall = stats.totals.fastestOverall;
      const fastestLine = fastestOverall
        ? `${fastestOverall.label} – ${msToText(fastestOverall.ms)} in Round ${fastestOverall.round}`
        : "No snippet timings captured.";

      const tempoLines = [
        `<li>Fastest snippet: ${fastestLine}</li>`,
      ];

      if (stats.players.host.timings.average) {
        tempoLines.push(`<li>${PLAYER_NAMES.host} average snippet: ${msToText(stats.players.host.timings.average)}</li>`);
      }
      if (stats.players.guest.timings.average) {
        tempoLines.push(`<li>${PLAYER_NAMES.guest} average snippet: ${msToText(stats.players.guest.timings.average)}</li>`);
      }
      tempoLines.push(`<li>Total snippet time: ${PLAYER_NAMES.host} ${msToText(stats.players.host.timings.total)} · ${PLAYER_NAMES.guest} ${msToText(stats.players.guest.timings.total)}</li>`);

      tempoBody.innerHTML = `<ul class="final-list">${tempoLines.join("")}</ul>`;
    };

    const stop = onSnapshot(roomRef, async (snap) => {
      if (!snap.exists()) {
        summaryBody.innerHTML = "<p class=\"mono\">Room not found.</p>";
        return;
      }
      const data = snap.data() || {};
      if (!roundsCache) {
        roundsCache = await ensureRounds();
      }
      renderStats(data);
    }, (err) => {
      console.warn("[final] snapshot error", err);
      summaryBody.innerHTML = "<p class=\"mono\">Final stats failed to load.</p>";
    });

    this.unmount = () => {
      try { stop(); } catch (err) {
        console.warn("[final] failed to stop snapshot", err);
      }
    };
  },

  async unmount() {},
};
