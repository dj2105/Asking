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

function extractSnippetText(raw) {
  if (!raw) return "";
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => extractSnippetText(entry))
      .filter((part) => part && part.trim())
      .join(" ")
      .trim();
  }
  if (typeof raw === "object") {
    if (typeof raw.text === "string") return raw.text;
    if (typeof raw.snippet === "string") return raw.snippet;
    if (typeof raw.value === "string") return raw.value;
    if (raw.current) return extractSnippetText(raw.current);
    if (Array.isArray(raw.lines)) {
      return raw.lines
        .map((entry) => extractSnippetText(entry))
        .filter((part) => part && part.trim())
        .join("\n")
        .trim();
    }
  }
  return String(raw || "");
}

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
            const snippet = extractSnippetText(data.snippet ?? data.interlude ?? "");
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
    padding: 18px 20px;
    border-radius: 14px;
    margin-top: 24px;
    text-align: left;
    font-family: Courier, monospace;
    font-size: 0.95em;
    line-height: 1.45;
    max-width: 460px;
    margin-left: auto;
    margin-right: auto;
  `;

  const heading = document.createElement("div");
  heading.className = "mono";
  heading.textContent = "Jemima's List";
  heading.style.cssText = `
    font-weight: 700;
    letter-spacing: 0.02em;
    font-size: 1.05em;
    margin-bottom: 14px;
  `;
  box.appendChild(heading);

  const list = document.createElement("ul");
  list.className = "jemima-list mono";
  list.style.cssText = `
    margin: 0;
    padding: 0;
  `;
  box.appendChild(list);

  const setListItems = (items) => {
    list.innerHTML = "";

    if (!items.length) {
      const empty = document.createElement("li");
      empty.style.cssText = `
        list-style-type: none;
        margin: 0;
        padding: 0;
      `;
      const span = document.createElement("span");
      span.style.cssText = `
        display: block;
        opacity: 0.75;
        font-style: italic;
      `;
      span.textContent = "Jemima is thinking about her sums…";
      empty.appendChild(span);
      list.appendChild(empty);
      return;
    }

    items.forEach(({ text, highlight }, index) => {
      if (!text) return;
      const li = document.createElement("li");
      li.style.cssText = `
        margin: 0;
        padding: 0;
        list-style-type: disc;
        list-style-position: inside;
      `;
      if (index !== items.length - 1) {
        li.style.marginBottom = "10px";
      }
      const span = document.createElement("span");
      span.style.cssText = `
        display: block;
        padding: 8px 12px;
        border-radius: 10px;
        background: ${highlight ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.1)"};
        white-space: pre-wrap;
        line-height: 1.45;
      `;
      span.textContent = text;
      span.style.fontWeight = highlight ? "700" : "400";
      li.appendChild(span);
      list.appendChild(li);
    });
  };

  container.appendChild(box);

  const hasMaths = Boolean(maths);
  const baseMathsItems = [];
  let baseCurrentSnippet = "";

  if (hasMaths) {
    const { location, beats = [], questions = [] } = maths;
    const r = Number(round);
    if (mode === "maths") {
      const locationText = location ? `Location: ${location}` : "";
      if (locationText) baseMathsItems.push(locationText);
      questions.forEach((q, idx) => {
        const text = (q || "").toString().trim();
        if (!text) return;
        baseMathsItems.push(`Q${idx + 1}: ${text}`);
      });
    } else {
      const beatIndex = beats.length ? (r - 1) % beats.length : 0;
      baseCurrentSnippet = (beats[beatIndex] || "").toString().trim();
    }
  }

  const refreshList = (overrideCurrentText = null, extraSnippets = []) => {
    if (!hasMaths) {
      setListItems([]);
      return;
    }

    const items = [];
    if (mode === "maths") {
      baseMathsItems.forEach((text) => {
        const trimmed = (text || "").toString().trim();
        if (!trimmed) return;
        items.push({ text: trimmed, highlight: false });
      });
    } else {
      const chosen = ((overrideCurrentText || "").toString().trim()) || baseCurrentSnippet;
      if (chosen) {
        items.push({ text: chosen, highlight: true });
      }
    }

    extraSnippets.forEach((text) => {
      const trimmed = (text || "").toString().trim();
      if (!trimmed) return;
      items.push({ text: trimmed, highlight: false });
    });

    setListItems(items);
  };

  refreshList();

  if (!roomCode || !userUid) {
    return;
  }

  const renderRetained = (dataMap) => {
    const map = dataMap instanceof Map
      ? dataMap
      : new Map(Object.entries(dataMap || {}));

    let currentOverride = null;
    if (mode !== "maths") {
      const infoCurrent = map.get(round) || {};
      currentOverride = ((infoCurrent && infoCurrent.snippet) || "").toString().trim() || null;
    }

    const extraSnippets = [];
    const entries = Array.from(map.entries())
      .filter(([r]) => Number(r) !== Number(round))
      .filter(([, info]) => info && info.snippet && (info.tie || info.winnerUid === userUid))
      .sort((a, b) => Number(b[0]) - Number(a[0]));

    entries.forEach(([, info]) => {
      const snippetText = (info?.snippet || "").toString().trim();
      if (!snippetText) return;
      extraSnippets.push(snippetText);
    });

    refreshList(currentOverride, extraSnippets);
  };

  const store = ensureSnippetStore(roomCode);
  if (!store) {
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
