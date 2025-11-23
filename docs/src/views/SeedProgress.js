// /src/views/SeedProgress.js
// Seeding worker view — resolves chosen packs, writes them into Firestore, and archives used packs.

import {
  ensureAuth,
  db,
  pickRandomAvailable,
  movePackToUsed,
  packsQuestionsRef,
  packsMathsRef,
} from "../lib/firebase.js";
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  serverTimestamp,
} from "firebase/firestore";
import { clampCode, getHashParams } from "../lib/util.js";
import { applyStageTheme } from "../lib/theme.js";
import { buildPlaceholderRounds, buildPlaceholderMaths, padItems, clone } from "../lib/placeholders.js";
import { normaliseBotConfig, startHash } from "../lib/SinglePlayerBot.js";
import {
  ensureLocalPackCache,
  findReadyPack,
  pickRandomReady,
  pickRandomPlaceholder,
  markReadyPackUsed,
} from "../lib/localPackStore.js";

const DEFAULT_HOST_UID = "daniel-001";
const DEFAULT_GUEST_UID = "jaime-001";

const roomRef = (code) => doc(db, "rooms", code);
const roundSubColRef = (code) => collection(roomRef(code), "rounds");

function el(tag, attrs = {}, kids = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  (Array.isArray(kids) ? kids : [kids]).forEach((child) =>
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child)
  );
  return node;
}

