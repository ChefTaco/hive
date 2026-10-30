from __future__ import annotations

import httpx
import pytest

from hivemem_sdk import HiveMemClient
from hivemem_sdk.errors import HiveMemHTTPError


def test_non_loopback_http_and_non_origin_urls_fail_closed() -> None:
    for unsafe in (
        "http://hivemem.example",
        "http://0.0.0.0:18790",
        "https://hivemem.example/v1",
        "https://user@hivemem.example",
    ):
        with pytest.raises(ValueError):
            HiveMemClient(base_url=unsafe, token="scoped-token")


def test_missing_custom_ca_fails_during_client_construction() -> None:
    with pytest.raises(FileNotFoundError):
        HiveMemClient(
            base_url="https://hivemem.example",
            token="scoped-token",
            ca_file="/definitely/missing/hivemem-ca.pem",
        )


def test_bearer_token_is_not_forwarded_across_redirect() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(302, headers={"location": "https://attacker.example/v1/health"})

    client = HiveMemClient(
        base_url="https://hivemem.example",
        token="scoped-token",
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(HiveMemHTTPError) as failure:
            client.health()
        assert failure.value.status_code == 302
        assert len(requests) == 1
        assert requests[0].headers["authorization"] == "Bearer scoped-token"
    finally:
        client.close()
