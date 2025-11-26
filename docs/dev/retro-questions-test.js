import Questions from "../src/views/Questions.js";
import ScoreStrip from "../src/lib/ScoreStrip.js";
import "../src/styles/questions-retro.css";

const questions = [
  {
    number: 13,
    text: "Which retro console popularised the phrase 'Do a barrel roll' in 1997?",
    answers: ["Nintendo 64", "PlayStation", "Dreamcast", "Game Boy Color"],
  },
  {
    number: 14,
    text: "What arcade classic features a yellow hero munching pellets in a maze?",
    answers: ["Galaga", "Pac-Man", "Centipede", "Dig Dug"],
  },
  {
    number: 15,
    text: "Which 80s computer had the BASIC command RUN " +
      "to start cassette-loaded programs?",
    answers: ["Commodore 64", "Apple IIc", "ZX Spectrum", "Amiga 500"],
  },
];

const state = {
  currentQuestionIndex: 0,
  userAnswers: Array(questions.length).fill(null),
  flashingAnswerId: null,
  inContinueView: false,
  typingHandle: 0,
};

function getCodeFromHash() {
  const hash = window.location.hash || "";
  const params = new URLSearchParams(hash.replace(/^#\/?/, ""));
  const code = (params.get("code") || "").trim().toUpperCase();
  return code || "DEV123";
}

function initScoreStrip() {
  const scoreRoot = document.getElementById("score-strip-root");
  if (scoreRoot) {
    const code = getCodeFromHash();
    ScoreStrip.mount(scoreRoot, { code });
  }
}

function typeQuestion(text) {
  const node = document.getElementById("question-text");
  if (!node) return;
  if (state.typingHandle) clearTimeout(state.typingHandle);
  node.textContent = "";
  let i = 0;
  const step = () => {
    node.textContent = text.slice(0, i);
    i += 1;
    if (i <= text.length) {
      state.typingHandle = setTimeout(step, 22);
    }
  };
  step();
}

function isComplete() {
  return state.userAnswers.every((ans) => ans !== null);
}

function renderNav() {
  const nav = document.getElementById("question-nav");
  if (!nav) return;
  nav.innerHTML = "";
  const allAnswered = isComplete();
  nav.classList.toggle("is-complete", allAnswered);

  questions.forEach((q, idx) => {
    const btn = document.createElement("button");
    btn.className = "round-panel__step mono";
    btn.textContent = q.number;

    const answered = state.userAnswers[idx] !== null;
    const isCurrent = idx === state.currentQuestionIndex;

    if (answered) btn.classList.add("is-answered");
    if (isCurrent && !state.inContinueView) btn.classList.add("is-active");

    btn.addEventListener("click", () => {
      state.currentQuestionIndex = idx;
      render();
    });

    nav.appendChild(btn);
  });
}

function renderAnswers() {
  const answersEl = document.getElementById("answers");
  if (!answersEl) return;
  const question = questions[state.currentQuestionIndex];
  answersEl.innerHTML = "";

  question.answers.forEach((label, idx) => {
    const btn = document.createElement("button");
    btn.className = "round-panel__choice mono";
    btn.textContent = label;
    if (state.userAnswers[state.currentQuestionIndex] === idx) {
      btn.classList.add("is-selected");
    }
    btn.addEventListener("click", () => handleAnswer(idx, btn));
    answersEl.appendChild(btn);
  });
}

function handleAnswer(answerIndex, btn) {
  state.userAnswers[state.currentQuestionIndex] = answerIndex;
  state.inContinueView = isComplete();

  if (btn) {
    btn.classList.add("is-blinking");
    btn.classList.add("is-blinking-fast");
    setTimeout(() => {
      btn.classList.remove("is-blinking");
      btn.classList.remove("is-blinking-fast");
    }, 700);
  }

  if (!state.inContinueView) {
    const nextIndex = state.userAnswers.findIndex((val) => val === null);
    state.currentQuestionIndex = nextIndex === -1 ? state.currentQuestionIndex : nextIndex;
  }

  render();
}

function renderContinueView() {
  const view = document.getElementById("continue-view");
  const btn = document.getElementById("continue-btn");
  if (!view || !btn) return;

  view.classList.toggle("is-hidden", !state.inContinueView);

  btn.classList.toggle("round-panel__submit--ready", state.inContinueView);
  btn.classList.toggle("round-panel__submit--waiting", !state.inContinueView);
  btn.classList.toggle("throb", state.inContinueView);

  btn.onclick = () => {
    state.userAnswers = Array(questions.length).fill(null);
    state.currentQuestionIndex = 0;
    state.inContinueView = false;
    state.flashingAnswerId = null;
    render();
  };
}

function renderQuestion() {
  const question = questions[state.currentQuestionIndex];
  typeQuestion(question.text);
  renderAnswers();
}

function render() {
  renderNav();
  renderQuestion();
  renderContinueView();
}

function initQuestionsPanel() {
  const root = document.getElementById("questions-root");
  if (!root) return;

  root.innerHTML = `
    <div class="view view-questions stage-center">
      <div class="round-panel">
        <h2 class="round-panel__heading mono">QUESTIONS</h2>

        <div id="question-nav" class="round-panel__steps"></div>

        <div id="question-view" class="round-panel__content">
          <div class="round-panel__question mono">
            <span id="question-text" class="round-panel__question-text"></span>
          </div>
          <div id="answers" class="round-panel__choices"></div>
        </div>

        <div id="continue-view" class="round-panel__submit-continue">
          <p class="round-panel__status-note mono continue-text">
            Select number to review answer, or:
          </p>
          <button
            id="continue-btn"
            class="round-panel__submit mono round-panel__submit--waiting"
            type="button"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  `;

  render();
}

function initTicker() {
  const marquee = document.getElementById("ticker-marquee");
  if (!marquee) return;
  const entries = [
    "Retro rehearsal mode — numbers start at 13 for late-round checks.",
    "Answers flash + auto-advance. Continue resets the demo.",
    "ScoreStrip header is live above; code pulled from the hash.",
  ];
  let idx = 0;
  const swap = () => {
    marquee.textContent = entries[idx];
    idx = (idx + 1) % entries.length;
  };
  swap();
  setInterval(swap, 4200);
}

function bootstrap() {
  document.addEventListener("DOMContentLoaded", () => {
    initScoreStrip();
    initTicker();
    initQuestionsPanel();
    window.Questions = Questions;
  });
}

bootstrap();
