// /src/views/Final.js
//
// Final room — show the full game summary once maths are complete.
// • Large headline scoreboard with a replay button (“IT’S A WINNER!”).
// • Animated replay adds per-round scores before flashing the winner.
// • Detailed breakdown cards for each question round (accordion style).
// • Maths snippets/questions in their own collapsible rectangle.
// • Return-to-lobby button at the end.
//
// Firestore reads:
//   rooms/{code} → state, scores, answers, marking, maths, mathsAnswers
//   rooms/{code}/rounds/{1..5} → hostItems, guestItems
//
// Router contract: module exports default { mount(container), unmount() }.

import { ensureAuth, db } from "../lib/firebase.js";
import { doc, collection, getDoc, onSnapshot } from "firebase/firestore";
import { clampCode, getHashParams } from "../lib/util.js";

const VERDICT = {
  RIGHT: "right",
  WRONG: "wrong",
  UNKNOWN: "unknown",
};

const HOST_NAME = "Daniel";
const GUEST_NAME = "Jaime";

const roundDocRef = (code, round) => doc(collection(doc(db, "rooms", code), "rounds"), String(round));
const roomRef = (code) => doc(db, "rooms", code);

function el(tag, attrs = {}, kids = []) {
  const node = document.createElement(tag);
  for (const key in attrs) {
    const value = attrs[key];
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  (Array.isArray(kids) ? kids : [kids]).forEach((child) => {
    if (child == null) return;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  });
  return node;
}

function sameAnswer(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

function statusFromAnswer(chosen, correct) {
  if (!chosen) return VERDICT.UNKNOWN;
  if (sameAnswer(chosen, correct)) return VERDICT.RIGHT;
  return VERDICT.WRONG;
}

function markerClass(status) {
  if (status === VERDICT.RIGHT) return "final-marker final-marker--right";
  if (status === VERDICT.WRONG) return "final-marker final-marker--wrong";
  return "final-marker final-marker--unknown";
}

function markerSymbol(status) {
  if (status === VERDICT.RIGHT) return "✓";
  if (status === VERDICT.WRONG) return "✕";
  return "?";
}

function verdictLabel(status, judgeName) {
  if (!status) return `${judgeName} undecided.`;
  if (status === VERDICT.RIGHT) return `${judgeName} marked it right.`;
  if (status === VERDICT.WRONG) return `${judgeName} said nope.`;
  return `${judgeName} chose “I dunno”.`;
}

function statusLabel(status) {
  if (status === VERDICT.RIGHT) return "Correct";
  if (status === VERDICT.WRONG) return "Wrong";
  return "Unanswered";
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return String(n);
}

const state = {
  code: "",
  room: null,
  rounds: {},
  unsubRoom: null,
  unsubRounds: {},
  openRound: 1,
  mathsOpen: false,
  finalScores: { host: 0, guest: 0 },
  displayScores: { host: 0, guest: 0 },
  timeline: [],
  animating: false,
  pendingRefreshAfterAnimation: false,
};

const dom = {
  root: null,
  scoreHost: null,
  scoreGuest: null,
  scoreProgress: null,
  winner: null,
  replayBtn: null,
  breakdownList: null,
  statsList: null,
  roundCards: {},
  mathsCard: null,
  mathsBody: null,
  mathsSummary: null,
};

function updateScoreDisplay({ force = false } = {}) {
  if (!dom.scoreHost || !dom.scoreGuest) return;
  if (!state.animating || force) {
    state.displayScores.host = state.finalScores.host;
    state.displayScores.guest = state.finalScores.guest;
  }
  dom.scoreHost.textContent = formatNumber(state.displayScores.host);
  dom.scoreGuest.textContent = formatNumber(state.displayScores.guest);
}

function setWinnerText(text, { flashing = false } = {}) {
  if (!dom.winner) return;
  if (!text) {
    dom.winner.textContent = "";
    dom.winner.classList.remove("final-winner--visible", "final-winner--flash");
    return;
  }
  dom.winner.textContent = text;
  dom.winner.classList.add("final-winner--visible");
  dom.winner.classList.toggle("final-winner--flash", !!flashing);
}

function stopTimelineWatchers() {
  if (typeof state.unsubRoom === "function") {
    try { state.unsubRoom(); } catch {}
  }
  state.unsubRoom = null;
  for (const key of Object.keys(state.unsubRounds)) {
    const fn = state.unsubRounds[key];
    if (typeof fn === "function") {
      try { fn(); } catch {}
    }
  }
  state.unsubRounds = {};
}

function computeRoundSummaries() {
  const room = state.room || {};
  const answersHost = room.answers?.host || {};
  const answersGuest = room.answers?.guest || {};
  const markingHost = room.marking?.host || {};
  const markingGuest = room.marking?.guest || {};

  const results = [];
  for (let r = 1; r <= 5; r += 1) {
    const roundDoc = state.rounds[r] || {};
    const hostItems = ensureArray(roundDoc.hostItems);
    const guestItems = ensureArray(roundDoc.guestItems);
    const hostAnswers = ensureArray(answersHost[r]);
    const guestAnswers = ensureArray(answersGuest[r]);
    const hostVerdicts = ensureArray(markingGuest[r]); // guest judges host answers
    const guestVerdicts = ensureArray(markingHost[r]); // host judges guest answers

    const hostQuestions = [0, 1, 2].map((idx) => {
      const item = hostItems[idx] || {};
      const answer = hostAnswers[idx] || {};
      const prompt = answer.question || item.question || `Question ${idx + 1}`;
      const correct = answer.correct || item.correct_answer || "";
      const chosen = answer.chosen || "";
      const status = statusFromAnswer(chosen, correct);
      const verdict = hostVerdicts[idx] || null;
      return {
        prompt,
        chosen,
        correct,
        status,
        verdict,
        player: HOST_NAME,
        judge: GUEST_NAME,
      };
    });

    const guestQuestions = [0, 1, 2].map((idx) => {
      const item = guestItems[idx] || {};
      const answer = guestAnswers[idx] || {};
      const prompt = answer.question || item.question || `Question ${idx + 1}`;
      const correct = answer.correct || item.correct_answer || "";
      const chosen = answer.chosen || "";
      const status = statusFromAnswer(chosen, correct);
      const verdict = guestVerdicts[idx] || null;
      return {
        prompt,
        chosen,
        correct,
        status,
        verdict,
        player: GUEST_NAME,
        judge: HOST_NAME,
      };
    });

    const hostCorrect = hostQuestions.filter((q) => q.status === VERDICT.RIGHT).length;
    const guestCorrect = guestQuestions.filter((q) => q.status === VERDICT.RIGHT).length;
    const hostWrong = hostQuestions.filter((q) => q.status === VERDICT.WRONG).length;
    const guestWrong = guestQuestions.filter((q) => q.status === VERDICT.WRONG).length;

    results.push({
      round: r,
      host: { questions: hostQuestions, correct: hostCorrect, wrong: hostWrong },
      guest: { questions: guestQuestions, correct: guestCorrect, wrong: guestWrong },
    });
  }
  return results;
}

function computeTimeline(roundSummaries) {
  return roundSummaries.map((entry) => ({
    label: `Round ${entry.round}`,
    hostDelta: entry.host.correct,
    guestDelta: entry.guest.correct,
  }));
}

function computeMathsSummary() {
  const maths = state.room?.maths || {};
  const correctAnswers = ensureArray(maths.answers).map((n) => Number(n));
  const questions = ensureArray(maths.questions);
  const beats = ensureArray(maths.beats);
  const mathsAnswers = state.room?.mathsAnswers || {};
  const hostAnswers = ensureArray(mathsAnswers.host).map((n) => Number(n));
  const guestAnswers = ensureArray(mathsAnswers.guest).map((n) => Number(n));

  const totalSlots = Math.max(questions.length, correctAnswers.length);
  const entries = [];
  let hostScore = 0;
  let guestScore = 0;
  for (let i = 0; i < totalSlots; i += 1) {
    const question = questions[i] || "";
    const correct = Number.isFinite(correctAnswers[i]) ? correctAnswers[i] : "—";
    const host = Number.isFinite(hostAnswers[i]) ? hostAnswers[i] : null;
    const guest = Number.isFinite(guestAnswers[i]) ? guestAnswers[i] : null;
    const hostRight = host !== null && host === correctAnswers[i];
    const guestRight = guest !== null && guest === correctAnswers[i];
    if (hostRight) hostScore += 1;
    if (guestRight) guestScore += 1;
    entries.push({ question, correct, host, guest, hostRight, guestRight });
  }

  return {
    location: maths.location || "",
    beats,
    entries,
    hostScore,
    guestScore,
  };
}

function renderBreakdown(roundSummaries) {
  if (!dom.breakdownList) return;
  dom.breakdownList.innerHTML = "";
  roundSummaries.forEach((entry) => {
    const item = el("div", { class: "final-breakdown__item" });
    const title = el("div", { class: "mono final-breakdown__round" }, `Round ${entry.round}`);
    const score = el(
      "div",
      { class: "mono final-breakdown__score" },
      `${HOST_NAME} +${entry.host.correct} · ${GUEST_NAME} +${entry.guest.correct}`
    );
    item.appendChild(title);
    item.appendChild(score);
    dom.breakdownList.appendChild(item);
  });
}

function renderStats(roundSummaries, mathsSummary) {
  if (!dom.statsList) return;
  const totalHostCorrect = roundSummaries.reduce((acc, r) => acc + r.host.correct, 0);
  const totalGuestCorrect = roundSummaries.reduce((acc, r) => acc + r.guest.correct, 0);
  const totalHostWrong = roundSummaries.reduce((acc, r) => acc + r.host.wrong, 0);
  const totalGuestWrong = roundSummaries.reduce((acc, r) => acc + r.guest.wrong, 0);

  const bestHostRound = [...roundSummaries].sort((a, b) => b.host.correct - a.host.correct)[0];
  const bestGuestRound = [...roundSummaries].sort((a, b) => b.guest.correct - a.guest.correct)[0];

  dom.statsList.innerHTML = "";
  dom.statsList.appendChild(
    el(
      "div",
      { class: "mono final-stats__row" },
      `${HOST_NAME} — ${totalHostCorrect} right · ${totalHostWrong} missed`
    )
  );
  dom.statsList.appendChild(
    el(
      "div",
      { class: "mono final-stats__row" },
      `${GUEST_NAME} — ${totalGuestCorrect} right · ${totalGuestWrong} missed`
    )
  );
  if (bestHostRound) {
    dom.statsList.appendChild(
      el(
        "div",
        { class: "mono final-stats__row" },
        `${HOST_NAME} peak: Round ${bestHostRound.round} (+${bestHostRound.host.correct})`
      )
    );
  }
  if (bestGuestRound) {
    dom.statsList.appendChild(
      el(
        "div",
        { class: "mono final-stats__row" },
        `${GUEST_NAME} peak: Round ${bestGuestRound.round} (+${bestGuestRound.guest.correct})`
      )
    );
  }
  dom.statsList.appendChild(
    el(
      "div",
      { class: "mono final-stats__row" },
      `Maths correct — ${HOST_NAME} ${mathsSummary.hostScore} · ${GUEST_NAME} ${mathsSummary.guestScore}`
    )
  );
}

function renderQuestionList(container, questions, { align = "host" } = {}) {
  container.innerHTML = "";
  questions.forEach((q, idx) => {
    const row = el("div", { class: align === "guest" ? "final-question final-question--guest" : "final-question" });
    const marker = el("div", { class: markerClass(q.status) }, markerSymbol(q.status));
    const content = el("div", { class: "final-question__content" });
    const prompt = el("div", { class: "mono final-question__prompt" }, `${idx + 1}. ${q.prompt}`);

    const answersWrap = el("div", { class: "final-question__answers" });
    const chosenClass = q.status === VERDICT.RIGHT
      ? "final-answer final-answer--correct"
      : q.status === VERDICT.WRONG
        ? "final-answer final-answer--wrong"
        : "final-answer final-answer--pending";
    const chosen = el("div", { class: `mono ${chosenClass}` }, `You said: ${q.chosen || "—"}`);
    const correct = el("div", { class: "mono final-answer final-answer--correct" }, `Correct: ${q.correct || "—"}`);
    answersWrap.appendChild(chosen);
    answersWrap.appendChild(correct);

    const verdict = el(
      "div",
      { class: "mono small final-question__verdict" },
      `${statusLabel(q.status)} · ${verdictLabel(q.verdict, q.judge)}`
    );

    content.appendChild(prompt);
    content.appendChild(answersWrap);
    content.appendChild(verdict);

    if (align === "guest") {
      row.appendChild(content);
      row.appendChild(marker);
    } else {
      row.appendChild(marker);
      row.appendChild(content);
    }
    container.appendChild(row);
  });
}

function renderRoundCard(roundSummary) {
  const info = dom.roundCards[roundSummary.round];
  if (!info) return;
  info.summary.textContent = `${HOST_NAME} ${roundSummary.host.correct} · ${GUEST_NAME} ${roundSummary.guest.correct}`;
  renderQuestionList(info.hostList, roundSummary.host.questions, { align: "host" });
  renderQuestionList(info.guestList, roundSummary.guest.questions, { align: "guest" });
}

function setRoundOpen(round, { force = false } = {}) {
  state.openRound = force ? round : (state.openRound === round ? null : round);
  Object.values(dom.roundCards).forEach((entry) => {
    entry.card.classList.toggle("final-round-card--open", entry.round === state.openRound);
  });
}

function setMathsOpen(force) {
  if (!dom.mathsCard) return;
  if (typeof force === "boolean") state.mathsOpen = force;
  dom.mathsCard.classList.toggle("final-collapsible--open", !!state.mathsOpen);
}

function renderMathsCard(summary) {
  if (!dom.mathsBody || !dom.mathsSummary) return;
  dom.mathsSummary.textContent = summary.location
    ? `${summary.location} — ${summary.beats.length} beats`
    : "Maths snippets and final answers";

  dom.mathsBody.innerHTML = "";
  if (summary.beats.length) {
    const beatList = el("ul", { class: "final-maths__beats" });
    summary.beats.forEach((beat) => {
      beatList.appendChild(el("li", { class: "mono" }, beat));
    });
    dom.mathsBody.appendChild(beatList);
  }

  summary.entries.forEach((entry, idx) => {
    const block = el("div", { class: "final-maths__item" });
    const prompt = el(
      "div",
      { class: "mono final-maths__prompt" },
      `${idx + 1}. ${entry.question || ""}`
    );
    const correct = el(
      "div",
      { class: "mono final-maths__correct" },
      `Answer: ${entry.correct}`
    );
    const playerRow = el("div", { class: "final-maths__players" });
    const hostLine = el(
      "div",
      {
        class: `mono final-maths__answer ${entry.hostRight ? "final-maths__answer--right" : "final-maths__answer--wrong"}`,
      },
      `${HOST_NAME}: ${entry.host ?? "—"}`
    );
    const guestLine = el(
      "div",
      {
        class: `mono final-maths__answer ${entry.guestRight ? "final-maths__answer--right" : "final-maths__answer--wrong"}`,
      },
      `${GUEST_NAME}: ${entry.guest ?? "—"}`
    );
    playerRow.appendChild(hostLine);
    playerRow.appendChild(guestLine);

    block.appendChild(prompt);
    block.appendChild(correct);
    block.appendChild(playerRow);
    dom.mathsBody.appendChild(block);
  });
}

async function runReplayAnimation() {
  if (state.animating) return;
  if (!state.timeline.length) return;
  state.animating = true;
  state.pendingRefreshAfterAnimation = false;
  if (dom.replayBtn) {
    dom.replayBtn.disabled = true;
    dom.replayBtn.classList.remove("throb");
  }
  if (dom.scoreProgress) {
    dom.scoreProgress.textContent = "Replaying the rounds…";
  }
  setWinnerText("", { flashing: false });

  state.displayScores = { host: 0, guest: 0 };
  dom.scoreHost.textContent = "0";
  dom.scoreGuest.textContent = "0";

  const applySteps = async () => {
    for (const step of state.timeline) {
      if (dom.scoreProgress) {
        dom.scoreProgress.textContent = step.label;
      }
      const increments = [];
      const hostDelta = step.hostDelta;
      const guestDelta = step.guestDelta;
      const hostDir = hostDelta >= 0 ? 1 : -1;
      const guestDir = guestDelta >= 0 ? 1 : -1;
      for (let i = 0; i < Math.abs(hostDelta); i += 1) increments.push({ who: "host", dir: hostDir });
      for (let i = 0; i < Math.abs(guestDelta); i += 1) increments.push({ who: "guest", dir: guestDir });

      // Slight pause if no increments (e.g., zero score round)
      if (!increments.length) {
        await new Promise((resolve) => setTimeout(resolve, 280));
        continue;
      }

      await new Promise((resolve) => {
        let idx = 0;
        const tick = () => {
          const stepInfo = increments[idx];
          if (stepInfo) {
            state.displayScores[stepInfo.who] += stepInfo.dir;
            dom.scoreHost.textContent = formatNumber(state.displayScores.host);
            dom.scoreGuest.textContent = formatNumber(state.displayScores.guest);
            idx += 1;
            setTimeout(tick, 260);
          } else {
            setTimeout(resolve, 320);
          }
        };
        tick();
      });
    }
  };

  await applySteps();

  state.animating = false;
  state.displayScores = { ...state.finalScores };
  updateScoreDisplay({ force: true });
  if (dom.scoreProgress) {
    dom.scoreProgress.textContent = "Final score locked.";
  }
  const winner = state.finalScores.host > state.finalScores.guest
    ? `${HOST_NAME} WINS!`
    : state.finalScores.guest > state.finalScores.host
      ? `${GUEST_NAME} WINS!`
      : "It’s a tie!";
  setWinnerText(winner, { flashing: true });
  if (dom.replayBtn) {
    dom.replayBtn.disabled = false;
    dom.replayBtn.classList.add("throb");
  }
  if (state.pendingRefreshAfterAnimation) {
    renderFinalView();
  }
}

function renderFinalView() {
  if (!dom.root) return;
  const room = state.room || {};
  if ((room.state || "").toLowerCase() !== "final") {
    if (dom.scoreProgress) {
      dom.scoreProgress.textContent = "Waiting for maths to complete…";
    }
    if (dom.replayBtn) {
      dom.replayBtn.disabled = true;
      dom.replayBtn.classList.remove("throb");
    }
    setWinnerText("", { flashing: false });
    return;
  }

  const roundSummaries = computeRoundSummaries();
  state.timeline = computeTimeline(roundSummaries);

  const storedHost = Number(room.scores?.questions?.host);
  const storedGuest = Number(room.scores?.questions?.guest);
  const computedHost = roundSummaries.reduce((acc, r) => acc + r.host.correct, 0);
  const computedGuest = roundSummaries.reduce((acc, r) => acc + r.guest.correct, 0);
  state.finalScores.host = Number.isFinite(storedHost) ? storedHost : computedHost;
  state.finalScores.guest = Number.isFinite(storedGuest) ? storedGuest : computedGuest;

  if (!state.animating) {
    updateScoreDisplay({ force: true });
    const winner = state.finalScores.host > state.finalScores.guest
      ? `${HOST_NAME} WINS!`
      : state.finalScores.guest > state.finalScores.host
        ? `${GUEST_NAME} WINS!`
        : "It’s a tie!";
    setWinnerText(winner, { flashing: false });
  } else {
    state.pendingRefreshAfterAnimation = true;
  }

  if (dom.scoreProgress) {
    dom.scoreProgress.textContent = "All rounds tallied.";
  }
  if (dom.replayBtn) {
    dom.replayBtn.disabled = state.timeline.length === 0;
    dom.replayBtn.classList.toggle("throb", state.timeline.length > 0);
  }

  renderBreakdown(roundSummaries);
  const mathsSummary = computeMathsSummary();
  renderStats(roundSummaries, mathsSummary);
  roundSummaries.forEach(renderRoundCard);
  renderMathsCard(mathsSummary);
}

function buildViewSkeleton(container) {
  container.innerHTML = "";
  const root = el("div", { class: "view view-final" });

  const scoreCard = el("div", { class: "card final-scoreboard" });
  const title = el("h1", { class: "final-scoreboard__title" }, "Final Scores");
  const scoreRow = el("div", { class: "final-scoreboard__row" });
  const hostBlock = el("div", { class: "final-scoreboard__player" }, [
    el("div", { class: "mono final-scoreboard__name" }, HOST_NAME),
    dom.scoreHost = el("div", { class: "final-scoreboard__value" }, "0"),
  ]);
  const guestBlock = el("div", { class: "final-scoreboard__player" }, [
    el("div", { class: "mono final-scoreboard__name" }, GUEST_NAME),
    dom.scoreGuest = el("div", { class: "final-scoreboard__value" }, "0"),
  ]);
  scoreRow.appendChild(hostBlock);
  scoreRow.appendChild(guestBlock);

  dom.scoreProgress = el("div", { class: "mono small final-scoreboard__progress" }, "Loading…");
  dom.replayBtn = el("button", { class: "btn final-cta", type: "button" }, "IT’S A WINNER!");
  dom.replayBtn.addEventListener("click", () => {
    runReplayAnimation().catch((err) => console.warn("[final] replay animation failed", err));
  });
  dom.winner = el("div", { class: "mono final-winner" });

  scoreCard.appendChild(title);
  scoreCard.appendChild(scoreRow);
  scoreCard.appendChild(dom.scoreProgress);
  scoreCard.appendChild(dom.replayBtn);
  scoreCard.appendChild(dom.winner);

  const breakdownCard = el("div", { class: "card final-breakdown" });
  breakdownCard.appendChild(el("h2", { class: "section-title" }, "Score breakdown"));
  dom.breakdownList = el("div", { class: "final-breakdown__list" });
  breakdownCard.appendChild(dom.breakdownList);
  breakdownCard.appendChild(el("h3", { class: "section-subtitle" }, "Highlights"));
  dom.statsList = el("div", { class: "final-stats" });
  breakdownCard.appendChild(dom.statsList);

  const roundsWrap = el("div", { class: "final-rounds" });
  dom.roundCards = {};
  for (let r = 1; r <= 5; r += 1) {
    const card = el("div", { class: "final-round-card" });
    const header = el("button", { class: "final-round-card__header", type: "button" });
    header.appendChild(el("span", { class: "mono final-round-card__label" }, `Round ${r}`));
    const summary = el("span", { class: "mono small final-round-card__summary" }, "");
    header.appendChild(summary);
    header.addEventListener("click", () => setRoundOpen(r));

    const body = el("div", { class: "final-round-card__body" });
    const hostTitle = el("div", { class: "mono final-round-player__title" }, `${HOST_NAME}’s questions`);
    const hostList = el("div", { class: "final-round-player" });
    const guestTitle = el("div", { class: "mono final-round-player__title" }, `${GUEST_NAME}’s questions`);
    const guestList = el("div", { class: "final-round-player" });

    body.appendChild(hostTitle);
    body.appendChild(hostList);
    body.appendChild(guestTitle);
    body.appendChild(guestList);

    card.appendChild(header);
    card.appendChild(body);

    dom.roundCards[r] = {
      round: r,
      card,
      header,
      summary,
      hostList,
      guestList,
      body,
    };
    roundsWrap.appendChild(card);
  }

  const mathsCard = el("div", { class: "card final-collapsible" });
  const mathsHeader = el("button", { class: "final-collapsible__header", type: "button" });
  mathsHeader.appendChild(el("span", { class: "mono" }, "Jemima’s Maths"));
  dom.mathsSummary = el("span", { class: "mono small final-collapsible__summary" }, "");
  mathsHeader.appendChild(dom.mathsSummary);
  mathsHeader.addEventListener("click", () => {
    state.mathsOpen = !state.mathsOpen;
    setMathsOpen();
  });
  dom.mathsBody = el("div", { class: "final-maths" });
  mathsCard.appendChild(mathsHeader);
  mathsCard.appendChild(dom.mathsBody);
  dom.mathsCard = mathsCard;

  const lobbyBtn = el("button", { class: "btn final-return", type: "button" }, "Return to lobby");
  lobbyBtn.addEventListener("click", () => {
    location.hash = "#/lobby";
  });

  root.appendChild(scoreCard);
  root.appendChild(breakdownCard);
  root.appendChild(roundsWrap);
  root.appendChild(mathsCard);
  root.appendChild(lobbyBtn);

  container.appendChild(root);
  dom.root = root;
}

async function bindFirestore(code) {
  stopTimelineWatchers();
  if (!code) return;

  state.unsubRoom = onSnapshot(roomRef(code), (snap) => {
    state.room = snap.data() || {};
    renderFinalView();
  });

  for (let r = 1; r <= 5; r += 1) {
    const ref = roundDocRef(code, r);
    try {
      const initial = await getDoc(ref);
      if (initial.exists()) {
        state.rounds[r] = initial.data() || {};
      }
    } catch (err) {
      console.warn("[final] failed to preload round", r, err);
    }
    state.unsubRounds[r] = onSnapshot(ref, (snap) => {
      if (snap.exists()) {
        state.rounds[r] = snap.data() || {};
        if (!state.animating) renderFinalView();
        else state.pendingRefreshAfterAnimation = true;
      }
    });
  }
}

export default {
  async mount(container) {
    dom.root = null;
    state.openRound = null;
    state.mathsOpen = false;
    state.animating = false;
    state.pendingRefreshAfterAnimation = false;
    state.timeline = [];
    state.rounds = {};

    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    const me = await ensureAuth();
    if (!me) throw new Error("Auth required for final view");

    const params = getHashParams();
    const code = clampCode(params.get("code") || "");
    state.code = code;

    buildViewSkeleton(container);
    setRoundOpen(1, { force: true });
    setMathsOpen(false);

    await bindFirestore(code);
  },

  async unmount() {
    stopTimelineWatchers();
    dom.root = null;
    dom.roundCards = {};
    dom.mathsCard = null;
  },
};
