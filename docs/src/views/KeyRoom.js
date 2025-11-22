// /src/views/KeyRoom.js
// Host upload & pack assignment flow for KeyRoom.
// • Hosts can upload multi-pack JSON/TXT files, validate, and store packs for future games.
// • Shows live counts of available packs with options to pick Random, Specific, or Placeholder.
// • On start we write chosen pack modes to rooms/{code} and route to the seeding worker.

import {
  ensureAuth,
  db,
  createPackDoc,
  packsQuestionsRef,
  packsMathsRef,
} from "../lib/firebase.js";
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  onSnapshot,
  query,
  where,
  serverTimestamp,
} from "firebase/firestore";
import { clampCode, copyToClipboard, getHashParams, setStoredRole } from "../lib/util.js";
import { BOT_UID, buildStartOptions, parseStartValue } from "../lib/SinglePlayerBot.js";
import { listReadyPacks } from "../lib/localPackStore.js";

const roomRef = (code) => doc(db, "rooms", code);

const PACK_KIND_CONFIG = {
  questions: {
    title: "Questions packs",
    selectLabel: "Questions source",
    randomLabel: "Random from available",
    placeholderLabel: "Use placeholders",
  },
  maths: {
    title: "Maths packs",
    selectLabel: "Maths source",
    randomLabel: "Random from available",
    placeholderLabel: "Use placeholders",
  },
};

function el(tag, attrs = {}, kids = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (value === false || value == null) continue;
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, value);
  }
  (Array.isArray(kids) ? kids : [kids]).forEach((child) =>
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child)
  );
  return node;
}

function sameNormalized(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function cleanText(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : "";
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function parseJsonValue(text) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("File contained no JSON content.");
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    // Attempt to extract the first JSON value for .txt uploads.
    const bounds = findFirstJsonBounds(text);
    if (!bounds) throw err;
    const snippet = text.slice(bounds.start, bounds.end);
    return JSON.parse(snippet);
  }
}

function findFirstJsonBounds(text) {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (start === -1) {
      if (ch === "{" || ch === "[") {
        start = i;
        depth = 1;
        inString = false;
        escape = false;
      }
      continue;
    }
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) {
        return { start, end: i + 1 };
      }
    }
  }
  return null;
}

function tryNormalizeQuestionsPack(candidate) {
  if (!candidate || typeof candidate !== "object") return { detected: false };
  const roundsSource = candidate.rounds || candidate.questions;
  if (!roundsSource) return { detected: false };

  let roundsArray = [];
  if (Array.isArray(roundsSource)) {
    roundsArray = roundsSource.slice();
  } else if (typeof roundsSource === "object") {
    roundsArray = Object.entries(roundsSource).map(([key, value]) => ({ ...value, round: Number(key) }));
  }
  if (!roundsArray.length) return { detected: true, valid: false, reason: "No rounds present." };

  const normalizedRounds = [];
  let totalItems = 0;
  for (let roundNumber = 1; roundNumber <= 5; roundNumber += 1) {
    let roundEntry = roundsArray.find((entry) => Number(entry?.round) === roundNumber);
    if (!roundEntry) roundEntry = roundsArray[roundNumber - 1];
    if (!roundEntry) {
      return {
        detected: true,
        valid: false,
        reason: `Round ${roundNumber} missing.`,
      };
    }
    const rawItems = Array.isArray(roundEntry.items)
      ? roundEntry.items
      : Array.isArray(roundEntry.questions)
      ? roundEntry.questions
      : [];
    if (rawItems.length !== 6) {
      return {
        detected: true,
        valid: false,
        reason: `Round ${roundNumber} must contain exactly 6 questions.`,
      };
    }
    const items = [];
    for (let idx = 0; idx < rawItems.length; idx += 1) {
      const normalized = normalizeQuestionItem(rawItems[idx]);
      if (!normalized) {
        return {
          detected: true,
          valid: false,
          reason: `Invalid question in round ${roundNumber}.`,
        };
      }
      items.push(normalized);
    }
    totalItems += items.length;
    const interludes = Array.isArray(roundEntry.interludes)
      ? roundEntry.interludes
          .map((entry) => cleanText(entry))
          .filter((entry) => entry)
      : null;
    const normalizedRound = { items };
    if (interludes && interludes.length) normalizedRound.interludes = interludes;
    normalizedRounds.push(normalizedRound);
  }

  if (totalItems !== 30) {
    return {
      detected: true,
      valid: false,
      reason: "Questions pack must contain exactly 30 items.",
    };
  }

  const notes = cleanText(candidate.notes);
  const data = { rounds: normalizedRounds };
  if (notes) data.notes = notes;
  return { detected: true, valid: true, data };
}

