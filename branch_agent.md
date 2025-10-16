# Branch Agent — Question Compilation & Encryption Workflow

## Objectives
- Curate a 30-question Millionaire ladder split 15/15 between host and guest.
- Preserve flexibility for the JSON specification to define categories, prize tiers, and per-round structure.
- Ensure final assets are packaged in a secure, tamper-evident bundle ready for distribution.

## Process Overview
1. **Ingest Specification**
   - Load the latest `millionaire_pack.json`.
   - Validate that the rules still mandate question-only output and forbid catalogue sample reuse.
   - Extract structural requirements (round counts, field names, distractor difficulties) without hard-coding values elsewhere.

2. **Compile Question Drafts**
   - For each round slot described in the JSON, request candidate prompts from the content team or generator that respect the category mix and ladder progression.
   - Run automated checks for similarity against the catalogue’s sample questions; flag anything with high textual overlap for manual revision.
   - Maintain a working set that records provenance, draft status, and reviewer notes, but do not embed those notes back into the JSON.

3. **Quality Assurance**
   - Review all 30 entries for factual accuracy, clarity, and balance between host and guest paths.
   - Confirm distractor difficulty ordering (easy → medium → hard) by peer review or heuristics as defined outside this document.
   - Ensure prize progression aligns with the Millionaire ladder stated in the JSON metadata.

4. **Encryption & Packaging**
   - Serialize the approved questions into the target schema defined by `question_fields`.
   - Generate a per-pack symmetric key; encrypt the serialized payload using AES-256-GCM.
   - Store the key in the secrets manager with an expiry aligned to the production schedule.
   - Produce an integrity manifest (e.g., SHA-256 hashes) for both encrypted payload and metadata, and sign it with the branch private key.

5. **Handoff**
   - Deliver the encrypted bundle, manifest, and retrieval instructions to deployment, referencing the JSON specification version.
   - Archive working notes separately, stripping any raw question text to maintain content secrecy.

## Flexibility Notes
- Any future adjustments (new rounds, alternative ladders, added fields) should be driven by updates to `millionaire_pack.json`; this document is intentionally agnostic to those particulars.
- When additional validation rules appear in the JSON, incorporate them in the QA stage without rewriting this guide.
