#!/usr/bin/env python3
"""Sealed pack workflow utilities for Jemima's Asking."""

from __future__ import annotations

import argparse
import base64
import ctypes
import ctypes.util
import datetime as _dt
import hashlib
import json
import os
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Any

PASSWORD = "DEMO-ONLY"
PBKDF2_ITERATIONS = 150_000

QUESTION_TEMPLATE = Path("AAA-questions.json")
MATHS_TEMPLATE = Path("AAA-maths.json")

QUESTIONS_PREFIX = "QPACK"
MATHS_PREFIX = "MPACK"


class CryptoError(RuntimeError):
    """Raised when OpenSSL reports an error."""


# ---------------------------------------------------------------------------
# Generic helpers


def utc_now() -> _dt.datetime:
    return _dt.datetime.now(tz=_dt.timezone.utc).replace(microsecond=0)


def isoformat(ts: _dt.datetime) -> str:
    return ts.astimezone(_dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def canonical_json_bytes(data: Any) -> bytes:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def extract_timestamp(name: str, prefix: str) -> str | None:
    if not name.startswith(prefix + "_"):
        return None
    stem = name[len(prefix) + 1 :]
    if stem.endswith(".sealed"):
        stem = stem[:-7]
    elif stem.endswith(".json"):
        stem = stem[:-5]
    return stem or None


def build_manifest(*, kind: str, version: str, sealed_path: Path, created_at: str, source_template: str) -> dict[str, Any]:
    return {
        "type": kind,
        "version": version,
        "createdAt": created_at,
        "hash": sha256_hex(sealed_path.read_bytes()),
        "filename": sealed_path.name,
        "bytes": sealed_path.stat().st_size,
        "sourceTemplate": source_template,
    }


# ---------------------------------------------------------------------------
# OpenSSL helpers


def _load_libcrypto() -> ctypes.CDLL:
    path = ctypes.util.find_library("crypto")
    if not path:
        raise CryptoError("Unable to locate libcrypto shared library.")
    return ctypes.CDLL(path)


def derive_key(password: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS, dklen=32)


def _prepare_encrypt_functions(lib: ctypes.CDLL) -> None:
    lib.EVP_CIPHER_CTX_new.restype = ctypes.c_void_p
    lib.EVP_CIPHER_CTX_free.argtypes = [ctypes.c_void_p]

    lib.EVP_aes_256_gcm.restype = ctypes.c_void_p

    lib.EVP_EncryptInit_ex.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
    ]
    lib.EVP_EncryptInit_ex.restype = ctypes.c_int

    lib.EVP_EncryptUpdate.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_int),
        ctypes.c_void_p,
        ctypes.c_int,
    ]
    lib.EVP_EncryptUpdate.restype = ctypes.c_int

    lib.EVP_EncryptFinal_ex.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_int),
    ]
    lib.EVP_EncryptFinal_ex.restype = ctypes.c_int

    lib.EVP_CIPHER_CTX_ctrl.argtypes = [
        ctypes.c_void_p,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_void_p,
    ]
    lib.EVP_CIPHER_CTX_ctrl.restype = ctypes.c_int


def _prepare_decrypt_functions(lib: ctypes.CDLL) -> None:
    lib.EVP_CIPHER_CTX_new.restype = ctypes.c_void_p
    lib.EVP_CIPHER_CTX_free.argtypes = [ctypes.c_void_p]

    lib.EVP_aes_256_gcm.restype = ctypes.c_void_p

    lib.EVP_DecryptInit_ex.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
    ]
    lib.EVP_DecryptInit_ex.restype = ctypes.c_int

    lib.EVP_DecryptUpdate.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_int),
        ctypes.c_void_p,
        ctypes.c_int,
    ]
    lib.EVP_DecryptUpdate.restype = ctypes.c_int

    lib.EVP_DecryptFinal_ex.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_int),
    ]
    lib.EVP_DecryptFinal_ex.restype = ctypes.c_int

    lib.EVP_CIPHER_CTX_ctrl.argtypes = [
        ctypes.c_void_p,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_void_p,
    ]
    lib.EVP_CIPHER_CTX_ctrl.restype = ctypes.c_int


