# Jemima’s Asking — Pack Generation Specification (Codex Prompt)

You are Codex. Generate **two JSON files** in `/packs/out/` for a new Jemima’s Asking game.

---

## (1) MATHS PACK — TIMELINE EDITION
**Filename:** `<ROOM>-maths.json`

**Requirements:**
- `"version": "jemima-maths-timeline-1"`
- `"meta.roomCode"` = a unique 3-letter uppercase code not yet used in `/packs/out` or `/packs/sealed`
- `"meta.generatedAt"` = current UTC ISO timestamp
- `"meta.hostUid"` = `"demo-host"`
- `"meta.guestUid"` = `"demo-guest"`
- `"maths"` object **or** `"games"` array of maths objects. Each maths object must contain:
  - `"events"` → array of **5** historical prompts, ordered from oldest to most recent.
    - Each event has `"prompt"` (string) and `"year"` (integer, 1–2025).
    - Events should be widely recognised so players can make educated guesses.
  - `"total"` = sum of the five years.
  - `"title"` (string) — concise headline for the set.
  - `"question"` (string) — short instruction, e.g. “Enter the year for each event (1–4 digits).”
  - `"scoring"` → margins and points (defaults allowed):
    - `targetTotal` (integer) matches `total`.
    - `sharpshooterMargin` = ±2% of total (round to nearest int).
    - `ballparkMargin` = ±5% of total (round to nearest int).
    - `perfectPoints` = 5, `sharpshooterPoints` = 3, `ballparkPoints` = 2, `safetyNetPoints` = 1 (closest if neither hits the bands).
  - Convenience mirrors (optional): `"clues"` and `"reveals"` repeat the event prompts; `"answer"` may duplicate `"total"`.
- If `"games"` is provided, include 1–5 maths objects; Key Room will split them into individually playable maths packs.

---

## (2) QUESTIONS PACK
**Filename:** `<ROOM>-questions.json`

**Requirements:**
- `"version": "jemima-questions-1"`
- `"meta.roomCode"` = same `<ROOM>` as maths pack
- `"meta.generatedAt"` = same ISO time
- `"meta.hostUid"` / `"meta.guestUid"` = as above
- `"rounds"` → object with keys `"1"` to `"5"`
  - Each round:
    - `"hostItems"` = 3 objects  
    - `"guestItems"` = 3 objects  
      Each item:
        ```json
        {
          "prompt": "string",
          "options": ["Option A","Option B"],
          "correct": "A"
        }
        ```
  - Topics: broad, witty, factual.  
    Avoid repetition across rounds; mix history, pop culture, geography, science, arts, etc.

---

## OUTPUT
- Write **exactly 2 files** into `/packs/out/`:
  - `<ROOM>-maths.json`
  - `<ROOM>-questions.json`
- Use the same `<ROOM>` in both filenames and in `"meta.roomCode"`.
- Ensure schemas validate and maths arithmetic is correct.
- Do **not** reuse any existing room code already present in `/packs/out/` or `/packs/sealed/`.