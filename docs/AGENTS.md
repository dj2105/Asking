AGENTS.md

Project

Jemima’s Asking — Two-player quiz duel
Stack: Vanilla JS (ESM) served from /public, Firebase (Anon Auth + Firestore) + LocalStorage + hand-rolled CSS.
Targets: modern mobile/desktop. Primary test rigs: iPad Safari + Windows 10/11 Chromium.

⸻

North Star
        •       Two players, two devices, fixed roles: Daniel = Host, Jaime = Guest. Roles are claimed once and never overwritten.
        •       Host prepares the room locally (packs + code) and only syncs the moments other screens need: countdowns, awards, final.
        •       Content comes from locally uploaded JSON/TXT packs (questions + maths). No live LLM/API calls during play.

⸻

Source Layout (authoritative)

project-root/
├─ docs/
│  ├─ index.html               # documentation microsite entry point (in-repo preview)
│  ├─ styles.css               # shared styling for documentation pages
│  ├─ src/
│  │  ├─ main.js               # hash router + score strip mounting
│  │  ├─ roomWatcher.js        # central state observer → navigation
│  │  ├─ lib/                  # firebase init, pack ingestion, helpers
│  │  └─ views/                # Lobby, KeyRoom, CodeRoom, Countdown, Questions, Marking, Award, Maths, Final, Rejoin
│  ├─ documents/               # persisted guidance for preview deploy notes
│  ├─ packs/                   # 
│  │  ├─ready
│  │  ├─placeholder
│  └─ ops/                     # operational runbooks and supporting assets
├─ questions.md                # question pack shape
└─ dates.md                    # maths pack shape

Keep new modules under /docs/src/lib or /docs/src/views. Use relative ESM imports.

⸻

Pack ingestion (current Key Room flow)
        •       Upload loose JSON or TXT files; Key Room auto-extracts embedded JSON values and hunts for valid packs.
        •       Questions packs = five rounds, each with six items (first 3 hostItems, last 3 guestItems). Optional interludes per round. Total items must be 30.
        •       Maths packs = timeline games with exactly five chronological events (years 1–2025). Can be a single game or a bundle under games[]. Scoring margins auto-filled when missing.
        •       Multiple packs can live in a single file. Invalid candidates are skipped with console warnings; accepted packs are stored in Firestore collections for reuse.
        •       No .sealed envelopes, no room codes inside pack files, and no legacy checksum/integrity requirements.

⸻

Firestore Contract (rooms/{CODE})
        •       meta.hostUid, meta.guestUid — written during seeding; reused for rejoin.
        •       state — "keyroom" | "coderoom" | "seeding" | "countdown" | "questions" | "marking" | "award" | "maths" | "final".
        •       round — 1…5 for Q&A, stays 5 during maths/final.
        •       countdown.startAt — ms epoch for the next synced hop.
        •       links.guestReady — guest has joined and armed countdown from lobby.
        •       answers.host.{round} / answers.guest.{round} — arrays of { chosen, correct?, questionId? }.
        •       submitted.host.{round} / submitted.guest.{round} — booleans per round.
        •       marking.host.{round} / marking.guest.{round} — arrays of "right"|"wrong"; marking.startAt = ms epoch for timer.
        •       markingAck.host.{round} / markingAck.guest.{round} — booleans acknowledging marking complete.
        •       award.startAt — ms epoch when award began.
        •       awardAck.host.{round} / awardAck.guest.{round} — confirms both saw the award.
        •       scores.{host|guest} — per-round question totals written during award transitions.
        •       maths — maths block from the merged pack.
        •       mathsAnswers.{host|guest} & mathsAnswersAck.{host|guest} — final stage submissions/acks (value/delta/points).
        •       seeds.progress/message — status from pack loading & jump tooling.
        •       timestamps.createdAt, timestamps.updatedAt — serverTimestamp().

Subcollections
        •       rooms/{CODE}/rounds/{N} — hostItems[3], guestItems[3], timings/snippet info as the game progresses.
        •       rooms/{CODE}/players/{uid} — optional extras (e.g., retainedSnippets) written by Key Room jump tooling.

Do not overwrite claimed UIDs. Never mix host/guest items.

⸻

Gameplay Flow (canonical)

1) Key Room (Daniel)
        •       Opens with code picker (manual or Random) and pack dropzones for questions + maths uploads.
        •       Accepts JSON/TXT containing multiple packs; normalizes to rounds/items for questions and timeline events for maths. Live counters show available packs.
        •       Host can choose Random, Specific, or Placeholder sources per pack type. START seeds Firestore with the chosen packs, sets state="coderoom", clears countdown, stores code locally, then routes to Code Room.
        •       Jump & prepare tool can reseed + fast-forward to any phase for rehearsal; exposes host hash and guest link.