def aes_gcm_encrypt(lib: ctypes.CDLL, key: bytes, nonce: bytes, plaintext: bytes) -> bytes:
    ctx = lib.EVP_CIPHER_CTX_new()
    if not ctx:
        raise CryptoError("Failed to allocate cipher context.")

    EVP_CTRL_GCM_SET_IVLEN = 0x9
    EVP_CTRL_GCM_GET_TAG = 0x10

    try:
        if lib.EVP_EncryptInit_ex(ctx, lib.EVP_aes_256_gcm(), None, None, None) != 1:
            raise CryptoError("EVP_EncryptInit_ex setup failed.")
        if lib.EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, len(nonce), None) != 1:
            raise CryptoError("Unable to set IV length for AES-GCM.")

        key_buf = ctypes.create_string_buffer(key, len(key))
        nonce_buf = ctypes.create_string_buffer(nonce, len(nonce))
        if lib.EVP_EncryptInit_ex(ctx, None, None, key_buf, nonce_buf) != 1:
            raise CryptoError("EVP_EncryptInit_ex key/iv failed.")

        out_buf = ctypes.create_string_buffer(len(plaintext) + 16)
        out_len = ctypes.c_int(0)
        if plaintext:
            in_buf = ctypes.create_string_buffer(plaintext, len(plaintext))
            if lib.EVP_EncryptUpdate(ctx, out_buf, ctypes.byref(out_len), in_buf, len(plaintext)) != 1:
                raise CryptoError("EVP_EncryptUpdate failed.")
        else:
            if lib.EVP_EncryptUpdate(ctx, out_buf, ctypes.byref(out_len), None, 0) != 1:
                raise CryptoError("EVP_EncryptUpdate zero-length failed.")

        total = out_len.value
        final_len = ctypes.c_int(0)
        if lib.EVP_EncryptFinal_ex(ctx, ctypes.byref(out_buf, total), ctypes.byref(final_len)) != 1:
            raise CryptoError("EVP_EncryptFinal_ex failed.")
        total += final_len.value

        tag_buf = ctypes.create_string_buffer(16)
        if lib.EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_GET_TAG, 16, tag_buf) != 1:
            raise CryptoError("Failed to read AES-GCM tag.")

        return out_buf.raw[:total] + tag_buf.raw[:16]
    finally:
        lib.EVP_CIPHER_CTX_free(ctx)


def aes_gcm_decrypt(lib: ctypes.CDLL, key: bytes, nonce: bytes, ciphertext_with_tag: bytes) -> bytes:
    if len(ciphertext_with_tag) < 16:
        raise CryptoError("Ciphertext too short for AES-GCM.")

    ct = ciphertext_with_tag[:-16]
    tag = ciphertext_with_tag[-16:]

    ctx = lib.EVP_CIPHER_CTX_new()
    if not ctx:
        raise CryptoError("Failed to allocate cipher context.")

    EVP_CTRL_GCM_SET_IVLEN = 0x9
    EVP_CTRL_GCM_SET_TAG = 0x11

    try:
        if lib.EVP_DecryptInit_ex(ctx, lib.EVP_aes_256_gcm(), None, None, None) != 1:
            raise CryptoError("EVP_DecryptInit_ex setup failed.")
        if lib.EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, len(nonce), None) != 1:
            raise CryptoError("Unable to set IV length for AES-GCM decrypt.")

        key_buf = ctypes.create_string_buffer(key, len(key))
        nonce_buf = ctypes.create_string_buffer(nonce, len(nonce))
        if lib.EVP_DecryptInit_ex(ctx, None, None, key_buf, nonce_buf) != 1:
            raise CryptoError("EVP_DecryptInit_ex key/iv failed.")

        out_buf = ctypes.create_string_buffer(len(ct))
        out_len = ctypes.c_int(0)
        if ct:
            in_buf = ctypes.create_string_buffer(ct, len(ct))
            if lib.EVP_DecryptUpdate(ctx, out_buf, ctypes.byref(out_len), in_buf, len(ct)) != 1:
                raise CryptoError("EVP_DecryptUpdate failed.")
        else:
            if lib.EVP_DecryptUpdate(ctx, out_buf, ctypes.byref(out_len), None, 0) != 1:
                raise CryptoError("EVP_DecryptUpdate zero-length failed.")

        tag_buf = ctypes.create_string_buffer(tag, len(tag))
        if lib.EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_TAG, len(tag), tag_buf) != 1:
            raise CryptoError("Failed to set AES-GCM tag.")

        final_len = ctypes.c_int(0)
        if lib.EVP_DecryptFinal_ex(ctx, None, ctypes.byref(final_len)) != 1:
            raise CryptoError("AES-GCM authentication failed.")

        total = out_len.value + final_len.value
        return out_buf.raw[:total]
    finally:
        lib.EVP_CIPHER_CTX_free(ctx)