function normalizeQuestionItem(raw = {}) {
  const question =
    cleanText(raw.question) || cleanText(raw.prompt) || cleanText(raw.text) || cleanText(raw.card);
  const correct =
    cleanText(raw.correct_answer) ||
    cleanText(raw.answer) ||
    cleanText(raw.correct) ||
    cleanText(raw.solution);
  if (!question || !correct) return null;

  const distractorPool = [];
  const pushOption = (value) => {
    const text = cleanText(value);
    if (text && !sameNormalized(text, correct) && !distractorPool.some((entry) => sameNormalized(entry, text))) {
      distractorPool.push(text);
    }
  };

  if (Array.isArray(raw.distractors)) raw.distractors.forEach(pushOption);
  if (Array.isArray(raw.incorrect_answers)) raw.incorrect_answers.forEach(pushOption);
  if (Array.isArray(raw.wrong_answers)) raw.wrong_answers.forEach(pushOption);
  if (Array.isArray(raw.options)) {
    raw.options.forEach((opt) => {
      if (!sameNormalized(opt, correct)) pushOption(opt);
    });
  }
  if (raw.distractors && typeof raw.distractors === "object") {
    [raw.distractors.easy, raw.distractors.medium, raw.distractors.hard].forEach(pushOption);
  }

  const easy = cleanText(raw.distractors?.easy) || distractorPool[0] || `${correct} (wrong)`;
  const medium = cleanText(raw.distractors?.medium) || distractorPool[1] || easy;
  const hard = cleanText(raw.distractors?.hard) || distractorPool[2] || medium;

  const normalized = {
    question,
    correct_answer: correct,
    distractors: {
      easy: easy || `${correct} (wrong)`,
      medium: medium || (easy || `${correct} (wrong)`),
      hard: hard || (medium || easy || `${correct} (wrong)`),
    },
  };

  const subject = cleanText(raw.subject) || cleanText(raw.category) || cleanText(raw.topic);
  if (subject) normalized.subject = subject;
  const difficulty =
    cleanText(raw.difficulty_tier) || cleanText(raw.difficulty) || cleanText(raw.tier) || cleanText(raw.level);
  if (difficulty) normalized.difficulty_tier = difficulty;
  const explainer = cleanText(raw.explanation) || cleanText(raw.note) || cleanText(raw.comment);
  if (explainer) normalized.explanation = explainer;
  const id = cleanText(raw.id) || cleanText(raw.uid);
  if (id) normalized.id = id;

  return normalized;
}

