AGENTS.md

Project

Jemima’s Asking — Two-player quiz duel
Stack: Vanilla JS (ESM) + Firebase (Auth anon + Firestore) + LocalStorage + hand-rolled CSS.
Targets: modern mobile/desktop. Primary test: iPad + Windows 10/11.

⸻

North Star
	•	Two players, two devices, fixed roles: Daniel = Host, Jaime = Guest. Roles are claimed once and never overwritten.
	•	Phases are mostly local; only key moments sync: countdowns, awards, final.
	•	Content comes from a sealed question pack uploaded by the host. No live LLM calls during play.

⸻

File Tree (authoritative)

project-root/
├─ index.html
├─ styles.css
├─ firebase.json
├─ firestore.rules
├─ firebase.config                # injected at run/deploy; not committed
└─ src/
   ├─ main.js                     # router + per-view theming seed
   ├─ roomWatcher.js              # state observer → navigation
   ├─ lib/
   │  ├─ firebase.js              # init, anon auth, db helpers
   │  ├─ seedUnsealer.js          # decrypt/validate sealed packs, write to Firestore
   │  ├─ MathsPane.js             # pinned inverted maths info box
   │  └─ util.js                  # clampCode, getHashParams, timeUntil, etc.
   └─ views/
      ├─ Lobby.js
      ├─ KeyRoom.js               # upload sealed pack; show code/date/verify; start seeding
      ├─ SeedProgress.js          # minimal (legacy) seeding UI; now just writes pack
      ├─ Countdown.js
      ├─ Questions.js
      ├─ Marking.js
      ├─ Award.js
      ├─ Interlude.js             # (used if ever needed outside Award flow)
      ├─ Maths.js
      └─ Final.js

Keep any new modules under /src/lib or /src/views and use relative ESM imports.

⸻

Sealed Question Pack (single source of truth)
	•	Filename: <ROOM>.sealed (e.g., CAT.sealed).
	•	Encryption: AES-GCM (binary blob). Decrypted only in-app by seedUnsealer.js.
	•	Internal JSON schema (pre-encryption):

{
  "version": "jemima-pack-1",
  "meta": {
    "roomCode": "CAT",
    "hostUid": "daniel-001",
    "guestUid": "jaime-001",
    "generatedAt": "ISO-8601 string"
  },
  "rounds": [
    { "round": 1, "hostItems":[x3], "guestItems":[x3], "interlude": "string" },
    … up to round 5 …
  ],
  "maths": {
    "location": "string",
    "beats": ["b1","b2","b3","b4"],
    "questions": ["q1","q2"],
    "answers": [int,int]
  },
  "integrity": {
    "checksum": "sha256 hex of canonical content",
    "verified": true
  }
}


	•	Items (QCFG shape):
{ subject, difficulty_tier: "pub|enthusiast|specialist", question, correct_answer, distractors{easy,medium,hard} }
Host and guest each get distinct 3 per round. Difficulty ramps by round via the pack’s selection.

⸻

Firestore Contract

Doc: rooms/{CODE}
	•	meta.hostUid, meta.guestUid — written once (transaction), never overwritten.
	•	state — "lobby" | "keyroom" | "countdown" | "questions" | "marking" | "award" | "maths" | "final".
	•	round — 1…5 during Q&A.
	•	answers.host.{round} / answers.guest.{round} — arrays of {questionId?, chosen, correct}.
	•	submitted.host.{round} / submitted.guest.{round} — booleans.
	•	marking.host.{round} / marking.guest.{round} — arrays of "right"|"wrong" (no “unsure” scoring).
	•	markingAck.host.{round} / markingAck.guest.{round} — booleans.
	•	maths — the object from the pack.
	•	countdown.startAt — ms epoch for next phase start.
	•	timestamps.createdAt, timestamps.updatedAt.
	•	Optional: seeds.progress/message during initial write.

Subcollection: rooms/{CODE}/rounds/{N}
	•	hostItems[3], guestItems[3], interlude.

Never mix host/guest items; never rewrite claimed UIDs.

⸻

Roles & Identity
	•	Fixed IDs shipped in the pack:
hostUid = "daniel-001", guestUid = "jaime-001" (or your chosen constants).
	•	These are stable across all games. Security derives from sealed content, not rotating IDs.

⸻

Flow (authoritative UX)

