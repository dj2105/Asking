#!/usr/bin/env python3
import sys, json, base64, hashlib, secrets, ctypes, ctypes.util

PASSWORD = b"DEMO-ONLY"

libcrypto_path = ctypes.util.find_library("crypto")
if not libcrypto_path:
    raise SystemExit("OpenSSL libcrypto not found; cannot perform AES-GCM encryption.")
libcrypto = ctypes.CDLL(libcrypto_path)

EVP_CIPHER_CTX_new = libcrypto.EVP_CIPHER_CTX_new
EVP_CIPHER_CTX_new.restype = ctypes.c_void_p

EVP_CIPHER_CTX_free = libcrypto.EVP_CIPHER_CTX_free
EVP_CIPHER_CTX_free.argtypes = [ctypes.c_void_p]

EVP_aes_256_gcm = libcrypto.EVP_aes_256_gcm
EVP_aes_256_gcm.restype = ctypes.c_void_p

EVP_EncryptInit_ex = libcrypto.EVP_EncryptInit_ex
EVP_EncryptInit_ex.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
EVP_EncryptInit_ex.restype = ctypes.c_int

EVP_EncryptUpdate = libcrypto.EVP_EncryptUpdate
EVP_EncryptUpdate.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_int), ctypes.c_void_p, ctypes.c_int]
EVP_EncryptUpdate.restype = ctypes.c_int

EVP_EncryptFinal_ex = libcrypto.EVP_EncryptFinal_ex
EVP_EncryptFinal_ex.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_int)]
EVP_EncryptFinal_ex.restype = ctypes.c_int

EVP_CIPHER_CTX_ctrl = libcrypto.EVP_CIPHER_CTX_ctrl
EVP_CIPHER_CTX_ctrl.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
EVP_CIPHER_CTX_ctrl.restype = ctypes.c_int

EVP_CTRL_GCM_SET_IVLEN = 0x9
EVP_CTRL_GCM_GET_TAG = 0x10


def aes_gcm_encrypt(key: bytes, nonce: bytes, plaintext: bytes, aad: bytes = b"") -> bytes:
    ctx = EVP_CIPHER_CTX_new()
    if not ctx:
        raise SystemExit("Unable to allocate cipher context.")
    try:
        if EVP_EncryptInit_ex(ctx, EVP_aes_256_gcm(), None, None, None) != 1:
            raise SystemExit("EVP_EncryptInit_ex failed (stage 1).")
        if EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, len(nonce), None) != 1:
            raise SystemExit("Failed to set IV length for AES-GCM.")

        key_buf = (ctypes.c_ubyte * len(key)).from_buffer_copy(key)
        nonce_buf = (ctypes.c_ubyte * len(nonce)).from_buffer_copy(nonce)
        if EVP_EncryptInit_ex(
            ctx,
            None,
            None,
            ctypes.c_void_p(ctypes.addressof(key_buf)),
            ctypes.c_void_p(ctypes.addressof(nonce_buf)),
        ) != 1:
            raise SystemExit("EVP_EncryptInit_ex failed (stage 2).")

        if aad:
            aad_buf = (ctypes.c_ubyte * len(aad)).from_buffer_copy(aad)
            tmp = ctypes.c_int(0)
            if EVP_EncryptUpdate(
                ctx,
                None,
                ctypes.byref(tmp),
                ctypes.c_void_p(ctypes.addressof(aad_buf)),
                len(aad),
            ) != 1:
                raise SystemExit("EVP_EncryptUpdate failed for AAD.")

        out_capacity = len(plaintext) + 16
        out_buf = (ctypes.c_ubyte * out_capacity)()
        out_len = ctypes.c_int(0)
        ciphertext = b""
        if plaintext:
            plaintext_buf = (ctypes.c_ubyte * len(plaintext)).from_buffer_copy(plaintext)
            if EVP_EncryptUpdate(
                ctx,
                ctypes.c_void_p(ctypes.addressof(out_buf)),
                ctypes.byref(out_len),
                ctypes.c_void_p(ctypes.addressof(plaintext_buf)),
                len(plaintext),
            ) != 1:
                raise SystemExit("EVP_EncryptUpdate failed for plaintext.")
            ciphertext = bytes(out_buf)[: out_len.value]

        final_buf = (ctypes.c_ubyte * 16)()
        final_len = ctypes.c_int(0)
        if EVP_EncryptFinal_ex(
            ctx,
            ctypes.c_void_p(ctypes.addressof(final_buf)),
            ctypes.byref(final_len),
        ) != 1:
            raise SystemExit("EVP_EncryptFinal_ex failed.")
        if final_len.value:
            ciphertext += bytes(final_buf)[: final_len.value]

        tag_buf = (ctypes.c_ubyte * 16)()
        if (
            EVP_CIPHER_CTX_ctrl(
                ctx,
                EVP_CTRL_GCM_GET_TAG,
                16,
                ctypes.c_void_p(ctypes.addressof(tag_buf)),
            )
            != 1
        ):
            raise SystemExit("Failed to retrieve AES-GCM authentication tag.")
        tag = bytes(tag_buf)
        return ciphertext + tag
    finally:
        EVP_CIPHER_CTX_free(ctx)

def js(o): return json.dumps(o, separators=(",", ":"), ensure_ascii=False)

def main():
    if len(sys.argv) < 2:
        print("Usage: encrypt_maths_pack.py <maths.json> [OUT.sealed]")
        sys.exit(1)
    in_path = sys.argv[1]
    with open(in_path, "r", encoding="utf-8") as f:
        payload = json.load(f)

    version = payload.get("version")
    if version is None:
        version = "jemima-maths-1"
    elif version not in {"jemima-maths-1", "jemima-maths-chain-1"}:
        raise SystemExit(
            "Unsupported maths pack version. Expected 'jemima-maths-1' or 'jemima-maths-chain-1'."
        )
    payload["version"] = version
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
    key = hashlib.pbkdf2_hmac("sha256", PASSWORD, salt, 150000, dklen=32)
    ct = aes_gcm_encrypt(key, nonce, js(payload).encode("utf-8"))

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
