#!/usr/bin/env python3
import sys, json, base64, hashlib, secrets, re
from datetime import datetime, timezone
from Crypto.Cipher import AES
from Crypto.Protocol.KDF import PBKDF2
from Crypto.Hash import SHA256

PASSWORD = b"DEMO-ONLY"
ALLOWED_VERSIONS = {"jemima-maths-1", "jemima-maths-chain-1"}

def js(o): return json.dumps(o, separators=(",", ":"), ensure_ascii=False)

def main():
    if len(sys.argv) < 1:
        print("Usage: encrypt_maths_pack.py <maths.json> [OUT.sealed]")
        sys.exit(1)
    in_path = sys.argv[1]
    with open(in_path, "r", encoding="utf-8") as f:
        payload = json.load(f)

    version = payload.get("version") or "jemima-maths-1"
    if version not in ALLOWED_VERSIONS:
        raise SystemExit("Unsupported maths pack version: %s" % version)
    payload["version"] = version
    meta = payload.get("meta", {})
    room_code = meta.get("roomCode")
    if not isinstance(room_code, str) or not re.fullmatch(r"[A-Z]{3}", room_code):
        raise SystemExit("meta.roomCode is required (3 uppercase letters).")
    if "generatedAt" not in meta:
        meta["generatedAt"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    meta.setdefault("hostUid", "demo-host")
    meta.setdefault("guestUid", "demo-guest")
    payload["meta"] = meta

    payload.pop("integrity", None)
    checksum = hashlib.sha256(js(payload).encode("utf-8")).hexdigest()
    payload["integrity"] = {"checksum": checksum, "verified": True}

    salt = secrets.token_bytes(16)
    nonce = secrets.token_bytes(12)
    key = PBKDF2(PASSWORD, salt, dkLen=32, count=150000, hmac_hash_module=SHA256)
    cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
    ciphertext, tag = cipher.encrypt_and_digest(js(payload).encode("utf-8"))
    ct = ciphertext + tag

    envelope = {
        "alg": "AES-GCM",
        "pbkdf2": "PBKDF2-HMAC-SHA256/150000",
        "salt_b64": base64.b64encode(salt).decode(),
        "nonce_b64": base64.b64encode(nonce).decode(),
        "ct_b64": base64.b64encode(ct).decode()
    }

    out_path = sys.argv[2] if len(sys.argv) > 2 else f"{meta['roomCode']}-maths.sealed"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(envelope, f, ensure_ascii=False, indent=2)

    print("Wrote:", out_path)
    print("roomCode:", meta["roomCode"])
    print("generatedAt:", meta["generatedAt"])
    print("checksum:", checksum)

if __name__ == "__main__":
    main()
