from concurrent.futures import ThreadPoolExecutor
import secrets
import time

from hivemem_sdk.webhooks import sign_webhook_body, verify_webhook_signature


def test_webhook_forgery_expiry_and_concurrent_replay():
    secret = secrets.token_hex(32)
    body = b'{"event_id":"sdk-fixture"}'
    timestamp = str(int(time.time()))
    nonce = "fixture-nonce"
    signature = sign_webhook_body(secret, body, timestamp=timestamp, nonce=nonce)
    seen = set()
    options = dict(secret=secret, body=body, timestamp=timestamp, nonce=nonce,
                   signature=signature, seen_nonces=seen)
    assert not verify_webhook_signature(**{**options, "body": body + b" "})
    assert not seen
    with ThreadPoolExecutor(max_workers=16) as pool:
        results = list(pool.map(lambda _: verify_webhook_signature(**options), range(32)))
    assert sum(results) == 1
    assert not verify_webhook_signature(**options)
    for value in ("0", "NaN", timestamp + "junk", "-1", "1e3"):
        assert not verify_webhook_signature(**{**options, "timestamp": value, "seen_nonces": set()})
    for tolerance in (float("nan"), float("inf"), -1):
        assert not verify_webhook_signature(**{**options, "tolerance_seconds": tolerance, "seen_nonces": set()})
