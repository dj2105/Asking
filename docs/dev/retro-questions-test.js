// Standalone retro questions harness for dev

const ROOM_CODE = "DE1";

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
    text: "Which 80s computer had the BASIC command RUN to start cassette-loaded programs?",
    answers: ["Commodore 64", "Apple IIc", "ZX Spectrum", "Amiga 500"],
  },
];

const state = {
  currentQuestionIndex: 0,
  userAnswers: Array(questions.length).fill(null),
  inContinueView: false,
  typingHandle: 0,
};

function initScoreStrip() {
  const scoreRoot = document.getElementById("score-strip-root");
  if (!scoreRoot) return;

  const code = ROOM_CODE;

  scoreRoot.innerHTML = `
    <div class="score-strip-dev">
      <div class="cell code">
        <span class="label">CODE</span>
        <span class="value">${code}</span>
      </div>
      <div class="cell round">
        <span class="label">ROUND</span>
        <span class="value">1</span>
      </div>
      <div class="cell score">
        <span class="player">
          <span class="name">DANIEL</span>
          <span class="value">07</span>
        </span>
        <span class="player">
          <span class="name">JAIME</span>
          <span class="value">09</span>
        </span>
      </div>
    </div>
  `;
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
    if (i <= text.length && !state.inContinueView) {
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
  nav.classList.toggle("hide-triangles", state.inContinueView);

  questions.forEach((q, idx) => {
    const btn = document.createElement("button");
    btn.className = "qn-btn";
    btn.textContent = q.number;

    const answered = state.userAnswers[idx] !== null;
    const isCurrent = idx === state.currentQuestionIndex;

    if (allAnswered) {
      btn.classList.add("final");
    } else if (answered) {
      btn.classList.add("answered");
    }

    if (isCurrent && !state.inContinueView) {
      btn.classList.add("with-triangle");
      btn.classList.add(allAnswered ? "final" : "current");
    }

    btn.addEventListener("click", () => {
      state.currentQuestionIndex = idx;
      state.inContinueView = isComplete();
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

  // Only show two answers (correct + one distractor in real data)
  const choices = (question.answers || []).slice(0, 2);

  choices.forEach((label, idx) => {
    const btn = document.createElement("button");
    btn.className = "answer-btn";
    btn.textContent = label;
    if (state.userAnswers[state.currentQuestionIndex] === idx) {
      btn.classList.add("selected");
    }
    btn.addEventListener("click", () => handleAnswer(idx, btn));
    answersEl.appendChild(btn);
  });
}

function handleAnswer(answerIndex, btn) {
  state.userAnswers[state.currentQuestionIndex] = answerIndex;
  const complete = isComplete();
  state.inContinueView = complete;

  if (btn) {
    btn.classList.add("flash");
    setTimeout(() => {
      btn.classList.remove("flash");
    }, 350);
  }

  if (!complete) {
    const nextIndex = state.userAnswers.findIndex((val) => val === null);
    if (nextIndex !== -1) {
      state.currentQuestionIndex = nextIndex;
    }
  }

  render();
}

function renderContinueView() {
  const view = document.getElementById("continue-view");
  const btn = document.getElementById("continue-btn");
  const qView = document.getElementById("question-view");
  if (!view || !btn || !qView) return;

  const active = state.inContinueView;

  view.classList.toggle("active", active);
  qView.style.display = active ? "none" : "block";

  btn.onclick = () => {
    state.userAnswers = Array(questions.length).fill(null);
    state.currentQuestionIndex = 0;
    state.inContinueView = false;
    render();
  };
}

function renderQuestion() {
  if (state.inContinueView) return;
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
    <div class="panel">
      <div class="panel-title">QUESTIONS</div>

      <div id="question-nav" class="question-nav"></div>

      <div id="question-view">
        <p id="question-text" class="question-text"></p>
        <div id="answers" class="answers"></div>
      </div>

      <div id="continue-view" class="continue-view">
        <p class="continue-text">
          Select a number to review<br />
          then press CONTINUE
        </p>
        <button id="continue-btn" class="continue-btn" type="button">
          CONTINUE
        </button>
      </div>
    </div>
  `;

  render();
}

function initTicker() {
  const marquee = document.getElementById("ticker-marquee");
  if (!marquee) return;
  const entries = [
    "Retro rehearsal mode — questions 13 to 15.",
    "Answers flash pink + auto-advance.",
    "Continue appears only after all three answers are selected.",
  ];
  marquee.textContent = entries.join("   •   ");
}

function bootstrap() {
  document.addEventListener("DOMContentLoaded", () => {
    initScoreStrip();
    initTicker();
    initQuestionsPanel();
  });
}

bootstrap();
