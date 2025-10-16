// /src/views/Final.js
import { ensureAuth, db } from "../lib/firebase.js";
import { doc, onSnapshot, getDoc } from "firebase/firestore";

export default function Final() {
  const root = document.createElement("div");
  root.className = "view view-final";

  const card = document.createElement("div");
  card.className = "card";
  root.appendChild(card);

  const heading = document.createElement("h1");
  heading.className = "title";
  heading.textContent = "Final";
  card.appendChild(heading);

  const summary = document.createElement("div");
  summary.id = "summary";
  summary.innerHTML = '<section class="panel"><p class="status">Loading…</p></section>';
  card.appendChild(summary);

  const code = (localStorage.getItem("lastGameCode") || "").toUpperCase();

  const sum = (arr) => (arr || []).reduce((total, value) => total + (Number(value) || 0), 0);

  function render(seed, hostDoc, guestDoc) {
    if (!seed || !Array.isArray(seed.rounds)) {
      summary.innerHTML = '<section class="panel"><p class="status">Missing pack data.</p></section>';
      return;
    }

    const getRound = (isHost, r) => (isHost ? seed.rounds[r - 1]?.hostQ : seed.rounds[r - 1]?.guestQ) || [];
    const actual = (isHost, docData) => {
      const perRound = [];
      for (let r = 1; r <= 5; r += 1) {
        const qs = getRound(isHost, r);
        const answers = (docData?.answers || {})[`r${r}`];
        let correct = 0;
        if (Array.isArray(qs) && answers) {
          for (const [idx, item] of qs.entries()) {
            const id = item.id || `q${idx + 1}`;
            const mine = answers[id];
            if (mine && mine === item.correct) correct += 1;
          }
        }
        perRound.push(correct);
      }
      return { per: perRound, total: sum(perRound) };
    };

    const hostScore = actual(true, hostDoc);
    const guestScore = actual(false, guestDoc);
    const hostMaths = Number.isInteger(hostDoc?.mathsScore) ? hostDoc.mathsScore : 0;
    const guestMaths = Number.isInteger(guestDoc?.mathsScore) ? guestDoc.mathsScore : 0;

    const totalDaniel = hostScore.total + hostMaths;
    const totalJaime = guestScore.total + guestMaths;
    const winner = totalDaniel > totalJaime ? "Daniel" : totalJaime > totalDaniel ? "Jaime" : "Tie";
    const banner = winner === "Tie" ? "Tie" : `${winner} wins`;

    summary.innerHTML = `
      <section class="panel final-panel">
        <h3>${banner.toUpperCase()}</h3>
        <p class="status">Daniel ${totalDaniel} · Jaime ${totalJaime}</p>
      </section>
    `;
  }

  (async () => {
    await ensureAuth();
    const roomRef = doc(db, "rooms", code);
    onSnapshot(roomRef, async (snap) => {
      if (!snap.exists()) return;
      const data = snap.data() || {};
      if (data.state !== "final") {
        summary.innerHTML = '<section class="panel"><p class="status">Waiting…</p></section>';
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
