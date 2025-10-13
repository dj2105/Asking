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
import { SNIPPET_TIE_TOKEN } from "./util.js";

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
            store.data.set(r, { snippet, winnerUid });
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

  const currentSnippetWrap = document.createElement("div");
  currentSnippetWrap.style.cssText = `
    margin-top: 16px;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid rgba(255,255,255,0.35);
    background: rgba(255,255,255,0.12);
    display: none;
  `;
  const currentSnippetTitle = document.createElement("div");
  currentSnippetTitle.className = "mono";
  currentSnippetTitle.style.cssText = "font-weight:700;margin-bottom:6px;";
  currentSnippetTitle.textContent = "Current Snippet";
  const currentSnippetBody = document.createElement("div");
  currentSnippetBody.className = "mono";
  currentSnippetBody.style.cssText = "white-space:pre-wrap;";
  currentSnippetWrap.appendChild(currentSnippetTitle);
  currentSnippetWrap.appendChild(currentSnippetBody);

  const retainedWrap = document.createElement("div");
  retainedWrap.style.cssText = `
    margin-top: 16px;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid rgba(255,255,255,0.35);
    background: rgba(255,255,255,0.1);
    display: none;
  `;
  const retainedTitle = document.createElement("div");
  retainedTitle.className = "mono";
  retainedTitle.style.cssText = "font-weight:700;margin-bottom:6px;";
  retainedTitle.textContent = "Retained Snippets";
  const retainedList = document.createElement("div");
  retainedList.style.cssText = "display:flex;flex-direction:column;gap:4px;";
  retainedWrap.appendChild(retainedTitle);
  retainedWrap.appendChild(retainedList);
  box.appendChild(currentSnippetWrap);
  box.appendChild(retainedWrap);

  container.appendChild(box);

  if (!roomCode || !userUid) {
    retainedWrap.style.display = "none";
    return;
  }

  const currentRoundNum = Number(round) || 0;

  const renderRetained = (dataMap) => {
    const map = dataMap || new Map();
    const currentInfo = map.get(currentRoundNum);
    if (currentInfo && currentInfo.snippet) {
      currentSnippetBody.textContent = currentInfo.snippet;
      currentSnippetWrap.style.display = "block";
    } else {
      currentSnippetBody.textContent = "Awaiting Jemima’s snippet…";
      currentSnippetWrap.style.display = "block";
    }

    const entries = Array.from(map.entries())
      .filter(([roundNum, info]) => {
        if (!info || !info.snippet) return false;
        const rNum = Number(roundNum) || 0;
        if (rNum === currentRoundNum) return false;
        if (info.winnerUid === SNIPPET_TIE_TOKEN) return true;
        return info.winnerUid === userUid;
      })
      .sort((a, b) => Number(b[0]) - Number(a[0]));

    if (!entries.length) {
      retainedList.innerHTML = "";
      retainedWrap.style.display = "none";
      return;
    }

    retainedList.innerHTML = "";
    entries.forEach(([roundNum, info]) => {
      const line = document.createElement("div");
      line.className = "mono";
      line.textContent = `Round ${roundNum} — ${info.snippet}`;
      retainedList.appendChild(line);
    });
    retainedWrap.style.display = "block";

  };

  const store = ensureSnippetStore(roomCode);
  if (!store) {
    retainedWrap.style.display = "none";
    currentSnippetWrap.style.display = "none";
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
