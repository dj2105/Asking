// /src/lib/MathsPane.js
//
// Jemima’s Maths Pane — pinned, inverted info box shown in Questions, Marking, Interlude, etc.
// - Always renders consistently (bottom, fixed height, inverted scheme)
// - Displays retained snippets (when a player wins the speed bonus) as a simple bullet list.
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
    padding: 16px 18px;
    border-radius: 12px;
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
  heading.style.cssText = `
    font-weight: 700;
    font-size: 1.05em;
  `;
  heading.textContent = "Jemima's List";
  box.appendChild(heading);

  const listEl = document.createElement("ul");
  listEl.className = "mono";
  listEl.style.cssText = `
    list-style: disc;
    list-style-position: outside;
    margin: 12px 0 0;
    padding-left: 22px;
  `;
  box.appendChild(listEl);

  let dynamicEntries = [];

  const updateList = () => {
    listEl.innerHTML = "";
    dynamicEntries.forEach((entry, index) => {
      const item = document.createElement("li");
      item.textContent = entry.text;
      if (entry.bold) {
        item.style.fontWeight = "700";
      }
      if (entry.subtle) {
        item.style.opacity = "0.85";
      }
      if (index > 0) {
        item.style.marginTop = "6px";
      }
      listEl.appendChild(item);
    });
  };

  updateList();

  container.appendChild(box);

  if (!roomCode || !userUid) {
    return;
  }

  const renderRetained = (dataMap) => {
    const map = dataMap instanceof Map
      ? dataMap
      : new Map(Object.entries(dataMap || {}));
    const infoCurrent = map.get(round) || {};
    const currentSnippet = ((infoCurrent && infoCurrent.snippet) || "").toString().trim();

    dynamicEntries = [];

    if (currentSnippet) {
      dynamicEntries.push({ text: currentSnippet, bold: true });
    }

    const entries = Array.from(map.entries())
      .filter(([r]) => Number(r) !== Number(round))
      .filter(([, info]) => info && info.snippet && (info.tie || info.winnerUid === userUid))
      .sort((a, b) => Number(b[0]) - Number(a[0]));

    entries.forEach(([, info]) => {
      const snippetText = (info?.snippet || "").toString().trim();
      if (!snippetText) return;
      dynamicEntries.push({ text: snippetText, subtle: true });
    });

    updateList();
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
