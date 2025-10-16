// /src/views/Final.js
//
// Grand finale scoreboard packed with post-game stats.
// • Waits until the room reaches state:"final".
// • Compiles data from the room doc + round docs to surface:
//     – Overall score (questions + maths)
//     – Marking accuracy (correct right/wrong calls, misreads)
//     – Pace metrics (average / fastest round, snippet tally)
//     – Answer streaks (longest right + wrong runs)
//     – Hardest questions cracked
//     – Maths recap (distance from perfect answers)
//
// Layout keeps within the existing narrow column, using a grid of stat cards.

import { ensureAuth, db } from "../lib/firebase.js";
import { doc, getDoc, onSnapshot } from "firebase/firestore";
import { clampCode, getHashParams } from "../lib/util.js";

const ROLE_NAMES = { host: "Daniel", guest: "Jaime" };
const VERDICT = { RIGHT: "right", WRONG: "wrong", UNKNOWN: "unknown" };
const DIFFICULTY_WEIGHT = { pub: 1, enthusiast: 2, specialist: 3 };

const sameNormalized = (a, b) =>
  String(a ?? "")
    .trim()
    .toLowerCase() === String(b ?? "")
    .trim()
    .toLowerCase();

const resolveCorrect = (answer = {}, fallbackItem = {}) => {
  if (answer.correct) return answer.correct;
  if (fallbackItem.correct_answer) return fallbackItem.correct_answer;
  return "";
};

const difficultyRank = (tier) => {
  const key = String(tier || "")
    .trim()
    .toLowerCase();
  return DIFFICULTY_WEIGHT[key] || 0;
};

const formatDifficulty = (tier) => {
  const key = String(tier || "")
    .trim()
    .toLowerCase();
  if (!key) return "Unrated";
  return key.replace(/\b\w/g, (ch) => ch.toUpperCase());
};

const trimQuestion = (text, limit = 120) => {
  const raw = String(text || "").trim();
  if (raw.length <= limit) return raw;
  return `${raw.slice(0, limit - 1)}…`;
};

const formatSeconds = (ms) => {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const seconds = ms / 1000;
  const precision = seconds >= 10 ? 1 : 2;
  return `${seconds.toFixed(precision).replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1")} s`;
};

const formatSpanLabel = (entry) => {
  if (!entry) return "";
  return `R${entry.round}·Q${entry.index + 1}`;
};

const resolveTimingForRole = (timings = {}, roleName, fallbackUid) => {
  const want = String(roleName || "").toLowerCase();
  if (!want) return null;
  for (const [uid, infoRaw] of Object.entries(timings || {})) {
    const info = infoRaw || {};
    if (String(info.role || "").toLowerCase() === want) {
      return { uid, info };
    }
  }
  if (fallbackUid && Object.prototype.hasOwnProperty.call(timings || {}, fallbackUid)) {
    return { uid: fallbackUid, info: (timings || {})[fallbackUid] || {} };
  }
  const entries = Object.entries(timings || {});
  if (entries.length === 1) {
    const [uid, info] = entries[0];
    return { uid, info: info || {} };
  }
  return null;
};

const computeStreaks = (entries = []) => {
  const base = { length: 0, start: null, end: null };
  const best = {
    right: { ...base },
    wrong: { ...base },
  };
  let currentRight = { length: 0, start: null };
  let currentWrong = { length: 0, start: null };

  for (const entry of entries) {
    if (entry.isCorrect) {
      if (!currentRight.start) currentRight.start = entry;
      currentRight.length += 1;
      if (currentRight.length > best.right.length) {
        best.right = {
          length: currentRight.length,
          start: currentRight.start,
          end: entry,
        };
      }
      currentWrong = { length: 0, start: null };
    } else if (entry.attempted) {
      if (!currentWrong.start) currentWrong.start = entry;
      currentWrong.length += 1;
      if (currentWrong.length > best.wrong.length) {
        best.wrong = {
          length: currentWrong.length,
          start: currentWrong.start,
          end: entry,
        };
      }
      currentRight = { length: 0, start: null };
    } else {
      currentRight = { length: 0, start: null };
      currentWrong = { length: 0, start: null };
    }
  }

  return best;
};

