# Jemima’s Asking — Pack Generation Specification (Codex Prompt)

You are Codex. Generate **two JSON files** in `/packs/out/` for a new Jemima’s Asking game.

---

## (1) MATHS PACK
**Filename:** `<ROOM>-maths.json`

**Requirements:**
- `"version": "jemima-maths-chain-1"`
- `"meta.roomCode"` = a unique 3-letter uppercase code not yet used in `/packs/out` or `/packs/sealed`
- `"meta.generatedAt"` = current UTC ISO timestamp
- `"meta.hostUid"` = `"demo-host"`
- `"meta.guestUid"` = `"demo-guest"`
- `"maths"` object:
  - `"beats"` → array of **5** short story beats, told by Jemima in first person.
    - No visible numerals. Each beat applies an operation (+, −, ×, ÷, double, half, add, subtract, etc.).
    - Beats connect into a playful, logical story. Each may mention everyday facts (cats, food, travel, etc.).
  - `"reveals"` → array of **5** reveal lines:
    - Exactly **two** are `"type": "total"` (rounds 2–4).
    - Others are `"obvious"` or `"specific"`.
    - Beat 5 reveal must **not** be `"total"`.
    - Numerals and units shown as **bold**: e.g. `**42 kilometres**`.
  - `"question"` → one short line with a blank, e.g. “What’s the final number? ___”
  - `"answer"` → integer
- `"results"`:
  - `"passage"` = the 5 beats rewritten as a single paragraph **with numbers and units inserted**, using bold.
  - `"finalAnswer"` = `{ "value": <integer>, "label": "Final total" }`
- No `"location"` field. No notes.

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
    - `"interlude"` = optional 1-sentence line in Jemima’s voice.
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