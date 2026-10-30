"""Test fixtures for the Hermes HiveMem plugin."""

from __future__ import annotations

import importlib
import json
import select
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import pytest


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
if str(PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(PLUGIN_ROOT))


@pytest.fixture
def hivemem_module():
    return importlib.import_module("plugins.memory.hivemem")


@pytest.fixture
def temp_hermes_home(tmp_path: Path) -> Path:
    home = tmp_path / "hermes-home"
    home.mkdir()
    return home


@pytest.fixture(scope="session")
def ts_hivemem_server():
    helper = PLUGIN_ROOT / "tests" / "ts_core_server.mjs"
    ts_dist = PLUGIN_ROOT.parent / "ts-core" / "dist" / "src" / "index.js"
    if not ts_dist.exists():
        pytest.fail("Build services/hive-mem/ts-core before running TypeScript HiveMem contract tests")

    process = subprocess.Popen(
        ["node", str(helper)],
        cwd=PLUGIN_ROOT.parent,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        assert process.stdout is not None
        deadline = time.monotonic() + 10.0
        line = ""
        while time.monotonic() < deadline:
            if process.poll() is not None:
                stderr = process.stderr.read() if process.stderr is not None else ""
                pytest.fail(f"TypeScript HiveMem test server exited early: {stderr}")
            ready, _, _ = select.select([process.stdout], [], [], 0.1)
            if ready:
                line = process.stdout.readline()
                break
        if not line:
            pytest.fail("TypeScript HiveMem test server did not report readiness")
        yield json.loads(line)
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


@pytest.fixture
def fake_hivemem_server():
    store: dict[str, dict[str, Any]] = {}

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt: str, *args) -> None:  # noqa: D401 - silence test server logs
            return

        def _json(self, status: int, payload: Any) -> None:
            raw = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def _empty(self, status: int) -> None:
            self.send_response(status)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def _body(self) -> dict[str, Any]:
            length = int(self.headers.get("Content-Length", "0") or 0)
            if length <= 0:
                return {}
            return json.loads(self.rfile.read(length).decode("utf-8"))

        def do_GET(self) -> None:  # noqa: N802 - stdlib handler naming
            parsed = urlparse(self.path)
            if parsed.path == "/v1/health":
                self._json(200, {"status": "ok"})
                return
            if parsed.path == "/v1/memories/browse":
                query = parse_qs(parsed.query)
                include_deleted = query.get("include_deleted", ["false"])[0] == "true"
                limit = int(query.get("limit", ["20"])[0])
                results = [m for m in store.values() if include_deleted or not m.get("deleted_at")]
                self._json(200, {"results": results[:limit], "total": len(results), "limit": limit, "next_cursor": None})
                return
            prefix = "/v1/memories/"
            if parsed.path.startswith(prefix):
                memory_id = parsed.path.removeprefix(prefix)
                query = parse_qs(parsed.query)
                include_deleted = query.get("include_deleted", ["false"])[0] == "true"
                record = store.get(memory_id)
                if not record or (record.get("deleted_at") and not include_deleted):
                    self._json(404, {"detail": "Memory not found"})
                    return
                self._json(200, record)
                return
            self._json(404, {"detail": "not found"})

        def do_POST(self) -> None:  # noqa: N802 - stdlib handler naming
            parsed = urlparse(self.path)
            if parsed.path == "/v1/memories/search":
                body = self._body()
                query = str(body.get("query") or "").lower()
                limit = int(body.get("limit") or 10)
                matches = []
                for record in store.values():
                    if record.get("deleted_at"):
                        continue
                    if body.get("workspace_id") not in (None, "*", record.get("workspace_id")):
                        continue
                    if body.get("scope") and body.get("scope") != record.get("scope"):
                        continue
                    if query and query not in record.get("content", "").lower():
                        continue
                    matches.append({"memory": record, "score": 0.91, "collection": "test", "is_own": True})
                self._json(200, {"results": matches[:limit], "total_searched": len(matches), "collections_searched": ["test"]})
                return
            if parsed.path == "/v1/memories":
                body = self._body()
                now = datetime.now(timezone.utc).isoformat()
                memory_id = str(uuid.uuid4())
                record = {
                    "id": memory_id,
                    "agent_id": "hermes-test",
                    "content": body["content"],
                    "type": body.get("type", "episodic"),
                    "scope": body.get("scope", "private"),
                    "source": body.get("source", "conversation"),
                    "confidence": body.get("confidence", 0.8),
                    "importance": body.get("importance", 0.5),
                    "tags": body.get("tags", []),
                    "metadata": body.get("metadata", {}),
                    "workspace_id": body.get("workspace_id", "default"),
                    "session_id": body.get("session_id"),
                    "created_at": now,
                    "updated_at": now,
                    "expires_at": None,
                    "supersedes": None,
                    "superseded_by": None,
                    "corroborated_by": [],
                    "endorsements": 0,
                    "endorsed_by": [],
                    "opposed_by": [],
                    "deleted_at": None,
                    "effective_confidence": body.get("confidence", 0.8),
                }
                store[memory_id] = record
                self._json(201, record)
                return
            self._json(404, {"detail": "not found"})

        def do_PUT(self) -> None:  # noqa: N802 - stdlib handler naming
            parsed = urlparse(self.path)
            prefix = "/v1/memories/"
            if not parsed.path.startswith(prefix):
                self._json(404, {"detail": "not found"})
                return
            memory_id = parsed.path.removeprefix(prefix)
            record = store.get(memory_id)
            if not record or record.get("deleted_at"):
                self._json(404, {"detail": "Memory not found"})
                return
            body = self._body()
            record.update(body)
            record["updated_at"] = datetime.now(timezone.utc).isoformat()
            self._json(200, record)

        def do_DELETE(self) -> None:  # noqa: N802 - stdlib handler naming
            parsed = urlparse(self.path)
            prefix = "/v1/memories/"
            if not parsed.path.startswith(prefix):
                self._json(404, {"detail": "not found"})
                return
            memory_id = parsed.path.removeprefix(prefix)
            record = store.get(memory_id)
            if not record:
                self._json(404, {"detail": "Memory not found"})
                return
            record["deleted_at"] = datetime.now(timezone.utc).isoformat()
            self._empty(204)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield {"url": f"http://127.0.0.1:{server.server_port}", "store": store}
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
