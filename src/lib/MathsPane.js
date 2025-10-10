// /src/lib/MathsPane.js
//
// Jemima’s Maths Pane — pinned, inverted info box shown in Questions, Marking, Interlude, etc.
// - Always renders consistently (bottom, fixed height, inverted scheme)
// - Shows one of the 4 beats for the current round, or both questions during maths round
// - Can be mounted via:
//     import MathsPane from "../lib/MathsPane.js";
//     MathsPane.mount(container, { maths, round, mode:"inline" });
//
// CSS colours rely on --ink and --paper variables set by each view.

export function mount(container, { maths, round = 1, mode = "inline" } = {}) {
  if (!container) return;
  container.innerHTML = "";

  const box = document.createElement("div");
  box.className = "jemima-maths-box mono";
  box.style.cssText = `
    background: var(--ink);
    color: var(--paper);
    padding: 12px 16px;
    border-radius: 12px;
    margin-top: 24px;
    text-align: left;
    font-family: Courier, monospace;
    font-size: 0.95em;
    line-height: 1.4;
    max-width: 460px;
    margin-left: auto;
    margin-right: auto;
    overflow-y: auto;
    max-height: 140px;
  `;

  let html = "";

  if (!maths) {
    html = "<i>Jemima is thinking about her sums…</i>";
  } else {
    const { location, beats = [], questions = [], answers = [] } = maths;
    const r = Number(round);

    if (mode === "maths") {
      // final round: show both questions + location summary
      html += `<b>Location:</b> ${location || "somewhere"}<br>`;
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i] || "";
        html += `Q${i + 1}: ${q}<br>`;
      }
    } else {
      // regular round 1–5: show one beat per round
      const beatIndex = (r - 1) % beats.length;
      const beat = beats[beatIndex] || "";
      html = `<b>Jemima’s Maths:</b> ${beat}`;
    }
  }

  box.innerHTML = html;
  container.appendChild(box);
}

export default { mount };