# ---------------------------------------------------------------------------
# Pack generation


def _load_template(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise SystemExit(f"Template not found: {path}")
    data = load_json(path)
    if not isinstance(data, dict):
        raise SystemExit(f"Template {path} must contain a JSON object.")
    return data


def _prepare_question_payload(now: _dt.datetime) -> dict[str, Any]:
    tpl = json.loads(json.dumps(_load_template(QUESTION_TEMPLATE)))
    tpl.setdefault("version", "jemima-questionpack-1")
    meta = tpl.setdefault("meta", {})
    meta.setdefault("hostUid", "demo-host")
    meta.setdefault("guestUid", "demo-guest")
    meta["generatedAt"] = isoformat(now)
    meta["roomCode"] = "SEA"
    return tpl


def _prepare_maths_payload(now: _dt.datetime) -> dict[str, Any]:
    tpl = json.loads(json.dumps(_load_template(MATHS_TEMPLATE)))
    tpl.setdefault("version", "jemima-maths-chain-2")
    meta = tpl.setdefault("meta", {})
    meta.setdefault("hostUid", "demo-host")
    meta.setdefault("guestUid", "demo-guest")
    meta["generatedAt"] = isoformat(now)
    meta["roomCode"] = "SEA"
    return tpl


def _seal_payload(payload: dict[str, Any]) -> dict[str, Any]:
    lib = _load_libcrypto()
    _prepare_encrypt_functions(lib)
    plaintext = canonical_json_bytes(payload)
    salt = os.urandom(16)
    nonce = os.urandom(12)
    key = derive_key(PASSWORD, salt)
    ciphertext = aes_gcm_encrypt(lib, key, nonce, plaintext)
    return {
        "alg": "aes-256-gcm+pbkdf2-sha256",
        "salt_b64": base64.b64encode(salt).decode("ascii"),
        "nonce_b64": base64.b64encode(nonce).decode("ascii"),
        "ct_b64": base64.b64encode(ciphertext).decode("ascii"),
        "pbkdf2_iterations": PBKDF2_ITERATIONS,
        "original": payload.get("meta", {}).get("roomCode", "SEA"),
    }


def _timestamps_in_directory(directory: Path) -> set[str]:
    timestamps: set[str] = set()
    for path in directory.glob(f"{QUESTIONS_PREFIX}_*.sealed"):
        ts = extract_timestamp(path.name, QUESTIONS_PREFIX)
        if ts:
            timestamps.add(ts)
    for path in directory.glob(f"{MATHS_PREFIX}_*.sealed"):
        ts = extract_timestamp(path.name, MATHS_PREFIX)
        if ts:
            timestamps.add(ts)
    for path in directory.glob(f"{QUESTIONS_PREFIX}_*.json"):
        ts = extract_timestamp(path.name, QUESTIONS_PREFIX)
        if ts:
            timestamps.add(ts)
    for path in directory.glob(f"{MATHS_PREFIX}_*.json"):
        ts = extract_timestamp(path.name, MATHS_PREFIX)
        if ts:
            timestamps.add(ts)
    return timestamps


def command_generate(args: argparse.Namespace) -> int:
    out_dir = Path(args.out).resolve()
    ensure_dir(out_dir)

    timestamps = sorted(_timestamps_in_directory(out_dir))
    if not timestamps:
        timestamps = [utc_now().strftime("%Y%m%d_%H%M%S")]

    missing_questions: list[str] = []
    missing_maths: list[str] = []
    for ts in timestamps:
        q_path = out_dir / f"{QUESTIONS_PREFIX}_{ts}.sealed"
        m_path = out_dir / f"{MATHS_PREFIX}_{ts}.sealed"
        if not q_path.exists():
            missing_questions.append(ts)
        if not m_path.exists():
            missing_maths.append(ts)

    if not missing_questions and not missing_maths:
        stamp = utc_now().strftime("%Y%m%d_%H%M%S")
        missing_questions.append(stamp)
        missing_maths.append(stamp)

    created: dict[str, str] = {}

    for ts in missing_questions:
        now = utc_now()
        payload = _prepare_question_payload(now)
        envelope = _seal_payload(payload)
        sealed_path = out_dir / f"{QUESTIONS_PREFIX}_{ts}.sealed"
        write_json(sealed_path, envelope)
        manifest = build_manifest(
            kind="questions",
            version=payload.get("version", ""),
            sealed_path=sealed_path,
            created_at=isoformat(now),
            source_template=str(QUESTION_TEMPLATE.name),
        )
        write_json(out_dir / f"{QUESTIONS_PREFIX}_{ts}.json", manifest)
        created["questions"] = sealed_path.name

    for ts in missing_maths:
        now = utc_now()
        payload = _prepare_maths_payload(now)
        envelope = _seal_payload(payload)
        sealed_path = out_dir / f"{MATHS_PREFIX}_{ts}.sealed"
        write_json(sealed_path, envelope)
        manifest = build_manifest(
            kind="maths",
            version=payload.get("version", ""),
            sealed_path=sealed_path,
            created_at=isoformat(now),
            source_template=str(MATHS_TEMPLATE.name),
        )
        write_json(out_dir / f"{MATHS_PREFIX}_{ts}.json", manifest)
        created["maths"] = sealed_path.name

    print(json.dumps(created))
    return 0


# ---------------------------------------------------------------------------
# Start command


@dataclass
class PackPair:
    timestamp: str
    question_sealed: Path
    maths_sealed: Path
    question_manifest: Path
    maths_manifest: Path


def _discover_pairs(source: Path) -> list[PackPair]:
    question_map: dict[str, Path] = {}
    maths_map: dict[str, Path] = {}
    q_manifest_map: dict[str, Path] = {}
    m_manifest_map: dict[str, Path] = {}

    for path in source.glob(f"{QUESTIONS_PREFIX}_*.sealed"):
        ts = extract_timestamp(path.name, QUESTIONS_PREFIX)
        if ts:
            question_map[ts] = path
    for path in source.glob(f"{MATHS_PREFIX}_*.sealed"):
        ts = extract_timestamp(path.name, MATHS_PREFIX)
        if ts:
            maths_map[ts] = path
    for path in source.glob(f"{QUESTIONS_PREFIX}_*.json"):
        ts = extract_timestamp(path.name, QUESTIONS_PREFIX)
        if ts:
            q_manifest_map[ts] = path
    for path in source.glob(f"{MATHS_PREFIX}_*.json"):
        ts = extract_timestamp(path.name, MATHS_PREFIX)
        if ts:
            m_manifest_map[ts] = path

    pairs: list[PackPair] = []
    for ts in sorted(set(question_map) & set(maths_map)):
        q_manifest = q_manifest_map.get(ts)
        m_manifest = m_manifest_map.get(ts)
        if not q_manifest or not m_manifest:
            continue
        pairs.append(
            PackPair(
                timestamp=ts,
                question_sealed=question_map[ts],
                maths_sealed=maths_map[ts],
                question_manifest=q_manifest,
                maths_manifest=m_manifest,
            )
        )
    return pairs


def _load_envelope(path: Path) -> dict[str, Any]:
    return load_json(path)


def _decrypt_envelope(envelope: dict[str, Any]) -> dict[str, Any]:
    salt = base64.b64decode(envelope.get("salt_b64", ""))
    nonce = base64.b64decode(envelope.get("nonce_b64", ""))
    ciphertext = base64.b64decode(envelope.get("ct_b64", ""))
    if len(salt) < 16 or len(nonce) != 12 or not ciphertext:
        raise CryptoError("Invalid sealed envelope.")
    lib = _load_libcrypto()
    _prepare_decrypt_functions(lib)
    key = derive_key(PASSWORD, salt)
    plaintext = aes_gcm_decrypt(lib, key, nonce, ciphertext)
    return json.loads(plaintext.decode("utf-8"))


def _canonical_rounds(rounds: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if isinstance(rounds, dict):
        for key in sorted(rounds.keys(), key=lambda k: int(k)):
            entry = rounds[key]
            out.append({
                "round": int(key),
                "hostItems": entry.get("hostItems"),
                "guestItems": entry.get("guestItems"),
            })
    elif isinstance(rounds, list):
        out.extend(rounds)
    return out


def _compute_integrity(pack: dict[str, Any]) -> dict[str, Any]:
    payload = json.loads(json.dumps(pack))
    payload.pop("integrity", None)
    checksum = sha256_hex(canonical_json_bytes(payload))
    payload["integrity"] = {"checksum": checksum, "verified": True}
    return payload


def _list_used_codes(used_dir: Path) -> set[str]:
    if not used_dir.exists():
        return set()
    return {entry.name for entry in used_dir.iterdir() if entry.is_dir()}


def _generate_room_code(existing: set[str]) -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    while True:
        code = "".join(random.choice(alphabet) for _ in range(3))
        if code not in existing:
            return code


def _move_files(pair: PackPair, target_dir: Path) -> None:
    ensure_dir(target_dir)
    transfers = [
        (pair.question_sealed, target_dir / pair.question_sealed.name),
        (pair.question_manifest, target_dir / pair.question_manifest.name),
        (pair.maths_sealed, target_dir / pair.maths_sealed.name),
        (pair.maths_manifest, target_dir / pair.maths_manifest.name),
    ]
    completed: list[tuple[Path, Path]] = []
    try:
        for src, dest in transfers:
            if dest.exists():
                continue
            if not src.exists():
                continue
            dest.write_bytes(src.read_bytes())
            completed.append((src, dest))
            src.unlink()
    except Exception:
        for src, dest in reversed(completed):
            if dest.exists():
                dest.replace(src)
        raise


def _initialise_firestore():
    try:
        import firebase_admin
        from firebase_admin import credentials, firestore
    except ModuleNotFoundError as exc:  # pragma: no cover
        raise SystemExit(
            "firebase_admin is required for start-game-with-new-pack. Install with `pip install firebase-admin`."
        ) from exc

    if not firebase_admin._apps:
        cred_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
        if cred_path:
            cred = credentials.Certificate(cred_path)
            firebase_admin.initialize_app(cred)
        else:
            firebase_admin.initialize_app()
    return firestore.client()


def _seed_firestore(pack: dict[str, Any], seed_source: dict[str, Any]) -> None:
    db = _initialise_firestore()
    from firebase_admin import firestore as fb_firestore

    code = pack["meta"]["roomCode"]
    room_ref = db.collection("rooms").document(code)

    maths = pack.get("maths", {})
    clues_map = {str(idx + 1): clue for idx, clue in enumerate(maths.get("clues") or []) if isinstance(clue, str)}
    reveals_map = {}
    for idx, reveal in enumerate(maths.get("reveals") or []):
        text = None
        if isinstance(reveal, str):
            text = reveal
        elif isinstance(reveal, dict):
            for key in ("prompt", "text", "value"):
                value = reveal.get(key)
                if isinstance(value, str) and value.strip():
                    text = value
                    break
        if text:
            reveals_map[str(idx + 1)] = text

    countdown = {"startAt": None}

    transaction = db.transaction()

    @fb_firestore.transactional
    def txn(transaction_obj):
        snap = room_ref.get(transaction=transaction_obj)
        base_doc = {
            "meta": {
                "hostUid": pack["meta"].get("hostUid"),
                "guestUid": pack["meta"].get("guestUid"),
            },
            "state": "keyroom",
            "round": 1,
            "maths": maths,
            "clues": clues_map,
            "reveals": reveals_map,
            "countdown": countdown,
            "answers": {"host": {}, "guest": {}},
            "submitted": {"host": {}, "guest": {}},
            "marking": {"host": {}, "guest": {}, "startAt": None},
            "markingAck": {"host": {}, "guest": {}},
            "award": {"startAt": None},
            "awardAck": {"host": {}, "guest": {}},
            "scores": {"host": {}, "guest": {}},
            "timings": {"host": {}, "guest": {}},
            "seeds": {"progress": 100, "message": "Pack ready."},
            "timestamps": {
                "createdAt": fb_firestore.SERVER_TIMESTAMP,
                "updatedAt": fb_firestore.SERVER_TIMESTAMP,
            },
        }
        if not snap.exists():
            transaction_obj.set(room_ref, base_doc)
        else:
            data = snap.to_dict() or {}
            meta = data.get("meta") or {}
            if not meta.get("hostUid"):
                meta["hostUid"] = base_doc["meta"]["hostUid"]
            if not meta.get("guestUid"):
                meta["guestUid"] = base_doc["meta"]["guestUid"]
            transaction_obj.update(
                room_ref,
                {
                    "meta": meta,
                    "state": "keyroom",
                    "round": 1,
                    "maths": maths,
                    "clues": clues_map,
                    "reveals": reveals_map,
                    "countdown": countdown,
                    "answers": {"host": {}, "guest": {}},
                    "submitted": {"host": {}, "guest": {}},
                    "marking": {"host": {}, "guest": {}, "startAt": None},
                    "markingAck": {"host": {}, "guest": {}},
                    "award": {"startAt": None},
                    "awardAck": {"host": {}, "guest": {}},
                    "scores": {"host": {}, "guest": {}},
                    "timings": {"host": {}, "guest": {}},
                    "seeds": {"progress": 100, "message": "Pack ready."},
                    "timestamps.updatedAt": fb_firestore.SERVER_TIMESTAMP,
                },
            )

    txn(transaction)

    rounds_ref = room_ref.collection("rounds")
    for entry in pack.get("rounds", []):
        rnum = int(entry.get("round", 0))
        if not rnum:
            continue
        rounds_ref.document(str(rnum)).set(
            {
                "round": rnum,
                "hostItems": entry.get("hostItems"),
                "guestItems": entry.get("guestItems"),
            }
        )

    room_ref.set(
        {
            "seedSource": seed_source,
            "timestamps.updatedAt": fb_firestore.SERVER_TIMESTAMP,
        },
        merge=True,
    )


def command_start(args: argparse.Namespace) -> int:
    source_dir = Path("packs/new").resolve()
    used_dir = Path("packs/used").resolve()

    ensure_dir(source_dir)
    ensure_dir(used_dir)

    pairs = _discover_pairs(source_dir)
    if not pairs:
        print(json.dumps({"error": "no_packs_available"}))
        return 0

    pair = pairs[0]

    q_manifest = load_json(pair.question_manifest)
    m_manifest = load_json(pair.maths_manifest)

    question_payload = _decrypt_envelope(_load_envelope(pair.question_sealed))
    maths_payload = _decrypt_envelope(_load_envelope(pair.maths_sealed))

    combined = {
        "version": "jemima-pack-1",
        "meta": {
            "hostUid": question_payload.get("meta", {}).get("hostUid", "demo-host"),
            "guestUid": question_payload.get("meta", {}).get("guestUid", "demo-guest"),
            "generatedAt": isoformat(utc_now()),
            "roomCode": "TMP",
        },
        "rounds": _canonical_rounds(question_payload.get("rounds")),
        "maths": maths_payload.get("maths", {}),
    }
    combined = _compute_integrity(combined)

    used_codes = _list_used_codes(used_dir)
    room_code = _generate_room_code(used_codes)
    combined["meta"]["roomCode"] = room_code

    target_dir = used_dir / room_code
    _move_files(pair, target_dir)

    seed_source = {
        "roomCode": room_code,
        "assignedAt": isoformat(utc_now()),
        "questionPack": {
            "filename": pair.question_sealed.name,
            "hash": q_manifest.get("hash"),
            "createdAt": q_manifest.get("createdAt"),
            "version": q_manifest.get("version"),
        },
        "mathsPack": {
            "filename": pair.maths_sealed.name,
            "hash": m_manifest.get("hash"),
            "createdAt": m_manifest.get("createdAt"),
            "version": m_manifest.get("version"),
        },
    }

    _seed_firestore(combined, seed_source)

    print(json.dumps({
        "roomCode": room_code,
        "questionPack": pair.question_sealed.name,
        "mathsPack": pair.maths_sealed.name,
    }))
    return 0


# ---------------------------------------------------------------------------
# CLI


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Sealed pack workflow utilities.")
    sub = parser.add_subparsers(dest="command", required=True)

    g = sub.add_parser("generate", help="Generate sealed packs if missing.")
    g.add_argument("--out", default="packs/new", help="Output directory for sealed packs.")
    g.set_defaults(func=command_generate)

    s = sub.add_parser("start", help="Assign the next pack pair to a new room.")
    s.set_defaults(func=command_start)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