2) Code Room (Daniel)
        •       Displays the chosen code and shareable lobby link (copy helper).
        •       Watches room document; when Jaime joins (links.guestReady true) host sees status update.
        •       Auto-navigates with the room state (countdown → questions → …). Back button returns to Key Room and resets state if still idle.

3) Lobby (Jaime)
        •       Card layout with code input (3–5 chars). START throbs when valid.
        •       If room state is coderoom and Jaime joins, lobby arms the countdown (state → countdown, countdown.startAt ≈ now+5s, links.guestReady true) and routes to Countdown.
        •       Otherwise routes to #/watcher?code=CODE (roomWatcher drives navigation). Includes links to Rejoin and Daniel’s entrance.

4) Countdown (sync)
        •       Both players see countdown timer + score strip (Daniel/Jaime labels, Round N). On zero → Questions.

5) Questions (local per role)
        •       Exactly 3 questions for the logged-in role (hostItems vs guestItems). Selecting an option auto-advances; question 3 auto-submits.
        •       MathsPane pinned with the current round clue.
        •       On submit: writes answers + submitted flag, then shows “Waiting for opponent…”.

6) Marking (local, 30s timer)
        •       Each player marks the opponent’s answers via ✓/✕ toggles. Timer enforced via marking.startAt.
        •       Submitting writes marking arrays + ack.

7) Award (sync, 30s timer)
        •       Shows your answers with ✓/✕ result. Score strip recomputes from answers (marking is informational).
        •       On timeout or Continue (both roles) → Countdown for next round; Round increments.

8) Maths (local)
        •       Two integer answers with units prompts. MathsPane stays mounted. Submits mathsAnswers + ack.

9) Final (sync)
        •       Minimal summary + “Return to Lobby” reset.

RoomWatcher + Rejoin
        •       #/watcher?code=CODE binds to room.state and routes safely, debouncing unknown states.
        •       Rejoin view lets either role hop back mid-game (manual route picker or auto from ?step=… params). Stores last room + role in localStorage.

⸻

Score Strip
        •       Mounted automatically on all game routes except lobby/keyroom/coderoom/seeding/final/watchers.
        •       Labels fixed (“Daniel”, “Jaime”). Round value comes from room.round.
        •       Scores = count of correct answers per player across all rounds (derived from answers + round docs). Marking does not change totals.

⸻

Runtime Invariants
        •       Host never sees guestItems in Questions and vice versa.
        •       Claimed UIDs (meta.hostUid / meta.guestUid) are immutable once set.
        •       Local phases ignore remote writes that could change UI state mid-phase (e.g., while answering).
        •       Submits set submitted.{role}.{round} and lock drafts.
        •       Maths answers must be integers; validation is strict.
        •       MathsPane always mounted/inverted; no other dark themes.

⸻

Testing Checklist (Emulator)
        •       Upload a full pack in Key Room → progress log shows load, START seeds → Code Room with shareable link.
        •       Add optional overrides (half/override packs) → log reflects overrides; assembled questions show placeholders where empty.
        •       Jaime joins via Lobby with the chosen code → countdown armed (links.guestReady true) and both devices land on Countdown.
        •       Distinct question sets per role; answer submission auto-locks; third question auto-submits.
        •       Interlude only appears to the player waiting.
        •       Marking timer respects marking.startAt; ✓/✕ writes marking arrays + ack booleans.
        •       Award updates scores via answer correctness only; score strip matches totals.
        •       Maths accepts integers, rejects others, and routes to Final after submit.
        •       Rejoin (manual + auto) lands Daniel/Jaime in the requested round/phase without breaking watchers.

⸻

Style (non-negotiable)
        •       Courier everywhere; titles/answers bold.
        •       Narrow centred column (≈400–450px) with generous breathing room.
        •       No global dark themes; only MathsPane uses inverted palette.
        •       Buttons rounded; actionable primaries throb when ready.

⸻

Safe Agent Tasks
        •       Role isolation audits (Questions/Marking fetch paths, stored role usage).
        •       Score integrity (answers → scores.{host|guest} → ScoreStrip rendering).
        •       Key Room tooling (pack overlay logic, countdown arming, jump paths).
        •       Countdown resilience (client clock drift ±5s).
