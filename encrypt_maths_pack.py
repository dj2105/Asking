#!/usr/bin/env python3
"""
encrypt_maths_pack.py

Seal a Jemima maths pack JSON using AES-256-GCM with PBKDF2-HMAC-SHA256 (150k).
Supports the timeline spec ("jemima-maths-timeline-1").

Output: <ROOM>-maths.sealed
"""

import sys, json, base64, hashlib, secrets, re
from datetime import datetime, timezone

# ---- Optional fast path via PyCryptodome; falls back to ctypes/OpenSSL ----
try:
    from Crypto.Cipher import AES  # type: ignore
    from Crypto.Protocol.KDF import PBKDF2  # type: ignore
    from Crypto.Hash import SHA256  # type: ignore
except ModuleNotFoundError:  # pragma: no cover
    AES = None
    PBKDF2 = None
    SHA256 = None

PASSWORD = b"DEMO-ONLY"           # <-- replace in production
PBKDF2_ROUNDS = 150_000
ALLOWED_VERSIONS = {"jemima-maths-timeline-1"}
DEFAULT_VERSION = "jemima-maths-timeline-1"

# ------------------------- helpers & crypto -------------------------

def js(o) -> str:
    return json.dumps(o, separators=(",", ":"), ensure_ascii=False)

def derive_key(password: bytes, salt: bytes) -> bytes:
    if PBKDF2 is not None and SHA256 is not None:
        return PBKDF2(password, salt, dkLen=32, count=PBKDF2_ROUNDS, hmac_hash_module=SHA256)
    return hashlib.pbkdf2_hmac("sha256", password, salt, PBKDF2_ROUNDS, dklen=32)

def encrypt_aes_gcm(key: bytes, nonce: bytes, plaintext: bytes) -> bytes:
    # PyCryptodome fast path
    if AES is not None:
        cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
        ciphertext, tag = cipher.encrypt_and_digest(plaintext)
        return ciphertext + tag

    # ctypes/OpenSSL fallback
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

        # init ctx
        if EVP_EncryptInit_ex(ctx, EVP_aes_256_gcm(), None, None, None) != 1:
            raise RuntimeError("EVP_EncryptInit_ex failed (stage 1)")
        if EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, 12, None) != 1:
            raise RuntimeError("EVP_CTRL_GCM_SET_IVLEN failed")

        key_buf = ctypes.create_string_buffer(key, len(key))
        # Nonce will be set later
        out_len = ctypes.c_int(0)

        # set key & nonce
        # We'll pass nonce when calling EncryptInit_ex again below
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

    # We need to return ciphertext+tag, but also expose nonce to the envelope.
    # Since this path is only used when PyCryptodome is unavailable (rare here),
    # we stash the nonce globally and read it back in seal().
    global _last_nonce_for_fallback
    _last_nonce_for_fallback = bytes(nonce)
    ciphertext = out_buf.raw[:total]
    tag = tag_buf.raw[:16]
    return ciphertext + tag

_last_nonce_for_fallback = None  # used only in OpenSSL fallback

# --------------------------- validation ---------------------------

def must(cond, msg):
    if not cond:
        raise SystemExit(msg)

def room_ok(s: str) -> bool:
    return bool(re.fullmatch(r"[A-Z]{3}", s or ""))

def validate_chain_pack(p: dict):
    must(p.get("version") == "jemima-maths-timeline-1", "Wrong version for maths pack.")
    maths = p.get("maths") or {}
    events = maths.get("events")
    must(isinstance(events, list) and len(events) == 5, "Maths: need exactly 5 events.")
    last = 0
    total = 0
    for idx, evt in enumerate(events, start=1):
        must(isinstance(evt, dict), f"Maths event {idx} missing.")
        must(isinstance(evt.get("prompt"), str) and evt["prompt"].strip(), f"Maths event {idx} prompt missing.")
        must(isinstance(evt.get("year"), int) and 1 <= evt["year"] <= 2025, f"Maths event {idx} year invalid.")
        must(idx == 1 or evt["year"] > last, "Events must be chronological")
        last = evt["year"]
        total += evt["year"]
    if maths.get("total") is not None:
        must(maths["total"] == total, "Maths total must match summed years.")
    must(isinstance(maths.get("question"), str) and maths["question"].strip(), "Maths: question missing.")

# ------------------------------ main ------------------------------

def main():
    if len(sys.argv) < 2:
        print("Usage: encrypt_maths_pack.py <maths.json> [OUT.sealed]")
        sys.exit(1)

    in_path = sys.argv[1]
    with open(in_path, "r", encoding="utf-8") as f:
        pack = json.load(f)

    # Ensure version
    ver = pack.get("version") or DEFAULT_VERSION
    pack["version"] = ver
    must(ver in ALLOWED_VERSIONS, f"Unsupported version: {ver}")

    # Minimal meta hygiene
    meta = pack.get("meta") or {}
    room_code = meta.get("roomCode")
    must(room_ok(room_code), "meta.roomCode is required (3 uppercase letters, e.g. 'CAT').")
    if "generatedAt" not in meta:
        meta["generatedAt"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    meta.setdefault("hostUid", "demo-host")
    meta.setdefault("guestUid", "demo-guest")
    pack["meta"] = meta

    # Validation
    validate_chain_pack(pack)

    # Integrity
    payload = dict(pack)
    payload.pop("integrity", None)
    checksum = hashlib.sha256(js(payload).encode("utf-8")).hexdigest()
    payload["integrity"] = {"checksum": checksum, "verified": True}

    # Seal
    salt = secrets.token_bytes(16)
    key = derive_key(PASSWORD, salt)
    nonce = secrets.token_bytes(12) if AES is not None else None
    plaintext = js(payload).encode("utf-8")
    ct = encrypt_aes_gcm(key, nonce if nonce is not None else b"", plaintext)
    if nonce is None:
        # took OpenSSL fallback path; nonce captured globally
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

    out_path = sys.argv[2] if len(sys.argv) > 2 else f"{meta['roomCode']}-maths.sealed"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(envelope, f, ensure_ascii=False, indent=2)

    print("Wrote:", out_path)
    print("roomCode:", meta["roomCode"])
    print("version:", ver)
    print("generatedAt:", meta["generatedAt"])
    print("checksum:", checksum)

if __name__ == "__main__":
    main()
