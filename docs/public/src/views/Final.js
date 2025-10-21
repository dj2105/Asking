// /src/views/Final.js
//
// Final room — celebratory scoreboard and full game recap.
// • Shows headline scores with a reveal animation triggered by "IT'S A WINNER!".
// • Breaks down rounds and maths outcomes with collapsible sections.
// • Presents every round's questions, answers, and marking verdicts (one round open at a time).
// • Ends with a return-to-lobby control.

import { ensureAuth, db } from "../lib/firebase.js";
import {
  doc,
  collection,
  onSnapshot,
} from "firebase/firestore";

import { clampCode, getHashParams } from "../lib/util.js";

const roomRef = (code) => doc(db, "rooms", code);
const roundRef = (code, round) => doc(collection(roomRef(code), "rounds"), String(round));

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  });
  (Array.isArray(children) ? children : [children]).forEach((child) => {
    if (child === null || child === undefined) return;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  });
  return node;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeText(value) {
  return String(value ?? "").trim().toLowerCase();
}

function sameAnswer(a, b) {
  return normalizeText(a) === normalizeText(b);
}

function resolveCorrectAnswer(answer = {}, item = {}) {
  if (answer.correct) return answer.correct;
  if (item.correct_answer) return item.correct_answer;
  return "";
}

function countCorrectAnswers(answers = [], items = []) {
  let total = 0;
  for (let i = 0; i < answers.length; i += 1) {
    const answer = answers[i] || {};
    const correct = resolveCorrectAnswer(answer, items[i] || {});
    if (correct && sameAnswer(answer.chosen, correct)) total += 1;
  }
  return total;
}

function verdictForPlayer(marking = [], index) {
  const raw = (marking || [])[index];
  if (raw === "right" || raw === "wrong" || raw === "unknown") return raw;
  return null;
}

function verdictIcon(verdict, fallbackStatus) {
  const status = verdict || fallbackStatus;
  if (status === "right") return { text: "-", className: "final-indicator--right" };
  if (status === "wrong") return { text: "-", className: "final-indicator--wrong" };
  return { text: "?", className: "final-indicator--unknown" };
}

function classifyAnswer(answer, correct) {
  if (!answer && !correct) return "final-answer--empty";
  if (!answer) return "final-answer--unknown";
  return sameAnswer(answer, correct) ? "final-answer--correct" : "final-answer--wrong";
}

function buildQuestionColumn({
  label,
  questions,
  answers,
  opponentMarking,
}) {
  const column = el("div", { class: "final-player" });
  column.appendChild(el("div", { class: "final-player__title" }, `${label}’s Questions`));

  const list = el("div", { class: "final-question-list" });
  for (let i = 0; i < 3; i += 1) {
    const item = questions[i] || {};
    const answer = answers[i] || {};
    const questionText = item.question || answer.question || "(question missing)";
    const correct = resolveCorrectAnswer(answer, item) || "(correct answer missing)";
    const chosen = answer.chosen || "";
    const isCorrect = chosen && sameAnswer(chosen, correct);
    const fallbackVerdict = isCorrect ? "right" : chosen ? "wrong" : "unknown";
    const verdict = verdictForPlayer(opponentMarking, i) || fallbackVerdict;
    const icon = verdictIcon(verdict, fallbackVerdict);

    const row = el("div", { class: "final-question" });
    const indicator = el("div", { class: `final-indicator ${icon.className}` }, icon.text);

    const content = el("div", { class: "final-question__content" });
    content.appendChild(el("div", { class: "final-question__prompt" }, `${i + 1}. ${questionText}`));

    const answerLine = el("div", { class: "final-question__answer" });
    const answerClass = classifyAnswer(chosen, correct);
    answerLine.appendChild(el("span", { class: `final-answer ${answerClass}` }, `${label} answered: ${chosen || "—"}`));
    answerLine.appendChild(el("span", { class: "final-answer final-answer--key" }, `Correct: ${correct}`));
    answerLine.appendChild(
      el(
        "span",
        { class: "final-answer final-answer--verdict" },
        verdict === "unknown" ? "Marked: I dunno" : verdict === "right" ? "Marked: Right" : "Marked: Wrong"
      )
    );

    content.appendChild(answerLine);

    row.appendChild(indicator);
    row.appendChild(content);
    list.appendChild(row);
  }

  column.appendChild(list);
  return column;
}

