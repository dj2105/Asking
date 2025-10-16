#!/usr/bin/env python3
import sys, json, base64, hashlib
from Crypto.Cipher import AES
from Crypto.Protocol.KDF import PBKDF2
from Crypto.Hash import SHA256

PASSWORD = b"DEMO-ONLY"

def audit_pack(data):
    report = {}
    report["version"] = data.get("version")
    meta = data.get("meta", {})
    report["meta"] = {k: meta.get(k) for k in ("roomCode","generatedAt")}
    if data.get("version") == "jemima-pack-1":
        rounds = data.get("rounds", [])
        report["rounds_count"] = len(rounds)
        if isinstance(rounds, list):
            report["items_total"] = sum(len(r.get("hostItems",[]))+len(r.get("guestItems",[])) for r in rounds)
    if "maths" in data:
        m = data["maths"]
        report["maths_ok"] = isinstance(m.get("beats",[]), list) and len(m.get("answers",[])) == 2
    # checksum
    clone = dict(data)
    clone.pop("integrity", None)
    canonical = json.dumps(clone, separators=(",", ":"), ensure_ascii=False)
    report["checksum_ok"] = (hashlib.sha256(canonical.encode()).hexdigest() == data.get("integrity",{}).get("checksum"))
    return report

def main():
    if len(sys.argv) < 2:
        print("Usage: unseal_check.py <FILE.sealed>")
        sys.exit(1)
    path = sys.argv[1]
    with open(path, "r", encoding="utf-8") as f:
        env = json.load(f)

    salt = base64.b64decode(env["salt_b64"])
    nonce = base64.b64decode(env["nonce_b64"])
    ct = base64.b64decode(env["ct_b64"])

    key = PBKDF2(PASSWORD, salt, dkLen=32, count=150000, hmac_hash_module=SHA256)
    cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
    pt = cipher.decrypt(ct[:-16])
    cipher.verify(ct[-16:])

    data = json.loads(pt.decode("utf-8"))
    print(json.dumps(audit_pack(data), indent=2))

if __name__ == "__main__":
    main()
