"""Webhook signature helpers for HiveMem consumers."""

from __future__ import annotations

import hashlib
import hmac
import math
import threading
import time


_nonce_lock = threading.Lock()


def sign_webhook_body(secret: str, body: bytes, *, timestamp: str, nonce: str) -> str:
    signed = timestamp.encode("utf-8") + b"." + nonce.encode("utf-8") + b"." + body
    return "sha256=" + hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()


def verify_webhook_signature(
    *,
    secret: str,
    body: bytes,
    signature: str,
    timestamp: str,
    nonce: str,
    tolerance_seconds: int = 300,
    seen_nonces: set[str] | None = None,
) -> bool:
    if not isinstance(timestamp, str) or not timestamp.isascii() or not timestamp.isdecimal():
        return False
    if not math.isfinite(tolerance_seconds) or tolerance_seconds < 0:
        return False
    try:
        ts = int(timestamp)
    except (TypeError, ValueError):
        return False
    if abs(int(time.time()) - ts) > tolerance_seconds:
        return False
    if not nonce:
        return False
    expected = sign_webhook_body(secret, body, timestamp=timestamp, nonce=nonce)
    ok = hmac.compare_digest(expected, signature or "")
    if ok and seen_nonces is not None:
        with _nonce_lock:
            if nonce in seen_nonces:
                return False
            seen_nonces.add(nonce)
    return ok