const analyseGame = (roomData = {}, rounds = {}, meta = {}) => {
  const answersByRole = { host: [], guest: [] };
  const answersByRound = { host: {}, guest: {} };
  const roleKeys = ["host", "guest"];

  for (const role of roleKeys) {
    for (let r = 1; r <= 5; r += 1) {
      const roundInfo = rounds[r] || {};
      const items = Array.isArray(role === "host" ? roundInfo.hostItems : roundInfo.guestItems)
        ? role === "host"
          ? roundInfo.hostItems
          : roundInfo.guestItems
        : [];
      const answerList = (((roomData.answers || {})[role] || {})[r] || []);
      const limit = Math.max(items.length, answerList.length);
      if (!answersByRound[role][r]) answersByRound[role][r] = [];

      for (let i = 0; i < limit; i += 1) {
        const item = items[i] || {};
        const answer = answerList[i] || {};
        const correct = resolveCorrect(answer, item);
        const chosen = answer.chosen || "";
        const attempted = Boolean(chosen);
        const isCorrect = attempted && correct && sameNormalized(chosen, correct);

        const entry = {
          role,
          playerName: ROLE_NAMES[role] || role,
          round: r,
          index: i,
          question: answer.question || item.question || "",
          chosen,
          correct,
          attempted,
          isCorrect,
          difficulty: item.difficulty_tier || "",
          difficultyRank: difficultyRank(item.difficulty_tier),
        };

        answersByRole[role].push(entry);
        answersByRound[role][r][i] = entry;
      }
    }
  }

  const totals = {
    host: {
      questions: answersByRole.host.filter((a) => a.isCorrect).length,
      mathsCorrect: 0,
    },
    guest: {
      questions: answersByRole.guest.filter((a) => a.isCorrect).length,
      mathsCorrect: 0,
    },
  };

  const computeMarking = (role) => {
    const verdicts = ((roomData.marking || {})[role] || {});
    const oppRole = role === "host" ? "guest" : "host";
    const stats = {
      correctRight: 0,
      correctWrong: 0,
      misreads: 0,
      passes: 0,
      opportunities: { right: 0, wrong: 0 },
    };

    for (let r = 1; r <= 5; r += 1) {
      const marks = verdicts[r] || [];
      const oppAnswers = (answersByRound[oppRole][r] || []);
      for (let i = 0; i < Math.max(marks.length, oppAnswers.length); i += 1) {
        const verdict = marks[i];
        const oppEntry = oppAnswers[i] || {};
        const opponentWasCorrect = Boolean(oppEntry.isCorrect);
        const opponentAttempted = Boolean(oppEntry.attempted);
        if (opponentAttempted) {
          if (opponentWasCorrect) stats.opportunities.right += 1;
          else stats.opportunities.wrong += 1;
        }

        if (verdict === VERDICT.RIGHT) {
          if (opponentWasCorrect) stats.correctRight += 1;
          else if (opponentAttempted) stats.misreads += 1;
        } else if (verdict === VERDICT.WRONG) {
          if (!opponentWasCorrect && opponentAttempted) stats.correctWrong += 1;
          else if (opponentWasCorrect) stats.misreads += 1;
        } else if (verdict === VERDICT.UNKNOWN) {
          stats.passes += 1;
        }
      }
    }

    return stats;
  };

  const markingStats = {
    host: computeMarking("host"),
    guest: computeMarking("guest"),
  };

  const streaks = {
    host: computeStreaks(answersByRole.host),
    guest: computeStreaks(answersByRole.guest),
  };

  const hardestCorrect = [...answersByRole.host, ...answersByRole.guest]
    .filter((entry) => entry.isCorrect && entry.difficultyRank > 0)
    .sort((a, b) => {
      if (b.difficultyRank !== a.difficultyRank) {
        return b.difficultyRank - a.difficultyRank;
      }
      if (b.round !== a.round) return b.round - a.round;
      return (b.index || 0) - (a.index || 0);
    });

  const hardestTopRank = hardestCorrect[0]?.difficultyRank || 0;
  const hardestEntries = hardestCorrect.filter((entry) => entry.difficultyRank === hardestTopRank);

  const mathsAnswers = roomData.mathsAnswers || {};
  const mathsCorrect = Array.isArray(roomData.maths?.answers)
    ? roomData.maths.answers.slice(0, 2).map((v) => (Number.isInteger(v) ? v : null))
    : [null, null];

  const mathsStats = {
    host: {
      answers: Array.isArray(mathsAnswers.host) ? mathsAnswers.host.slice(0, 2) : [],
      deltas: [],
    },
    guest: {
      answers: Array.isArray(mathsAnswers.guest) ? mathsAnswers.guest.slice(0, 2) : [],
      deltas: [],
    },
    correct: mathsCorrect,
  };

  for (const role of roleKeys) {
    const submission = mathsStats[role].answers;
    let matches = 0;
    mathsStats[role].deltas = submission.map((value, idx) => {
      const mine = Number.isInteger(value) ? Number(value) : null;
      const target = mathsCorrect[idx];
      if (mine === null || target === null) return null;
      const delta = Math.abs(mine - target);
      if (delta === 0) matches += 1;
      return delta;
    });
    totals[role].mathsCorrect = matches;
  }

  const timings = { host: [], guest: [] };
  const snippetWins = { host: 0, guest: 0, ties: 0 };

  for (let r = 1; r <= 5; r += 1) {
    const roundInfo = rounds[r] || {};
    const { hostUid, guestUid } = meta || {};
    const hostEntry = resolveTimingForRole(roundInfo.timings || {}, "host", hostUid);
    const guestEntry = resolveTimingForRole(roundInfo.timings || {}, "guest", guestUid);
    const hostMs = Number(hostEntry?.info?.totalMs);
    const guestMs = Number(guestEntry?.info?.totalMs);
    if (Number.isFinite(hostMs) && hostMs > 0) timings.host.push({ round: r, totalMs: hostMs });
    if (Number.isFinite(guestMs) && guestMs > 0) timings.guest.push({ round: r, totalMs: guestMs });

    if (Boolean(roundInfo.snippetTie)) snippetWins.ties += 1;
    else if (roundInfo.snippetWinnerUid) {
      if (roundInfo.snippetWinnerUid === hostUid) snippetWins.host += 1;
      else if (roundInfo.snippetWinnerUid === guestUid) snippetWins.guest += 1;
    }
  }

  const summariseTimings = (entries = []) => {
    if (!entries.length) {
      return {
        averageMs: null,
        fastest: null,
        slowest: null,
        totalMs: 0,
      };
    }
    const totalMs = entries.reduce((sum, item) => sum + (Number(item.totalMs) || 0), 0);
    const averageMs = totalMs / entries.length;
    const sorted = entries.slice().sort((a, b) => a.totalMs - b.totalMs);
    return {
      averageMs,
      totalMs,
      fastest: sorted[0],
      slowest: sorted[sorted.length - 1],
    };
  };

  const pace = {
    host: summariseTimings(timings.host),
    guest: summariseTimings(timings.guest),
    snippets: snippetWins,
  };

  return {
    totals,
    marking: markingStats,
    streaks,
    hardest: {
      entries: hardestEntries,
      rank: hardestTopRank,
    },
    maths: mathsStats,
    pace,
    answersByRole,
  };
};

