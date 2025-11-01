AGENTS.md

Project

Jemima’s Asking — Two-player quiz duel
Stack: Vanilla JS (ESM) served from /public, Firebase (Anon Auth + Firestore) + LocalStorage + hand-rolled CSS.
Targets: modern mobile/desktop. Primary test rigs: iPad Safari + Windows 10/11 Chromium.

⸻

North Star
        •       Two players, two devices, fixed roles: Daniel = Host, Jaime = Guest. Roles are claimed once and never overwritten.
        •       Host prepares the room locally (packs + code) and only syncs the moments other screens need: countdowns, awards, final.
        •       Content comes from sealed packs (full + optional overrides). No live LLM/API calls during play.

⸻

Source Layout (authoritative)

project-root/
├─ public/
│  ├─ index.html               # single entry point; injects firebase config + mounts /src/main.js
│  ├─ styles.css               # Courier-first design system
│  └─ src/
│     ├─ main.js               # hash router + score strip mounting
│     ├─ roomWatcher.js        # central state observer → navigation
│     ├─ lib/
│     │  ├─ firebase.js        # init, anon auth, db helpers
│     │  ├─ seedUnsealer.js    # decrypt/validate sealed packs, seed Firestore
│     │  ├─ ScoreStrip.js      # shared scoreboard overlay
│     │  ├─ MathsPane.js       # pinned inverted maths info box
│     │  └─ util.js            # clampCode, hash params, storage helpers, crypto utils
│     └─ views/
│        ├─ Lobby.js           # guest join & watcher launcher
│        ├─ KeyRoom.js         # host prep: load packs, pick/share code, stage rooms
│        ├─ CodeRoom.js        # host waiting room post-seed
│        ├─ SeedProgress.js    # legacy seeding screen (jump support)
│        ├─ Countdown.js
│        ├─ Questions.js
│        ├─ Marking.js
│        ├─ Interlude.js
│        ├─ Award.js
│        ├─ Maths.js
│        ├─ Final.js
│        └─ Rejoin.js          # role-aware resume portal
├─ firebase.json
├─ firestore.rules
├─ firebase.config             # injected at run/deploy; not committed
└─ docs/
   ├─ index.html               # documentation microsite entry point (in-repo preview)
   ├─ styles.css               # shared styling for documentation pages
   ├─ documents/
   │  └─ pr-preview.md         # persisted guidance for preparing preview deploy notes
   ├─ packs/                   # static assets referenced from docs/index.html
   └─ ops/                     # operational runbooks and supporting assets

Keep new modules under /public/src/lib or /public/src/views. Use relative ESM imports.

⸻

Sealed Content (single source of trivia)
        •       Filenames end with .sealed. Any base name works; room codes are chosen in Key Room.
        •       Supported envelopes:
                – Full pack (version jemima-pack-1): 5 rounds of host+guest items, round clues, maths block, integrity checksum.
                – Half pack (jemima-halfpack-1): host OR guest items only; maths optional.
                – Question override (jemima-questionpack-1): replaces both sides’ question items.
                – Maths override (jemima-maths-chain-2): replaces only the maths block.
        •       Key Room lets Daniel mix these: start from a full pack, then layer optional question/host/guest/maths overrides. Missing items are padded with “<empty>”.
        •       Decryption: AES-GCM envelope, PBKDF2 150k iters, TextDecoder. Password default = DEMO-ONLY.
        •       Integrity: SHA-256 over canonical JSON (integrity.checksum) and verified flag true.

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
        •       Opens with code picker (manual or Random) and pack dropzones.
        •       Upload order flexible: base full pack, then optional overrides (questions/host/guest/maths). Status log shows what’s loaded.
        •       START seeds Firestore, writes assembled pack, sets state="coderoom", clears countdown, stores code locally, then routes to Code Room.
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