function computeRoundSummary(room = {}, roundDocs = {}, hostUid = "", guestUid = "") {
  const answers = room.answers || {};
  const hostAnswersAll = answers.host || {};
  const guestAnswersAll = answers.guest || {};
  const marking = room.marking || {};
  const markingHost = marking.host || {};
  const markingGuest = marking.guest || {};

  const rounds = [];
  let hostTotal = 0;
  let guestTotal = 0;
  let hostPerfect = 0;
  let guestPerfect = 0;
  let hostRoundWins = 0;
  let guestRoundWins = 0;

  for (let r = 1; r <= 5; r += 1) {
    const roundData = roundDocs[r] || {};
    const hostItems = roundData.hostItems || [];
    const guestItems = roundData.guestItems || [];
    const hostAnswers = hostAnswersAll[r] || [];
    const guestAnswers = guestAnswersAll[r] || [];
    const hostCorrect = countCorrectAnswers(hostAnswers, hostItems);
    const guestCorrect = countCorrectAnswers(guestAnswers, guestItems);

    hostTotal += hostCorrect;
    guestTotal += guestCorrect;
    if (hostCorrect >= 3) hostPerfect += 1;
    if (guestCorrect >= 3) guestPerfect += 1;
    if (hostCorrect > guestCorrect) hostRoundWins += 1;
    else if (guestCorrect > hostCorrect) guestRoundWins += 1;

    rounds.push({
      round: r,
      hostItems,
      guestItems,
      hostAnswers,
      guestAnswers,
      hostMarking: markingGuest[r] || [],
      guestMarking: markingHost[r] || [],
      hostCorrect,
      guestCorrect,
    });
  }

  return {
    rounds,
    totals: { host: hostTotal, guest: guestTotal },
    perfect: { host: hostPerfect, guest: guestPerfect },
    roundWins: { host: hostRoundWins, guest: guestRoundWins },
  };
}

function computeMathsSummary(room = {}) {
  const maths = room.maths || {};
  const expected = Array.isArray(maths.answers) ? maths.answers : [];
  const mathsAnswers = room.mathsAnswers || {};
  const hostAnswers = Array.isArray(mathsAnswers.host) ? mathsAnswers.host : [];
  const guestAnswers = Array.isArray(mathsAnswers.guest) ? mathsAnswers.guest : [];

  const hostCorrect = expected.reduce((acc, correct, idx) => acc + (Number(hostAnswers[idx]) === Number(correct) ? 1 : 0), 0);
  const guestCorrect = expected.reduce((acc, correct, idx) => acc + (Number(guestAnswers[idx]) === Number(correct) ? 1 : 0), 0);

  return {
    maths,
    expected,
    hostAnswers,
    guestAnswers,
    hostCorrect,
    guestCorrect,
  };
}

function formatStatLine(label, value) {
  return el("div", { class: "final-stat" }, [
    el("div", { class: "final-stat__label" }, label),
    el("div", { class: "final-stat__value" }, value),
  ]);
}

function buildRoundBreakdown(rounds) {
  const list = el("ul", { class: "final-timeline" });
  rounds.forEach((entry) => {
    const item = el("li", { class: "final-timeline__item" });
    item.appendChild(el("div", { class: "final-timeline__round" }, `Round ${entry.round}`));
    item.appendChild(el("div", { class: "final-timeline__scores" }, `Daniel +${entry.hostCorrect} · Jaime +${entry.guestCorrect}`));
    list.appendChild(item);
  });
  return list;
}

