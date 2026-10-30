"""Official Python client for the HiveMem REST API."""

from __future__ import annotations

import ipaddress
import os
import re
import ssl
import time
from typing import Any
from collections.abc import Callable
from urllib.parse import urlsplit

import httpx

from hivemem_sdk.context import ContextPackage
from hivemem_sdk.errors import HiveMemHTTPError


def _normalize_base_url(value: str | None) -> str:
    raw = (value or "http://localhost:18790").strip()
    if "://" not in raw:
        host_hint = raw.rsplit(":", 1)[0].strip("[]").lower()
        scheme = "http" if host_hint == "localhost" or host_hint.startswith("127.") else "https"
        raw = f"{scheme}://{raw}"
    parsed = urlsplit(raw)
    if (
        parsed.scheme.lower() not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("HiveMem base_url must be an exact HTTP(S) origin without userinfo")
    hostname = parsed.hostname.rstrip(".").lower()
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
        label = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
        if not all(label.fullmatch(part) for part in hostname.split(".")):
            raise ValueError("HiveMem base_url must use a valid DNS hostname")
    if address is not None and (address.is_unspecified or address.is_multicast):
        raise ValueError("HiveMem base_url cannot use an unspecified or multicast address")
    loopback = hostname == "localhost" or bool(address and address.is_loopback)
    scheme = parsed.scheme.lower()
    if scheme == "http" and not loopback:
        raise ValueError("HiveMem base_url requires HTTPS outside loopback development")
    try:
        parsed_port = parsed.port
    except ValueError as exc:
        raise ValueError("HiveMem base_url contains an invalid port") from exc
    rendered_host = f"[{hostname}]" if ":" in hostname else hostname
    port = f":{parsed_port}" if parsed_port is not None else ""
    return f"{scheme}://{rendered_host}{port}"


class _BaseClient:
    def __init__(
        self,
        *,
        base_url: str | None = None,
        token: str | None = None,
        workspace_id: str | None = None,
        timeout: float = 30.0,
        max_retries: int = 2,
        ca_file: str | None = None,
        request_id_provider: Callable[[], str] | None = None,
        auth_refresh: Callable[[], str | None] | None = None,
        on_request: Callable[[str, str, dict[str, Any]], None] | None = None,
        on_response: Callable[[httpx.Response], None] | None = None,
    ) -> None:
        self.base_url = _normalize_base_url(base_url or os.getenv("HIVEMEM_API_URL"))
        self.token = token or os.getenv("HIVEMEM_TOKEN") or os.getenv("HIVEMEM_MCP_TOKEN")
        self.workspace_id = workspace_id or os.getenv("HIVEMEM_WORKSPACE_ID") or "default"
        self.timeout = timeout
        self.max_retries = max_retries
        self.ca_file = str(ca_file or os.getenv("HIVEMEM_CA_FILE") or "").strip()
        self.request_id_provider = request_id_provider
        self.auth_refresh = auth_refresh
        self.on_request = on_request
        self.on_response = on_response

    def _tls_verify(self) -> bool | ssl.SSLContext:
        if not self.ca_file:
            return True
        return ssl.create_default_context(cafile=self.ca_file)

    def _headers(self) -> dict[str, str]:
        headers = {"Accept": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        if self.request_id_provider:
            headers["X-Request-ID"] = self.request_id_provider()
        return headers

    def _url(self, path: str) -> str:
        if not path.startswith("/"):
            path = "/" + path
        return f"{self.base_url}{path}"

    @staticmethod
    def _json_or_none(response: httpx.Response) -> Any:
        if response.status_code == 204 or not response.content:
            return None
        return response.json()

    @staticmethod
    def _raise_for_status(response: httpx.Response) -> None:
        if response.is_success:
            return
        details: Any | None = None
        message = response.text
        try:
            details = response.json()
            message = details.get("detail") if isinstance(details, dict) else message
        except ValueError:
            pass
        raise HiveMemHTTPError(response.status_code, str(message), details=details)


class HiveMemClient(_BaseClient):
    """Synchronous HiveMem API client."""

    def __init__(self, *, transport: httpx.BaseTransport | None = None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._client = httpx.Client(
            timeout=self.timeout,
            headers=self._headers(),
            transport=transport,
            verify=self._tls_verify(),
            follow_redirects=False,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "HiveMemClient":
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.close()

    def request(self, method: str, path: str, **kwargs: Any) -> Any:
        for attempt in range(self.max_retries + 1):
            if self.auth_refresh:
                refreshed = self.auth_refresh()
                if refreshed:
                    self.token = refreshed
            if self.on_request:
                self.on_request(method, self._url(path), kwargs)
            self._client.headers.update(self._headers())
            response = self._client.request(method, self._url(path), **kwargs)
            if self.on_response:
                self.on_response(response)
            if response.status_code < 500 or attempt == self.max_retries:
                self._raise_for_status(response)
                return self._json_or_none(response)
            time.sleep(0.1 * (attempt + 1))
        return None

    def health(self) -> dict[str, Any]:
        return self.request("GET", "/v1/health")

    def create_memory(self, **body: Any) -> dict[str, Any]:
        body.setdefault("workspace_id", self.workspace_id)
        return self.request("POST", "/v1/memories", json=body)

    def batch_create_memories(self, memories: list[dict[str, Any]]) -> list[dict[str, Any]]:
        for memory in memories:
            memory.setdefault("workspace_id", self.workspace_id)
        return self.request("POST", "/v1/memories/batch", json={"memories": memories})

    def get_memory(self, memory_id: str, *, include_deleted: bool = False) -> dict[str, Any]:
        return self.request("GET", f"/v1/memories/{memory_id}", params={"include_deleted": include_deleted})

    def update_memory(self, memory_id: str, **body: Any) -> dict[str, Any]:
        return self.request("PUT", f"/v1/memories/{memory_id}", json=body)

    def delete_memory(self, memory_id: str) -> None:
        return self.request("DELETE", f"/v1/memories/{memory_id}")

    def search_memories(self, query: str | None = None, *, explain: bool = False, **body: Any) -> dict[str, Any]:
        if query is not None:
            body["query"] = query
        body.setdefault("workspace_id", self.workspace_id)
        return self.request("POST", "/v1/memories/search", params={"explain": explain}, json=body)

    def search_text(self, query: str, **body: Any) -> dict[str, Any]:
        body.update({"query": query, "workspace_id": body.get("workspace_id", self.workspace_id)})
        return self.request("POST", "/v1/memories/search/text", json=body)

    def search_hybrid(self, query: str, **body: Any) -> dict[str, Any]:
        body.update({"query": query, "workspace_id": body.get("workspace_id", self.workspace_id)})
        return self.request("POST", "/v1/memories/search/hybrid", json=body)

    def sync_knowledge_source(self, **body: Any) -> dict[str, Any]:
        body.setdefault("workspace_id", self.workspace_id)
        return self.request("POST", "/v1/knowledge/sources/sync", json=body)

    def browse_memories(self, **params: Any) -> dict[str, Any]:
        params.setdefault("workspace_id", self.workspace_id)
        return self.request("GET", "/v1/memories/browse", params=params)

    def create_session(self, **body: Any) -> dict[str, Any]:
        body.setdefault("workspace_id", self.workspace_id)
        return self.request("POST", "/v1/sessions", json=body)

    def list_sessions(self, **params: Any) -> list[dict[str, Any]]:
        params.setdefault("workspace_id", self.workspace_id)
        return self.request("GET", "/v1/sessions", params=params)

    def get_session(self, session_id: str) -> dict[str, Any]:
        return self.request("GET", f"/v1/sessions/{session_id}")

    def update_session(self, session_id: str, **body: Any) -> dict[str, Any]:
        return self.request("PUT", f"/v1/sessions/{session_id}", json=body)

    def delete_session(self, session_id: str) -> None:
        return self.request("DELETE", f"/v1/sessions/{session_id}")

    def session_memories(self, session_id: str, **params: Any) -> dict[str, Any]:
        params.setdefault("workspace_id", self.workspace_id)
        return self.request("GET", f"/v1/sessions/{session_id}/memories", params=params)

    def context(self, **body: Any) -> ContextPackage:
        body.setdefault("workspace_id", self.workspace_id)
        return ContextPackage(self.request("POST", "/v1/context", json=body))

    def session_context(self, session_id: str, **body: Any) -> ContextPackage:
        body.setdefault("workspace_id", self.workspace_id)
        return ContextPackage(self.request("POST", f"/v1/sessions/{session_id}/context", json=body))

    def chat(self, query: str, **body: Any) -> dict[str, Any]:
        body.update({"query": query, "workspace_id": body.get("workspace_id", self.workspace_id)})
        return self.request("POST", "/v1/chat", json=body)

    def session_chat(self, session_id: str, query: str, **body: Any) -> dict[str, Any]:
        body.update({"query": query, "workspace_id": body.get("workspace_id", self.workspace_id)})
        return self.request("POST", f"/v1/sessions/{session_id}/chat", json=body)

    def queue_status(self, **params: Any) -> dict[str, Any]:
        return self.request("GET", "/v1/queue/status", params=params)

    def schedule_dream(self, peer_id: str, **body: Any) -> dict[str, Any]:
        body.setdefault("workspace_id", self.workspace_id)
        return self.request("POST", f"/v1/peers/{peer_id}/dream", json=body)

    def list_conclusions(self, peer_id: str, **params: Any) -> list[dict[str, Any]]:
        params.setdefault("workspace_id", self.workspace_id)
        return self.request("GET", f"/v1/peers/{peer_id}/conclusions", params=params)

    def peer_representation(self, peer_id: str, **params: Any) -> dict[str, Any]:
        params.setdefault("workspace_id", self.workspace_id)
        return self.request("GET", f"/v1/peers/{peer_id}/representation", params=params)

    def get_peer_card(self, peer_id: str, **params: Any) -> dict[str, Any]:
        params.setdefault("workspace_id", self.workspace_id)
        return self.request("GET", f"/v1/peers/{peer_id}/card", params=params)

    def upsert_peer_card(self, peer_id: str, content: str, **body: Any) -> dict[str, Any]:
        body.update({"content": content, "workspace_id": body.get("workspace_id", self.workspace_id)})
        return self.request("POST", f"/v1/peers/{peer_id}/card", json=body)

    def rebuild_peer_card(self, peer_id: str, **body: Any) -> dict[str, Any]:
        body.setdefault("workspace_id", self.workspace_id)
        return self.request("POST", f"/v1/peers/{peer_id}/card/rebuild", json=body)

    def review_peer_card(self, peer_id: str, **params: Any) -> dict[str, Any]:
        params.setdefault("workspace_id", self.workspace_id)
        return self.request("POST", f"/v1/peers/{peer_id}/card/review", params=params)

    def export_agent_bundle(self, agent_id: str) -> dict[str, Any]:
        return self.request("GET", f"/v1/agents/{agent_id}/bundle")

    def import_agent_bundle(self, agent_id: str, bundle: dict[str, Any]) -> dict[str, Any]:
        return self.request("POST", f"/v1/agents/{agent_id}/bundle", json=bundle)

    def list_webhooks(self, **params: Any) -> list[dict[str, Any]]:
        return self.request("GET", "/v1/webhooks", params=params)

    def create_webhook(self, url: str, **body: Any) -> dict[str, Any]:
        body.update({"url": url, "workspace_id": body.get("workspace_id", self.workspace_id)})
        return self.request("POST", "/v1/webhooks", json=body)

    def update_webhook(self, endpoint_id: str, **body: Any) -> dict[str, Any]:
        return self.request("PUT", f"/v1/webhooks/{endpoint_id}", json=body)

    def delete_webhook(self, endpoint_id: str) -> dict[str, Any]:
        return self.request("DELETE", f"/v1/webhooks/{endpoint_id}")

    def test_webhook(self, **body: Any) -> dict[str, Any]:
        body.setdefault("workspace_id", self.workspace_id)
        return self.request("POST", "/v1/webhooks/test", json=body)

    def webhook_deliveries(self, **params: Any) -> dict[str, Any]:
        return self.request("GET", "/v1/webhooks/deliveries", params=params)


class AsyncHiveMemClient(_BaseClient):
    """Asynchronous HiveMem API client."""

    def __init__(self, *, transport: httpx.AsyncBaseTransport | None = None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._client = httpx.AsyncClient(
            timeout=self.timeout,
            headers=self._headers(),
            transport=transport,
            verify=self._tls_verify(),
            follow_redirects=False,
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "AsyncHiveMemClient":
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        await self.close()

    async def request(self, method: str, path: str, **kwargs: Any) -> Any:
        for attempt in range(self.max_retries + 1):
            if self.auth_refresh:
                refreshed = self.auth_refresh()
                if refreshed:
                    self.token = refreshed
            if self.on_request:
                self.on_request(method, self._url(path), kwargs)
            self._client.headers.update(self._headers())
            response = await self._client.request(method, self._url(path), **kwargs)
            if self.on_response:
                self.on_response(response)
            if response.status_code < 500 or attempt == self.max_retries:
                self._raise_for_status(response)
                return self._json_or_none(response)
            await _async_sleep(0.1 * (attempt + 1))
        return None

    async def health(self) -> dict[str, Any]:
        return await self.request("GET", "/v1/health")

    async def create_memory(self, **body: Any) -> dict[str, Any]:
        body.setdefault("workspace_id", self.workspace_id)
        return await self.request("POST", "/v1/memories", json=body)

    async def search_memories(self, query: str | None = None, *, explain: bool = False, **body: Any) -> dict[str, Any]:
        if query is not None:
            body["query"] = query
        body.setdefault("workspace_id", self.workspace_id)
        return await self.request("POST", "/v1/memories/search", params={"explain": explain}, json=body)

    async def sync_knowledge_source(self, **body: Any) -> dict[str, Any]:
        body.setdefault("workspace_id", self.workspace_id)
        return await self.request("POST", "/v1/knowledge/sources/sync", json=body)

    async def create_session(self, **body: Any) -> dict[str, Any]:
        body.setdefault("workspace_id", self.workspace_id)
        return await self.request("POST", "/v1/sessions", json=body)

    async def context(self, **body: Any) -> ContextPackage:
        body.setdefault("workspace_id", self.workspace_id)
        return ContextPackage(await self.request("POST", "/v1/context", json=body))

    async def queue_status(self, **params: Any) -> dict[str, Any]:
        return await self.request("GET", "/v1/queue/status", params=params)

    async def create_webhook(self, url: str, **body: Any) -> dict[str, Any]:
        body.update({"url": url, "workspace_id": body.get("workspace_id", self.workspace_id)})
        return await self.request("POST", "/v1/webhooks", json=body)

    async def test_webhook(self, **body: Any) -> dict[str, Any]:
        body.setdefault("workspace_id", self.workspace_id)
        return await self.request("POST", "/v1/webhooks/test", json=body)

    async def get_peer_card(self, peer_id: str, **params: Any) -> dict[str, Any]:
        params.setdefault("workspace_id", self.workspace_id)
        return await self.request("GET", f"/v1/peers/{peer_id}/card", params=params)

    async def upsert_peer_card(self, peer_id: str, content: str, **body: Any) -> dict[str, Any]:
        body.update({"content": content, "workspace_id": body.get("workspace_id", self.workspace_id)})
        return await self.request("POST", f"/v1/peers/{peer_id}/card", json=body)

    async def export_agent_bundle(self, agent_id: str) -> dict[str, Any]:
        return await self.request("GET", f"/v1/agents/{agent_id}/bundle")


async def _async_sleep(seconds: float) -> None:
    import asyncio

    await asyncio.sleep(seconds)
