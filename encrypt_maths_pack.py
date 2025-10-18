#!/usr/bin/env python3
import base64
import ctypes
import ctypes.util
import hashlib
import json
import secrets
import sys

PASSWORD = b"DEMO-ONLY"
PBKDF2_ROUNDS = 150000


def js(obj):
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def pbkdf2(password: bytes, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password, salt, PBKDF2_ROUNDS, dklen=32)


class AesGcmCipher:
    EVP_CTRL_GCM_SET_IVLEN = 0x9
    EVP_CTRL_GCM_GET_TAG = 0x10

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
        self.lib.EVP_EncryptInit_ex.argtypes = [
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_void_p,
        ]
        self.lib.EVP_EncryptInit_ex.restype = ctypes.c_int
        self.lib.EVP_EncryptUpdate.argtypes = [
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_int),
            ctypes.c_void_p,
            ctypes.c_int,
        ]
        self.lib.EVP_EncryptUpdate.restype = ctypes.c_int
        self.lib.EVP_EncryptFinal_ex.argtypes = [
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_int),
        ]
        self.lib.EVP_EncryptFinal_ex.restype = ctypes.c_int
        self.lib.EVP_CIPHER_CTX_ctrl.argtypes = [
            ctypes.c_void_p,
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_void_p,
        ]
        self.lib.EVP_CIPHER_CTX_ctrl.restype = ctypes.c_int

    def encrypt(self, key: bytes, nonce: bytes, plaintext: bytes) -> bytes:
        ctx = self.lib.EVP_CIPHER_CTX_new()
        if not ctx:
            raise RuntimeError("EVP_CIPHER_CTX_new failed")
        try:
            cipher = self.lib.EVP_aes_256_gcm()
            if self.lib.EVP_EncryptInit_ex(ctx, cipher, None, None, None) != 1:
                raise RuntimeError("EVP_EncryptInit_ex failed")
            if (
                self.lib.EVP_CIPHER_CTX_ctrl(
                    ctx, self.EVP_CTRL_GCM_SET_IVLEN, len(nonce), None
                )
                != 1
            ):
                raise RuntimeError("EVP_CIPHER_CTX_ctrl set IV length failed")
            key_buf = ctypes.create_string_buffer(key)
            nonce_buf = ctypes.create_string_buffer(nonce)
            if self.lib.EVP_EncryptInit_ex(ctx, None, None, key_buf, nonce_buf) != 1:
                raise RuntimeError("EVP_EncryptInit_ex key/iv failed")
            out_buf = ctypes.create_string_buffer(len(plaintext) + 16)
            out_len = ctypes.c_int(0)
            pt_buf = ctypes.create_string_buffer(plaintext)
            if (
                self.lib.EVP_EncryptUpdate(
                    ctx, out_buf, ctypes.byref(out_len), pt_buf, len(plaintext)
                )
                != 1
            ):
                raise RuntimeError("EVP_EncryptUpdate failed")
            total = out_len.value
            final_len = ctypes.c_int(0)
            if self.lib.EVP_EncryptFinal_ex(
                ctx, ctypes.byref(out_buf, total), ctypes.byref(final_len)
            ) != 1:
                raise RuntimeError("EVP_EncryptFinal_ex failed")
            total += final_len.value
            tag_buf = ctypes.create_string_buffer(16)
            if (
                self.lib.EVP_CIPHER_CTX_ctrl(
                    ctx, self.EVP_CTRL_GCM_GET_TAG, 16, tag_buf
                )
                != 1
            ):
                raise RuntimeError("EVP_CIPHER_CTX_ctrl get tag failed")
            return out_buf.raw[:total] + tag_buf.raw
        finally:
            self.lib.EVP_CIPHER_CTX_free(ctx)


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: encrypt_maths_pack.py <maths.json> [OUT.sealed]")
        sys.exit(1)
    in_path = sys.argv[1]
    with open(in_path, "r", encoding="utf-8") as f:
        payload = json.load(f)

    payload.setdefault("version", "jemima-maths-1")
    meta = payload.get("meta", {})
    if "roomCode" not in meta:
        raise SystemExit("meta.roomCode is required (3-letter uppercase).")
    meta.setdefault("generatedAt", "1970-01-01T00:00:00Z")
    meta.setdefault("hostUid", "demo-host")
    meta.setdefault("guestUid", "demo-guest")
    payload["meta"] = meta

    payload.pop("integrity", None)
    checksum = hashlib.sha256(js(payload).encode("utf-8")).hexdigest()
    payload["integrity"] = {"checksum": checksum, "verified": True}

    salt = secrets.token_bytes(16)
    nonce = secrets.token_bytes(12)
    key = pbkdf2(PASSWORD, salt)
    cipher = AesGcmCipher()
    ct = cipher.encrypt(key, nonce, js(payload).encode("utf-8"))

    envelope = {
        "alg": "AES-GCM",
        "pbkdf2": "PBKDF2-HMAC-SHA256/150000",
        "salt_b64": base64.b64encode(salt).decode(),
        "nonce_b64": base64.b64encode(nonce).decode(),
        "ct_b64": base64.b64encode(ct).decode(),
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