function buildMathsContent(summary) {
  const { maths, expected, hostAnswers, guestAnswers, hostCorrect, guestCorrect } = summary;
  const container = el("div", { class: "final-maths" });

  const location = maths.location ? `Location: ${maths.location}` : "Location: —";
  container.appendChild(el("div", { class: "final-maths__location" }, location));

  if (Array.isArray(maths.beats) && maths.beats.length) {
    const beatList = el("ul", { class: "final-maths__beats" });
    maths.beats.forEach((beat, idx) => {
      beatList.appendChild(el("li", { class: "final-maths__beat" }, `${idx + 1}. ${beat}`));
    });
    container.appendChild(beatList);
  }

  const qaWrap = el("div", { class: "final-maths__qa" });
  const header = el("div", { class: "final-maths__qa-head" }, [
    el("div", { class: "final-maths__qa-question" }, "Question"),
    el("div", { class: "final-maths__qa-answer" }, "Correct"),
    el("div", { class: "final-maths__qa-answer" }, "Daniel"),
    el("div", { class: "final-maths__qa-answer" }, "Jaime"),
  ]);
  qaWrap.appendChild(header);

  const questions = Array.isArray(maths.questions) ? maths.questions : [];
  for (let i = 0; i < Math.max(expected.length, questions.length); i += 1) {
    const row = el("div", { class: "final-maths__qa-row" });
    const question = questions[i] || "—";
    const correct = expected[i];
    const host = hostAnswers[i];
    const guest = guestAnswers[i];

    const hostClass = Number(host) === Number(correct) ? "final-answer--correct" : "final-answer--wrong";
    const guestClass = Number(guest) === Number(correct) ? "final-answer--correct" : "final-answer--wrong";

    row.appendChild(el("div", { class: "final-maths__qa-question" }, question));
    row.appendChild(el("div", { class: "final-maths__qa-answer final-answer final-answer--key" }, String(correct ?? "—")));
    row.appendChild(el("div", { class: `final-maths__qa-answer final-answer ${hostClass}` }, host !== undefined ? String(host) : "—"));
    row.appendChild(el("div", { class: `final-maths__qa-answer final-answer ${guestClass}` }, guest !== undefined ? String(guest) : "—"));
    qaWrap.appendChild(row);
  }

  const footer = el("div", { class: "final-maths__footer" }, `Maths accuracy — Daniel ${hostCorrect}/2 · Jaime ${guestCorrect}/2`);
  container.appendChild(qaWrap);
  container.appendChild(footer);

  return container;
}

