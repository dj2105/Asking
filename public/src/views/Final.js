// /src/views/Final.js
import { ensureAuth, db } from "../lib/firebase.js";
import { doc, onSnapshot, getDoc } from "firebase/firestore";

export default function Final() {
  const root = document.createElement("div");
  root.className = "view view-final";

  const card = document.createElement("div");
  card.className = "card final-card";
  card.innerHTML = `
    <div class="card-eyebrow mono">Final tally</div>
    <div id="final-summary" class="final-summary">
      <div class="card-title final-title">Jemima’s verdict</div>
      <div class="status-line final-status">Loading…</div>
    </div>
    <div class="card-actions">
      <button type="button" class="btn outline" id="final-lobby">Back to lobby</button>
    </div>
  `;
  root.appendChild(card);

  const $ = (sel) => root.querySelector(sel);

  const code = (localStorage.getItem("lastGameCode") || "").toUpperCase();

  const lobbyBtn = $("#final-lobby");
  if (lobbyBtn) {
    lobbyBtn.addEventListener("click", () => {
      location.hash = "#/lobby";
    });
  }

  function sum(list) {
    return (list || []).reduce((total, value) => total + (Number(value) || 0), 0);
  }

  function render(seed, hostDoc, guestDoc) {
    const container = $("#final-summary");
    if (!container) return;

    if (!seed || !Array.isArray(seed.rounds)) {
      container.innerHTML = `<div class="status-line final-status">Waiting…</div>`;
      return;
    }

    const hostPlayer = hostDoc || {};
    const guestPlayer = guestDoc || {};

    const rounds = seed.rounds || [];
    const getRound = (forHost, idx) => {
      const entry = rounds[idx - 1] || {};
      return forHost ? entry.hostQ || [] : entry.guestQ || [];
    };

    const computeTotal = (forHost, docData) => {
      const perRound = [];
      for (let round = 1; round <= 5; round += 1) {
        const questions = getRound(forHost, round);
        const answers = (docData?.answers || {})[`r${round}`];
        let correct = 0;
        if (Array.isArray(questions) && answers) {
          questions.forEach((question, idx) => {
            const answerId = question?.id || `q${idx + 1}`;
            if (answers[answerId] && answers[answerId] === question?.correct) {
              correct += 1;
            }
          });
        }
        perRound.push(correct);
      }
      return { perRound, total: sum(perRound) };
    };

    const hostTotals = computeTotal(true, hostPlayer);
    const guestTotals = computeTotal(false, guestPlayer);
    const hostMaths = Number.isInteger(hostPlayer?.mathsScore) ? hostPlayer.mathsScore : 0;
    const guestMaths = Number.isInteger(guestPlayer?.mathsScore) ? guestPlayer.mathsScore : 0;

    const danielTotal = hostTotals.total + hostMaths;
    const jaimeTotal = guestTotals.total + guestMaths;
    const leader = danielTotal > jaimeTotal ? "Daniel" : jaimeTotal > danielTotal ? "Jaime" : "Tie";

    const headline = leader === "Tie" ? "Daniel & Jaime tie" : `${leader} wins`;

    container.innerHTML = `
      <div class="card-title final-title">${headline}</div>
      <div class="final-score">Daniel ${danielTotal} · Jaime ${jaimeTotal}</div>
    `;
  }

  (async () => {
    await ensureAuth();
    if (!code) {
      const summary = $("#final-summary");
      if (summary) {
        summary.innerHTML = `
          <div class="card-eyebrow mono">Final tally</div>
          <div class="status-line final-status">No recent room.</div>
        `;
      }
      return;
    }

    const roomRef = doc(db, "rooms", code);
    onSnapshot(roomRef, async (snap) => {
      if (!snap.exists()) return;
      const data = snap.data() || {};
      if (data.state !== "final") {
        const summary = $("#final-summary");
        if (summary) summary.innerHTML = `<div class="status-line final-status">Waiting…</div>`;
        return;
      }

      const seed = data.seed || (await getDoc(roomRef).then((s) => s.data()?.seed).catch(() => null));
      const [hostSnap, guestSnap] = await Promise.all([
        getDoc(doc(db, "rooms", code, "players", "host")),
        getDoc(doc(db, "rooms", code, "players", "guest")),
      ]);
      render(seed, hostSnap.exists() ? hostSnap.data() : {}, guestSnap.exists() ? guestSnap.data() : {});
    });
  })();

  return root;
}
