// /src/views/Final.js
import { ensureAuth, db } from "../lib/firebase.js";
import { doc, collection, getDoc, getDocs, onSnapshot } from "firebase/firestore";

const ROLE_NAMES = { host: "Daniel", guest: "Jaime" };
const DIFF_RANK = { pub: 1, enthusiast: 2, specialist: 3 };
const DIFF_LABEL = {
  pub: "Pub-tier",
  enthusiast: "Enthusiast-tier",
  specialist: "Specialist-tier",
};

function same(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

function pickItem(items, idx, questionText) {
  if (!Array.isArray(items)) return null;
  const byIndex = items[idx] || null;
  if (byIndex && same(byIndex.question, questionText)) return byIndex;
  if (questionText) {
    for (const entry of items) {
      if (entry && same(entry.question, questionText)) return entry;
    }
  }
  return byIndex;
}

function toInteger(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (!Number.isInteger(num)) return null;
  return num;
}

function longestBoolStreak(values, target) {
  let best = 0;
  let run = 0;
  for (const value of values) {
    if (value === target) {
      run += 1;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return best;
}

function formatMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const secs = ms / 1000;
  const decimals = secs >= 10 ? 1 : 2;
  const text = secs.toFixed(decimals).replace(/\.0+$/, "").replace(/(\d)0$/, "$1");
  return text;
}

function formatDuration(ms) {
  const base = formatMs(ms);
  return base === "—" ? "—" : `${base}s`;
}

function formatPercent(frac) {
  if (!Number.isFinite(frac)) return "—";
  const value = Math.round(frac * 1000) / 10;
  const text = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${text}%`;
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function resolveTimingForRole(timings = {}, roleName, fallbacks = []) {
  const want = String(roleName || "").toLowerCase();
  if (!want) return null;
  const entries = Object.entries(timings || {});
  for (const [uid, infoRaw] of entries) {
    const info = infoRaw || {};
    if (String(info.role || "").toLowerCase() === want) {
      return { uid, info };
    }
  }
  for (const candidate of fallbacks) {
    if (!candidate) continue;
    if (Object.prototype.hasOwnProperty.call(timings || {}, candidate)) {
      return { uid: candidate, info: (timings || {})[candidate] || {} };
    }
  }
  if (entries.length === 1) {
    const [uid, infoRaw] = entries[0];
    return { uid, info: infoRaw || {} };
  }
  return null;
}

function computeQuestionDuration(qDoneMs, startAt) {
  if (Number.isFinite(qDoneMs) && Number.isFinite(startAt)) {
    return Math.max(0, qDoneMs - startAt);
  }
  return null;
}

function computeMarkDuration(totalMs, questionDuration) {
  if (!Number.isFinite(totalMs)) return null;
  if (!Number.isFinite(questionDuration)) return totalMs;
  return Math.max(0, totalMs - questionDuration);
}

function computeMarkingStats(roomData, role) {
  const oppRole = role === "host" ? "guest" : "host";
  const marksByRound = ((roomData.marking || {})[role] || {});
  const answersByRound = ((roomData.answers || {})[oppRole] || {});
  const stats = {
    correctRightCalls: 0,
    correctWrongCalls: 0,
    incorrectRightCalls: 0,
    incorrectWrongCalls: 0,
    totalRightCalls: 0,
    totalWrongCalls: 0,
    unknownCalls: 0,
    accuracy: null,
  };

  for (const [roundKey, arr] of Object.entries(marksByRound)) {
    const marks = Array.isArray(arr) ? arr : [];
    const answers = Array.isArray(answersByRound[roundKey]) ? answersByRound[roundKey] : [];
    marks.forEach((mark, idx) => {
      const normalized = mark === "right" ? "right" : mark === "wrong" ? "wrong" : "unknown";
      const answer = answers[idx] || {};
      const actualCorrect = answer && answer.chosen && same(answer.chosen, answer.correct);
      if (normalized === "right") {
        stats.totalRightCalls += 1;
        if (actualCorrect) stats.correctRightCalls += 1;
        else stats.incorrectRightCalls += 1;
      } else if (normalized === "wrong") {
        stats.totalWrongCalls += 1;
        if (!actualCorrect) stats.correctWrongCalls += 1;
        else stats.incorrectWrongCalls += 1;
      } else {
        stats.unknownCalls += 1;
      }
    });
  }

  const totalCalls = stats.totalRightCalls + stats.totalWrongCalls;
  if (totalCalls > 0) {
    stats.accuracy = (stats.correctRightCalls + stats.correctWrongCalls) / totalCalls;
  }

  return stats;
}

function computeTimingStats(rounds, hostUid, guestUid, names) {
  const hostDurations = { question: [], mark: [], total: [] };
  const guestDurations = { question: [], mark: [], total: [] };
  const fastestTotals = [];
  const fastestQuestions = [];
  const fastestMarks = [];

  rounds.forEach(({ round, data }) => {
    const timings = data.timings || {};
    const startAt = Number(((data.timingsMeta || {}).questionsStartAt));

    const hostEntry = resolveTimingForRole(timings, "host", [hostUid]);
    if (hostEntry) {
      const qDur = computeQuestionDuration(Number(hostEntry.info.qDoneMs), startAt);
      const totalDur = Number(hostEntry.info.totalMs);
      const markDur = computeMarkDuration(totalDur, qDur);
      if (Number.isFinite(qDur)) hostDurations.question.push(qDur);
      if (Number.isFinite(markDur)) hostDurations.mark.push(markDur);
      if (Number.isFinite(totalDur)) hostDurations.total.push(totalDur);
      if (Number.isFinite(totalDur)) fastestTotals.push({ role: "host", name: names.host, round, value: totalDur });
      if (Number.isFinite(qDur)) fastestQuestions.push({ role: "host", name: names.host, round, value: qDur });
      if (Number.isFinite(markDur)) fastestMarks.push({ role: "host", name: names.host, round, value: markDur });
    }

    const guestEntry = resolveTimingForRole(timings, "guest", [guestUid]);
    if (guestEntry) {
      const qDur = computeQuestionDuration(Number(guestEntry.info.qDoneMs), startAt);
      const totalDur = Number(guestEntry.info.totalMs);
      const markDur = computeMarkDuration(totalDur, qDur);
      if (Number.isFinite(qDur)) guestDurations.question.push(qDur);
      if (Number.isFinite(markDur)) guestDurations.mark.push(markDur);
      if (Number.isFinite(totalDur)) guestDurations.total.push(totalDur);
      if (Number.isFinite(totalDur)) fastestTotals.push({ role: "guest", name: names.guest, round, value: totalDur });
      if (Number.isFinite(qDur)) fastestQuestions.push({ role: "guest", name: names.guest, round, value: qDur });
      if (Number.isFinite(markDur)) fastestMarks.push({ role: "guest", name: names.guest, round, value: markDur });
    }
  });

  const hasAny = hostDurations.total.length || guestDurations.total.length || hostDurations.question.length || guestDurations.question.length;
  if (!hasAny) {
    return { lines: [] };
  }

  const avgHostQuestion = average(hostDurations.question);
  const avgGuestQuestion = average(guestDurations.question);
  const avgHostMark = average(hostDurations.mark);
  const avgGuestMark = average(guestDurations.mark);
  const sumHostTotal = hostDurations.total.reduce((sum, value) => sum + value, 0);
  const sumGuestTotal = guestDurations.total.reduce((sum, value) => sum + value, 0);

  const sortByValue = (arr) => arr.slice().sort((a, b) => a.value - b.value)[0] || null;
  const bestTotal = sortByValue(fastestTotals);
  const bestQuestion = sortByValue(fastestQuestions);
  const bestMark = sortByValue(fastestMarks);

  const lines = [];
  if (bestTotal) {
    lines.push(`${bestTotal.name} blitzed Round ${bestTotal.round} in ${formatDuration(bestTotal.value)} total.`);
  }
  if (bestQuestion) {
    lines.push(`${bestQuestion.name} wrapped their questions in Round ${bestQuestion.round} in ${formatDuration(bestQuestion.value)}.`);
  }
  if (bestMark) {
    lines.push(`${bestMark.name} marked quickest in Round ${bestMark.round} (${formatDuration(bestMark.value)}).`);
  }
  lines.push(`Average question time — ${names.host} ${formatDuration(avgHostQuestion)} · ${names.guest} ${formatDuration(avgGuestQuestion)}.`);
  lines.push(`Average marking time — ${names.host} ${formatDuration(avgHostMark)} · ${names.guest} ${formatDuration(avgGuestMark)}.`);
  lines.push(`Total time on task — ${names.host} ${formatDuration(sumHostTotal)} · ${names.guest} ${formatDuration(sumGuestTotal)}.`);

  return { lines };
}

function difficultyScore(record) {
  const tier = String(record.difficultyTier || "").toLowerCase();
  const base = DIFF_RANK[tier] || 0;
  const roundScore = Number(record.round) || 0;
  return base * 100 + roundScore;
}

function computeStats(roomData, rounds, context) {
  const code = context.code || "";
  const hostUid = context.hostUid || "";
  const guestUid = context.guestUid || "";
  const hostPlayer = context.hostPlayer || {};
  const guestPlayer = context.guestPlayer || {};

  const answersHost = ((roomData.answers || {}).host || {});
  const answersGuest = ((roomData.answers || {}).guest || {});

  const roundSummaries = [];
  const hostRecords = [];
  const guestRecords = [];
  const snippetTotals = { host: 0, guest: 0, tie: 0 };

  let biggestSwing = null;
  let hostRunning = 0;
  let guestRunning = 0;
  let leadChanges = 0;
  let lastLeader = "tie";
  let biggestGap = 0;
  let biggestGapStage = null;

  const roundMap = new Map();
  rounds.forEach(({ round, data }) => {
    if (!Number.isFinite(round)) return;
    roundMap.set(round, data || {});
  });
  const sortedRounds = Array.from(roundMap.keys()).sort((a, b) => a - b);

  sortedRounds.forEach((round) => {
    const data = roundMap.get(round) || {};
    const hostItems = Array.isArray(data.hostItems) ? data.hostItems : [];
    const guestItems = Array.isArray(data.guestItems) ? data.guestItems : [];
    const hostAnswers = Array.isArray(answersHost[round]) ? answersHost[round] : [];
    const guestAnswers = Array.isArray(answersGuest[round]) ? answersGuest[round] : [];

    let hostRoundCorrect = 0;
    let guestRoundCorrect = 0;

    hostAnswers.forEach((ans, idx) => {
      const item = pickItem(hostItems, idx, ans?.question);
      const question = ans?.question || item?.question || "";
      const chosen = ans?.chosen || "";
      const correctText = ans?.correct || item?.correct_answer || "";
      const correct = Boolean(chosen) && same(chosen, correctText);
      if (correct) hostRoundCorrect += 1;
      hostRecords.push({
        type: "round",
        round,
        index: idx + 1,
        question,
        chosen,
        correctAnswer: correctText,
        correct,
        difficultyTier: item?.difficulty_tier || "",
        subject: item?.subject || "",
      });
    });

    guestAnswers.forEach((ans, idx) => {
      const item = pickItem(guestItems, idx, ans?.question);
      const question = ans?.question || item?.question || "";
      const chosen = ans?.chosen || "";
      const correctText = ans?.correct || item?.correct_answer || "";
      const correct = Boolean(chosen) && same(chosen, correctText);
      if (correct) guestRoundCorrect += 1;
      guestRecords.push({
        type: "round",
        round,
        index: idx + 1,
        question,
        chosen,
        correctAnswer: correctText,
        correct,
        difficultyTier: item?.difficulty_tier || "",
        subject: item?.subject || "",
      });
    });

    const delta = hostRoundCorrect - guestRoundCorrect;
    if (biggestSwing === null || Math.abs(delta) > Math.abs(biggestSwing.delta)) {
      biggestSwing = { round, delta };
    }

    const snippetWinnerUid = data.snippetWinnerUid || "";
    const snippetTie = Boolean(data.snippetTie);
    let snippetLabel = "—";
    if (snippetTie) {
      snippetTotals.tie += 1;
      snippetLabel = "Split";
    } else if (snippetWinnerUid) {
      if (snippetWinnerUid === hostUid) {
        snippetTotals.host += 1;
        snippetLabel = ROLE_NAMES.host;
      } else if (snippetWinnerUid === guestUid) {
        snippetTotals.guest += 1;
        snippetLabel = ROLE_NAMES.guest;
      }
    }

    roundSummaries.push({
      round,
      hostCorrect: hostRoundCorrect,
      guestCorrect: guestRoundCorrect,
      snippetLabel,
    });

    hostRunning += hostRoundCorrect;
    guestRunning += guestRoundCorrect;
    const leader = hostRunning === guestRunning ? "tie" : hostRunning > guestRunning ? "host" : "guest";
    const gap = Math.abs(hostRunning - guestRunning);
    if (gap > biggestGap) {
      biggestGap = gap;
      biggestGapStage = { label: `Round ${round}`, leader };
    }
    if (leader !== "tie" && leader !== lastLeader) {
      leadChanges += 1;
      lastLeader = leader;
    } else if (leader === "tie") {
      // preserve lastLeader when tied
    }
  });

  const mathsAnswers = roomData.mathsAnswers || {};
  const mathsCorrect = Array.isArray(roomData.maths?.answers) ? roomData.maths.answers : [];
  const mathsQuestions = Array.isArray(roomData.maths?.questions) ? roomData.maths.questions : [];
  const hostMathsAnswers = Array.isArray(mathsAnswers.host) ? mathsAnswers.host : [];
  const guestMathsAnswers = Array.isArray(mathsAnswers.guest) ? mathsAnswers.guest : [];
  const mathsCount = Math.max(mathsCorrect.length, hostMathsAnswers.length, guestMathsAnswers.length, 0);
  let hostMathsCorrect = 0;
  let guestMathsCorrect = 0;
  const mathsRecords = [];

  for (let idx = 0; idx < mathsCount; idx += 1) {
    const prompt = mathsQuestions[idx] || "";
    const correctValue = toInteger(mathsCorrect[idx]);
    const hostValue = toInteger(hostMathsAnswers[idx]);
    const guestValue = toInteger(guestMathsAnswers[idx]);
    const hostCorrect = hostValue !== null && correctValue !== null && hostValue === correctValue;
    const guestCorrect = guestValue !== null && correctValue !== null && guestValue === correctValue;
    if (hostCorrect) hostMathsCorrect += 1;
    if (guestCorrect) guestMathsCorrect += 1;

    hostRecords.push({
      type: "maths",
      round: `M${idx + 1}`,
      index: idx + 1,
      question: prompt,
      chosen: hostValue !== null ? String(hostValue) : "",
      correctAnswer: correctValue !== null ? String(correctValue) : "",
      correct: hostCorrect,
      difficultyTier: "maths",
      subject: "Jemima’s Maths",
    });

    guestRecords.push({
      type: "maths",
      round: `M${idx + 1}`,
      index: idx + 1,
      question: prompt,
      chosen: guestValue !== null ? String(guestValue) : "",
      correctAnswer: correctValue !== null ? String(correctValue) : "",
      correct: guestCorrect,
      difficultyTier: "maths",
      subject: "Jemima’s Maths",
    });

    mathsRecords.push({
      index: idx + 1,
      prompt,
      correctValue,
      hostValue,
      guestValue,
      hostCorrect,
      guestCorrect,
    });
  }

  if (mathsCount > 0) {
    hostRunning += hostMathsCorrect;
    guestRunning += guestMathsCorrect;
    const leader = hostRunning === guestRunning ? "tie" : hostRunning > guestRunning ? "host" : "guest";
    const gap = Math.abs(hostRunning - guestRunning);
    if (gap > biggestGap) {
      biggestGap = gap;
      biggestGapStage = { label: "Maths", leader };
    }
    if (leader !== "tie" && leader !== lastLeader) {
      leadChanges += 1;
      lastLeader = leader;
    }
  }

  if (!snippetTotals.host && !snippetTotals.guest && !snippetTotals.tie) {
    const hostRetained = Object.values(hostPlayer.retainedSnippets || {}).filter(Boolean).length;
    const guestRetained = Object.values(guestPlayer.retainedSnippets || {}).filter(Boolean).length;
    if (hostRetained || guestRetained) {
      snippetTotals.host = hostRetained;
      snippetTotals.guest = guestRetained;
    }
  }

  const hostQuestionRecords = hostRecords.filter((rec) => rec.type === "round");
  const guestQuestionRecords = guestRecords.filter((rec) => rec.type === "round");

  const totals = {
    host: {
      questionsCorrect: hostQuestionRecords.filter((rec) => rec.correct).length,
      questionsAsked: hostQuestionRecords.length,
      mathsCorrect: hostMathsCorrect,
      mathsAsked: mathsCount,
    },
    guest: {
      questionsCorrect: guestQuestionRecords.filter((rec) => rec.correct).length,
      questionsAsked: guestQuestionRecords.length,
      mathsCorrect: guestMathsCorrect,
      mathsAsked: mathsCount,
    },
  };
  totals.host.total = totals.host.questionsCorrect + totals.host.mathsCorrect;
  totals.guest.total = totals.guest.questionsCorrect + totals.guest.mathsCorrect;

  let winnerText = "Dead heat";
  if (totals.host.total > totals.guest.total) winnerText = `${ROLE_NAMES.host} wins`;
  else if (totals.guest.total > totals.host.total) winnerText = `${ROLE_NAMES.guest} wins`;

  const margin = Math.abs(totals.host.total - totals.guest.total);
  let marginText = "All square after Jemima’s maths.";
  if (margin === 1) marginText = "Settled by a single point.";
  else if (margin > 1) marginText = `Winning margin: ${margin} points.`;

  const mathsSummaryRow = mathsCount > 0 ? {
    hostText: `${totals.host.mathsCorrect}/${mathsCount}`,
    guestText: `${totals.guest.mathsCorrect}/${mathsCount}`,
    label: totals.host.mathsCorrect === totals.guest.mathsCorrect
      ? "Split"
      : totals.host.mathsCorrect > totals.guest.mathsCorrect ? ROLE_NAMES.host : ROLE_NAMES.guest,
  } : null;

  let mathsHighlight = "";
  if (mathsCount > 0) {
    if (totals.host.mathsCorrect === totals.guest.mathsCorrect) mathsHighlight = "Maths was a draw.";
    else if (totals.host.mathsCorrect > totals.guest.mathsCorrect) mathsHighlight = `${ROLE_NAMES.host} edged the maths ${totals.host.mathsCorrect}-${totals.guest.mathsCorrect}.`;
    else mathsHighlight = `${ROLE_NAMES.guest} took the maths ${totals.guest.mathsCorrect}-${totals.host.mathsCorrect}.`;
  }

  const markingHost = computeMarkingStats(roomData, "host");
  const markingGuest = computeMarkingStats(roomData, "guest");

  const markingParts = [];
  if (markingHost.correctWrongCalls !== markingGuest.correctWrongCalls) {
    const leader = markingHost.correctWrongCalls > markingGuest.correctWrongCalls ? ROLE_NAMES.host : ROLE_NAMES.guest;
    const winnerValue = Math.max(markingHost.correctWrongCalls, markingGuest.correctWrongCalls);
    const otherValue = Math.min(markingHost.correctWrongCalls, markingGuest.correctWrongCalls);
    markingParts.push(`${leader} caught ${winnerValue} wrong answer${winnerValue === 1 ? "" : "s"} (${otherValue} for the opponent).`);
  }
  if (markingHost.correctRightCalls !== markingGuest.correctRightCalls) {
    const leader = markingHost.correctRightCalls > markingGuest.correctRightCalls ? ROLE_NAMES.host : ROLE_NAMES.guest;
    const winnerValue = Math.max(markingHost.correctRightCalls, markingGuest.correctRightCalls);
    const otherValue = Math.min(markingHost.correctRightCalls, markingGuest.correctRightCalls);
    markingParts.push(`${leader} confirmed ${winnerValue} right answer${winnerValue === 1 ? "" : "s"} (${otherValue} for the opponent).`);
  }
  const hostAcc = formatPercent(markingHost.accuracy);
  const guestAcc = formatPercent(markingGuest.accuracy);
  if (hostAcc !== "—" || guestAcc !== "—") {
    markingParts.push(`Accuracy — ${ROLE_NAMES.host} ${hostAcc}, ${ROLE_NAMES.guest} ${guestAcc}.`);
  }
  if (snippetTotals.host || snippetTotals.guest || snippetTotals.tie) {
    const tieText = snippetTotals.tie ? `, splits ${snippetTotals.tie}` : "";
    markingParts.push(`Snippets kept — ${ROLE_NAMES.host} ${snippetTotals.host}, ${ROLE_NAMES.guest} ${snippetTotals.guest}${tieText}.`);
  }
  if (!markingParts.length) {
    markingParts.push("Both judges matched verdicts all night.");
  }
  const markingHighlight = markingParts.join(" ");

  const timing = computeTimingStats(rounds, hostUid, guestUid, ROLE_NAMES);

  const hostBools = hostRecords.map((rec) => Boolean(rec.correct));
  const guestBools = guestRecords.map((rec) => Boolean(rec.correct));
  const streakLine = `${ROLE_NAMES.host}: ${longestBoolStreak(hostBools, true)} right / ${longestBoolStreak(hostBools, false)} wrong · ${ROLE_NAMES.guest}: ${longestBoolStreak(guestBools, true)} right / ${longestBoolStreak(guestBools, false)} wrong`;

  const hardestLines = [];
  const hostHardest = hostQuestionRecords.filter((rec) => rec.correct).sort((a, b) => difficultyScore(b) - difficultyScore(a))[0] || null;
  const guestHardest = guestQuestionRecords.filter((rec) => rec.correct).sort((a, b) => difficultyScore(b) - difficultyScore(a))[0] || null;
  if (hostHardest) {
    const tier = String(hostHardest.difficultyTier || "").toLowerCase();
    const diffLabel = DIFF_LABEL[tier] || "High-tier";
    hardestLines.push({
      line: `${ROLE_NAMES.host} cracked a ${diffLabel} question in Round ${hostHardest.round}.`,
      question: hostHardest.question,
    });
  }
  if (guestHardest) {
    const tier = String(guestHardest.difficultyTier || "").toLowerCase();
    const diffLabel = DIFF_LABEL[tier] || "High-tier";
    hardestLines.push({
      line: `${ROLE_NAMES.guest} cracked a ${diffLabel} question in Round ${guestHardest.round}.`,
      question: guestHardest.question,
    });
  }

  const roundParts = [];
  if (biggestSwing && biggestSwing.delta !== 0) {
    const swingName = biggestSwing.delta > 0 ? ROLE_NAMES.host : ROLE_NAMES.guest;
    const swingPoints = Math.abs(biggestSwing.delta);
    roundParts.push(`Round ${biggestSwing.round} swung ${swingPoints} point${swingPoints === 1 ? "" : "s"} toward ${swingName}.`);
  }
  if (leadChanges > 0) {
    roundParts.push(`Lead changed ${leadChanges} time${leadChanges === 1 ? "" : "s"}.`);
  }
  if (biggestGap > 0 && biggestGapStage && biggestGapStage.leader) {
    const leaderName = biggestGapStage.leader === "host" ? ROLE_NAMES.host : ROLE_NAMES.guest;
    roundParts.push(`${leaderName} led by ${biggestGap} after ${biggestGapStage.label}.`);
  }
  if (!roundParts.length) {
    roundParts.push("Every round was perfectly balanced.");
  }
  const roundHighlight = roundParts.join(" ");

  return {
    code,
    names: ROLE_NAMES,
    totals,
    scoreline: `${ROLE_NAMES.host} ${totals.host.total} · ${ROLE_NAMES.guest} ${totals.guest.total}`,
    winnerText,
    marginText,
    roundSummaries,
    roundHighlight,
    mathsSummaryRow,
    mathsRecords,
    mathsHighlight,
    markingStats: { host: markingHost, guest: markingGuest },
    markingHighlight,
    snippetTotals,
    timingLines: timing.lines,
    hardestLines,
    streakLine,
    roundCount: roundSummaries.length,
    mathsCount,
  };
}

function formatMathsCell(value, correct) {
  if (value === null || value === undefined) return "—";
  const text = escapeHtml(String(value));
  return `${text} ${correct ? "✓" : "✕"}`;
}

function buildSummaryPanel(stats) {
  const extras = [];
  if (stats.code) extras.push(`Room ${stats.code}`);
  if (stats.roundCount) {
    const roundsText = `${stats.roundCount} round${stats.roundCount === 1 ? "" : "s"}`;
    extras.push(stats.mathsCount ? `${roundsText} + maths` : roundsText);
  }
  const subLabel = extras.length ? `<div class="mono small final-sublabel">${escapeHtml(extras.join(" · "))}</div>` : "";
  return `
    <section class="panel final-panel">
      <div class="final-summary">
        ${subLabel}
        <div class="mono final-winner">${escapeHtml(stats.winnerText)}</div>
        <div class="mono final-scoreline">${escapeHtml(stats.scoreline)}</div>
      </div>
      <div class="final-breakdown">
        <div class="mono final-breakdown__line">Questions — ${ROLE_NAMES.host} ${stats.totals.host.questionsCorrect}/${stats.totals.host.questionsAsked} · ${ROLE_NAMES.guest} ${stats.totals.guest.questionsCorrect}/${stats.totals.guest.questionsAsked}</div>
        <div class="mono final-breakdown__line">Maths — ${ROLE_NAMES.host} ${stats.totals.host.mathsCorrect}/${stats.totals.host.mathsAsked || 0} · ${ROLE_NAMES.guest} ${stats.totals.guest.mathsCorrect}/${stats.totals.guest.mathsAsked || 0}</div>
        <div class="mono small final-breakdown__line">${escapeHtml(stats.marginText)}</div>
      </div>
    </section>
  `;
}

function buildRoundsPanel(stats) {
  if (!stats.roundSummaries.length && !stats.mathsSummaryRow) return "";
  const rows = stats.roundSummaries.map((entry) => `
      <tr>
        <td>Round ${escapeHtml(entry.round)}</td>
        <td>${escapeHtml(String(entry.hostCorrect))}</td>
        <td>${escapeHtml(String(entry.guestCorrect))}</td>
        <td>${escapeHtml(entry.snippetLabel || "—")}</td>
      </tr>
    `).join("");
  const mathsRow = stats.mathsSummaryRow ? `
      <tr>
        <td>Maths</td>
        <td>${escapeHtml(stats.mathsSummaryRow.hostText)}</td>
        <td>${escapeHtml(stats.mathsSummaryRow.guestText)}</td>
        <td>${escapeHtml(stats.mathsSummaryRow.label)}</td>
      </tr>
    ` : "";
  return `
    <section class="panel final-panel">
      <h3 class="section-title">Score by round</h3>
      <table class="final-table mono final-table--rounds">
        <thead>
          <tr>
            <th>Stage</th>
            <th>${ROLE_NAMES.host}</th>
            <th>${ROLE_NAMES.guest}</th>
            <th>Snippet</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
          ${mathsRow}
        </tbody>
      </table>
      <p class="mono small final-highlight">${escapeHtml(stats.roundHighlight)}</p>
    </section>
  `;
}

function buildMarkingPanel(stats) {
  const host = stats.markingStats.host;
  const guest = stats.markingStats.guest;
  const snippetTotals = stats.snippetTotals || { host: 0, guest: 0 };
  return `
    <section class="panel final-panel">
      <h3 class="section-title">Marking duel</h3>
      <table class="final-table mono final-table--marking">
        <thead>
          <tr>
            <th>Metric</th>
            <th>${ROLE_NAMES.host}</th>
            <th>${ROLE_NAMES.guest}</th>
          </tr>
        </thead>
        <tbody>
          <tr><td>Correct ✓ calls</td><td>${escapeHtml(String(host.correctRightCalls))}</td><td>${escapeHtml(String(guest.correctRightCalls))}</td></tr>
          <tr><td>Correct ✕ calls</td><td>${escapeHtml(String(host.correctWrongCalls))}</td><td>${escapeHtml(String(guest.correctWrongCalls))}</td></tr>
          <tr><td>Incorrect ✓ calls</td><td>${escapeHtml(String(host.incorrectRightCalls))}</td><td>${escapeHtml(String(guest.incorrectRightCalls))}</td></tr>
          <tr><td>Incorrect ✕ calls</td><td>${escapeHtml(String(host.incorrectWrongCalls))}</td><td>${escapeHtml(String(guest.incorrectWrongCalls))}</td></tr>
          <tr><td>Unknowns</td><td>${escapeHtml(String(host.unknownCalls))}</td><td>${escapeHtml(String(guest.unknownCalls))}</td></tr>
          <tr><td>Snippets kept</td><td>${escapeHtml(String(snippetTotals.host || 0))}</td><td>${escapeHtml(String(snippetTotals.guest || 0))}</td></tr>
          <tr><td>Accuracy</td><td>${escapeHtml(formatPercent(host.accuracy))}</td><td>${escapeHtml(formatPercent(guest.accuracy))}</td></tr>
        </tbody>
      </table>
      <p class="mono small final-highlight">${escapeHtml(stats.markingHighlight)}</p>
    </section>
  `;
}

function buildMathsPanel(stats) {
  if (!stats.mathsRecords.length) return "";
  const rows = stats.mathsRecords.map((record) => {
    const correctDisplay = record.correctValue === null ? "—" : escapeHtml(String(record.correctValue));
    const hostClass = record.hostValue === null ? "" : record.hostCorrect ? "final-good" : "final-bad";
    const guestClass = record.guestValue === null ? "" : record.guestCorrect ? "final-good" : "final-bad";
    const hostCell = record.hostValue === null ? "—" : formatMathsCell(record.hostValue, record.hostCorrect);
    const guestCell = record.guestValue === null ? "—" : formatMathsCell(record.guestValue, record.guestCorrect);
    const prompt = record.prompt ? `<div class="final-question">${escapeHtml(record.prompt)}</div>` : "";
    return `
      <tr>
        <td>Beat ${escapeHtml(String(record.index))}${prompt}</td>
        <td>${correctDisplay}</td>
        <td class="${hostClass}">${hostCell}</td>
        <td class="${guestClass}">${guestCell}</td>
      </tr>
    `;
  }).join("");
  return `
    <section class="panel final-panel">
      <h3 class="section-title">Maths showdown</h3>
      <table class="final-table mono final-table--maths">
        <thead>
          <tr>
            <th>Beat</th>
            <th>Correct</th>
            <th>${ROLE_NAMES.host}</th>
            <th>${ROLE_NAMES.guest}</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
      <p class="mono small final-highlight">${escapeHtml(stats.mathsHighlight)}</p>
    </section>
  `;
}

function buildTimingPanel(stats) {
  if (!stats.timingLines.length) return "";
  const lines = stats.timingLines.map((line) => `<p class="mono small">${escapeHtml(line)}</p>`).join("");
  return `
    <section class="panel final-panel">
      <h3 class="section-title">Pace & timing</h3>
      <div class="final-list">${lines}</div>
    </section>
  `;
}

function buildHighlightsPanel(stats) {
  const blocks = [];
  stats.hardestLines.forEach((entry) => {
    blocks.push(`
      <div class="final-highlight-block">
        <p class="mono small">${escapeHtml(entry.line)}</p>
        ${entry.question ? `<p class="mono small final-question">${escapeHtml(entry.question)}</p>` : ""}
      </div>
    `);
  });
  if (stats.streakLine) {
    blocks.push(`<p class="mono small">Streaks — ${escapeHtml(stats.streakLine)}</p>`);
  }
  if (!blocks.length) return "";
  return `
    <section class="panel final-panel">
      <h3 class="section-title">Highlights</h3>
      <div class="final-list">${blocks.join("")}</div>
    </section>
  `;
}

function renderStats(stats) {
  const sections = [
    buildSummaryPanel(stats),
    buildRoundsPanel(stats),
    buildMarkingPanel(stats),
    buildMathsPanel(stats),
    buildTimingPanel(stats),
    buildHighlightsPanel(stats),
  ].filter(Boolean);
  return `<h2>Final</h2>${sections.join("")}`;
}

export default function Final() {
  const el = document.createElement("section");
  el.className = "wrap";
  const summary = document.createElement("div");
  summary.id = "summary";
  summary.innerHTML = `<h2>Final</h2><section class="panel"><p class="status">Loading…</p></section>`;
  el.appendChild(summary);

  const code = (localStorage.getItem("lastGameCode") || "").toUpperCase();

  (async () => {
    await ensureAuth();
    if (!code) {
      summary.innerHTML = `<h2>Final</h2><section class="panel"><p class="status">No recent game found.</p></section>`;
      return;
    }

    const roomRef = doc(db, "rooms", code);
    let rendering = false;
    let queued = null;

    const runRender = async (roomData) => {
      try {
        const meta = roomData.meta || {};
        const hostUid = meta.hostUid || "host";
        const guestUid = meta.guestUid || "guest";
        const [hostSnap, guestSnap, roundsSnap] = await Promise.all([
          getDoc(doc(db, "rooms", code, "players", hostUid)),
          getDoc(doc(db, "rooms", code, "players", guestUid)),
          getDocs(collection(roomRef, "rounds")),
        ]);
        const rounds = [];
        roundsSnap.forEach((docSnap) => {
          const data = docSnap.data() || {};
          const roundNumber = Number(data.round) || Number(docSnap.id);
          if (Number.isFinite(roundNumber) && roundNumber > 0) {
            rounds.push({ round: roundNumber, data });
          }
        });
        rounds.sort((a, b) => a.round - b.round);
        const stats = computeStats(roomData, rounds, {
          code,
          hostUid,
          guestUid,
          hostPlayer: hostSnap.exists() ? hostSnap.data() || {} : {},
          guestPlayer: guestSnap.exists() ? guestSnap.data() || {} : {},
        });
        summary.innerHTML = renderStats(stats);
      } catch (err) {
        console.warn("[final] render failed:", err);
        summary.innerHTML = `<h2>Final</h2><section class="panel"><p class="status">Failed to load final stats.</p></section>`;
      }
    };

    const triggerRender = (roomData) => {
      if (rendering) {
        queued = roomData;
        return;
      }
      rendering = true;
      runRender(roomData).finally(() => {
        rendering = false;
        if (queued) {
          const next = queued;
          queued = null;
          triggerRender(next);
        }
      });
    };

    onSnapshot(roomRef, (snap) => {
      if (!snap.exists()) {
        summary.innerHTML = `<h2>Final</h2><section class="panel"><p class="status">Room not found.</p></section>`;
        return;
      }
      const data = snap.data() || {};
      if ((data.state || "").toLowerCase() !== "final") {
        summary.innerHTML = `<h2>Final</h2><section class="panel"><p class="status">Waiting…</p></section>`;
        return;
      }
      triggerRender(data);
    }, (err) => {
      console.warn("[final] snapshot error:", err);
      summary.innerHTML = `<h2>Final</h2><section class="panel"><p class="status">Lost connection.</p></section>`;
    });
  })();

  return el;
}