export default {
  async mount(container) {
    await ensureAuth();

    const params = getHashParams();
    const code = clampCode(params.get("code") || "");

    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    container.innerHTML = "";
    const root = el("div", { class: "view view-final" });
    container.appendChild(root);

    if (!code) {
      root.appendChild(
        el("div", { class: "card" }, [
          el("div", { class: "view-heading" }, "Final Room"),
          el("div", { class: "mono", style: "text-align:center;" }, "Missing room code. Return to the lobby."),
          el("button", {
            class: "btn",
            type: "button",
            onclick: () => { location.hash = "#/lobby"; },
          }, "Return to Lobby"),
        ]),
      );
      return;
    }

    const heroCard = el("div", { class: "card final-card final-card--hero" });
    const heading = el("h2", { class: "view-heading final-heading" }, "Final Scores");
    const roomChip = el("div", { class: "final-room-code" }, `Room ${code}`);

    const scoreBoard = el("div", { class: "final-scoreboard" });
    const hostScoreValue = el("div", { class: "final-score__value" }, "0");
    const guestScoreValue = el("div", { class: "final-score__value" }, "0");
    const hostScore = el("div", { class: "final-score" }, [
      el("div", { class: "final-score__label" }, "Daniel"),
      hostScoreValue,
    ]);
    const guestScore = el("div", { class: "final-score" }, [
      el("div", { class: "final-score__label" }, "Jaime"),
      guestScoreValue,
    ]);
    scoreBoard.appendChild(hostScore);
    scoreBoard.appendChild(guestScore);

    const winnerLabel = el("div", { class: "final-winner final-winner--hidden" }, "Awaiting final score…");

    const revealButton = el("button", {
      class: "btn big final-cta",
      type: "button",
      disabled: "",
    }, "IT’S A WINNER!");

    const breakdownTitle = el("div", { class: "final-subheading" }, "Round Breakdown");
    const breakdownWrap = el("div", { class: "final-timeline-wrap" });

    const statsTitle = el("div", { class: "final-subheading" }, "Highlights");
    const statsWrap = el("div", { class: "final-stats" });

    heroCard.appendChild(heading);
    heroCard.appendChild(roomChip);
    heroCard.appendChild(scoreBoard);
    heroCard.appendChild(revealButton);
    heroCard.appendChild(winnerLabel);
    heroCard.appendChild(breakdownTitle);
    heroCard.appendChild(breakdownWrap);
    heroCard.appendChild(statsTitle);
    heroCard.appendChild(statsWrap);

    const roundsCard = el("div", { class: "card final-card final-card--rounds" });
    roundsCard.appendChild(el("h3", { class: "final-subheading" }, "All Questions"));
    const accordion = el("div", { class: "final-accordion" });
    const roundBodies = new Map();
    let openRound = null;

    const toggleRound = (round) => {
      roundBodies.forEach((body, r) => {
        const shouldOpen = r === round && openRound !== round;
        if (shouldOpen) {
          body.classList.add("final-accordion__body--open");
          body.style.maxHeight = `${body.scrollHeight}px`;
          openRound = round;
        } else {
          body.classList.remove("final-accordion__body--open");
          body.style.maxHeight = "";
          if (r === round) openRound = null;
        }
      });
    };

    for (let r = 1; r <= 5; r += 1) {
      const item = el("div", { class: "final-accordion__item" });
      const header = el("button", {
        class: "final-accordion__header",
        type: "button",
        onclick: () => toggleRound(r),
      }, `Round ${r}`);
      const body = el("div", { class: "final-accordion__body" });
      item.appendChild(header);
      item.appendChild(body);
      accordion.appendChild(item);
      roundBodies.set(r, body);
    }

    roundsCard.appendChild(accordion);

    const mathsCard = el("div", { class: "card final-card final-card--maths" });
    const mathsHeader = el("button", { class: "final-accordion__header final-accordion__header--maths", type: "button" }, "Maths Snippet & Answers");
    const mathsBody = el("div", { class: "final-accordion__body" });
    mathsHeader.addEventListener("click", () => {
      const isOpen = mathsBody.classList.toggle("final-accordion__body--open");
      mathsBody.style.maxHeight = isOpen ? `${mathsBody.scrollHeight}px` : "";
    });
    mathsCard.appendChild(mathsHeader);
    mathsCard.appendChild(mathsBody);

    const footer = el("div", { class: "final-footer" });
    const lobbyBtn = el("button", {
      class: "btn final-return",
      type: "button",
      onclick: () => { location.hash = "#/lobby"; },
    }, "Return to Lobby");
    footer.appendChild(lobbyBtn);

    root.appendChild(heroCard);
    root.appendChild(roundsCard);
    root.appendChild(mathsCard);
    root.appendChild(footer);

    const state = {
      room: null,
      rounds: {},
      hostUid: "",
      guestUid: "",
      totals: { host: 0, guest: 0 },
      roundSummary: [],
      maths: null,
      ready: false,
      animationRunning: false,
      animationDone: false,
    };

    const updateRoundBodies = () => {
      const summary = state.roundSummary;
      summary.forEach((info) => {
        const body = roundBodies.get(info.round);
        if (!body) return;
        body.innerHTML = "";
        const columns = el("div", { class: "final-round" });
        columns.appendChild(
          buildQuestionColumn({
            label: "Daniel",
            role: "host",
            questions: info.hostItems,
            answers: info.hostAnswers,
            opponentMarking: info.hostMarking,
          })
        );
        columns.appendChild(
          buildQuestionColumn({
            label: "Jaime",
            role: "guest",
            questions: info.guestItems,
            answers: info.guestAnswers,
            opponentMarking: info.guestMarking,
          })
        );
        body.appendChild(columns);
        if (body.classList.contains("final-accordion__body--open")) {
          body.style.maxHeight = `${body.scrollHeight}px`;
        }
      });
    };

    const render = () => {
      const room = state.room || {};
      if (!room || room.state !== "final") {
        revealButton.disabled = true;
        winnerLabel.textContent = "Waiting for final state…";
        winnerLabel.classList.remove("final-winner--flash");
        winnerLabel.classList.add("final-winner--hidden");
        return;
      }

      const summary = computeRoundSummary(room, state.rounds, state.hostUid, state.guestUid);
      state.roundSummary = summary.rounds;
      state.totals = summary.totals;
      const mathsSummary = computeMathsSummary(room);
      state.maths = mathsSummary;
      state.ready = true;

      if (!state.animationDone) {
        hostScoreValue.textContent = "0";
        guestScoreValue.textContent = "0";
        winnerLabel.textContent = "Press the button to reveal the winner.";
        winnerLabel.classList.add("final-winner--hidden");
        winnerLabel.classList.remove("final-winner--flash");
      } else {
        hostScoreValue.textContent = String(summary.totals.host);
        guestScoreValue.textContent = String(summary.totals.guest);
      }

      breakdownWrap.innerHTML = "";
      breakdownWrap.appendChild(buildRoundBreakdown(summary.rounds));

      statsWrap.innerHTML = "";
      statsWrap.appendChild(formatStatLine("Rounds won", `Daniel ${summary.roundWins.host} · Jaime ${summary.roundWins.guest}`));
      statsWrap.appendChild(formatStatLine("Perfect rounds", `Daniel ${summary.perfect.host} · Jaime ${summary.perfect.guest}`));
      statsWrap.appendChild(formatStatLine(
        "Maths accuracy",
        `Daniel ${mathsSummary.hostCorrect}/2 · Jaime ${mathsSummary.guestCorrect}/2`
      ));

      mathsBody.innerHTML = "";
      mathsBody.appendChild(buildMathsContent(mathsSummary));
      if (mathsBody.classList.contains("final-accordion__body--open")) {
        mathsBody.style.maxHeight = `${mathsBody.scrollHeight}px`;
      }

      updateRoundBodies();

      revealButton.disabled = state.animationDone;
    };

    const runAnimation = async () => {
      if (!state.ready || state.animationRunning || state.animationDone) return;
      state.animationRunning = true;
      revealButton.disabled = true;

      const frames = state.roundSummary.map((info) => ({
        label: `Round ${info.round}`,
        hostDelta: info.hostCorrect,
        guestDelta: info.guestCorrect,
      }));

      let host = 0;
      let guest = 0;
      hostScoreValue.textContent = "0";
      guestScoreValue.textContent = "0";

      const timelineItems = breakdownWrap.querySelectorAll(".final-timeline__item");

      for (let i = 0; i < frames.length; i += 1) {
        const frame = frames[i];
        if (timelineItems[i]) timelineItems[i].classList.add("final-timeline__item--active");
        await delay(420);
        host += frame.hostDelta;
        guest += frame.guestDelta;
        hostScoreValue.textContent = String(host);
        guestScoreValue.textContent = String(guest);
        await delay(180);
        if (timelineItems[i]) timelineItems[i].classList.remove("final-timeline__item--active");
      }

      state.animationRunning = false;
      state.animationDone = true;

      hostScoreValue.textContent = String(state.totals.host);
      guestScoreValue.textContent = String(state.totals.guest);

      let winnerText = "It’s a tie!";
      if (state.totals.host > state.totals.guest) winnerText = "Daniel WINS!";
      else if (state.totals.guest > state.totals.host) winnerText = "Jaime WINS!";

      winnerLabel.textContent = winnerText;
      winnerLabel.classList.remove("final-winner--hidden");
      winnerLabel.classList.add("final-winner--flash");
    };

    revealButton.addEventListener("click", runAnimation);

    const unsubs = [];

    const unsubRoom = onSnapshot(roomRef(code), (snap) => {
      if (!snap.exists()) return;
      state.room = snap.data() || {};
      const meta = state.room.meta || {};
      if (meta.hostUid && meta.hostUid !== state.hostUid) {
        state.hostUid = meta.hostUid;
      }
      if (meta.guestUid && meta.guestUid !== state.guestUid) {
        state.guestUid = meta.guestUid;
      }
      render();
    });
    unsubs.push(() => { try { unsubRoom(); } catch {} });

    for (let r = 1; r <= 5; r += 1) {
      const unsub = onSnapshot(roundRef(code, r), (snap) => {
        state.rounds[r] = snap.exists() ? snap.data() || {} : {};
        render();
      });
      unsubs.push(() => { try { unsub(); } catch {} });
    }

    this.unmount = () => {
      unsubs.forEach((fn) => { try { fn(); } catch {} });
    };
  },
};

