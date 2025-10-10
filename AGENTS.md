# AGENTS.md

## Project

**Jemima’s Asking — Two-player quiz duel**
Stack: Vanilla JS + Vite (static), Firebase Auth (anon), Firestore (RTDB-ish sync), Gemini (content), LocalStorage (drafts), CSS (hand-rolled).
Audience devices: modern mobile + desktop. Primary test: iPad + Windows 10/11.

---

## North Star (Do Not Drift)

* **Two players, two devices, fixed roles.** *Daniel = Host*, *Jaime = Guest*. Roles claimed once and never overwritten.
* **Shared countdown; local phases.** Devices **only** re-sync after each submit → **no cross-device resets** mid-phase.
* **5 Q&A rounds → Maths → Final.**
* **Visuals are minimal, narrow, light backgrounds, dark “ink” accents.** *Never full dark backgrounds* (except the pinned inverted Maths box).

---

## File Tree (Authoritative)

```
project-root/
├─ index.html
├─ styles.css
├─ firebase.json
├─ firestore.rules
├─ firebase.config          # injected at build/run; not committed
└─ src/
   ├─ main.js               # router + mount + global ink/light seed
   ├─ roomWatcher.js        # state machine observer + nav
   ├─ lib/
   │  ├─ firebase.js        # init, anon auth, db helpers
   │  ├─ gemini.js          # prompt packs (QCFG, JMaths) + calls
   │  ├─ bgGenerator.js     # per-view ink/light generation
   │  └─ MathsPane.js       # pinned inverted maths box component
   └─ views/
      ├─ Lobby.js
      ├─ KeyRoom.js
      ├─ SeedProgress.js
      ├─ Countdown.js
      ├─ Questions.js
      ├─ Marking.js
      ├─ Award.js
      ├─ Interlude.js
      ├─ Maths.js
      └─ Final.js
```

> Agent rule: **Respect this structure.** If you introduce new modules, tuck them under `/src/lib` or `/src/views` appropriately and update imports using relative paths.

---

## Firestore Contract (Canonical)

**Doc:** `rooms/{CODE}`
Fields:

* `meta.hostUid`, `meta.guestUid`: set once via **transaction**; **never overwritten**.
* `state`: `"lobby" | "keyroom" | "seeding" | "countdown" | "questions" | "marking" | "interlude" | "award" | "final"`.
* `round`: integer 1–5 during Q&A; `maths` happens after 5.
* `answers.host.{round}` / `answers.guest.{round}`: arrays of `{question, chosen, correct}`.
* `submitted.host.{round}` / `submitted.guest.{round}`: booleans.
* `marking.host.{round}` / `marking.guest.{round}`: arrays of `"right"|"unsure"|"wrong"`.
* `markingAck.host.{round}`, `markingAck.guest.{round}`: booleans.
* `maths`: `{location, beats[4], questions[2], answers[2]}` per **jmaths-1**.
* `seeds`: `{progress, message, counters, errors?}`.
* `timestamps.createdAt`, `timestamps.updatedAt`.
* `countdown.startAt`: ms epoch for next round start.

**Subcollection:** `rooms/{CODE}/rounds/{N}`

* `hostItems[3]`, `guestItems[3]` (each an item: `{subject, difficulty_tier, question, correct_answer, distractors{easy,medium,hard}}`)
* `interlude`: string (Jemima line)

> Agent rule: **Never** mix host/guest items. **Never** rewrite claimed UIDs. Use server timestamps where available.

---

## State Machine (Authoritative)

`Lobby → KeyRoom → Seeding → (Countdown → Questions[local] → Marking[local] → Award[sync] → Interlude/next) ×5 → Maths[local] → Final[sync] → Lobby`

**Local vs Sync:**

* **Local phases** (no cross-device UI changes): Questions, Marking, Maths.
* **Sync phases**: Countdown, Award, Interlude, Final.

---

## Rejoin & Drafts

