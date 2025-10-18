#!/usr/bin/env python3
import sys, json, base64, hashlib, secrets

try:
    from Crypto.Cipher import AES  # type: ignore
    from Crypto.Protocol.KDF import PBKDF2  # type: ignore
    from Crypto.Hash import SHA256  # type: ignore
except ModuleNotFoundError:  # pragma: no cover - fallback when PyCryptodome unavailable
    AES = None
    PBKDF2 = None
    SHA256 = None

PASSWORD = b"DEMO-ONLY"
ALLOWED_VERSIONS = {"jemima-maths-1", "jemima-maths-chain-1"}

PACK_VERSION = "jemima-maths-chain-1"


def js(o):
    return json.dumps(o, separators=(",", ":"), ensure_ascii=False)


def derive_key(password: bytes, salt: bytes) -> bytes:
    if PBKDF2 is not None and SHA256 is not None:
        return PBKDF2(password, salt, dkLen=32, count=150000, hmac_hash_module=SHA256)
    return hashlib.pbkdf2_hmac("sha256", password, salt, 150000, dklen=32)


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

    EVP_CIPHER_CTX_free = None

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

        EVP_CIPHER_CTX_free = libcrypto.EVP_CIPHER_CTX_free
        EVP_CIPHER_CTX_free.argtypes = [ctypes.c_void_p]
        EVP_CIPHER_CTX_free.restype = None

        if EVP_EncryptInit_ex(ctx, EVP_aes_256_gcm(), None, None, None) != 1:
            raise RuntimeError("EVP_EncryptInit_ex failed (stage 1)")
        if EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, len(nonce), None) != 1:
            raise RuntimeError("EVP_CTRL_GCM_SET_IVLEN failed")

        key_buf = ctypes.create_string_buffer(key, len(key))
        nonce_buf = ctypes.create_string_buffer(nonce, len(nonce))
        key_ptr = ctypes.cast(key_buf, ctypes.c_void_p)
        nonce_ptr = ctypes.cast(nonce_buf, ctypes.c_void_p)
        if EVP_EncryptInit_ex(ctx, None, None, key_ptr, nonce_ptr) != 1:
            raise RuntimeError("EVP_EncryptInit_ex failed (stage 2)")

        out_buf = ctypes.create_string_buffer(len(plaintext) + 16)
        out_ptr = ctypes.cast(out_buf, ctypes.c_void_p)
        out_len = ctypes.c_int(0)
        plaintext_buf = ctypes.create_string_buffer(plaintext, len(plaintext))
        plaintext_ptr = ctypes.cast(plaintext_buf, ctypes.c_void_p) if len(plaintext) else None
        if len(plaintext):
            if EVP_EncryptUpdate(ctx, out_ptr, ctypes.byref(out_len), plaintext_ptr, len(plaintext)) != 1:
                raise RuntimeError("EVP_EncryptUpdate failed")
        ciphertext = out_buf.raw[:out_len.value]

        final_buf = ctypes.create_string_buffer(16)
        final_ptr = ctypes.cast(final_buf, ctypes.c_void_p)
        final_len = ctypes.c_int(0)
        if EVP_EncryptFinal_ex(ctx, final_ptr, ctypes.byref(final_len)) != 1:
            raise RuntimeError("EVP_EncryptFinal_ex failed")
        ciphertext += final_buf.raw[:final_len.value]

        tag_buf = ctypes.create_string_buffer(16)
        tag_ptr = ctypes.cast(tag_buf, ctypes.c_void_p)
        if EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_GET_TAG, 16, tag_ptr) != 1:
            raise RuntimeError("EVP_CTRL_GCM_GET_TAG failed")
        tag = tag_buf.raw[:16]
        return ciphertext + tag
    finally:
        if EVP_CIPHER_CTX_free is not None:
            EVP_CIPHER_CTX_free(ctypes.c_void_p(ctx))
        else:
            libcrypto.EVP_CIPHER_CTX_free(ctypes.c_void_p(ctx))

def main():
    if len(sys.argv) < 1:
        print("Usage: encrypt_maths_pack.py <maths.json> [OUT.sealed]")
        sys.exit(1)
    in_path = sys.argv[1]
    with open(in_path, "r", encoding="utf-8") as f:
        payload = json.load(f)

    payload["version"] = PACK_VERSION
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
    key = derive_key(PASSWORD, salt)
    ct = encrypt_aes_gcm(key, nonce, js(payload).encode("utf-8"))

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
