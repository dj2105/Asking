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

import sys, json, base64, hashlib, secrets
from datetime import datetime, timezone
from pathlib import Path

# ---- crypto via PyCryptodome (optional) ----
try:
    from Crypto.Cipher import AES  # type: ignore
    from Crypto.Protocol.KDF import PBKDF2  # type: ignore
    from Crypto.Hash import SHA256  # type: ignore
except ModuleNotFoundError:  # pragma: no cover
    AES = None
    PBKDF2 = None
    SHA256 = None

PASSWORD = b"DEMO-ONLY"         # <-- change in production
PBKDF2_ROUNDS = 150_000

# -------------------- helpers --------------------

def js(o) -> str:
    return json.dumps(o, separators=(",", ":"), ensure_ascii=False)

def derive_key(password: bytes, salt: bytes) -> bytes:
    if PBKDF2 is not None and SHA256 is not None:
        return PBKDF2(password, salt, dkLen=32, count=PBKDF2_ROUNDS, hmac_hash_module=SHA256)
    return hashlib.pbkdf2_hmac("sha256", password, salt, PBKDF2_ROUNDS, dklen=32)

def encrypt_aes_gcm(key: bytes, nonce: bytes, plaintext: bytes) -> bytes:
    if AES is not None:
        cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
        ciphertext, tag = cipher.encrypt_and_digest(plaintext)
        return ciphertext + tag

    import ctypes
    from ctypes.util import find_library

    lib_name = find_library("crypto") or "libcrypto.so"
    libcrypto = ctypes.CDLL(lib_name)

    EVP_CTRL_GCM_SET_IVLEN = 0x9
    EVP_CTRL_GCM_GET_TAG = 0x10

    EVP_CIPHER_CTX_new = libcrypto.EVP_CIPHER_CTX_new
    EVP_CIPHER_CTX_new.restype = ctypes.c_void_p
    ctx = EVP_CIPHER_CTX_new()
    if not ctx:
        raise RuntimeError("Failed to allocate EVP_CIPHER_CTX")

    EVP_CIPHER_CTX_free = libcrypto.EVP_CIPHER_CTX_free
    EVP_CIPHER_CTX_free.argtypes = [ctypes.c_void_p]

    try:
        EVP_aes_256_gcm = libcrypto.EVP_aes_256_gcm
        EVP_aes_256_gcm.restype = ctypes.c_void_p

        EVP_EncryptInit_ex = libcrypto.EVP_EncryptInit_ex
        EVP_EncryptInit_ex.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
        EVP_EncryptInit_ex.restype = ctypes.c_int

        EVP_CIPHER_CTX_ctrl = libcrypto.EVP_CIPHER_CTX_ctrl
        EVP_CIPHER_CTX_ctrl.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
        EVP_CIPHER_CTX_ctrl.restype = ctypes.c_int

        EVP_EncryptUpdate = libcrypto.EVP_EncryptUpdate
        EVP_EncryptUpdate.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_int), ctypes.c_void_p, ctypes.c_int]
        EVP_EncryptUpdate.restype = ctypes.c_int

        EVP_EncryptFinal_ex = libcrypto.EVP_EncryptFinal_ex
        EVP_EncryptFinal_ex.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_int)]
        EVP_EncryptFinal_ex.restype = ctypes.c_int

        if EVP_EncryptInit_ex(ctx, EVP_aes_256_gcm(), None, None, None) != 1:
            raise RuntimeError("EVP_EncryptInit_ex failed (stage 1)")
        if EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, 12, None) != 1:
            raise RuntimeError("EVP_CTRL_GCM_SET_IVLEN failed")

        key_buf = ctypes.create_string_buffer(key, len(key))
        return _openssl_gcm_encrypt(libcrypto, ctx, key_buf, plaintext)
    finally:
        EVP_CIPHER_CTX_free(ctypes.c_void_p(ctx))


def _openssl_gcm_encrypt(libcrypto, ctx, key_buf, plaintext: bytes) -> bytes:
    import ctypes, secrets

    EVP_EncryptInit_ex = libcrypto.EVP_EncryptInit_ex
    EVP_CIPHER_CTX_ctrl = libcrypto.EVP_CIPHER_CTX_ctrl
    EVP_EncryptUpdate = libcrypto.EVP_EncryptUpdate
    EVP_EncryptFinal_ex = libcrypto.EVP_EncryptFinal_ex

    EVP_CTRL_GCM_GET_TAG = 0x10

    nonce = secrets.token_bytes(12)
    nonce_buf = ctypes.create_string_buffer(nonce, len(nonce))
    if EVP_EncryptInit_ex(ctx, None, None, key_buf, nonce_buf) != 1:
        raise RuntimeError("EVP_EncryptInit_ex failed (stage 2)")

    out_buf = ctypes.create_string_buffer(len(plaintext) + 16)
    out_len = ctypes.c_int(0)
    if len(plaintext):
        pt_buf = ctypes.create_string_buffer(plaintext, len(plaintext))
        if EVP_EncryptUpdate(ctx, out_buf, ctypes.byref(out_len), pt_buf, len(plaintext)) != 1:
            raise RuntimeError("EVP_EncryptUpdate failed")
    total = out_len.value

    final_len = ctypes.c_int(0)
    if EVP_EncryptFinal_ex(ctx, ctypes.byref(out_buf, total), ctypes.byref(final_len)) != 1:
        raise RuntimeError("EVP_EncryptFinal_ex failed")
    total += final_len.value

    tag_buf = ctypes.create_string_buffer(16)
    if EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_GET_TAG, 16, tag_buf) != 1:
        raise RuntimeError("EVP_CTRL_GCM_GET_TAG failed")

    global _last_nonce_for_fallback
    _last_nonce_for_fallback = bytes(nonce)
    ciphertext = out_buf.raw[:total]
    tag = tag_buf.raw[:16]
    return ciphertext + tag


_last_nonce_for_fallback = None

def must(cond, msg):
    if not cond:
        raise SystemExit(msg)

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
    # roomCode is optional: generated later when packs are uploaded
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
        # ensure no legacy interlude leftovers
        rd.pop("interlude", None)
    pack["rounds"] = rounds
    return pack

def validate_final(pack: dict):
    must(pack["version"] == "jemima-questions-1", "Questions: version must be 'jemima-questions-1'")
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
    nonce = secrets.token_bytes(12) if AES is not None else None
    plaintext = js(payload).encode("utf-8")
    ct = encrypt_aes_gcm(key, nonce if nonce is not None else b"", plaintext)
    if nonce is None:
        global _last_nonce_for_fallback
        nonce = _last_nonce_for_fallback
        if not nonce:
            raise RuntimeError("Fallback nonce missing")

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
    room_code = pack["meta"].get("roomCode")
    print("roomCode:", room_code or "<generated after upload>")
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

    if len(sys.argv) > 2:
        out_path = sys.argv[2]
    else:
        room_code = pack["meta"].get("roomCode")
        fallback_name = f"{Path(in_path).stem}-questions.sealed"
        out_path = f"{room_code}-questions.sealed" if room_code else fallback_name
    seal(pack, out_path)

if __name__ == "__main__":
    main()