function logLine(logEl, message) {
  const stamp = new Date().toISOString().split("T")[1].replace(/Z$/, "");
  logEl.textContent += `[${stamp}] ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function selectionFromRoom(value = {}) {
  const mode = typeof value.mode === "string" ? value.mode.toLowerCase() : "random";
  const packId = typeof value.packId === "string" && value.packId.trim() ? value.packId.trim() : null;
  return { mode, packId };
}

function buildRoundsFromPack(pack) {
  const rounds = Array.isArray(pack?.rounds) ? pack.rounds : [];
  if (rounds.length < 5) return null;
  const assembled = [];
  for (let i = 0; i < 5; i += 1) {
    const entry = rounds[i] || rounds.find((round) => Number(round?.round) === i + 1);
    const items = Array.isArray(entry?.items) ? entry.items : [];
    if (items.length !== 6) return null;
    const hostItems = padItems(items.slice(0, 3).map((item) => clone(item)));
    const guestItems = padItems(items.slice(3, 6).map((item) => clone(item)));
    const payload = {
      round: i + 1,
      hostItems,
      guestItems,
    };
    if (Array.isArray(entry?.interludes) && entry.interludes.length) {
      payload.interludes = entry.interludes
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value) => value);
    }
    assembled.push(payload);
  }
  return assembled;
}

function buildClueMap(maths) {
  const map = {};
  if (Array.isArray(maths?.events)) {
    maths.events.forEach((event, idx) => {
      if (typeof event?.prompt === "string" && event.prompt.trim()) {
        map[idx + 1] = event.prompt.trim();
      }
    });
  }
  if (Array.isArray(maths?.clues)) {
    maths.clues.forEach((clue, idx) => {
      if (typeof clue === "string" && clue.trim()) {
        map[idx + 1] = clue.trim();
      }
    });
  }
  return map;
}

function buildRevealMap(maths) {
  const map = {};
  if (Array.isArray(maths?.events)) {
    maths.events.forEach((event, idx) => {
      if (typeof event?.prompt === "string" && event.prompt.trim()) {
        map[idx + 1] = event.prompt.trim();
      }
    });
  }
  if (Array.isArray(maths?.reveals)) {
    maths.reveals.forEach((reveal, idx) => {
      if (typeof reveal === "string" && reveal.trim()) {
        map[idx + 1] = reveal.trim();
      }
    });
  }
  return map;
}

function sanitizeChosenPacks(raw = {}) {
  return {
    questions: selectionFromRoom(raw.questions),
    maths: selectionFromRoom(raw.maths),
  };
}

function cloneMaths(maths) {
  return maths ? JSON.parse(JSON.stringify(maths)) : null;
}

async function fetchSpecificPack(kind, packId) {
  if (!packId) return null;
  try {
    const ref = doc(kind === "questions" ? packsQuestionsRef() : packsMathsRef(), packId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    const data = snap.data();
    if (data?.status && data.status !== "available") return null;
    return { id: snap.id, data };
  } catch (err) {
    console.warn("[seeding] failed to fetch specific pack", kind, packId, err);
    return null;
  }
}

async function resolveQuestionsPack(chosen, logEl, updateSeeds) {
  const selection = { mode: chosen.mode, packId: chosen.packId || null };
  if (selection.mode === "none") {
    logLine(logEl, "Questions pack skipped — using placeholder file.");
    const placeholderPack = pickRandomPlaceholder("questions");
    if (placeholderPack?.data) {
      const roundsFromPack = buildRoundsFromPack(placeholderPack.data);
      if (roundsFromPack) {
        logLine(logEl, `Placeholder questions assigned from ${placeholderPack.id}.`);
        return { rounds: roundsFromPack, selection };
      }
    }
    return { rounds: await buildPlaceholderRounds(), selection };
  }

  if (selection.mode === "specific" && selection.packId) {
    const local = findReadyPack("questions", selection.packId);
    if (local?.data) {
      logLine(logEl, `Loading local questions pack ${selection.packId}…`);
      const rounds = buildRoundsFromPack(local.data);
      if (rounds) {
        markReadyPackUsed("questions", local.id);
        logLine(logEl, `Loaded local questions pack ${selection.packId}.`);
        return { rounds, selection: { ...selection, assignedPackId: local.id }, usedLocalPackId: local.id };
      }
      logLine(logEl, `Local questions pack ${selection.packId} invalid — falling back.`);
    } else {
      logLine(logEl, `Loading questions pack ${selection.packId}…`);
      await updateSeeds("Loading selected questions pack…", 20);
      const fetched = await fetchSpecificPack("questions", selection.packId);
      if (fetched?.data) {
        const rounds = buildRoundsFromPack(fetched.data);
        if (rounds) {
          logLine(logEl, `Loaded questions pack ${selection.packId}.`);
          return {
            rounds,
            selection: { ...selection, assignedPackId: fetched.id },
            usedPackId: fetched.id,
          };
        }
        logLine(logEl, `Questions pack ${selection.packId} invalid — falling back.`);
      } else {
        logLine(logEl, `Questions pack ${selection.packId} not available — falling back.`);
      }
    }
  }

  logLine(logEl, "Selecting random questions pack…");
  await updateSeeds("Selecting random questions pack…", 25);
  const localRandom = pickRandomReady("questions");
  if (localRandom?.data) {
    const rounds = buildRoundsFromPack(localRandom.data);
    if (rounds) {
      markReadyPackUsed("questions", localRandom.id);
      logLine(logEl, `Assigned local questions pack ${localRandom.id}.`);
      return {
        rounds,
        selection: { ...selection, assignedPackId: localRandom.id },
        usedLocalPackId: localRandom.id,
      };
    }
    logLine(logEl, `Local questions pack ${localRandom.id} invalid — checking uploads.`);
  }

  const randomPack = await pickRandomAvailable("questions");
  if (randomPack?.data) {
    const rounds = buildRoundsFromPack(randomPack.data);
    if (rounds) {
      logLine(logEl, `Assigned questions pack ${randomPack.id}.`);
      return {
        rounds,
        selection: { ...selection, assignedPackId: randomPack.id },
        usedPackId: randomPack.id,
      };
    }
    logLine(logEl, `Random questions pack ${randomPack.id} invalid — using placeholders.`);
  } else {
    logLine(logEl, "No questions packs available — using placeholders.");
  }

  const rounds = await buildPlaceholderRounds();
  return {
    rounds,
    selection,
  };
}

async function resolveMathsPack(chosen, logEl, updateSeeds) {
  const selection = { mode: chosen.mode, packId: chosen.packId || null };
  if (selection.mode === "none") {
    logLine(logEl, "Maths pack skipped — using placeholder maths.");
    const placeholder = pickRandomPlaceholder("maths");
    if (placeholder?.data?.maths) {
      return { maths: cloneMaths(placeholder.data.maths), selection };
    }
    return { maths: await buildPlaceholderMaths(), selection };
  }

  if (selection.mode === "specific" && selection.packId) {
    const local = findReadyPack("maths", selection.packId);
    if (local?.data?.maths) {
      logLine(logEl, `Loading local maths pack ${selection.packId}…`);
      markReadyPackUsed("maths", local.id);
      return {
        maths: cloneMaths(local.data.maths),
        selection: { ...selection, assignedPackId: local.id },
        usedLocalPackId: local.id,
      };
    }

    logLine(logEl, `Loading maths pack ${selection.packId}…`);
    await updateSeeds("Loading selected maths pack…", 35);
    const fetched = await fetchSpecificPack("maths", selection.packId);
    if (fetched?.data?.maths) {
      logLine(logEl, `Loaded maths pack ${selection.packId}.`);
      return {
        maths: cloneMaths(fetched.data.maths),
        selection: { ...selection, assignedPackId: fetched.id },
        usedPackId: fetched.id,
      };
    }
    logLine(logEl, `Maths pack ${selection.packId} not available — falling back.`);
  }

  logLine(logEl, "Selecting random maths pack…");
  await updateSeeds("Selecting random maths pack…", 40);
  const localRandom = pickRandomReady("maths");
  if (localRandom?.data?.maths) {
    markReadyPackUsed("maths", localRandom.id);
    logLine(logEl, `Assigned local maths pack ${localRandom.id}.`);
    return {
      maths: cloneMaths(localRandom.data.maths),
      selection: { ...selection, assignedPackId: localRandom.id },
      usedLocalPackId: localRandom.id,
    };
  }

  const randomPack = await pickRandomAvailable("maths");
  if (randomPack?.data?.maths) {
    logLine(logEl, `Assigned maths pack ${randomPack.id}.`);
    return {
      maths: cloneMaths(randomPack.data.maths),
      selection: { ...selection, assignedPackId: randomPack.id },
      usedPackId: randomPack.id,
    };
  }

  logLine(logEl, "No maths packs available — using placeholder maths.");
  return {
    maths: await buildPlaceholderMaths(),
    selection,
  };
}

async function writeRounds(code, rounds) {
  const roundsRef = roundSubColRef(code);
  await Promise.all(
    rounds.map((round) => {
      const payload = {
        round: round.round,
        hostItems: padItems(round.hostItems),
        guestItems: padItems(round.guestItems),
      };
      if (Array.isArray(round.interludes) && round.interludes.length) {
        payload.interludes = round.interludes;
      }
      return setDoc(doc(roundsRef, String(round.round)), payload);
    })
  );
}

export default {
  async mount(container) {
    await ensureAuth();
    await ensureLocalPackCache();

    const params = getHashParams();
    const code = clampCode(params.get("code") || "");

    applyStageTheme("keyroom", 1);

    container.innerHTML = "";
    const root = el("div", { class: "view view-seeding" });
    const card = el("div", { class: "card" });
    root.appendChild(card);
    container.appendChild(root);

    card.appendChild(el("h1", { class: "title" }, "Seeding Jemima"));
    card.appendChild(el("div", { class: "mono", style: "text-align:center;margin-bottom:8px;" }, code ? `Room ${code}` : "Room unknown"));

    const status = el("div", { class: "mono", style: "min-height:20px;margin-bottom:8px;" }, "Preparing…");
    card.appendChild(status);

    const logEl = el("pre", {
      class: "mono small",
      style: "background:rgba(0,0,0,0.05);padding:12px;border-radius:10px;min-height:160px;max-height:240px;overflow:auto;",
    });
    card.appendChild(logEl);

    if (!code) {
      status.textContent = "No room code provided.";
      return;
    }

    const updateSeeds = async (message, progress) => {
      try {
        await updateDoc(roomRef(code), {
          "seeds.message": message,
          "seeds.progress": progress,
          "timestamps.updatedAt": serverTimestamp(),
        });
      } catch (err) {
        console.warn("[seeding] failed to update seeds status", err);
      }
    };

    const updateStatus = (message) => {
      status.textContent = message;
      logLine(logEl, message);
    };

    try {
      updateStatus("Loading room…");
      const ref = roomRef(code);
      let snap = await getDoc(ref);
      if (!snap.exists()) {
        await setDoc(ref, {
          state: "seeding",
          seeds: { progress: 0, message: "Preparing…" },
          timestamps: { createdAt: serverTimestamp(), updatedAt: serverTimestamp() },
        });
        snap = await getDoc(ref);
      }
      const roomData = snap.data() || {};
      const chosen = sanitizeChosenPacks(roomData.chosenPacks);

      await updateSeeds("Resolving packs…", 15);
      const questionsResult = await resolveQuestionsPack(chosen.questions, logEl, updateSeeds);
      const mathsResult = await resolveMathsPack(chosen.maths, logEl, updateSeeds);

      const rounds = questionsResult.rounds || (await buildPlaceholderRounds());
      const maths = mathsResult.maths || (await buildPlaceholderMaths());

      await updateSeeds("Writing questions…", 55);
      await writeRounds(code, rounds);

      const meta = { ...(roomData.meta || {}) };
      if (!meta.hostUid) meta.hostUid = DEFAULT_HOST_UID;
      const botConfig = normaliseBotConfig(roomData.bot);
      if (botConfig.enabled) meta.guestUid = botConfig.guestUid || DEFAULT_GUEST_UID;
      if (!meta.guestUid) meta.guestUid = DEFAULT_GUEST_UID;

      const startState = botConfig.enabled ? botConfig.startState : "coderoom";
      const startRound = botConfig.enabled ? botConfig.startRound : 1;
      const countdownStart = startState === "countdown" ? Date.now() + 3_000 : null;

      const chosenPacks = {
        questions: {
          mode: questionsResult.selection?.mode || chosen.questions.mode,
          packId: chosen.questions.packId || null,
          assignedPackId: questionsResult.selection?.assignedPackId || null,
        },
        maths: {
          mode: mathsResult.selection?.mode || chosen.maths.mode,
          packId: chosen.maths.packId || null,
          assignedPackId: mathsResult.selection?.assignedPackId || null,
        },
      };

      await updateSeeds("Committing room…", 75);
      const baseRoomFields = {
        meta,
        state: startState,
        round: startRound,
        maths,
        clues: buildClueMap(maths),
        reveals: buildRevealMap(maths),
        countdown: { startAt: countdownStart },
        answers: { host: {}, guest: {} },
        submitted: { host: {}, guest: {} },
        marking: { host: {}, guest: {}, startAt: null },
        markingAck: { host: {}, guest: {} },
        award: { startAt: null },
        awardAck: { host: {}, guest: {} },
        scores: { host: {}, guest: {} },
        timings: { host: {}, guest: {} },
        chosenPacks,
        links: { guestReady: botConfig.enabled ? true : false },
        bot: botConfig.enabled ? botConfig : null,
      };

      const createPayload = {
        ...baseRoomFields,
        seeds: { message: "Pack ready.", progress: 95 },
        timestamps: { createdAt: serverTimestamp(), updatedAt: serverTimestamp() },
      };

      const updatePayload = {
        ...baseRoomFields,
        "seeds.message": "Pack ready.",
        "seeds.progress": 95,
        "timestamps.updatedAt": serverTimestamp(),
      };

      if (!snap.exists()) {
        await setDoc(ref, createPayload);
      } else {
        await updateDoc(ref, updatePayload);
      }

      await updateSeeds("Archiving packs…", 96);
      if (questionsResult.usedPackId) {
        const moved = await movePackToUsed("questions", questionsResult.usedPackId, { roomCode: code });
        if (!moved) throw new Error("Failed to archive questions pack.");
      }
      if (questionsResult.usedLocalPackId) {
        logLine(logEl, `Local questions pack ${questionsResult.usedLocalPackId} moved to placeholders.`);
      }
      if (mathsResult.usedPackId) {
        const moved = await movePackToUsed("maths", mathsResult.usedPackId, { roomCode: code });
        if (!moved) throw new Error("Failed to archive maths pack.");
      }
      if (mathsResult.usedLocalPackId) {
        logLine(logEl, `Local maths pack ${mathsResult.usedLocalPackId} moved to placeholders.`);
      }

      await updateSeeds("Pack ready.", 100);
      updateStatus("Seeding complete. Routing to start…");
      const targetHash = startHash(code, botConfig);
      setTimeout(() => {
        location.hash = targetHash;
      }, 600);
    } catch (err) {
      console.error("[seeding] failed", err);
      status.textContent = err?.message || "Seeding failed.";
      logLine(logEl, err?.stack || String(err));
      await updateSeeds("Seeding failed.", 100);
    }
  },

  async unmount() {},
};