1) Lobby (both)
	•	Minimal welcome. Jaime’s entrance link to watcher page; Daniel’s entrance to Key Room.

2) Key Room (host uploads the pack)
	•	Large header shows room code (from file name and pack), with Copy.
	•	File input accepts *.sealed. The recommended naming is <CODE>.sealed.
	•	On load:
	•	Decrypt + validate checksum/schema.
	•	Display Generated date from meta.generatedAt.
	•	Show a green verified circle when integrity passes.
	•	Write Firestore:
	•	rooms/{CODE} with meta.hostUid/guestUid, round=1, state="countdown".
	•	rounds/1…5 items from the pack.
	•	maths at room level.
	•	Set a near-future countdown.startAt and navigate both clients to Countdown.
	•	A file picker remains visible to replace with a different pack before countdown (defensive UX).

3) Guest Join (watcher)
	•	Jaime enters room code (same as file name). Lobby stays identical.
	•	On join, watcher navigates to Countdown for the same startAt.

4) Countdown (sync)
	•	Full-screen seconds. Score strip visible (thin, full-width; left: CODE  Round N; right: Daniel  x    Jaime  y).
	•	On zero → Questions.

5) Questions (local)
	•	Exactly 3 items for the player’s own role (hostItems vs guestItems).
	•	Each screen = question + two options. Selecting auto-advances; the 3rd auto-submits.
	•	MathsPane (inverted box) pinned below with the current beat.
	•	After submit: “Waiting for opponent…” locally; no cross-device resets.

6) Marking (local, 30s timer)
	•	Each player sees the opponent’s three questions and the opponent’s chosen answers (bold).
	•	Two buttons per item, centered: ✓ He’s right (green) / ✕ Totally wrong (red). Only one can be active.
	•	Timer (30s) top-right in bold Courier. Unmarked when time ends count as 0 (no score change).
	•	On submit (or timeout): write marking.{role}.{round} and markingAck.{role}.{round}=true.

7) Award (sync, 30s timer)
	•	Shows your own three answered questions with ✓/✕ against your choices.
	•	Updates the score strip (scores change only here, once both acks true and the award begins).
	•	After timer → Countdown for the next round.

8) Interludes
	•	The pack provides an interlude per round describing surreal things Jemima does while waiting.
	•	Interludes are shown to the player who finishes questions first while they wait (never blocking the other).
	•	Not a global phase; purely local filler between Questions and Marking/Award.

9) Maths (local, after Round 5 award)
	•	Two integer answers with explicit units. MathsPane remains visible.
	•	On submit → Final.

10) Final (sync)
	•	Minimal summary; option to return to Lobby.

⸻

Score Strip (always on, except Lobby/KeyRoom)
	•	Full-width, dark ink strip; light text in Courier.
	•	Left: CODE   Round N
	•	Right: Daniel  X      Jaime  Y
	•	Scores update at the start of each Questions round (i.e., after Award).

⸻

Runtime Invariants
	•	Host never sees guestItems in Questions and vice versa.
	•	Claimed UIDs are immutable.
	•	Local phases ignore remote writes that could change UI state mid-phase.
	•	Submits set submitted.{role}.{round} and lock drafts.
	•	Maths answers are integers only; JSON validated.
	•	MathsPane always mounted and inverted; no full dark pages elsewhere.

⸻

Testing Checklist (Emulator)
	•	Upload CAT.sealed in Key Room → see generated date + green verified dot.
	•	Firestore shows rooms/CAT, rounds/1..5, maths present.
	•	Guest joins with CAT → both see the same countdown.
	•	Distinct question sets per role; auto-advance works; third answer auto-submits.
	•	Marking timer enforces 30s; ✓/✕ writes correct arrays; Award updates scores once per round.
	•	Interlude appears only to the player who finished early.
	•	Maths validates integer answers and proceeds to Final.

⸻

Style (non-negotiable)
	•	Courier everywhere; titles/answers bold.
	•	Narrow centered column (≈400–450px).
	•	No global dark themes; only MathsPane uses inverted scheme.
	•	Buttons rounded; primary actions throb when actionable.

⸻

Safe Agent Tasks
	•	Role isolation audit (Questions/Marking fetch paths).
	•	Award score consistency (update only at award start).
	•	KeyRoom verify UI (date + green verified circle + copy code + re-upload).
	•	Countdown robustness (client clock drift tolerance ±5s).

⸻
