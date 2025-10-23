#!/usr/bin/env python3
"""Encrypt pack JSON files into sealed envelopes.

This script reads all `.json` files in the target directory (default `packs/out`),
canonicalises their content, encrypts them with AES-256-GCM using a PBKDF2-derived
key, and writes `.sealed` envelope files alongside them. By default the source
JSON files are removed once their sealed counterparts have been written
successfully. Use `--keep-json` to retain the originals.
"""

from __future__ import annotations

import argparse
import base64
import ctypes
import ctypes.util
import hashlib
import json
import os
from pathlib import Path
from typing import Iterable

EVP_CTRL_GCM_SET_IVLEN = 0x9
EVP_CTRL_GCM_GET_TAG = 0x10


class EncryptionError(RuntimeError):
    """Raised when OpenSSL reports a failure."""


def _load_libcrypto() -> ctypes.CDLL:
    path = ctypes.util.find_library("crypto")
    if not path:
        raise EncryptionError("Unable to locate libcrypto shared library.")
    return ctypes.CDLL(path)


def _prepare_crypto_functions(libcrypto: ctypes.CDLL) -> None:
    """Configure argument and return types for the OpenSSL functions we use."""

    libcrypto.EVP_CIPHER_CTX_new.restype = ctypes.c_void_p
    libcrypto.EVP_CIPHER_CTX_free.argtypes = [ctypes.c_void_p]

    libcrypto.EVP_aes_256_gcm.restype = ctypes.c_void_p

    libcrypto.EVP_EncryptInit_ex.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
    ]
    libcrypto.EVP_EncryptInit_ex.restype = ctypes.c_int

    libcrypto.EVP_EncryptUpdate.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_int),
        ctypes.c_void_p,
        ctypes.c_int,
    ]
    libcrypto.EVP_EncryptUpdate.restype = ctypes.c_int

    libcrypto.EVP_EncryptFinal_ex.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_int),
    ]
    libcrypto.EVP_EncryptFinal_ex.restype = ctypes.c_int

    libcrypto.EVP_CIPHER_CTX_ctrl.argtypes = [
        ctypes.c_void_p,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_void_p,
    ]
    libcrypto.EVP_CIPHER_CTX_ctrl.restype = ctypes.c_int


def _aes_gcm_encrypt(libcrypto: ctypes.CDLL, key: bytes, iv: bytes, plaintext: bytes) -> bytes:
    """Encrypt *plaintext* using AES-256-GCM via OpenSSL's EVP API."""

    if len(key) != 32:
        raise ValueError("AES-256-GCM requires a 32-byte key.")
    if len(iv) != 12:
        raise ValueError("AES-256-GCM requires a 12-byte nonce/IV.")

    ctx = libcrypto.EVP_CIPHER_CTX_new()
    if not ctx:
        raise EncryptionError("Failed to create EVP_CIPHER_CTX.")

    try:
        if libcrypto.EVP_EncryptInit_ex(ctx, libcrypto.EVP_aes_256_gcm(), None, None, None) != 1:
            raise EncryptionError("EVP_EncryptInit_ex (setup) failed.")

        if libcrypto.EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, len(iv), None) != 1:
            raise EncryptionError("Unable to set IV length for AES-GCM.")

        key_buf = ctypes.create_string_buffer(key, len(key))
        iv_buf = ctypes.create_string_buffer(iv, len(iv))
        if libcrypto.EVP_EncryptInit_ex(ctx, None, None, key_buf, iv_buf) != 1:
            raise EncryptionError("EVP_EncryptInit_ex (key/iv) failed.")

        out_buf = ctypes.create_string_buffer(len(plaintext) + 16)
        out_len = ctypes.c_int(0)
        if plaintext:
            in_buf = ctypes.create_string_buffer(plaintext, len(plaintext))
            if libcrypto.EVP_EncryptUpdate(ctx, out_buf, ctypes.byref(out_len), in_buf, len(plaintext)) != 1:
                raise EncryptionError("EVP_EncryptUpdate failed.")
        else:
            # Zero-length plaintext: still need to call update with no input.
            if libcrypto.EVP_EncryptUpdate(ctx, out_buf, ctypes.byref(out_len), None, 0) != 1:
                raise EncryptionError("EVP_EncryptUpdate (zero-length) failed.")

        total = out_len.value
        final_len = ctypes.c_int(0)
        if libcrypto.EVP_EncryptFinal_ex(ctx, ctypes.byref(out_buf, total), ctypes.byref(final_len)) != 1:
            raise EncryptionError("EVP_EncryptFinal_ex failed.")
        total += final_len.value

        tag_buf = ctypes.create_string_buffer(16)
        if libcrypto.EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_GET_TAG, 16, tag_buf) != 1:
            raise EncryptionError("Failed to fetch AES-GCM tag.")

        return out_buf.raw[:total] + tag_buf.raw[:16]
    finally:
        libcrypto.EVP_CIPHER_CTX_free(ctx)


