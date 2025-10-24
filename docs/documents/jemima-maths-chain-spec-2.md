# Jemima's Maths — Full Current Specification (jemima-maths-chain-2)

> Version tag: `jemima-maths-chain-2`

## 1. Overview

Jemima's Maths now spans five timed competitive rounds followed by a final maths challenge. Each round delivers one shared clue. After all five clues, the final maths question links the entire clue chain together. Victory in each round grants access to that round's reveal, which is visible only to the faster player of the round.

## 2. Round Flow

Each numbered round (1–5) progresses through Countdown → Questions → Marking → Award.

### 2.1 Countdown
- Three-second shared countdown.
- Host writes `countdown.startAt`; both devices tick locally.

### 2.2 Questions Phase
- Each player answers three binary (A/B) questions.
- Hidden timer starts when the countdown hits zero.
- Timer pauses individually when a player submits their third answer.
- Both players wait for the opponent's completion before advancing.

### 2.3 Marking Phase
- Players view the opponent's answers and assign ✓ / ✕ verdicts.
- Once a player finishes marking all three answers, their timer resumes and stops upon pressing **DONE**.
- Final time for the round is saved in Firestore as `timings.{role}.{round} = { totalSeconds: n.nn }` (total time from the start of questions to the end of marking, excluding opponent wait periods).

### 2.4 Award Phase
- No countdown.
- Displays the round number, each player's total question score for that round, each player's total elapsed time in seconds (to one decimal place), the round clue (identical for both players and persistent through the round), reveal text (only visible to the faster player), and a cumulative total score strip (updates here only).
- If times are exactly equal, no reveal text appears for either player.
- Round clues disappear permanently when the Award phase ends.

### 2.5 Interlude
- Removed. The state machine now transitions directly from Award → next Countdown (or → Maths after Round 5).

## 3. Maths Phase (after Round 5 Award)

- Both players see the maths question referencing all five clues.
- Two number inputs appear (whole numbers only).
- Answers autosave locally until both press **DONE**.
- Host compares both submissions with the correct numeric answer.

**Scoring**
- Exact match → +3 points.
- Closest numeric answer → +1 point.
- Equal distance → +1 each.
- Both exact → +3 each.

Results are written to `mathsAnswers.{role} = { value: <int>, delta: <absDiff>, points: <int> }`.

## 4. Scoring Rules

- Only question round points count toward the cumulative strip.
- Marking yields no score.
- Maths points are tallied separately and added in the Final screen.
- Final view displays per-round question totals, maths result, and overall winner.

## 5. Data Model (Firestore)

```
rooms/{CODE}
 ├─ state: "countdown" | "questions" | "marking" | "award" | "maths" | "final"
 ├─ round: 1–5
 ├─ clues: { 1: "clue text", ... }
 ├─ reveals: { 1: "reveal text", ... }
 ├─ timings:
 │    ├─ host: { 1:{totalSeconds:..}, 2:{..}, ... }
 │    └─ guest: { 1:{...}, ... }
 ├─ maths:
 │    ├─ question: "string"
 │    ├─ answer: <int>
 │    └─ clues: ["c1","c2","c3","c4","c5"]
 ├─ mathsAnswers:
 │    ├─ host: { value, delta, points }
 │    └─ guest: { value, delta, points }
 └─ scores:
      ├─ host: { 1:<int>, 2:<int>, 3:<int>, 4:<int>, 5:<int> }
      └─ guest: { ... }
```

## 6. Pack / .sealed Structure

```
Version: "jemima-maths-chain-2"

{
  "version": "jemima-maths-chain-2",
  "meta": {
    "roomCode": "ABC",
    "generatedAt": "2025-10-24T00:00:00Z"
  },
  "maths": {
    "clues": [
      "Round 1 clue text",
      "Round 2 clue text",
      "Round 3 clue text",
      "Round 4 clue text",
      "Round 5 clue text"
    ],
    "reveals": [
      "Round 1 reveal",
      "Round 2 reveal",
      "Round 3 reveal",
      "Round 4 reveal",
      "Round 5 reveal"
    ],
    "question": "Final maths question text",
    "answer": 123
  }
}
```

Encrypted output filename pattern: `<CODE>-maths.sealed` (AES-256-GCM as before).

## 7. Winner Logic

- Per round: fastest player sees the reveal clue in Award. Ties mean no reveal for either player.
- Game end: total question-round points plus maths points determine the winner. The Final screen shows both totals, the maths correctness summary, and the winner banner.

## 8. Visibility Summary

| Phase      | Visible Items                                                                    | Hidden Items            |
|------------|-----------------------------------------------------------------------------------|-------------------------|
| Questions  | Current round clue                                                                | Timer                   |
| Marking    | Current round clue                                                                | Timer                   |
| Award      | Clue, times, reveal (fastest only), updated totals                                | Other rounds' clues     |
| Maths      | Final question                                                                    | Clues                   |
| Final      | All scores and maths result                                                       | Timers                  |

---

This document supersedes earlier Jemima's Maths specifications and reflects the full jemima-maths-chain-2 gameplay, timing, scoring, Firestore schema, and sealed-pack format.