* **Same device:** auto-restore drafts for Questions/Marking/Maths from LocalStorage **iff** no submitted flag yet.
* **New device:** Host can generate short takeover codes (room `meta.takeover`) and assign to `host`/`guest`. On success, drafts are not migrated; user continues fresh but with role reclaimed.

> Agent rule: Do **not** clear drafts until write of `submitted.{role}.{round} == true`.

---

## Seeding Rules

* Host triggers seeding in **KeyRoom**:

  * Generate **Round 1** items (6) → split to `hostItems[3]`, `guestItems[3]` under `rounds/1`.
  * Write **maths** once at top level (per `jmaths-1`).
  * Launch background gen for **Rounds 2–5**.
  * Once Round 1 present, flip to `state:"countdown"` with a near-future `countdown.startAt`.
* Guest: read-only log/progress.

> Agent rule: If generation returns more than 6 items, **verify** via `qcfg-1.verification_prompt`, discard fails, and only commit approved items.

---

## Questions Phase (Strict UX)

* Show **only the 3 items** for current role (`hostItems` for Host, `guestItems` for Guest).
* Each screen: 1 question + **two** tappable options.
* Selecting an option: apply selected style → **auto-advance** after ~600–1200 ms.
* After Q3: show “Waiting for opponent…”.
* Pinned **MathsPane** always visible below (inverted scheme), showing the relevant beat.

> Agent rule: Implement “**third answer auto-submits**” (no extra Done). Ensure no network events from the other device can deselect a local choice.

---

## Marking Phase (Strict UX)

* Show opponent’s 3 questions with **their chosen** answers.
* Marking buttons inline per item:

  * ✓ “He’s right” (green)
  * ? “I dunno” (dark blue)
  * ✕ “Totally wrong” (red)
* Clicking a button inverts colours + draws a big hand-scribbled ✓/?/✕ beside the answer.
* **DONE** throbs once all 3 marked → write `marking.{role}.{round}` and set `markingAck.{role}.{round}=true`.
* Host process advances to `state:"interlude"` when both acks true.
* MathsPane pinned at bottom.

---

## Visual System (Non-Negotiable)

* **Typeface:** Courier (mono) throughout. Titles/answers bold.
* **Colour:** per-view random dark **ink** and light **bg** (no full dark backgrounds). MathsPane is the **only** inverted box.
* **Layout:** central narrow column **≈400–450px**; phone-optimised; tidy spacing hierarchy: `title → panel → status`.
* **Buttons:** rounded; outline→filled on “ready”; **throb** animation when active/primary. Lobby arrow is bold Courier `→`.
* **Tone:** clean, functional; only Jemima’s interludes carry playful flavour.

> Agent rule: Preserve these tokens/classes. If consolidating CSS, do not alter visual output (pixel-snap width and spacings must remain).

---

## Prompt Packs (Source of Truth)

* **QCFG (`version: qcfg-1`)**: generation + verification prompts, delivery rules (two-choice), subject variety caps, banlists, constraints.
* **JMaths (`version: jmaths-1`)**: 4-beat whimsical story + 2 integer questions with explicit units; allowed locations/units; trivial maths only.

> Agent rule: *Never* paste sample questions verbatim into live rounds. Verification must cite reputable sources by name.

---

## Runtime Invariants / Acceptance Criteria

* Role isolation: **a host can never see guestItems in Questions**, and vice versa.
* Idempotent claiming: once `meta.hostUid` or `meta.guestUid` set, transactions must reject writes that change them.
* Local phases immune to remote writes: no selection gets cleared because the other player progressed.
* Submits: writing `submitted.{role}.{round}=true` locks local drafts for that round and unmounts local inputs.
* State transitions only from watcher/host actions as defined (no accidental loops).
* MathsPane always mounted and inverted; never full-screen dark elsewhere.
* CSS: consistent `.btn`, `.btn--choice`, `.throb`, and ink/bg custom properties per view.

---