export default function Final() {
  const root = document.createElement("section");
  root.className = "wrap final-wrap";

  const heading = document.createElement("h2");
  heading.textContent = "Final";
  root.appendChild(heading);

  const panel = document.createElement("section");
  panel.className = "panel final-panel";
  panel.innerHTML = '<p class="status mono">Loading…</p>';
  root.appendChild(panel);

  const lobbyBtn = document.createElement("button");
  lobbyBtn.type = "button";
  lobbyBtn.className = "btn final-lobby";
  lobbyBtn.textContent = "Back to Lobby";
  lobbyBtn.addEventListener("click", () => {
    location.hash = "#/lobby";
  });
  root.appendChild(lobbyBtn);

  const params = getHashParams();
  const code = clampCode(params.get("code") || "");

  const renderWaiting = (text) => {
    panel.innerHTML = `<p class="status mono">${text}</p>`;
  };

  const renderFinal = (roomData, roundsMap) => {
    const meta = roomData.meta || {};
    const analysis = analyseGame(roomData, roundsMap, meta);

    const hostTotals = analysis.totals.host;
    const guestTotals = analysis.totals.guest;
    const hostPoints = hostTotals.questions + hostTotals.mathsCorrect;
    const guestPoints = guestTotals.questions + guestTotals.mathsCorrect;

    let verdict = "Dead heat";
    if (hostPoints > guestPoints) verdict = `${ROLE_NAMES.host} wins`;
    else if (guestPoints > hostPoints) verdict = `${ROLE_NAMES.guest} wins`;

    const questionBreakdown = `Questions ${hostTotals.questions} – ${guestTotals.questions}`;
    const mathsBreakdown = `Maths ${hostTotals.mathsCorrect} – ${guestTotals.mathsCorrect}`;

    const markingHost = analysis.marking.host;
    const markingGuest = analysis.marking.guest;

    const leadWrong = markingHost.correctWrong === markingGuest.correctWrong
      ? "Both split the wrong calls"
      : (markingHost.correctWrong > markingGuest.correctWrong
        ? `${ROLE_NAMES.host} sniffed more wrong answers`
        : `${ROLE_NAMES.guest} sniffed more wrong answers`);

    const leadRight = markingHost.correctRight === markingGuest.correctRight
      ? "Right-answer instincts were level"
      : (markingHost.correctRight > markingGuest.correctRight
        ? `${ROLE_NAMES.host} backed more correct answers`
        : `${ROLE_NAMES.guest} backed more correct answers`);

    const streakHost = analysis.streaks.host;
    const streakGuest = analysis.streaks.guest;

    const formatStreakLine = (playerName, streakInfo) => {
      const right = streakInfo.right;
      const wrong = streakInfo.wrong;
      const parts = [];
      if (right.length > 1) {
        const start = formatSpanLabel(right.start);
        const end = formatSpanLabel(right.end);
        const span = start && end && start !== end ? `${start} → ${end}` : start || end;
        parts.push(`${playerName} strung ${right.length} right answers (${span || ""})`);
      } else if (right.length === 1) {
        const single = formatSpanLabel(right.start || right.end);
        parts.push(`${playerName} kept the streak alive with 1 right (${single || ""})`);
      } else {
        parts.push(`${playerName} never built a streak of right answers`);
      }

      if (wrong.length > 1) {
        const start = formatSpanLabel(wrong.start);
        const end = formatSpanLabel(wrong.end);
        const span = start && end && start !== end ? `${start} → ${end}` : start || end;
        parts.push(`Longest wobble: ${wrong.length} misses (${span || ""})`);
      } else if (wrong.length === 1) {
        const loc = formatSpanLabel(wrong.start || wrong.end);
        parts.push(`Single slip recorded at ${loc || "—"}`);
      }
      return parts;
    };

    const hardest = analysis.hardest.entries;
    const hardestText = [];
    if (hardest.length) {
      const difficulty = formatDifficulty(hardest[0].difficulty);
      for (const entry of hardest.slice(0, 2)) {
        const span = formatSpanLabel(entry);
        hardestText.push(`${entry.playerName} cracked a ${difficulty} question (${span}) — “${trimQuestion(entry.question)}”`);
      }
      if (hardest.length > 2) {
        const extra = hardest.length - 2;
        hardestText.push(`+ ${extra} more ${difficulty.toLowerCase()} question${extra === 1 ? "" : "s"} solved at that level.`);
      }
    } else {
      hardestText.push("No graded questions were answered correctly.");
    }

    const mathsLines = [];
    const correctMaths = analysis.maths.correct;
    if (correctMaths.some((v) => Number.isInteger(v))) {
      mathsLines.push(`Correct beats: ${correctMaths.map((v) => (Number.isInteger(v) ? v : "—")).join(" & ")}`);
    }

    const formatMathsLine = (playerName, data) => {
      if (!data.answers.length) return `${playerName} did not submit maths answers.`;
      const formattedAnswers = data.answers.map((v) => (Number.isInteger(v) ? v : "—"));
      const deltas = data.deltas
        .map((d) => (Number.isFinite(d) ? (d === 0 ? "perfect" : `Δ${d}`) : "—"));
      return `${playerName} submitted ${formattedAnswers.join(" & ")} (${deltas.join(", ")})`;
    };

    mathsLines.push(formatMathsLine(ROLE_NAMES.host, analysis.maths.host));
    mathsLines.push(formatMathsLine(ROLE_NAMES.guest, analysis.maths.guest));

    const buildCard = (title, lines) => {
      const card = document.createElement("div");
      card.className = "final-card";
      const h = document.createElement("h3");
      h.textContent = title;
      card.appendChild(h);
      const list = document.createElement("ul");
      list.className = "final-list";
      for (const line of lines) {
        const item = document.createElement("li");
        item.textContent = line;
        list.appendChild(item);
      }
      card.appendChild(list);
      return card;
    };

    panel.innerHTML = "";

    const headline = document.createElement("div");
    headline.className = "final-headline";

    const verdictLine = document.createElement("div");
    verdictLine.className = "final-verdict";
    verdictLine.textContent = verdict;

    const scoreline = document.createElement("div");
    scoreline.className = "final-scoreline";
    scoreline.textContent = `${ROLE_NAMES.host} ${hostPoints} · ${guestPoints} ${ROLE_NAMES.guest}`;

    const breakdown = document.createElement("div");
    breakdown.className = "final-breakdown";
    breakdown.textContent = `${questionBreakdown} • ${mathsBreakdown}`;

    headline.appendChild(verdictLine);
    headline.appendChild(scoreline);
    headline.appendChild(breakdown);
    panel.appendChild(headline);

    const grid = document.createElement("div");
    grid.className = "final-grid";

    grid.appendChild(
      buildCard("Marking duel", [
        leadWrong,
        `${ROLE_NAMES.host}: ${markingHost.correctWrong} wrong calls, ${markingHost.correctRight} right calls (misreads ${markingHost.misreads})`,
        `${ROLE_NAMES.guest}: ${markingGuest.correctWrong} wrong calls, ${markingGuest.correctRight} right calls (misreads ${markingGuest.misreads})`,
        leadRight,
      ])
    );

    const streakLines = [
      ...formatStreakLine(ROLE_NAMES.host, streakHost),
      ...formatStreakLine(ROLE_NAMES.guest, streakGuest),
    ];
    grid.appendChild(buildCard("Streak watch", streakLines));

    const paceLines = [];
    const hostPace = analysis.pace.host;
    const guestPace = analysis.pace.guest;
    if (hostPace.averageMs) {
      const fast = hostPace.fastest;
      paceLines.push(
        `${ROLE_NAMES.host} avg ${formatSeconds(hostPace.averageMs)} — fastest ${formatSeconds(fast?.totalMs)} (Round ${fast?.round || "?"})`
      );
    } else {
      paceLines.push(`${ROLE_NAMES.host} pace unavailable.`);
    }
    if (guestPace.averageMs) {
      const fast = guestPace.fastest;
      paceLines.push(
        `${ROLE_NAMES.guest} avg ${formatSeconds(guestPace.averageMs)} — fastest ${formatSeconds(fast?.totalMs)} (Round ${fast?.round || "?"})`
      );
    } else {
      paceLines.push(`${ROLE_NAMES.guest} pace unavailable.`);
    }
    const snippet = analysis.pace.snippets;
    paceLines.push(
      `Snippets: ${ROLE_NAMES.host} ${snippet.host} • ${ROLE_NAMES.guest} ${snippet.guest} • Dead heats ${snippet.ties}`
    );
    grid.appendChild(buildCard("Pace & snippets", paceLines));

    grid.appendChild(buildCard("Hardest answers", hardestText));
    grid.appendChild(buildCard("Jemima’s maths", mathsLines));

    panel.appendChild(grid);
  };

  (async () => {
    await ensureAuth();
    if (!code) {
      renderWaiting("Missing room code.");
      return;
    }

    const roomRef = doc(db, "rooms", code);
    let roundsCache = null;
    let fetchingRounds = false;

    const loadRounds = async () => {
      if (roundsCache) return roundsCache;
      if (fetchingRounds) {
        await fetchingRounds;
        return roundsCache;
      }
      const pending = (async () => {
        const map = {};
        for (let r = 1; r <= 5; r += 1) {
          try {
            const snap = await getDoc(doc(db, "rooms", code, "rounds", String(r)));
            map[r] = snap.exists() ? snap.data() || {} : {};
          } catch (err) {
            console.warn("[final] failed to load round", r, err);
            map[r] = {};
          }
        }
        roundsCache = map;
        return map;
      })();
      fetchingRounds = pending;
      const result = await pending;
      fetchingRounds = false;
      return result;
    };

    onSnapshot(
      roomRef,
      async (snap) => {
        if (!snap.exists()) {
          renderWaiting("Room not found.");
          return;
        }

        const data = snap.data() || {};
        if ((data.state || "").toLowerCase() !== "final") {
          renderWaiting("Waiting for both players…");
          return;
        }

        const roundsMap = await loadRounds();
        renderFinal(data, roundsMap);
      },
      (err) => {
        console.warn("[final] room snapshot error", err);
        renderWaiting("Connection lost.");
      }
    );
  })();

  return root;
}
