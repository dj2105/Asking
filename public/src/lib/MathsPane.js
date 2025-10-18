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
import { PACK_VERSION_MATHS, PACK_VERSION_MATHS_CHAIN } from "./seedUnsealer.js";
import { isChainMaths, isLegacyMaths } from "./util.js";

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

export function mount(container, { maths, round = 1, mode = "inline", roomCode, userUid, version } = {}) {
  if (!container) return;

  const prevCleanup = watcherMap.get(container);
  if (typeof prevCleanup === "function") {
    try { prevCleanup(); } catch {}
  }
  watcherMap.delete(container);

  container.innerHTML = "";

  const box = document.createElement("div");
  box.className = "jemima-maths-box mono";

  const heading = document.createElement("div");
  heading.className = "mono maths-panel__heading";
  heading.textContent = "Jemima's List";
  box.appendChild(heading);

  const listEl = document.createElement("ul");
  listEl.className = "mono maths-panel__list";
  box.appendChild(listEl);

  const footer = document.createElement("div");
  footer.className = "mono maths-panel__footer";
  footer.textContent = "Location: —";
  box.appendChild(footer);

  let mathsEntries = [];
  let snippetEntries = [];

  const renderEntries = () => {
    listEl.innerHTML = "";
    const combined = [...mathsEntries, ...snippetEntries];
    if (!combined.length) {
      const item = document.createElement("li");
      item.className = "maths-panel__item maths-panel__item--subtle";
      item.textContent = "Maths loading…";
      listEl.appendChild(item);
      return;
    }

    combined.forEach((entry) => {
      const item = document.createElement("li");
      item.className = "maths-panel__item";
      if (entry.bold) item.classList.add("maths-panel__item--bold");
      if (entry.subtle) item.classList.add("maths-panel__item--subtle");
      item.textContent = entry.text;
      listEl.appendChild(item);
    });
  };

  const resolvedRound = () => {
    if (mode === "maths") return 5;
    const numeric = Number(round);
    if (!Number.isInteger(numeric)) return 1;
    return Math.max(1, Math.min(5, numeric));
  };

  const updateFooter = (locationText, resolvedVersion) => {
    const loc = locationText && locationText.trim() ? locationText.trim() : "—";
    let suffix = "";
    if (resolvedVersion === PACK_VERSION_MATHS_CHAIN) suffix = " • chain";
    else if (resolvedVersion === PACK_VERSION_MATHS) suffix = " • legacy";
    else if (resolvedVersion) suffix = ` • ${resolvedVersion}`;
    footer.textContent = `Location: ${loc}${suffix}`;
  };

  const applyMaths = () => {
    if (!maths || typeof maths !== "object") {
      mathsEntries = [{ text: "Maths loading…", subtle: true }];
      updateFooter("", version);
      renderEntries();
      return;
    }

    const beats = Array.isArray(maths.beats) ? maths.beats : [];
    const questions = Array.isArray(maths.questions) ? maths.questions : [];
    const locationText = typeof maths.location === "string" ? maths.location : "";

    let resolvedVersion = String(version || maths.version || "").trim();
    if (resolvedVersion !== PACK_VERSION_MATHS && resolvedVersion !== PACK_VERSION_MATHS_CHAIN) {
      if (isChainMaths(maths)) resolvedVersion = PACK_VERSION_MATHS_CHAIN;
      else if (isLegacyMaths(maths)) resolvedVersion = PACK_VERSION_MATHS;
    }

    mathsEntries = [];

    if (resolvedVersion === PACK_VERSION_MATHS_CHAIN) {
      const idx = Math.max(0, Math.min(beats.length - 1, resolvedRound() - 1));
      const beat = (beats[idx] || "").toString().trim();
      mathsEntries.push({ text: beat || "…", bold: true });
    } else if (resolvedVersion === PACK_VERSION_MATHS) {
      const active = resolvedRound();
      if (active >= 5 || mode === "maths") {
        const first = (questions[0] || "").toString().trim();
        const second = (questions[1] || "").toString().trim();
        mathsEntries.push({ text: first || "Question 1 pending." });
        mathsEntries.push({ text: second || "Question 2 pending." });
      } else {
        const beat = (beats[active - 1] || "").toString().trim();
        mathsEntries.push({ text: beat || "…", bold: true });
      }
    } else {
      mathsEntries.push({ text: "Maths format unsupported.", subtle: true });
    }

    updateFooter(locationText, resolvedVersion);
    renderEntries();
  };

  applyMaths();

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

    snippetEntries = [];

    if (currentSnippet) {
      snippetEntries.push({ text: currentSnippet, bold: true });
    }

    const entries = Array.from(map.entries())
      .filter(([r]) => Number(r) !== Number(round))
      .filter(([, info]) => info && info.snippet && (info.tie || info.winnerUid === userUid))
      .sort((a, b) => Number(b[0]) - Number(a[0]));

    entries.forEach(([, info]) => {
      const snippetText = (info?.snippet || "").toString().trim();
      if (!snippetText) return;
      snippetEntries.push({ text: snippetText, subtle: true });
    });

    renderEntries();
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
