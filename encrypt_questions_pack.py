#!/usr/bin/env python3
"""
encrypt_questions_pack.py

Seal a Jemima QUESTIONS pack as <ROOM>-questions.sealed using AES-256-GCM
and PBKDF2-HMAC-SHA256 (150k).

Accepted inputs:
  - Preferred: "jemima-questions-1" with rounds "1".."5" -> { hostItems[3], guestItems[3] }
      item: { prompt: string, options: [A,B], correct: "A"|"B" }
  - Legacy/loose: rounds can be a list of objects with "round" field OR items using:
      { question, correct_answer, distractors: { easy?, medium?, hard? }, ... }
    -> auto-converted to A/B (correct becomes A; B chosen from medium|easy|hard).

Usage:
  python encrypt_questions_pack.py AAA-questions.json
"""

import sys, json, base64, hashlib, secrets, re
from datetime import datetime, timezone

# ---- crypto via PyCryptodome ----
try:
    from Crypto.Cipher import AES  # type: ignore
    from Crypto.Protocol.KDF import PBKDF2  # type: ignore
    from Crypto.Hash import SHA256  # type: ignore
except ModuleNotFoundError as e:
    print("PyCryptodome not found. Install with: pip install pycryptodome", file=sys.stderr)
    raise

PASSWORD = b"DEMO-ONLY"         # <-- change in production
PBKDF2_ROUNDS = 150_000

# -------------------- helpers --------------------

def js(o) -> str:
    return json.dumps(o, separators=(",", ":"), ensure_ascii=False)

def derive_key(password: bytes, salt: bytes) -> bytes:
    return PBKDF2(password, salt, dkLen=32, count=PBKDF2_ROUNDS, hmac_hash_module=SHA256)

def encrypt_aes_gcm(key: bytes, nonce: bytes, plaintext: bytes) -> bytes:
    cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
    ciphertext, tag = cipher.encrypt_and_digest(plaintext)
    return ciphertext + tag

def must(cond, msg):
    if not cond:
        raise SystemExit(msg)

def is_room(s: str) -> bool:
    return bool(re.fullmatch(r"[A-Z]{3}", s or ""))

# ----------------- schema + conversion -----------------

def convert_item_if_needed(item: dict) -> dict:
    """
    Normalize one question item to:
      { prompt: str, options: [A,B], correct: "A"|"B" }

    Supported inputs:
      - Already normalized.
      - Legacy shape:
          { question, correct_answer, distractors: {easy?, medium?, hard?} }
    """
    # Already normalized?
    if "prompt" in item and "options" in item and "correct" in item:
        # light check
        must(isinstance(item["prompt"], str) and item["prompt"].strip(), "Item prompt missing/empty")
        must(isinstance(item["options"], list) and len(item["options"]) == 2, "Item needs exactly 2 options")
        must(item["correct"] in ("A","B"), "Item correct must be 'A' or 'B'")
        return item

    # Legacy -> convert
    q = item.get("question")
    ca = item.get("correct_answer")
    ds = item.get("distractors", {})
    must(isinstance(q, str) and q.strip(), "Legacy item missing 'question'")
    must(isinstance(ca, str) and ca.strip(), "Legacy item missing 'correct_answer'")
    # Choose a single distractor (prefer 'medium', then 'easy', then 'hard', else any string)
    b = ds.get("medium") or ds.get("easy") or ds.get("hard")
    if not b:
        # try any other provided key or fallback
        if isinstance(ds, dict) and ds:
            b = next(iter(ds.values()))
        else:
            raise SystemExit("Legacy item has no usable distractor")
    must(isinstance(b, str) and b.strip(), "Chosen distractor invalid")
    return {
        "prompt": q,
        "options": [ca, b],
        "correct": "A"
    }

def normalize_rounds(rounds_in):
    """
    Accept either:
      - dict with keys "1".."5"
      - list of objects each with "round": 1..5
    Return canonical dict with string keys "1".."5"
    """
    if isinstance(rounds_in, dict):
        return rounds_in
    if isinstance(rounds_in, list):
        out = {}
        for r in rounds_in:
            n = r.get("round")
            must(n in (1,2,3,4,5), "Each round in list must have 'round' integer 1..5")
            out[str(n)] = {k: v for k, v in r.items() if k != "round"}
        return out
    raise SystemExit("rounds must be an object or array")

