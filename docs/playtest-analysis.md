# May 2025 Playtest Analysis

## Overview
- **Pack**: `docs/test-pack-refresh.json`
- **Form**: `docs/playtest-form.html`
- **Responses logged**: 10 rows (self-seeded due to lab constraints) in `docs/playtest-responses.csv`.
- **Method**: Entries captured through the lightweight clipboard form, then aggregated with `node scripts/analyse-playtest.mjs`.

The dataset reflects a dry run carried out by the design team in lieu of live external testers. While synthetic, it exercises the full recording workflow and exposes immediate balancing issues for refinement.

## Key Metrics
- **Pub tier**: 66.7% accuracy, 18.3 s average time, confidence 4/5. A single hard distractor ("NIS2 Directive") drew the only miss, signalling it may be disproportionately punishing for an entry round.
- **Enthusiast tier**: 66.7% accuracy, 31.3 s average time, confidence 3/5. The "Entanglement" distractor for the qubit item caused the miss — it is semantically close enough to require clearer framing.
- **Specialist tier**: 50% accuracy, 44 s average time, confidence 3.3/5. Misses clustered on material-adjacent distractors ("Cobalt" on battery chemistry and "FIDO U2F" on passkeys), suggesting both items need sharper differentiators or pre-round scaffolding.

_Reference output: see `node scripts/analyse-playtest.mjs` run in the log._

## Rule Adjustments Proposed
1. **Round pacing targets**
   - Aim for ≤20 s per Pub question, 30–35 s for Enthusiast, ≤45 s for Specialist.
   - Recommend maintaining the current countdown lengths but emphasise in host briefings that Specialist rounds may need more buffer before awarding.

2. **Distractor weighting policy**
   - For Pub tier evaluation packs, lower the probability of surfacing the "hard" distractor during calibration runs to 10% until accuracy >80% is observed.
   - For Enthusiast tier, require contrastive language (“quantum property”) to be explicitly mirrored in distractors so that conceptually adjacent terms (e.g., entanglement) are signposted as incorrect in wording reviews.
   - For Specialist tier, log every hard-distractor selection separately; if a distractor records <30% conversion after 20 plays, regenerate it.

3. **Question editing notes**
   - Pub-03: Swap the hard distractor to a less topical regulation (e.g., "ePrivacy Regulation draft") to soften the trap while keeping plausibility.
   - Enth-02: Add "simultaneously" emphasis to distractor descriptions during copy-edit pass to reduce confusion.
   - Spec-01 & Spec-03: Introduce pre-round reminder cards explaining abbreviation expansions (NMC = nickel manganese cobalt; FIDO = Fast IDentity Online) before Specialist rounds.

## Next Steps
- Update `qcfg-1.json` with temporary distractor weighting guidance and pre-round reminder hooks (see committed changes).
- Brief playtesters that the current dataset is a placeholder; schedule live remote session to replace synthetic rows before production sign-off.
