#!/usr/bin/env python3
import base64
import ctypes
import ctypes.util
import hashlib
import json
import sys

PASSWORD = b"DEMO-ONLY"
PBKDF2_ROUNDS = 150000


def js(obj):
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def pbkdf2(password: bytes, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password, salt, PBKDF2_ROUNDS, dklen=32)


class AesGcmCipher:
    EVP_CTRL_GCM_SET_IVLEN = 0x9
    EVP_CTRL_GCM_SET_TAG = 0x11

    def __init__(self) -> None:
        path = ctypes.util.find_library("crypto")
        if not path:
            raise RuntimeError("OpenSSL libcrypto not found")
        self.lib = ctypes.CDLL(path)
        self._configure()

    def _configure(self) -> None:
        self.lib.EVP_aes_256_gcm.restype = ctypes.c_void_p
        self.lib.EVP_CIPHER_CTX_new.restype = ctypes.c_void_p
        self.lib.EVP_CIPHER_CTX_new.argtypes = []
        self.lib.EVP_CIPHER_CTX_free.argtypes = [ctypes.c_void_p]
        self.lib.EVP_DecryptInit_ex.argtypes = [
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_void_p,
        ]
        self.lib.EVP_DecryptInit_ex.restype = ctypes.c_int
        self.lib.EVP_DecryptUpdate.argtypes = [
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_int),
            ctypes.c_void_p,
            ctypes.c_int,
        ]
        self.lib.EVP_DecryptUpdate.restype = ctypes.c_int
        self.lib.EVP_DecryptFinal_ex.argtypes = [
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_int),
        ]
        self.lib.EVP_DecryptFinal_ex.restype = ctypes.c_int
        self.lib.EVP_CIPHER_CTX_ctrl.argtypes = [
            ctypes.c_void_p,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_void_p,
        ]
        self.lib.EVP_CIPHER_CTX_ctrl.restype = ctypes.c_int

    def decrypt(self, key: bytes, nonce: bytes, ciphertext: bytes, tag: bytes) -> bytes:
        ctx = self.lib.EVP_CIPHER_CTX_new()
        if not ctx:
            raise RuntimeError("EVP_CIPHER_CTX_new failed")
        try:
            cipher = self.lib.EVP_aes_256_gcm()
            if self.lib.EVP_DecryptInit_ex(ctx, cipher, None, None, None) != 1:
                raise RuntimeError("EVP_DecryptInit_ex failed")
            if self.lib.EVP_CIPHER_CTX_ctrl(
                ctx, self.EVP_CTRL_GCM_SET_IVLEN, len(nonce), None
            ) != 1:
                raise RuntimeError("EVP_CIPHER_CTX_ctrl set IV length failed")
            key_buf = ctypes.create_string_buffer(key)
            nonce_buf = ctypes.create_string_buffer(nonce)
            if self.lib.EVP_DecryptInit_ex(ctx, None, None, key_buf, nonce_buf) != 1:
                raise RuntimeError("EVP_DecryptInit_ex key/iv failed")
            out_buf = ctypes.create_string_buffer(len(ciphertext))
            out_len = ctypes.c_int(0)
            ct_buf = ctypes.create_string_buffer(ciphertext)
            if (
                self.lib.EVP_DecryptUpdate(
                    ctx, out_buf, ctypes.byref(out_len), ct_buf, len(ciphertext)
                )
                != 1
            ):
                raise RuntimeError("EVP_DecryptUpdate failed")
            total = out_len.value
            tag_buf = ctypes.create_string_buffer(tag)
            if self.lib.EVP_CIPHER_CTX_ctrl(
                ctx, self.EVP_CTRL_GCM_SET_TAG, len(tag), tag_buf
            ) != 1:
                raise RuntimeError("EVP_CIPHER_CTX_ctrl set tag failed")
            final_len = ctypes.c_int(0)
            if self.lib.EVP_DecryptFinal_ex(
                ctx, ctypes.byref(out_buf, total), ctypes.byref(final_len)
            ) != 1:
                raise RuntimeError("EVP_DecryptFinal_ex verification failed")
            total += final_len.value
            return out_buf.raw[:total]
        finally:
            self.lib.EVP_CIPHER_CTX_free(ctx)


def audit_pack(data):
    report = {}
    report["version"] = data.get("version")
    meta = data.get("meta", {})
    report["meta"] = {k: meta.get(k) for k in ("roomCode", "generatedAt")}
    if data.get("version") == "jemima-pack-1":
        rounds = data.get("rounds", [])
        report["rounds_count"] = len(rounds)
        if isinstance(rounds, list):
            report["items_total"] = sum(
                len(r.get("hostItems", [])) + len(r.get("guestItems", [])) for r in rounds
            )
    if "maths" in data:
        m = data["maths"]
        report["maths_ok"] = isinstance(m.get("beats", []), list) and len(m.get("answers", [])) == 2
    clone = dict(data)
    clone.pop("integrity", None)
    canonical = js(clone)
    report["checksum_ok"] = (
        hashlib.sha256(canonical.encode()).hexdigest()
        == data.get("integrity", {}).get("checksum")
    )
    return report


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: unseal_check.py <FILE.sealed>")
        sys.exit(1)
    path = sys.argv[1]
    with open(path, "r", encoding="utf-8") as f:
        env = json.load(f)

    salt = base64.b64decode(env["salt_b64"])
    nonce = base64.b64decode(env["nonce_b64"])
    ct = base64.b64decode(env["ct_b64"])
    ciphertext, tag = ct[:-16], ct[-16:]

    key = pbkdf2(PASSWORD, salt)
    cipher = AesGcmCipher()
    plaintext = cipher.decrypt(key, nonce, ciphertext, tag)

    data = json.loads(plaintext.decode("utf-8"))
    print(json.dumps(audit_pack(data), indent=2))


if __name__ == "__main__":
    main()
