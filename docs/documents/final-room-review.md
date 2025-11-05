# Final room data review

## End-of-game data inventory

- **Round scores and answers** – Once both Q&M submissions are marked, the room document records per-round question totals for host and guest under `scores`, computed directly from the stored answers and the seeded question items.
- **Marking verdicts and timing** – Each player’s marking pass is persisted as `marking.{role}.{round}` with the verdicts (`right`/`wrong`/`unknown`) alongside a `timings` entry that logs their total marking time in seconds for that round.
- **Maths challenge** – The room document retains the final maths question, its clues, and correct answer (`maths`), plus each player’s submitted value, delta from the correct answer, and awarded points in `mathsAnswers` (host finalises the deltas/points once both submissions arrive).
- **Round metadata** – Each `rounds/{n}` document keeps the original host/guest question items and per-round timestamps such as `timingsMeta.questionsStartAt`, letting you tie answer data back to the full prompt text and scheduled pacing.

## Stat opportunities for the Final room

- **Marking prowess** – Count how many `right` verdicts each player awarded across `marking.{role}` to announce "most answers spotted correctly," or compare verdicts with the underlying `answers` array to highlight any over/under-marking drama.
- **Speed crowns** – Use `timings.{role}.{round}.totalSeconds` to surface fastest marker per round or overall, matching the existing helper that already determines the faster role for clue reveals in Award.
- **Accuracy streaks** – Re-walk `answers.{role}.{round}` against the seeded question data to celebrate streaks, perfect rounds, or clutch saves heading into maths.

## Bridging the question-only strip to the final totals

The in-game ScoreStrip is driven solely by `scores.host/guest`, so it reflects question-round correctness but ignores maths points (and any marking theatrics). In Final, totals are recomputed as "questions + maths" and the maths table already surfaces the deltas and awarded points.

A playful reveal could:

1. Freeze the ScoreStrip totals when entering Final (still showing question-only points).
2. Overlay each player’s `marking` verdicts as animated stamps on their answers (a "check audit" montage) before a "Jemima adjusts the ledger" pulse adds the maths bonuses, sliding the strip numbers up to the full totals pulled from `mathsAnswers` and echoed in the Final card.
3. Drop confetti for whichever side the combined totals crowned via `winnerLabel`.

This keeps continuity with the strip while acknowledging the late-stage data that wasn’t visible during play.

## Whole-game review, paced per round

To let both players audit everything without information overload:

- Build a Final-room timeline/accordion with one expandable panel per round. Each panel can reuse the seeded `hostItems`/`guestItems` to show the exact questions, overlay the stored answers and marking verdicts, and tag the round clue pulled the same way the Maths Pane resolves it.
- Append timing chips (e.g., "Daniel marked in 18.4s") using the saved `timings` entries, adding colour for the faster marker as already derived in Award.
- Close with a dedicated maths panel mirroring Final’s summary—question prompt, correct number, both submissions, deltas, and points—so the climactic calculation sits alongside the Q&M recap.

This structure keeps the review digestible while ensuring every clue, response, and ruling from Q&M through maths is easy to cross-check.
