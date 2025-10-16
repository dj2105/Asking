#!/usr/bin/env python3
import sys, json, base64, hashlib, secrets
from Crypto.Cipher import AES
from Crypto.Protocol.KDF import PBKDF2
from Crypto.Hash import SHA256

PASSWORD = b"DEMO-ONLY"

def js(o): return json.dumps(o, separators=(",", ":"), ensure_ascii=False)

def main():
    if len(sys.argv) < 2:
        print("Usage: encrypt_full_pack.py <plaintext.json> [OUT.sealed]")
        sys.exit(1)
    in_path = sys.argv[1]
    with open(in_path, "r", encoding="utf-8") as f:
        pack = json.load(f)

    # Ensure version + meta fields exist
    pack["version"] = "jemima-pack-1"
    meta = pack.get("meta", {})
    if "roomCode" not in meta:
        raise SystemExit("meta.roomCode is required (3-letter uppercase).")
    meta.setdefault("generatedAt", "1970-01-01T00:00:00Z")
    meta.setdefault("hostUid", "demo-host")
    meta.setdefault("guestUid", "demo-guest")
    pack["meta"] = meta

    # Remove any pre-existing integrity before hashing
    pack.pop("integrity", None)

    checksum = hashlib.sha256(js(pack).encode("utf-8")).hexdigest()
    pack["integrity"] = {"checksum": checksum, "verified": True}

    # KDF + AES-GCM
    salt = secrets.token_bytes(16)
    nonce = secrets.token_bytes(12)
    key = PBKDF2(PASSWORD, salt, dkLen=32, count=150000, hmac_hash_module=SHA256)
    cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
    ciphertext, tag = cipher.encrypt_and_digest(js(pack).encode("utf-8"))
    ct = ciphertext + tag

    envelope = {
        "alg": "AES-GCM",
        "pbkdf2": "PBKDF2-HMAC-SHA256/150000",
        "salt_b64": base64.b64encode(salt).decode(),
        "nonce_b64": base64.b64encode(nonce).decode(),
        "ct_b64": base64.b64encode(ct).decode()
    }

    out_path = sys.argv[2] if len(sys.argv) > 2 else f"{meta['roomCode']}.sealed"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(envelope, f, ensure_ascii=False, indent=2)

    print("Wrote:", out_path)
    print("roomCode:", meta["roomCode"])
    print("generatedAt:", meta["generatedAt"])
    print("checksum:", checksum)

if __name__ == "__main__":
    main()
