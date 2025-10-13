// /src/lib/MathsPane.js
//
// Jemima’s Maths Pane — pinned, inverted info box shown in Questions, Marking, Interlude, etc.
// - Always renders consistently (bottom, fixed height, inverted scheme)
// - Shows one of the 4 beats for the current round, or both questions during maths round
// - Mirrors retained snippets (when a player wins the speed bonus) beneath the usual content.
// - Can be mounted via:
//     import MathsPane from "../lib/MathsPane.js";
//     MathsPane.mount(container, { maths, round, mode:"inline", roomCode, userUid });
//
// CSS colours rely on --ink and --paper variables set by each view.

import { db } from "./firebase.js";
import { doc, collection, onSnapshot } from "firebase/firestore";

const roundSubColRef = (code) => collection(doc(db, "rooms", code), "rounds");

const watcherMap = new WeakMap();
const snippetStores = new Map();

function ensureSnippetStore(code) {
  const key = String(code || "").trim().toUpperCase();
  if (!key) return null;
  if (snippetStores.has(key)) return snippetStores.get(key);

  const store = {
    key,
    data: new Map(),
    listeners: new Set(),
    unsubs: []
  };
  snippetStores.set(key, store);

  (async () => {
    try {
      for (let r = 1; r <= 5; r += 1) {
        const ref = doc(roundSubColRef(key), String(r));
        const stop = onSnapshot(ref, (snap) => {
          if (!snap.exists()) {
            store.data.set(r, { snippet: "", winnerUid: null });
          } else {
            const data = snap.data() || {};
            const snippet = (data.snippet || data.interlude || "").toString();
            const winnerUid = data.snippetWinnerUid || null;
            const tie = Boolean(data.snippetTie);
            store.data.set(r, { snippet, winnerUid, tie });
          }
          store.listeners.forEach((fn) => {
            try { fn(store.data); } catch (err) { console.warn("[maths-pane] listener error:", err); }
          });
        }, (err) => {
          console.warn("[maths-pane] snippet watch error:", err);
        });
        store.unsubs.push(stop);
      }
    } catch (err) {
      console.warn("[maths-pane] init failed:", err);
    }
  })();

  return store;
}

export function mount(container, { maths, round = 1, mode = "inline", roomCode, userUid } = {}) {
  if (!container) return;

  const prevCleanup = watcherMap.get(container);
  if (typeof prevCleanup === "function") {
    try { prevCleanup(); } catch {}
  }
  watcherMap.delete(container);

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
    max-height: 160px;
  `;

  const core = document.createElement("div");

  if (!maths) {
    core.innerHTML = "<i>Jemima is thinking about her sums…</i>";
  } else {
    const { location, beats = [], questions = [] } = maths;
    const r = Number(round);

    if (mode === "maths") {
      const parts = [];
      parts.push(`<b>Location:</b> ${location || "somewhere"}`);
      for (let i = 0; i < questions.length; i += 1) {
        const q = questions[i] || "";
        parts.push(`Q${i + 1}: ${q}`);
      }
      core.innerHTML = parts.join("<br>");
    } else {
      const beatIndex = beats.length ? (r - 1) % beats.length : 0;
      const beat = beats[beatIndex] || "";
      core.innerHTML = `<b>Jemima’s Maths:</b> ${beat}`;
    }
  }

  box.appendChild(core);

  const snippetWrap = document.createElement("div");
  snippetWrap.style.cssText = `
    margin-top: 16px;
    padding: 12px 14px;
    border-radius: 10px;
    border: 1px solid rgba(255,255,255,0.35);
    background: rgba(255,255,255,0.1);
    display: none;
  `;
  const currentTitle = document.createElement("div");
  currentTitle.className = "mono";
  currentTitle.style.cssText = "font-weight:700;margin-bottom:6px;";
  currentTitle.textContent = "Current Maths Snippet";
  const currentLine = document.createElement("div");
  currentLine.className = "mono";
  currentLine.style.cssText = "margin-bottom:10px;white-space:pre-wrap;";
  const retainedTitle = document.createElement("div");
  retainedTitle.className = "mono";
  retainedTitle.style.cssText = "font-weight:700;margin-bottom:6px;display:none;";
  retainedTitle.textContent = "Previous Wins";
  const retainedList = document.createElement("div");
  retainedList.style.cssText = "display:flex;flex-direction:column;gap:4px;";
  snippetWrap.appendChild(currentTitle);
  snippetWrap.appendChild(currentLine);
  snippetWrap.appendChild(retainedTitle);
  snippetWrap.appendChild(retainedList);
  box.appendChild(snippetWrap);

  container.appendChild(box);

  if (!roomCode || !userUid) {
    snippetWrap.style.display = "none";
    return;
  }

  const renderRetained = (dataMap) => {
    const map = dataMap || new Map();
    const infoCurrent = map.get(round) || {};
    const currentSnippet = (infoCurrent && infoCurrent.snippet) || "";
    if (currentSnippet) {
      currentTitle.style.display = "block";
      currentLine.textContent = currentSnippet;
      snippetWrap.style.display = "block";
    } else {
      currentTitle.style.display = "none";
      currentLine.textContent = "";
    }

    const entries = Array.from(map.entries())
      .filter(([r]) => Number(r) !== Number(round))
      .filter(([, info]) => info && info.snippet && (info.tie || info.winnerUid === userUid))
      .sort((a, b) => Number(b[0]) - Number(a[0]));

    if (!entries.length) {
      retainedList.innerHTML = "";
      retainedTitle.style.display = "none";
      if (!currentSnippet) {
        snippetWrap.style.display = "none";
      }
      return;
    }

    retainedList.innerHTML = "";
    entries.forEach(([roundNum, info]) => {
      const line = document.createElement("div");
      line.className = "mono";
      line.textContent = `Round ${roundNum} — ${info.snippet}`;
      retainedList.appendChild(line);
    });
    retainedTitle.style.display = "block";
    snippetWrap.style.display = "block";
  };

  const store = ensureSnippetStore(roomCode);
  if (!store) {
    snippetWrap.style.display = "none";
    return;
  }

  const listener = (data) => {
    renderRetained(data || store.data);
  };
  store.listeners.add(listener);
  listener(store.data);

  watcherMap.set(container, () => {
    store.listeners.delete(listener);
  });
}

export default { mount };