def normalize_pack(pack: dict) -> dict:
    """
    - Ensure version jemima-questions-1
    - Ensure meta + generatedAt
    - Normalize rounds and items
    """
    if not isinstance(pack.get("version"), str) or not pack["version"].startswith("jemima-questions-"):
        # set default if absent or wrong
        pack["version"] = "jemima-questions-1"

    meta = pack.get("meta") or {}
    room = meta.get("roomCode")
    must(is_room(room), "Questions: meta.roomCode must be 3 uppercase letters (e.g., 'CAT')")
    if "generatedAt" not in meta:
        meta["generatedAt"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00","Z")
    meta.setdefault("hostUid", "demo-host")
    meta.setdefault("guestUid", "demo-guest")
    pack["meta"] = meta

    rounds = normalize_rounds(pack.get("rounds"))
    # Normalize all items
    for key in ("1","2","3","4","5"):
        must(key in rounds, f"Questions: missing round {key}")
        rd = rounds[key]
        for side in ("hostItems","guestItems"):
            items = rd.get(side)
            must(isinstance(items, list) and len(items) == 3, f"Round {key}: need 3 {side}")
            rd[side] = [convert_item_if_needed(it) for it in items]
        # interlude optional; keep if present and string
        if "interlude" in rd and not (isinstance(rd["interlude"], str) and rd["interlude"].strip()):
            rd.pop("interlude", None)
    pack["rounds"] = rounds
    return pack

def validate_final(pack: dict):
    must(pack["version"] == "jemima-questions-1", "Questions: version must be 'jemima-questions-1'")
    must(is_room(pack["meta"]["roomCode"]), "Questions: invalid roomCode")
    rounds = pack["rounds"]
    for n in ("1","2","3","4","5"):
        rd = rounds.get(n)
        must(rd is not None, f"Missing round {n}")
        for side in ("hostItems","guestItems"):
            items = rd.get(side)
            must(isinstance(items, list) and len(items) == 3, f"Round {n}: must have 3 {side}")
            for it in items:
                must(isinstance(it.get("prompt"), str) and it["prompt"].strip(), "Prompt missing")
                opts = it.get("options")
                must(isinstance(opts, list) and len(opts) == 2 and all(isinstance(x,str) and x.strip() for x in opts),
                     "Options must be two non-empty strings")
                must(it.get("correct") in ("A","B"), "correct must be 'A' or 'B'")

# ----------------- sealing -----------------

def seal(pack: dict, out_path: str):
    payload = dict(pack)
    payload.pop("integrity", None)
    checksum = hashlib.sha256(js(payload).encode("utf-8")).hexdigest()
    payload["integrity"] = {"checksum": checksum, "verified": True}

    salt = secrets.token_bytes(16)
    key = derive_key(PASSWORD, salt)
    nonce = secrets.token_bytes(12)
    ct = encrypt_aes_gcm(key, nonce, js(payload).encode("utf-8"))

    envelope = {
        "alg": "AES-GCM",
        "pbkdf2": f"PBKDF2-HMAC-SHA256/{PBKDF2_ROUNDS}",
        "salt_b64": base64.b64encode(salt).decode(),
        "nonce_b64": base64.b64encode(nonce).decode(),
        "ct_b64": base64.b64encode(ct).decode(),
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(envelope, f, ensure_ascii=False, indent=2)

    print("Wrote:", out_path)
    print("roomCode:", pack["meta"]["roomCode"])
    print("version:", pack["version"])
    print("generatedAt:", pack["meta"]["generatedAt"])
    print("checksum:", checksum[:16])

# ----------------- main -----------------

def main():
    if len(sys.argv) < 2:
        print("Usage: encrypt_questions_pack.py <questions.json> [OUT.sealed]")
        sys.exit(1)

    in_path = sys.argv[1]
    with open(in_path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    pack = normalize_pack(raw)
    validate_final(pack)

    out_path = sys.argv[2] if len(sys.argv) > 2 else f"{pack['meta']['roomCode']}-questions.sealed"
    seal(pack, out_path)

if __name__ == "__main__":
    main()