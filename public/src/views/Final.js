// /src/views/Final.js
//
// Final room presentation. Shows the final score hero panel, lets players replay
// the scoring animation, provides a round-by-round breakdown, and exposes the
// maths snippet recap.
//
// Data sources:
//   rooms/{code}
//     - answers.host.{round}[{ question, chosen, correct }]
//     - answers.guest.{round}[...]
//     - marking.host.{round}["right"|"wrong"|"unknown"] // host (Daniel) marks guest
//     - marking.guest.{round}[...]
//     - maths, mathsAnswers
//     - scores.questions (for parity)
//   rooms/{code}/rounds/{round}
//     - hostItems / guestItems (question text fallbacks)
//     - timings.{uid}.totalMs (snippet race durations)
//     - snippetWinnerUid / snippetTie
//   rooms/{code}/players/{uid}
//     - retainedSnippets (for stats, best-effort)
//
// The view is mounted via the hash router (see /src/main.js). Export an object
// with mount/unmount to align with other routes.

import { ensureAuth, db } from "../lib/firebase.js";
import { doc, onSnapshot, getDoc } from "firebase/firestore";
import { clampCode, getLastRoomCode } from "../lib/util.js";

const MAX_ROUNDS = 5;
const PLAYER_LABELS = { host: "Daniel", guest: "Jaime" };

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const key in attrs) {
    const value = attrs[key];
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2), value);
    } else if (value !== undefined && value !== null) {
      node.setAttribute(key, String(value));
    }
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const child of kids) {
    if (child == null) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function sameAnswer(a, b) {
  const norm = (v) => String(v ?? "").trim().toLowerCase();
  return norm(a) === norm(b) && norm(a) !== "";
}

function normaliseAnswer(value) {
  const text = String(value ?? "").trim();
  return text;
}

function resolveMarkStatus(mark) {
  if (mark === "right") return "right";
  if (mark === "wrong") return "wrong";
  if (mark === "unknown") return "unknown";
  return "pending";
}

function statusToSymbol(status) {
  switch (status) {
    case "right": return "✓";
    case "wrong": return "✕";
    case "unknown": return "?";
    case "pending": return "…";
    default: return "·";
  }
}

function statusClass(status) {
  if (status === "right") return "right";
  if (status === "wrong") return "wrong";
  if (status === "unknown") return "unknown";
  return "pending";
}

function describeActual(player, status) {
  switch (status) {
    case "right": return `${player} answered correctly.`;
    case "wrong": return `${player} answered incorrectly.`;
    case "unknown": return `${player} didn’t lock an answer.`;
    case "pending": return `${player} result unavailable.`;
    default: return `${player} result unavailable.`;
  }
}

function describeMark(player, status) {
  switch (status) {
    case "right": return `${player} marked it as correct.`;
    case "wrong": return `${player} marked it as wrong.`;
    case "unknown": return `${player} marked it as “I dunno”.`;
    case "pending": return `${player} hasn’t marked this yet.`;
    default: return `${player} verdict missing.`;
  }
}

function resolveTimingForRole(timings = {}, roleName, fallbackUid) {
  const want = String(roleName || "").toLowerCase();
  for (const [uid, raw] of Object.entries(timings || {})) {
    const info = raw || {};
    if (String(info.role || "").toLowerCase() === want) {
      return { uid, info };
    }
  }
  if (fallbackUid && Object.prototype.hasOwnProperty.call(timings, fallbackUid)) {
    return { uid: fallbackUid, info: timings[fallbackUid] || {} };
  }
  return null;
}

function formatSeconds(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "—";
  const secs = value / 1000;
  if (secs >= 10) return `${secs.toFixed(1).replace(/\.0$/, "")} s`;
  return `${secs.toFixed(2).replace(/0$/, "")} s`;
}

function formatRoundList(list = []) {
  if (!Array.isArray(list) || list.length === 0) return "None";
  return list.map((n) => `R${n}`).join(", ");
}

function countTrueFlags(map = {}) {
  let total = 0;
  for (const key in map) {
    if (map[key]) total += 1;
  }
  return total;
}

function buildQuestionEntry({ answer = {}, item = {}, mark, owner }) {
  const prompt = normaliseAnswer(answer.question) || normaliseAnswer(item.question) || "(question missing)";
  const chosen = normaliseAnswer(answer.chosen);
  const correct = normaliseAnswer(answer.correct) || normaliseAnswer(item.correct_answer) || "";
  let actualStatus = "unknown";
  if (chosen) actualStatus = sameAnswer(chosen, correct) ? "right" : "wrong";
  const markStatus = resolveMarkStatus(mark);
  return {
    prompt,
    chosen,
    correct,
    actualStatus,
    markStatus,
    owner,
  };
}

function buildMathsEntry({ index, maths, hostAnswer, guestAnswer }) {
  const questions = Array.isArray(maths.questions) ? maths.questions : [];
  const correctAnswers = Array.isArray(maths.answers) ? maths.answers : [];
  const question = questions[index] || `Question ${index + 1}`;
  const correctRaw = correctAnswers[index];
  const correct = Number.isFinite(Number(correctRaw)) ? Number(correctRaw) : null;

  const toNumber = (value) => {
    if (value === null || value === undefined) return null;
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    return Math.round(num);
  };

  const hostVal = toNumber(hostAnswer);
  const guestVal = toNumber(guestAnswer);

  const evalStatus = (value) => {
    if (correct === null) return "pending";
    if (value === null) return "unknown";
    return value === correct ? "right" : "wrong";
  };

  const hostStatus = evalStatus(hostVal);
  const guestStatus = evalStatus(guestVal);

  const diff = (value) => {
    if (correct === null || value === null) return null;
    const gap = Math.abs(value - correct);
    return gap === 0 ? "perfect" : `${gap}`;
  };

  return {
    question,
    correct,
    host: { value: hostVal, status: hostStatus, diff: diff(hostVal) },
    guest: { value: guestVal, status: guestStatus, diff: diff(guestVal) },
  };
}

function createScoreBlock(name) {
  const block = el("div", { class: "final-hero__score" });
  const label = el("div", { class: "final-hero__score-label" }, name);
  const value = el("div", { class: "final-hero__score-value" }, "—");
  block.appendChild(label);
  block.appendChild(value);
  return { block, label, value };
}

export default {
  async mount(container, params = {}) {
    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    const requested = params?.code || "";
    const code = clampCode(requested || getLastRoomCode());

    container.innerHTML = "";
    const root = el("div", { class: "view view-final" });

    const hero = el("div", { class: "card final-hero" });
    const heroTitle = el("div", { class: "final-hero__title" }, "Final Scores");
    const scoresWrap = el("div", { class: "final-hero__scores" });
    const hostScore = createScoreBlock("Daniel");
    const guestScore = createScoreBlock("Jaime");
    hostScore.block.classList.add("final-hero__score--host");
    guestScore.block.classList.add("final-hero__score--guest");
    scoresWrap.appendChild(hostScore.block);
    scoresWrap.appendChild(guestScore.block);
    const heroStatus = el("div", { class: "final-hero__status" }, "Waiting for the room…");
    const heroProgress = el("div", { class: "final-hero__progress" }, "Press the button to replay the tally.");
    hero.appendChild(heroTitle);
    hero.appendChild(scoresWrap);
    hero.appendChild(heroStatus);
    hero.appendChild(heroProgress);

    const revealBtn = el("button", {
      class: "btn final-cta",
      type: "button",
    }, "IT’S A WINNER!");

    const breakdownCard = el("div", { class: "card final-card" });
    const breakdownTitle = el("h3", { class: "final-section-title" }, "Score breakdown");
    const breakdownGrid = el("div", { class: "final-round-summary" });
    const statsList = el("div", { class: "final-stats" });
    breakdownCard.appendChild(breakdownTitle);
    breakdownCard.appendChild(breakdownGrid);
    breakdownCard.appendChild(statsList);

    const roundsContainer = el("div", { class: "final-rounds" });
    const mathsContainer = el("div", { class: "final-maths" });
    const mathsToggle = el("button", {
      class: "final-maths__toggle",
      type: "button",
      "aria-expanded": "false",
    }, "Jemima’s Maths — recap");
    const mathsPanel = el("div", { class: "final-maths__panel", hidden: "" });
    mathsContainer.appendChild(mathsToggle);
    mathsContainer.appendChild(mathsPanel);

    const returnBtn = el("button", { class: "btn final-return", type: "button" }, "Return to Lobby");
    returnBtn.addEventListener("click", () => {
      location.hash = "#/lobby";
    });

    root.appendChild(hero);
    root.appendChild(revealBtn);
    root.appendChild(breakdownCard);
    root.appendChild(roundsContainer);
    root.appendChild(mathsContainer);
    root.appendChild(returnBtn);

    container.appendChild(root);

    if (!code) {
      heroStatus.textContent = "No room code detected.";
      revealBtn.disabled = true;
      return;
    }

    let animation = {
      running: false,
      timeouts: [],
      finalHost: 0,
      finalGuest: 0,
      timeline: [],
      ready: false,
    };

    const stopAnimation = () => {
      for (const t of animation.timeouts) {
        try { clearTimeout(t); } catch {}
      }
      animation.timeouts = [];
      animation.running = false;
      hero.classList.remove("final-hero--animating");
    };

    const triggerPulse = (block) => {
      if (!block) return;
      block.classList.remove("final-hero__score--pulse");
      void block.offsetWidth; // force reflow
      block.classList.add("final-hero__score--pulse");
      animation.timeouts.push(setTimeout(() => {
        block.classList.remove("final-hero__score--pulse");
      }, 420));
    };

    const runScoreAnimation = () => {
      if (!animation.ready || animation.timeline.length === 0 || animation.running) return;
      stopAnimation();
      animation.running = true;
      revealBtn.disabled = true;
      revealBtn.classList.remove("throb");
      hero.classList.add("final-hero--animating");
      heroProgress.textContent = "Scoring in progress…";

      let host = 0;
      let guest = 0;
      hostScore.value.textContent = "0";
      guestScore.value.textContent = "0";

      const steps = animation.timeline.slice();
      const stepDelay = 700;

      const playStep = (index) => {
        if (!animation.running) return;
        if (index >= steps.length) {
          animation.timeouts.push(setTimeout(() => {
            heroProgress.textContent = "Scores locked.";
            hostScore.value.textContent = String(animation.finalHost);
            guestScore.value.textContent = String(animation.finalGuest);
            triggerPulse(hostScore.block);
            triggerPulse(guestScore.block);
            animation.running = false;
            hero.classList.remove("final-hero--animating");
            revealBtn.disabled = false;
            revealBtn.textContent = "Replay the reveal";
            revealBtn.classList.add("outline");
            heroProgress.classList.remove("final-hero__progress--counting");
          }, stepDelay / 2));
          return;
        }

        const stage = steps[index];
        heroProgress.classList.add("final-hero__progress--counting");
        heroProgress.textContent = stage.label;
        host += stage.hostDelta;
        guest += stage.guestDelta;
        hostScore.value.textContent = String(host);
        guestScore.value.textContent = String(guest);
        triggerPulse(hostScore.block);
        triggerPulse(guestScore.block);
        animation.timeouts.push(setTimeout(() => playStep(index + 1), stepDelay));
      };

      animation.timeouts.push(setTimeout(() => playStep(0), 320));
    };

    revealBtn.addEventListener("click", () => {
      if (animation.running) return;
      runScoreAnimation();
    });

    mathsToggle.addEventListener("click", () => {
      const expanded = mathsToggle.getAttribute("aria-expanded") === "true";
      mathsToggle.setAttribute("aria-expanded", expanded ? "false" : "true");
      if (expanded) mathsPanel.setAttribute("hidden", "");
      else mathsPanel.removeAttribute("hidden");
    });

    const state = {
      code,
      room: null,
      rounds: {},
      players: { host: null, guest: null },
      playerIds: { host: null, guest: null },
      unsubscribers: [],
    };

    let renderPending = false;
    let currentGame = null;

    const scheduleRender = () => {
      if (renderPending) return;
      renderPending = true;
      Promise.resolve().then(() => {
        renderPending = false;
        const computed = computeGameData(state);
        currentGame = computed;
        applyGameState(computed);
      });
    };

    const computeGameData = (snapshotState) => {
      if (!snapshotState.room) return null;
      const room = snapshotState.room || {};
      const answers = room.answers || {};
      const marking = room.marking || {};
      const maths = room.maths || {};
      const mathsAnswers = room.mathsAnswers || {};
      const meta = room.meta || {};
      const hostUid = snapshotState.playerIds.host || meta.hostUid || "";
      const guestUid = snapshotState.playerIds.guest || meta.guestUid || "";
      const rounds = [];
      let hostTotal = 0;
      let guestTotal = 0;
      const hostPerfect = [];
      const guestPerfect = [];
      let hostSnippetWins = 0;
      let guestSnippetWins = 0;
      let snippetTies = 0;
      let fastest = null;

      for (let r = 1; r <= MAX_ROUNDS; r += 1) {
        const roundData = snapshotState.rounds[r] || {};
        const hostItems = Array.isArray(roundData.hostItems) ? roundData.hostItems : [];
        const guestItems = Array.isArray(roundData.guestItems) ? roundData.guestItems : [];
        const hostAns = Array.isArray(((answers.host || {})[r])) ? ((answers.host || {})[r]) : [];
        const guestAns = Array.isArray(((answers.guest || {})[r])) ? ((answers.guest || {})[r]) : [];
        const hostMarks = Array.isArray(((marking.guest || {})[r])) ? ((marking.guest || {})[r]) : [];
        const guestMarks = Array.isArray(((marking.host || {})[r])) ? ((marking.host || {})[r]) : [];

        const hostQuestions = [];
        const guestQuestions = [];
        for (let i = 0; i < 3; i += 1) {
          hostQuestions.push(buildQuestionEntry({
            answer: hostAns[i] || {},
            item: hostItems[i] || {},
            mark: hostMarks[i],
            owner: "host",
          }));
          guestQuestions.push(buildQuestionEntry({
            answer: guestAns[i] || {},
            item: guestItems[i] || {},
            mark: guestMarks[i],
            owner: "guest",
          }));
        }

        const hostScore = hostQuestions.filter((q) => q.actualStatus === "right").length;
        const guestScore = guestQuestions.filter((q) => q.actualStatus === "right").length;
        hostTotal += hostScore;
        guestTotal += guestScore;
        if (hostScore === 3) hostPerfect.push(r);
        if (guestScore === 3) guestPerfect.push(r);

        const snippet = {
          winnerUid: roundData.snippetWinnerUid || null,
          tie: Boolean(roundData.snippetTie),
        };
        if (snippet.tie) snippetTies += 1;
        else if (snippet.winnerUid === hostUid) hostSnippetWins += 1;
        else if (snippet.winnerUid === guestUid) guestSnippetWins += 1;

        const timings = roundData.timings || {};
        const hostTiming = resolveTimingForRole(timings, "host", hostUid);
        const guestTiming = resolveTimingForRole(timings, "guest", guestUid);
        const hostMs = Number(hostTiming?.info?.totalMs) || null;
        const guestMs = Number(guestTiming?.info?.totalMs) || null;

        if (Number.isFinite(hostMs) && (fastest === null || hostMs < fastest.ms)) {
          fastest = { player: PLAYER_LABELS.host, round: r, ms: hostMs };
        }
        if (Number.isFinite(guestMs) && (fastest === null || guestMs < fastest.ms)) {
          fastest = { player: PLAYER_LABELS.guest, round: r, ms: guestMs };
        }

        rounds.push({
          round: r,
          hostScore,
          guestScore,
          hostQuestions,
          guestQuestions,
          snippet,
          timings: { hostMs, guestMs },
        });
      }

      const mathsEntries = [];
      const maxMaths = Math.max(
        Array.isArray(maths.questions) ? maths.questions.length : 0,
        Array.isArray(maths.answers) ? maths.answers.length : 0,
        Array.isArray(mathsAnswers.host) ? mathsAnswers.host.length : 0,
        Array.isArray(mathsAnswers.guest) ? mathsAnswers.guest.length : 0,
      );
      for (let i = 0; i < Math.max(maxMaths, 2); i += 1) {
        mathsEntries.push(buildMathsEntry({
          index: i,
          maths,
          hostAnswer: (mathsAnswers.host || [])[i],
          guestAnswer: (mathsAnswers.guest || [])[i],
        }));
      }

      const timeline = rounds.map((entry) => ({
        label: `Round ${entry.round}`,
        hostDelta: entry.hostScore,
        guestDelta: entry.guestScore,
      }));

      return {
        code,
        roomState: String(room.state || "").toLowerCase(),
        totals: { host: hostTotal, guest: guestTotal },
        rounds,
        timeline,
        stats: {
          hostPerfect,
          guestPerfect,
          snippet: { host: hostSnippetWins, guest: guestSnippetWins, ties: snippetTies },
          fastest,
          retained: {
            host: countTrueFlags(snapshotState.players.host?.retainedSnippets || {}),
            guest: countTrueFlags(snapshotState.players.guest?.retainedSnippets || {}),
          },
        },
        maths: {
          location: maths.location || "",
          beats: Array.isArray(maths.beats) ? maths.beats : [],
          entries: mathsEntries,
        },
      };
    };

    const applyGameState = (game) => {
      stopAnimation();
      if (!game) {
        heroTitle.textContent = "Final Scores";
        heroStatus.textContent = "Waiting for the final state…";
        hostScore.value.textContent = "—";
        guestScore.value.textContent = "—";
        revealBtn.disabled = true;
        revealBtn.classList.remove("throb");
        breakdownGrid.innerHTML = "";
        statsList.innerHTML = "";
        roundsContainer.innerHTML = "";
        mathsPanel.innerHTML = "";
        return;
      }

      const ready = game.roomState === "final";
      heroTitle.textContent = ready ? "Final Scores" : "Almost there";
      if (!animation.running) {
        hostScore.value.textContent = String(game.totals.host);
        guestScore.value.textContent = String(game.totals.guest);
      }
      heroStatus.textContent = `Daniel ${game.totals.host} · Jaime ${game.totals.guest}`;

      const hostLead = game.totals.host - game.totals.guest;
      hero.classList.remove("final-hero--daniel", "final-hero--jaime", "final-hero--tie");
      hero.classList.remove("final-hero--flash");
      if (ready) {
        if (hostLead > 0) {
          heroTitle.textContent = "Daniel WINS!";
          hero.classList.add("final-hero--daniel", "final-hero--flash");
          heroProgress.textContent = "Daniel claims the duel.";
        } else if (hostLead < 0) {
          heroTitle.textContent = "Jaime WINS!";
          hero.classList.add("final-hero--jaime", "final-hero--flash");
          heroProgress.textContent = "Jaime takes the crown.";
        } else {
          heroTitle.textContent = "Tie game";
          hero.classList.add("final-hero--tie");
          heroProgress.textContent = "All square after five rounds.";
        }
      } else {
        heroProgress.textContent = "Waiting for both players to arrive.";
      }

      animation.finalHost = game.totals.host;
      animation.finalGuest = game.totals.guest;
      animation.timeline = game.timeline || [];
      animation.ready = ready;
      revealBtn.disabled = !ready;
      if (ready) {
        revealBtn.classList.add("throb");
        revealBtn.textContent = "IT’S A WINNER!";
        revealBtn.classList.remove("outline");
      } else {
        revealBtn.classList.remove("throb");
      }

      // Breakdown
      breakdownGrid.innerHTML = "";
      for (const summary of game.rounds) {
        const row = el("div", { class: "final-round-summary__row" });
        const roundLabel = el("div", { class: "final-round-summary__round" }, `Round ${summary.round}`);
        const hostCol = el("div", { class: "final-round-summary__score final-round-summary__score--host" }, `+${summary.hostScore}`);
        const guestCol = el("div", { class: "final-round-summary__score final-round-summary__score--guest" }, `+${summary.guestScore}`);
        const swing = summary.hostScore === summary.guestScore
          ? "Level"
          : summary.hostScore > summary.guestScore
            ? `Daniel +${summary.hostScore - summary.guestScore}`
            : `Jaime +${summary.guestScore - summary.hostScore}`;
        const swingCol = el("div", { class: "final-round-summary__swing" }, swing);
        row.appendChild(roundLabel);
        row.appendChild(hostCol);
        row.appendChild(guestCol);
        row.appendChild(swingCol);
        breakdownGrid.appendChild(row);
      }
      const totalRow = el("div", { class: "final-round-summary__row final-round-summary__row--total" });
      totalRow.appendChild(el("div", { class: "final-round-summary__round" }, "TOTAL"));
      totalRow.appendChild(el("div", { class: "final-round-summary__score final-round-summary__score--host" }, String(game.totals.host)));
      totalRow.appendChild(el("div", { class: "final-round-summary__score final-round-summary__score--guest" }, String(game.totals.guest)));
      totalRow.appendChild(el("div", { class: "final-round-summary__swing" }, hostLead === 0 ? "Dead heat" : (hostLead > 0 ? `Daniel by ${hostLead}` : `Jaime by ${Math.abs(hostLead)}`)));
      breakdownGrid.appendChild(totalRow);

      // Stats
      statsList.innerHTML = "";
      const statEntries = [
        {
          label: "Perfect rounds",
          value: `Daniel — ${formatRoundList(game.stats.hostPerfect)} | Jaime — ${formatRoundList(game.stats.guestPerfect)}`,
        },
        {
          label: "Snippet race",
          value: `Daniel ${game.stats.snippet.host} · Jaime ${game.stats.snippet.guest}${game.stats.snippet.ties ? ` (ties: ${game.stats.snippet.ties})` : ""}`,
        },
        {
          label: "Fastest finish",
          value: game.stats.fastest
            ? `${game.stats.fastest.player} in Round ${game.stats.fastest.round} — ${formatSeconds(game.stats.fastest.ms)}`
            : "No timing data yet",
        },
        {
          label: "Snippets retained",
          value: `Daniel ${game.stats.retained.host} · Jaime ${game.stats.retained.guest}`,
        },
      ];
      for (const entry of statEntries) {
        const stat = el("div", { class: "final-stat" });
        stat.appendChild(el("div", { class: "final-stat__label" }, entry.label));
        stat.appendChild(el("div", { class: "final-stat__value" }, entry.value));
        statsList.appendChild(stat);
      }

      // Rounds accordion
      const openState = {
        current: null,
      };
      const blocks = [];
      roundsContainer.innerHTML = "";

      const setRoundOpen = (round) => {
        openState.current = round;
        blocks.forEach(({ roundNumber, wrapper, toggle, panel }) => {
          const isOpen = roundNumber === round;
          wrapper.classList.toggle("final-round-block--open", isOpen);
          toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
          if (isOpen) panel.removeAttribute("hidden");
          else panel.setAttribute("hidden", "");
        });
      };

      for (const summary of game.rounds) {
        const wrapper = el("div", { class: "final-round-block" });
        const toggle = el("button", {
          class: "final-round-toggle",
          type: "button",
          "aria-expanded": "false",
        });
        toggle.appendChild(el("span", { class: "final-round-toggle__label" }, `Round ${summary.round}`));
        toggle.appendChild(el("span", { class: "final-round-toggle__score" }, `Daniel ${summary.hostScore} · Jaime ${summary.guestScore}`));
        toggle.appendChild(el("span", { class: "final-round-toggle__chevron" }, "›"));

        const panel = el("div", { class: "final-round-panel", hidden: "" });
        const inner = el("div", { class: "final-round-panel__inner" });

        const hostSection = el("div", { class: "final-player-section" });
        hostSection.appendChild(el("div", { class: "final-player-section__title" }, "Daniel’s questions"));
        const hostList = el("div", { class: "final-question-list" });
        summary.hostQuestions.forEach((question, idx) => {
          hostList.appendChild(buildQuestionRow({
            question,
            index: idx,
            perspective: "host",
          }));
        });
        hostSection.appendChild(hostList);

        const guestSection = el("div", { class: "final-player-section" });
        guestSection.appendChild(el("div", { class: "final-player-section__title" }, "Jaime’s questions"));
        const guestList = el("div", { class: "final-question-list" });
        summary.guestQuestions.forEach((question, idx) => {
          guestList.appendChild(buildQuestionRow({
            question,
            index: idx,
            perspective: "guest",
          }));
        });
        guestSection.appendChild(guestList);

        const metaWrap = el("div", { class: "final-round-meta" });
        const snippetText = summary.snippet.tie
          ? "Snippet race tied — both kept it"
          : summary.snippet.winnerUid === (state.playerIds.host || state.room?.meta?.hostUid)
            ? "Snippet race: Daniel kept the snippet"
            : summary.snippet.winnerUid === (state.playerIds.guest || state.room?.meta?.guestUid)
              ? "Snippet race: Jaime kept the snippet"
              : "Snippet race unresolved";
        metaWrap.appendChild(el("div", { class: "final-round-meta__item" }, snippetText));
        const timingBits = [];
        if (Number.isFinite(summary.timings.hostMs)) timingBits.push(`Daniel ${formatSeconds(summary.timings.hostMs)}`);
        if (Number.isFinite(summary.timings.guestMs)) timingBits.push(`Jaime ${formatSeconds(summary.timings.guestMs)}`);
        if (timingBits.length > 0) {
          metaWrap.appendChild(el("div", { class: "final-round-meta__item" }, `Finish times — ${timingBits.join(" · ")}`));
        }

        inner.appendChild(hostSection);
        inner.appendChild(guestSection);
        inner.appendChild(metaWrap);
        panel.appendChild(inner);

        wrapper.appendChild(toggle);
        wrapper.appendChild(panel);
        roundsContainer.appendChild(wrapper);

        blocks.push({ roundNumber: summary.round, wrapper, toggle, panel });

        toggle.addEventListener("click", () => {
          if (openState.current === summary.round) {
            setRoundOpen(null);
          } else {
            setRoundOpen(summary.round);
          }
        });
      }

      // Open the last round by default if ready
      if (blocks.length > 0) {
        const target = ready ? blocks[blocks.length - 1].roundNumber : null;
        if (target != null) setRoundOpen(target);
      }

      // Maths panel content
      mathsPanel.innerHTML = "";
      const mathsInner = el("div", { class: "final-maths__inner" });
      if (game.maths.location) {
        mathsInner.appendChild(el("div", { class: "final-maths__location" }, game.maths.location));
      }
      if (Array.isArray(game.maths.beats) && game.maths.beats.length > 0) {
        const beatList = el("ul", { class: "final-maths__beats" });
        for (const beat of game.maths.beats) {
          beatList.appendChild(el("li", { class: "final-maths__beat" }, beat));
        }
        mathsInner.appendChild(beatList);
      }
      for (let i = 0; i < game.maths.entries.length; i += 1) {
        const entry = game.maths.entries[i];
        const block = el("div", { class: "final-maths__row" });
        block.appendChild(el("div", { class: "final-maths__prompt" }, `${i + 1}. ${entry.question}`));
        const correctLine = entry.correct === null ? "Correct answer: —" : `Correct answer: ${entry.correct}`;
        block.appendChild(el("div", { class: "final-maths__correct" }, correctLine));
        block.appendChild(buildMathsAnswerLine({
          label: "Daniel",
          data: entry.host,
        }));
        block.appendChild(buildMathsAnswerLine({
          label: "Jaime",
          data: entry.guest,
        }));
        mathsInner.appendChild(block);
      }
      mathsPanel.appendChild(mathsInner);
    };

    const buildQuestionRow = ({ question, index, perspective }) => {
      const playerName = perspective === "host" ? PLAYER_LABELS.host : PLAYER_LABELS.guest;
      const opponentName = perspective === "host" ? PLAYER_LABELS.guest : PLAYER_LABELS.host;
      const row = el("div", { class: "final-question" });

      let leftStatus;
      let rightStatus;
      let leftTitle;
      let rightTitle;

      if (perspective === "host") {
        leftStatus = question.actualStatus;
        rightStatus = question.markStatus;
        leftTitle = describeActual(playerName, leftStatus);
        rightTitle = describeMark(opponentName, rightStatus);
      } else {
        leftStatus = question.markStatus;
        rightStatus = question.actualStatus;
        leftTitle = describeMark(opponentName, leftStatus);
        rightTitle = describeActual(playerName, rightStatus);
      }

      const leftIcon = el("div", { class: `final-question__icon final-question__icon--left final-question__icon--${statusClass(leftStatus)}` }, statusToSymbol(leftStatus));
      leftIcon.setAttribute("title", leftTitle);
      const rightIcon = el("div", { class: `final-question__icon final-question__icon--right final-question__icon--${statusClass(rightStatus)}` }, statusToSymbol(rightStatus));
      rightIcon.setAttribute("title", rightTitle);

      const content = el("div", { class: "final-question__content" });
      content.appendChild(el("div", { class: "final-question__prompt" }, `${index + 1}. ${question.prompt}`));

      const chosenLine = el("div", { class: `final-question__answer final-question__answer--${statusClass(question.actualStatus)}` });
      const chosenValue = question.chosen ? question.chosen : "(no answer)";
      chosenLine.appendChild(el("span", { class: "final-question__answer-label" }, `${playerName} answered:`));
      chosenLine.appendChild(el("span", { class: "final-question__answer-value" }, ` ${chosenValue}`));
      content.appendChild(chosenLine);

      const correctValue = question.correct || "(not recorded)";
      const correctLine = el("div", { class: "final-question__answer final-question__answer--correct" });
      correctLine.appendChild(el("span", { class: "final-question__answer-label" }, "Correct answer:"));
      correctLine.appendChild(el("span", { class: "final-question__answer-value" }, ` ${correctValue}`));
      content.appendChild(correctLine);

      row.appendChild(leftIcon);
      row.appendChild(content);
      row.appendChild(rightIcon);
      return row;
    };

    const buildMathsAnswerLine = ({ label, data }) => {
      const status = data?.status || "pending";
      const wrapper = el("div", { class: `final-maths__answer final-maths__answer--${statusClass(status)}` });
      const value = data?.value;
      const showValue = value === null || value === undefined ? "—" : String(value);
      let suffix = "";
      if (data?.diff && data.diff !== "perfect") suffix = ` (Δ ${data.diff})`;
      if (data?.diff === "perfect") suffix = " (perfect)";
      wrapper.appendChild(el("span", { class: "final-maths__answer-label" }, `${label}: `));
      wrapper.appendChild(el("span", { class: "final-maths__answer-value" }, `${showValue}${suffix}`));
      return wrapper;
    };

    const loadPlayerDoc = async (role, uid) => {
      if (!uid) return;
      try {
        const snap = await getDoc(doc(db, "rooms", code, "players", uid));
        if (snap.exists()) state.players[role] = snap.data() || {};
        state.playerIds[role] = uid;
      } catch (err) {
        console.warn("[final] failed to load player doc", role, err);
      } finally {
        scheduleRender();
      }
    };

    const roomRef = doc(db, "rooms", code);

    state.unsubscribers.push(onSnapshot(roomRef, (snap) => {
      if (!snap.exists()) {
        state.room = null;
        scheduleRender();
        return;
      }
      const data = snap.data() || {};
      state.room = data;
      const hostUid = data.meta?.hostUid || null;
      const guestUid = data.meta?.guestUid || null;
      if (hostUid && hostUid !== state.playerIds.host) loadPlayerDoc("host", hostUid);
      if (guestUid && guestUid !== state.playerIds.guest) loadPlayerDoc("guest", guestUid);
      scheduleRender();
    }, (err) => {
      console.warn("[final] room snapshot failed", err);
    }));

    for (let r = 1; r <= MAX_ROUNDS; r += 1) {
      const roundRef = doc(db, "rooms", code, "rounds", String(r));
      state.unsubscribers.push(onSnapshot(roundRef, (snap) => {
        state.rounds[r] = snap.exists() ? (snap.data() || {}) : {};
        scheduleRender();
      }, (err) => {
        console.warn(`[final] round ${r} snapshot failed`, err);
      }));
    }

    await ensureAuth();

    this.unmount = () => {
      stopAnimation();
      state.unsubscribers.forEach((fn) => { try { fn(); } catch {} });
      state.unsubscribers = [];
    };
  },

  async unmount() {
    // placeholder – real cleanup attached in mount
  },
};