function tryNormalizeMathsPack(candidate) {
  if (!candidate || typeof candidate !== "object") return { detected: false };
  const mathsSource = candidate.maths && typeof candidate.maths === "object" ? candidate.maths : candidate;
  const normalizeTimeline = (source) => {
    const events = Array.isArray(source?.events)
      ? source.events
          .slice(0, 5)
          .map((entry) => ({
            prompt: cleanText(entry?.prompt),
            year: Number.isInteger(entry?.year) ? entry.year : Number(entry?.year),
          }))
      : [];

    if (events.length !== 5) {
      return { ok: false, reason: "Maths pack requires 5 chronological events." };
    }

    let lastYear = 0;
    for (let i = 0; i < events.length; i += 1) {
      const evt = events[i];
      if (!evt.prompt) return { ok: false, reason: `Maths event ${i + 1} missing a prompt.` };
      if (!Number.isInteger(evt.year) || evt.year < 1 || evt.year > 2025) {
        return { ok: false, reason: `Maths event ${i + 1} year must be 1–2025.` };
      }
      if (i > 0 && evt.year < lastYear) {
        return { ok: false, reason: "Maths events must be chronological." };
      }
      lastYear = evt.year;
    }

    const total = events.reduce((sum, evt) => sum + evt.year, 0);
    if (source.total != null && Number(source.total) !== total) {
      return { ok: false, reason: "Maths total must match summed event years." };
    }

    const scoring = source.scoring && typeof source.scoring === "object" ? source.scoring : {};
    const sharpshooterMargin = Number.isInteger(scoring.sharpshooterMargin)
      ? scoring.sharpshooterMargin
      : Math.round(total * 0.02);
    const ballparkMargin = Number.isInteger(scoring.ballparkMargin) ? scoring.ballparkMargin : Math.round(total * 0.05);
    const notes = cleanText(candidate.notes || source.notes);

    const data = {
      maths: {
        title: cleanText(source.title) || "History in Five Dates",
        intro: cleanText(source.intro),
        note: cleanText(source.note),
        events,
        total,
        question: cleanText(source.question) || "Enter the year for each event (1–4 digits).",
        scoring: {
          targetTotal: total,
          sharpshooterMargin,
          ballparkMargin,
          sharpshooterPercent: scoring.sharpshooterPercent || 0.02,
          ballparkPercent: scoring.ballparkPercent || 0.05,
          perfectPoints: scoring.perfectPoints || 5,
          sharpshooterPoints: scoring.sharpshooterPoints || 3,
          ballparkPoints: scoring.ballparkPoints || 2,
          safetyNetPoints: scoring.safetyNetPoints || 1,
        },
        clues: events.map((evt) => evt.prompt),
        reveals: Array.isArray(source.reveals) ? source.reveals.slice(0, 5) : events.map((evt) => evt.prompt),
        answer: total,
      },
    };
    if (notes) data.notes = notes;
    return { ok: true, data };
  };

  const hasMarker = Array.isArray(mathsSource?.events) || Array.isArray(mathsSource?.clues) || Array.isArray(mathsSource?.games);
  if (!hasMarker) return { detected: false };

  if (Array.isArray(mathsSource.games)) {
    const dataList = [];
    for (let i = 0; i < mathsSource.games.length; i += 1) {
      const res = normalizeTimeline(mathsSource.games[i]);
      if (!res.ok) return { detected: true, valid: false, reason: `Game ${i + 1}: ${res.reason}` };
      dataList.push(res.data);
    }
    return { detected: true, valid: true, dataList };
  }

  const single = normalizeTimeline(mathsSource);
  if (!single.ok) return { detected: true, valid: false, reason: single.reason };
  return { detected: true, valid: true, dataList: [single.data] };
}

function extractPacks(value) {
  const packs = [];
  let rejected = 0;

  const visit = (node, trace = "root") => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach((child, idx) => visit(child, `${trace}[${idx}]`));
      return;
    }
    if (typeof node !== "object") return;

    const questions = tryNormalizeQuestionsPack(node);
    if (questions.detected) {
      if (questions.valid) {
        packs.push({ kind: "questions", data: questions.data });
      } else {
        console.warn(`[KeyRoom] Rejected questions pack at ${trace}: ${questions.reason}`);
        rejected += 1;
      }
      return;
    }

    const maths = tryNormalizeMathsPack(node);
    if (maths.detected) {
      if (maths.valid) {
        const bundle = Array.isArray(maths.dataList) ? maths.dataList : maths.data ? [maths.data] : [];
        bundle.forEach((data, idx) => {
          packs.push({ kind: "maths", data, sourceName: maths.dataList?.length > 1 ? `Game ${idx + 1}` : undefined });
        });
      } else {
        console.warn(`[KeyRoom] Rejected maths pack at ${trace}: ${maths.reason}`);
        rejected += 1;
      }
      return;
    }

    Object.entries(node).forEach(([key, child]) => visit(child, `${trace}.${key}`));
  };

  visit(value);
  return { packs, rejected };
}

