// /src/views/Final.js
//
// Final summary — aggregates per-round scores and maths outcome.
// • Shows round-by-round question totals.
// • Displays maths answers, deltas, and awarded points.
// • Highlights the overall winner (question totals + maths points).
// • Offers a button to return to the lobby.

import { ensureAuth, db } from "../lib/firebase.js";
import { doc, onSnapshot } from "firebase/firestore";

import { clampCode, getHashParams } from "../lib/util.js";

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
  return `${num}`;
}

function computeTotals(scores = {}, mathsAnswers = {}) {
  const hostRounds = scores.host || {};
  const guestRounds = scores.guest || {};
  let hostQuestions = 0;
  let guestQuestions = 0;
  for (let r = 1; r <= 5; r += 1) {
    hostQuestions += Number(hostRounds[r] || 0);
    guestQuestions += Number(guestRounds[r] || 0);
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

function renderRoundTable(table, scores) {
  const hostRounds = scores.host || {};
  const guestRounds = scores.guest || {};
  table.innerHTML = "";
  for (let r = 1; r <= 5; r += 1) {
    const row = el("tr", {}, [
      el("td", { class: "mono" }, `Round ${r}`),
      el("td", { class: "mono" }, formatPoints(hostRounds[r])),
      el("td", { class: "mono" }, formatPoints(guestRounds[r])),
    ]);
    table.appendChild(row);
  }
}

function renderMaths(mathSection, maths = {}, mathsAnswers = {}) {
  const question = maths.question || "Jemima’s final question";
  const correct = Number.isFinite(Number(maths.answer)) ? Number(maths.answer) : null;
  const host = mathsAnswers.host || {};
  const guest = mathsAnswers.guest || {};
  mathSection.innerHTML = "";
  mathSection.appendChild(el("div", { class: "mono final-maths__question" }, question));
  if (Number.isFinite(correct)) {
    mathSection.appendChild(el("div", { class: "mono final-maths__answer" }, `Correct answer: ${correct}`));
  }
  const table = el("table", { class: "final-maths__table" });
  table.appendChild(el("thead", {}, el("tr", {}, [
    el("th", { class: "mono" }, "Player"),
    el("th", { class: "mono" }, "Answer"),
    el("th", { class: "mono" }, "Δ"),
    el("th", { class: "mono" }, "Points"),
  ])));
  const tbody = el("tbody");
  tbody.appendChild(el("tr", {}, [
    el("td", { class: "mono" }, "Daniel"),
    el("td", { class: "mono" }, formatPoints(host.value)),
    el("td", { class: "mono" }, formatDelta(host.delta)),
    el("td", { class: "mono" }, formatPoints(host.points)),
  ]));
  tbody.appendChild(el("tr", {}, [
    el("td", { class: "mono" }, "Jaime"),
    el("td", { class: "mono" }, formatPoints(guest.value)),
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

    container.innerHTML = "";
    const root = el("div", { class: "view view-final" });
    const card = el("div", { class: "card final-card" });
    const heading = el("h1", { class: "title" }, "Jemima’s Maths — Final Results");
    const winnerBanner = el("div", { class: "mono final-winner" }, "");

    const totalsSummary = el("div", { class: "final-summary" });
    const questionsTable = el("table", { class: "final-round-table" });
    questionsTable.appendChild(el("thead", {}, el("tr", {}, [
      el("th", { class: "mono" }, "Round"),
      el("th", { class: "mono" }, "Daniel"),
      el("th", { class: "mono" }, "Jaime"),
    ])));
    const questionsBody = el("tbody");
    questionsTable.appendChild(questionsBody);

    const mathsSection = el("div", { class: "final-maths" });

    const totalsList = el("ul", { class: "final-totals mono" }, [
      el("li", {}, "Daniel — Questions: 0, Maths: 0, Total: 0"),
      el("li", {}, "Jaime — Questions: 0, Maths: 0, Total: 0"),
    ]);

    const backBtn = el("button", {
      class: "btn",
      onclick: () => { window.location.hash = "#/lobby"; },
    }, "RETURN TO LOBBY");

    card.appendChild(heading);
    card.appendChild(winnerBanner);
    card.appendChild(el("h2", { class: "mono section-heading" }, "Question rounds"));
    card.appendChild(questionsTable);
    card.appendChild(el("h2", { class: "mono section-heading" }, "Maths challenge"));
    card.appendChild(mathsSection);
    card.appendChild(el("h2", { class: "mono section-heading" }, "Totals"));
    card.appendChild(totalsSummary);
    totalsSummary.appendChild(totalsList);
    card.appendChild(backBtn);

    root.appendChild(card);
    container.appendChild(root);

    const updateView = (roomData = {}) => {
      const scores = roomData.scores || {};
      const maths = roomData.maths || {};
      const mathsAnswers = roomData.mathsAnswers || {};
      const totals = computeTotals(scores, mathsAnswers);
      winnerBanner.textContent = winnerLabel(totals);
      renderRoundTable(questionsBody, scores);
      renderMaths(mathsSection, maths, mathsAnswers);
      totalsList.innerHTML = "";
      totalsList.appendChild(el("li", {}, `Daniel — Questions: ${totals.hostQuestions}, Maths: ${totals.hostMaths}, Total: ${totals.hostTotal}`));
      totalsList.appendChild(el("li", {}, `Jaime — Questions: ${totals.guestQuestions}, Maths: ${totals.guestMaths}, Total: ${totals.guestTotal}`));
    };

    this._stop = onSnapshot(roomRef(code), (snap) => {
      if (!snap.exists()) return;
      updateView(snap.data() || {});
    }, (err) => {
      console.warn("[final] snapshot error:", err);
    });
  },

  async unmount() {
    if (this._stop) {
      try { this._stop(); } catch {}
      this._stop = null;
    }
  }
};
