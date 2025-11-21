# Jemima Maths Timeline Packs (agent spec)

Use this file as the `agent.md` for generating Jemima’s history maths packs. Each maths game asks players to name the year a famous event happened; totals decide the winner.

## Core gameplay
- Five rounds, each with one historical event. Events must be in strictly chronological order (each newer than the last).
- Players guess a single AD year (1–4 digits) for every event. Answers are kept hidden until the final tally.
- Totals are compared against the correct sum to award points:
  - **5 points** — exact match to the target total.
  - **3 points** — within ±2% of the target (round margins to the nearest whole year).
  - **2 points** — within ±5% of the target.
  - **1 point** — if nobody earns 5/3/2 points, the single closest total takes the safety net (both get 1 point on a tie).

## JSON shape
Produce `version: "jemima-maths-timeline-1"` payloads with no room codes or lobby details. Packs may contain a single maths game under `maths`, or multiple games under `games`.

### Single game (`maths`)
```
{
  "version": "jemima-maths-timeline-1",
  "maths": {
    "title": "String",
    "question": "Instructional string (e.g., Enter the year for each event (1–4 digits).)",
    "events": [
      { "prompt": "Concise event title", "year": 1066 },
      ... five total, strictly increasing years ...
    ],
    "total": 0,                // sum of the five years
    "scoring": {
      "targetTotal": 0,        // equals total
      "sharpshooterMargin": 0, // ±2% of total, rounded
      "ballparkMargin": 0,     // ±5% of total, rounded
      "perfectPoints": 5,
      "sharpshooterPoints": 3,
      "ballparkPoints": 2,
      "safetyNetPoints": 1
    },
    "clues": ["Copy of each prompt"],
    "reveals": ["Copy of each prompt"]
  }
}
```

### Multi-game bundle (`games`)
```
{
  "version": "jemima-maths-timeline-1",
  "games": [ { ...maths object... }, { ... }, ... ]
}
```
- Include 1–5 maths objects per pack; Key Room will split them into individually playable maths packs.
- No event may be repeated across the bundle.
- Packs with fewer or more than five games are accepted, but each maths game must always contain exactly five events.

## Event sourcing
- Years must be between AD 1 and AD 2025, widely agreed upon, and easy for players to guess.
- Avoid deep obscurities; prefer headline moments (e.g., moon landing 1969, first steam locomotive 1804).
- Keep prompts concise and accurate; no room/lobby codes or passwords anywhere in the JSON.