## Safe Tasks You Can Do (Examples)

1. **Role separation audit**

   * *Goal:* Ensure Questions.js pulls from `{role}Items` and never leaks the other.
   * *Edits:* `/src/views/Questions.js`, shared util for role, tests (if present).
   * *Definition of done:* For `emu=1`, forcing `role=guest` shows only `guestItems`; no cross-reads anywhere.

2. **Third-answer auto-submit**

   * *Goal:* After 3rd selection, write `answers.{role}.{round}`, set `submitted`, show waiting pane.
   * *Edits:* `/src/views/Questions.js`, maybe `/src/styles.css` for button state.
   * *DOD:* No “Done” button appears; submit happens with a short delay; drafts cleared on success.

3. **Shared utils extraction**

   * *Goal:* Factor `getHashParams`, `clampCode`, role inference into `/src/lib/util.js`.
   * *DOD:* All imports updated; no circular deps; dead code removed.

4. **Countdown reliability**

   * *Goal:* Use `countdown.startAt` and client clock; count to zero even offline; flip to Questions only when time elapsed + round data ready.
   * *DOD:* Degrades gracefully if clock skew <±5s.

5. **Seeding resilience**

   * *Goal:* Wrap Gemini calls with retries; verify items (`qcfg-1`); write approved; stream progress.
   * *DOD:* `seeds.progress` advances; `seeds.message` human-readable; background rounds continue even if one fails.

---

## Commands (Codex CLI)

Use small, goal-scoped briefs at repo root:

```
codex "Audit Questions.js, Marking.js, Award.js, roomWatcher.js for strict host/guest isolation. Create /src/lib/role.js with inferRole(). Replace ad-hoc role parsing. Do not alter visuals."
```

```
codex "Implement third-answer auto-submit in Questions.js. Keep throb animation and button styling intact. Update styles only if necessary without changing look."
```

```
codex "Extract shared utils: getHashParams, clampCode, timeUntil(startAt). Create /src/lib/util.js and refactor imports. No behaviour changes."
```

```
codex "Harden KeyRoom seeding: verify items per qcfg-1, write rounds/1 split, maths at top-level, queue rounds 2–5. Progress updates under seeds.*"
```

**Approval mode:** start in **Read Only** → review plan/diffs → then **Auto** for that task only.
**Windows note:** prefer WSL2 for smooth shell.

---

## Testing (Emulator Checklist to Script)

* Create `rooms/XL6` per example in the project description and the following:

  * Distinct `meta.hostUid` / `meta.guestUid`.
  * `rounds/1` has 3 + 3 split, different content.
  * Set both `submitted.{role}.1 = true` to unlock Marking.
  * Fill `marking.*.1` arrays, set both `markingAck.*.1 = true`.
  * Advance to `interlude` → `countdown` for round 2 with future `startAt`.
  * `maths` present and valid (integers for answers).
* Verify CSS: narrow column, inverted MathsPane, throbbing primaries.

---

## Style & Semantics Conventions

* JS: modern ESM, no jQuery, minimal dependencies.
* CSS: utility classes limited; rely on custom properties for `--ink`, `--bg`, `--inkSoft`.
* Naming:

  * Booleans: `is*`, `has*`, `*Ack`
  * Firestore: camelCase for fields, numeric keys as strings in per-round maps.
* Errors: log human-readable to console and to `seeds.message` during seeding.

---

## Hard “DO NOT” List

* Do **not** introduce global dark themes or full dark backgrounds.
* Do **not** change courier typography or column width behaviour.
* Do **not** co-locate host/guest items or allow role flipping after claim.
* Do **not** block local inputs based on the other device’s progress.
* Do **not** paste sample questions/answers verbatim into gameplay.

---

## Maintainers’ Notes

* If you must create new files, prefer tiny modules over monoliths.
* Keep Gemini prompt packs pristine and versioned.
* Always gate multi-file edits behind a plan + diff review.

---