def canonicalise_json(source: Path) -> bytes:
    data = json.loads(source.read_text(encoding="utf-8"))
    # Mirror JSON.stringify default formatting (no extra whitespace, UTF-8 output).
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return text.encode("utf-8")


def derive_key(password: str, salt: bytes, iterations: int) -> bytes:
    password_bytes = password.encode("utf-8")
    return hashlib.pbkdf2_hmac("sha256", password_bytes, salt, iterations, dklen=32)


def build_envelope(ciphertext: bytes, salt: bytes, nonce: bytes, iterations: int, original_name: str) -> dict[str, object]:
    return {
        "alg": "aes-256-gcm+pbkdf2-sha256",
        "salt_b64": base64.b64encode(salt).decode("ascii"),
        "nonce_b64": base64.b64encode(nonce).decode("ascii"),
        "ct_b64": base64.b64encode(ciphertext).decode("ascii"),
        "pbkdf2_iterations": iterations,
        "original": original_name,
    }


def iter_json_files(target_dir: Path) -> Iterable[Path]:
    for path in sorted(target_dir.glob("*.json")):
        if path.is_file():
            yield path


def encrypt_file(libcrypto: ctypes.CDLL, path: Path, password: str, iterations: int, keep_json: bool) -> Path:
    plaintext = canonicalise_json(path)
    salt = os.urandom(16)
    nonce = os.urandom(12)
    key = derive_key(password, salt, iterations)
    ciphertext = _aes_gcm_encrypt(libcrypto, key, nonce, plaintext)
    envelope = build_envelope(ciphertext, salt, nonce, iterations, path.name)

    sealed_path = path.with_suffix(".sealed")
    sealed_path.write_text(json.dumps(envelope, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    if not keep_json:
        path.unlink()

    return sealed_path


def main() -> None:
    parser = argparse.ArgumentParser(description="Encrypt pack JSON files into sealed envelopes.")
    parser.add_argument("directory", nargs="?", default="packs/out", help="Directory containing JSON packs.")
    parser.add_argument("--password", default="DEMO-ONLY", help="Password for PBKDF2 key derivation (default: DEMO-ONLY).")
    parser.add_argument("--iterations", type=int, default=150_000, help="PBKDF2 iteration count (default: 150000).")
    parser.add_argument("--keep-json", action="store_true", help="Retain original JSON files alongside sealed output.")

    args = parser.parse_args()
    target_dir = Path(args.directory).resolve()
    if not target_dir.exists():
        raise SystemExit(f"Target directory {target_dir} does not exist.")

    libcrypto = _load_libcrypto()
    _prepare_crypto_functions(libcrypto)

    json_files = list(iter_json_files(target_dir))
    if not json_files:
        print(f"No JSON files found in {target_dir}.")
        return

    for path in json_files:
        sealed_path = encrypt_file(libcrypto, path, args.password, args.iterations, args.keep_json)
        action = "kept" if args.keep_json else "removed"
        print(f"Encrypted {path.name} -> {sealed_path.name} ({action} JSON).")


if __name__ == "__main__":
    main()