function formatTimestamp(ts) {
  if (!ts) return "";
  try {
    if (typeof ts.toDate === "function") return ts.toDate().toLocaleString();
    if (typeof ts.toMillis === "function") return new Date(ts.toMillis()).toLocaleString();
    if (typeof ts.seconds === "number") return new Date(ts.seconds * 1000).toLocaleString();
    const numeric = Number(ts);
    if (Number.isFinite(numeric)) return new Date(numeric).toLocaleString();
  } catch (err) {
    console.warn("[keyroom] failed to format timestamp", err);
  }
  return "";
}

function selectionFromValue(value) {
  if (value === "none") return { mode: "none" };
  if (typeof value === "string" && value.startsWith("pack:")) {
    return { mode: "specific", packId: value.slice(5) };
  }
  return { mode: "random" };
}

function buildPackOptionLabel(kind, pack) {
  if (kind === "questions") {
    const source = pack.sourceName || pack.notes || pack.id;
    return `${source || "Questions pack"} (${pack.rounds?.length ? "30 questions" : "unknown"})`;
  }
  const source = pack.sourceName || pack.notes || pack.id;
  const title = pack.maths?.title || "Maths pack";
  const total = Number.isInteger(pack.maths?.total) ? ` · total ${pack.maths.total}` : "";
  return `${source || "Maths pack"} · ${title}${total}`;
}

export default {
  async mount(container) {
    await ensureAuth();

    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty("--ink-h", String(hue));

    const params = getHashParams();
    const hintedCode = clampCode(params.get("code") || "");

    const uploads = [];
    const unsubscribers = [];
    this._cleanup = () => {
      uploads.forEach((input) => {
        try {
          input.value = "";
        } catch (err) {
          console.warn("[keyroom] failed to reset file input", err);
        }
      });
      unsubscribers.forEach((fn) => {
        try {
          fn();
        } catch {}
      });
    };

    container.innerHTML = "";
    const root = el("div", { class: "view view-keyroom" });
    const card = el("div", { class: "card" });
    root.appendChild(card);
    container.appendChild(root);

    const headerRow = el("div", {
      style: "display:flex;justify-content:space-between;align-items:center;gap:10px;",
    });
    headerRow.appendChild(el("h1", { class: "title" }, "Key Room"));
    headerRow.appendChild(
      el(
        "button",
        {
          class: "btn outline",
          type: "button",
          onclick: () => {
            location.hash = "#/lobby";
          },
        },
        "Back"
      )
    );
    card.appendChild(headerRow);

    const intro = el(
      "div",
      { class: "mono", style: "margin-bottom:12px;" },
      "Upload packs or paste JSON, pick your sources, then START to seed Jemima."
    );
    card.appendChild(intro);

    const codeRow = el("div", {
      class: "mono",
      style: "display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap;justify-content:center;",
    });
    const codeInput = el("input", {
      type: "text",
      class: "mono",
      maxlength: "3",
      value: hintedCode || "",
      style: "font-size:18px;padding:6px 10px;border:1px solid rgba(0,0,0,0.2);border-radius:8px;width:120px;text-align:center;",
      oninput: (event) => {
        event.target.value = clampCode(event.target.value);
        reflectStartState();
      },
    });
    const randomBtn = el(
      "button",
      {
        class: "btn outline",
        type: "button",
        onclick: () => {
          codeInput.value = clampCode(generateCode());
          reflectStartState();
        },
      },
      "Random"
    );
    const copyBtn = el(
      "button",
      {
        class: "btn outline",
        type: "button",
        onclick: async () => {
          const code = clampCode(codeInput.value);
          if (!code) return;
          const url = `${location.origin}${location.pathname}#/lobby?code=${code}`;
          const ok = await copyToClipboard(url);
          if (ok) status.textContent = "Join link copied.";
        },
      },
      "Copy link"
    );
    codeRow.appendChild(el("span", { style: "font-weight:700;" }, "Room"));
    codeRow.appendChild(codeInput);
    codeRow.appendChild(randomBtn);
    codeRow.appendChild(copyBtn);
    card.appendChild(codeRow);

    const availabilityBadge = el(
      "div",
      {
        class: "mono small",
        style: "margin-bottom:10px;text-align:center;opacity:0.85;",
      },
      "Questions available: 0 · Maths available: 0"
    );
    card.appendChild(availabilityBadge);

    const status = el("div", { class: "mono", style: "min-height:22px;margin-bottom:10px;" }, "Upload a pack to get started.");
    card.appendChild(status);

    const uploadRow = el("div", {
      style: "display:flex;justify-content:center;gap:12px;align-items:center;margin-bottom:12px;flex-wrap:wrap;",
    });
    const uploadInput = el("input", {
      type: "file",
      accept: ".json,.txt",
      multiple: true,
      style: "display:none;",
    });
    uploads.push(uploadInput);
    uploadInput.addEventListener("change", async (event) => {
      const files = Array.from(event.target.files || []);
      event.target.value = "";
      if (!files.length) return;
      await processUploads(files, status);
    });
    const uploadBtn = el(
      "button",
      {
        class: "btn outline",
        type: "button",
        onclick: () => uploadInput.click(),
      },
      "Upload packs (.json/.txt)"
    );
    uploadRow.appendChild(uploadBtn);
    uploadRow.appendChild(uploadInput);
    card.appendChild(uploadRow);

    const packSections = {};
    const selects = {};
    const remotePackData = { questions: [], maths: [] };
    const localPackData = { questions: [], maths: [] };
    const packData = { questions: [], maths: [] };

    Object.entries(PACK_KIND_CONFIG).forEach(([kind, config]) => {
      const section = el("div", { style: "margin-bottom:18px;" });
      const header = el(
        "div",
        { class: "mono", style: "font-weight:700;margin-bottom:6px;" },
        config.title
      );
      section.appendChild(header);

      const select = el(
        "select",
        {
          class: "mono",
          style: "width:100%;padding:8px;border-radius:8px;border:1px solid rgba(0,0,0,0.2);margin-bottom:6px;",
          onchange: () => {
            reflectStartState();
          },
        }
      );
      selects[kind] = select;
      section.appendChild(select);

      const list = el("div", {
        class: "mono small",
        style: "max-height:180px;overflow:auto;border:1px solid rgba(0,0,0,0.08);border-radius:10px;padding:10px;",
      });
      section.appendChild(list);
      packSections[kind] = { list, select };
      card.appendChild(section);
    });

    const advancedWrap = el("div", { class: "mono", style: "margin-bottom:16px;" });
    const advancedToggle = el(
      "button",
      {
        class: "btn outline",
        type: "button",
        onclick: () => {
          const expanded = advancedWrap.classList.toggle("is-open");
          textarea.style.display = expanded ? "block" : "none";
          applyBtn.style.display = expanded ? "inline-block" : "none";
        },
      },
      "Advanced: paste JSON"
    );
    const textarea = el("textarea", {
      class: "mono",
      placeholder: "Paste JSON that contains question/maths packs…",
      style: "display:none;width:100%;min-height:120px;margin-top:8px;padding:8px;border-radius:8px;border:1px solid rgba(0,0,0,0.2);",
    });
    const applyBtn = el(
      "button",
      {
        class: "btn outline",
        type: "button",
        style: "display:none;margin-top:8px;",
        onclick: async () => {
          const value = textarea.value.trim();
          if (!value) {
            status.textContent = "Paste JSON first.";
            return;
          }
          try {
            const parsed = parseJsonValue(value);
            const { summaryText } = await storePacks(parsed, "Manual paste");
            status.textContent = summaryText;
            textarea.value = "";
            advancedWrap.classList.remove("is-open");
            textarea.style.display = "none";
            applyBtn.style.display = "none";
          } catch (err) {
            console.warn("[keyroom] paste failed", err);
            status.textContent = err?.message || "Failed to parse pasted JSON.";
          }
        },
      },
      "Add packs from JSON"
    );
    advancedWrap.appendChild(advancedToggle);
    advancedWrap.appendChild(textarea);
    advancedWrap.appendChild(applyBtn);
    card.appendChild(advancedWrap);

    const singleStartRow = el("div", {
      style:
        "display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:8px;margin-bottom:10px;margin-top:6px;",
    });
    const singleStartBtn = el(
      "button",
      {
        class: "btn primary",
        type: "button",
        disabled: "",
        onclick: async () => {
          await prepareSinglePlayer();
        },
      },
      "Single-player START"
    );
    const singleStartSelect = el("select", {
      class: "mono",
      style: "min-width:200px;padding:8px;border-radius:8px;border:1px solid rgba(0,0,0,0.2);",
      onchange: () => reflectStartState(),
    });
    buildStartOptions().forEach((opt) => {
      singleStartSelect.appendChild(el("option", { value: opt.value }, opt.label));
    });
    singleStartRow.appendChild(singleStartBtn);
    singleStartRow.appendChild(singleStartSelect);
    card.appendChild(singleStartRow);
    card.appendChild(
      el(
        "div",
        {
          class: "mono small",
          style: "text-align:center;opacity:0.82;margin-top:-4px;margin-bottom:6px;",
        },
        "Jaime is replaced by a bot (50–80% correct)."
      )
    );

    const startBtn = el(
      "button",
      {
        class: "btn primary",
        type: "button",
        disabled: "",
        onclick: async () => {
          await prepareRoom();
        },
      },
      "Start seeding"
    );
    card.appendChild(el("div", { style: "text-align:center;" }, startBtn));

    // Initialise selects with default options.
    Object.entries(selects).forEach(([kind, select]) => {
      populateSelect(kind, select, []);
    });

    const refreshPackData = (kind) => {
      const merged = [...localPackData[kind]];
      remotePackData[kind].forEach((pack) => {
        if (!merged.some((entry) => entry.id === pack.id)) {
          merged.push(pack);
        }
      });
      packData[kind] = merged;
      renderPackList(kind);
      populateSelect(kind, selects[kind], packData[kind]);
      updateAvailability();
      reflectStartState();
    };

    const refreshLocalPacks = () => {
      localPackData.questions = listReadyPacks("questions");
      localPackData.maths = listReadyPacks("maths");
      refreshPackData("questions");
      refreshPackData("maths");
    };

    const attachWatcher = (kind) => {
      try {
        const targetRef = kind === "questions" ? packsQuestionsRef() : packsMathsRef();
        const q = query(targetRef, where("status", "==", "available"));
        const unsubscribe = onSnapshot(
          q,
          (snapshot) => {
            remotePackData[kind] = snapshot.docs
              .map((docSnap) => ({ id: docSnap.id, origin: "remote", ...docSnap.data() }))
              .sort((a, b) => {
                const aTime = a.uploadedAt && typeof a.uploadedAt.toMillis === "function" ? a.uploadedAt.toMillis() : 0;
                const bTime = b.uploadedAt && typeof b.uploadedAt.toMillis === "function" ? b.uploadedAt.toMillis() : 0;
                return bTime - aTime;
              });
            refreshPackData(kind);
          },
          (err) => {
            console.warn("[keyroom] pack watcher failed", kind, err);
          }
        );
        unsubscribers.push(unsubscribe);
      } catch (err) {
        console.warn("[keyroom] skipping remote pack watcher", kind, err);
      }
    };

    refreshLocalPacks();
    attachWatcher("questions");
    attachWatcher("maths");

    reflectStartState();

    const initialCode = hintedCode || generateCode();
    codeInput.value = initialCode;
    reflectStartState();

    async function processUploads(files, statusEl) {
      let totalQuestions = 0;
      let totalMaths = 0;
      let totalRejected = 0;
      statusEl.textContent = "Processing uploads…";
      for (const file of files) {
        try {
          const text = await file.text();
          const parsed = parseJsonValue(text);
          const { summaryText, questionsAdded, mathsAdded, rejected } = await storePacks(parsed, file.name);
          statusEl.textContent = summaryText;
          totalQuestions += questionsAdded;
          totalMaths += mathsAdded;
          totalRejected += rejected;
        } catch (err) {
          console.warn("[keyroom] upload failed", file.name, err);
          totalRejected += 1;
          statusEl.textContent = err?.message || `Failed to process ${file.name}.`;
        }
      }
      const summary = buildSummary(totalQuestions, totalMaths, totalRejected);
      statusEl.textContent = summary;
    }

    function buildSummary(qCount, mCount, rejected) {
      return `Added ${qCount} questions packs, ${mCount} maths packs. (${rejected} rejected).`;
    }

    function populateSelect(kind, select, packs) {
      const previous = select.value;
      select.innerHTML = "";
      const config = PACK_KIND_CONFIG[kind];
      select.appendChild(el("option", { value: "random" }, config.randomLabel));
      select.appendChild(el("option", { value: "none" }, config.placeholderLabel));
      packs.forEach((pack) => {
        select.appendChild(
          el(
            "option",
            { value: `pack:${pack.id}` },
            buildPackOptionLabel(kind, pack)
          )
        );
      });
      if ([...select.options].some((opt) => opt.value === previous)) {
        select.value = previous;
      } else if (packs.length) {
        select.value = "random";
      } else {
        select.value = "none";
      }
    }

    function renderPackList(kind) {
      const { list } = packSections[kind];
      list.innerHTML = "";
      const packs = packData[kind];
      if (!packs.length) {
        list.appendChild(el("div", {}, `No ${kind} packs uploaded yet.`));
        return;
      }
      packs.forEach((pack) => {
        const block = el("div", {
          style: "padding:8px 0;border-bottom:1px solid rgba(0,0,0,0.08);",
        });
        const title = pack.sourceName || pack.notes || pack.id;
        block.appendChild(el("div", { style: "font-weight:700;" }, title || `Pack ${pack.id}`));
        const metaLines = [];
        if (kind === "questions") metaLines.push("30 questions");
        if (kind === "maths" && pack.maths?.location) metaLines.push(pack.maths.location);
        const origin = pack.origin === "local" ? "docs/packs/ready" : null;
        const uploaded = formatTimestamp(pack.uploadedAt);
        if (uploaded) metaLines.push(uploaded);
        if (origin) metaLines.push(origin);
        metaLines.push(`ID: ${pack.id}`);
        block.appendChild(el("div", { style: "opacity:0.75;" }, metaLines.join(" · ")));
        if (pack.notes) {
          block.appendChild(el("div", { style: "margin-top:4px;opacity:0.8;" }, pack.notes));
        }
        list.appendChild(block);
      });
    }

    function updateAvailability() {
      const qCount = packData.questions.length;
      const mCount = packData.maths.length;
      availabilityBadge.textContent = `Questions available: ${qCount} · Maths available: ${mCount}`;
    }

    async function storePacks(value, sourceName) {
      const { packs, rejected } = extractPacks(value);
      let questionsAdded = 0;
      let mathsAdded = 0;
      let rejectedCount = rejected;
      for (const entry of packs) {
        try {
          await createPackDoc(entry.kind, entry.data, sourceName);
          if (entry.kind === "questions") questionsAdded += 1;
          else mathsAdded += 1;
        } catch (err) {
          console.warn("[keyroom] failed to store pack", entry.kind, err);
          rejectedCount += 1;
        }
      }
      const summaryText = buildSummary(questionsAdded, mathsAdded, rejectedCount);
      return { summaryText, questionsAdded, mathsAdded, rejected: rejectedCount };
    }

    function reflectStartState() {
      const code = clampCode(codeInput.value);
      const ready = code.length >= 3;
      singleStartBtn.disabled = !ready;
      singleStartBtn.classList.toggle("throb", ready);
      startBtn.disabled = !ready;
      startBtn.classList.toggle("throb", ready);
      if (!ready) {
        status.textContent = "Enter a 3 character code to enable Start.";
        return;
      }
      const qMode = selectionFromValue(selects.questions.value).mode;
      const mMode = selectionFromValue(selects.maths.value).mode;
      if (qMode === "none" && mMode === "none") {
        status.textContent = "Starting with placeholders for questions and maths.";
      } else if (qMode === "none") {
        status.textContent = "Questions will use placeholders; maths will be assigned.";
      } else if (mMode === "none") {
        status.textContent = "Maths will use placeholders; questions will be assigned.";
      } else {
        status.textContent = "Press Start to assign packs.";
      }
    }

    function generateCode() {
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      let out = "";
      for (let i = 0; i < 3; i += 1) {
        const idx = Math.floor(Math.random() * alphabet.length);
        out += alphabet[idx];
      }
      return out;
    }

    async function prepareRoom() {
      const code = clampCode(codeInput.value);
      if (code.length < 3) {
        status.textContent = "Enter a valid room code.";
        return;
      }
      startBtn.disabled = true;
      startBtn.classList.remove("throb");
      status.textContent = "Preparing room…";

      const chosenPacks = {
        questions: selectionFromValue(selects.questions.value),
        maths: selectionFromValue(selects.maths.value),
      };

      try {
        const ref = roomRef(code);
        const snap = await getDoc(ref);
        if (!snap.exists()) {
          await setDoc(ref, {
            state: "seeding",
            round: 1,
            chosenPacks,
            seeds: { progress: 5, message: "Assigning packs…" },
            countdown: { startAt: null },
            links: { guestReady: false },
            timestamps: { createdAt: serverTimestamp(), updatedAt: serverTimestamp() },
          });
        } else {
          await updateDoc(ref, {
            state: "seeding",
            round: 1,
            chosenPacks,
            seeds: { progress: 5, message: "Assigning packs…" },
            "countdown.startAt": null,
            "links.guestReady": false,
            "timestamps.updatedAt": serverTimestamp(),
          });
        }
        setStoredRole(code, "host");
        status.textContent = `Room ${code} primed. Routing to seeding…`;
        location.hash = `#/seeding?code=${code}`;
      } catch (err) {
        console.error("[keyroom] failed to prepare room", err);
        status.textContent = err?.message || "Failed to prepare room.";
        startBtn.disabled = false;
        reflectStartState();
      }
    }

    async function prepareSinglePlayer() {
      const code = clampCode(codeInput.value);
      if (code.length < 3) {
        status.textContent = "Enter a valid room code.";
        return;
      }
      singleStartBtn.disabled = true;
      singleStartBtn.classList.remove("throb");
      startBtn.disabled = true;
      startBtn.classList.remove("throb");
      status.textContent = "Preparing single-player room…";

      const chosenPacks = {
        questions: selectionFromValue(selects.questions.value),
        maths: selectionFromValue(selects.maths.value),
      };

      const { state, round } = parseStartValue(singleStartSelect.value);
      const correctChance = Math.round((Math.random() * 0.3 + 0.5) * 100) / 100;
      const botConfig = {
        enabled: true,
        correctChance,
        startState: state,
        startRound: round,
        guestUid: BOT_UID,
      };

      try {
        const ref = roomRef(code);
        const snap = await getDoc(ref);
        const createPayload = {
          state: "seeding",
          round,
          chosenPacks,
          bot: botConfig,
          seeds: { progress: 5, message: "Assigning packs…" },
          countdown: { startAt: null },
          links: { guestReady: true },
          timestamps: { createdAt: serverTimestamp(), updatedAt: serverTimestamp() },
        };
        const updatePayload = {
          state: "seeding",
          round,
          chosenPacks,
          bot: botConfig,
          seeds: { progress: 5, message: "Assigning packs…" },
          "countdown.startAt": null,
          "links.guestReady": true,
          "timestamps.updatedAt": serverTimestamp(),
        };
        if (!snap.exists()) {
          await setDoc(ref, createPayload);
        } else {
          await updateDoc(ref, updatePayload);
        }
        setStoredRole(code, "host");
        status.textContent = `Room ${code} primed for single-player. Routing to seeding…`;
        location.hash = `#/seeding?code=${code}`;
      } catch (err) {
        console.error("[keyroom] failed to prepare single-player room", err);
        status.textContent = err?.message || "Failed to prepare single-player room.";
        reflectStartState();
      }
    }

    this._storePacks = storePacks;
    this._processUploads = processUploads;
  },

  async unmount() {
    if (typeof this._cleanup === "function") {
      this._cleanup();
    }
    this._cleanup = null;
  },
};
