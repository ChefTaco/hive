"""Tests for the Hermes HiveMem memory provider plugin."""

from __future__ import annotations

import json
import http.server
import os
import shutil
import ssl
import subprocess
import threading
from pathlib import Path

import pytest


def _isolate_hivemem_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in (
        "HERMES_HIVEMEM_API_URL",
        "HERMES_HIVEMEM_TOKEN",
        "HERMES_HIVEMEM_VERIFY_TLS",
        "HERMES_HIVEMEM_CA_FILE",
        "HIVEMEM_API_URL",
        "HIVEMEM_TOKEN",
        "HIVEMEM_MCP_TOKEN",
        "HIVEMEM_CA_FILE",
    ):
        monkeypatch.delenv(key, raising=False)


def _write_config(home: Path, api_url: str, **overrides) -> None:
    values = {
        "api_url": api_url,
        "workspace_id": "test-workspace",
        "default_scope": "private",
        "recall_mode": "hybrid",
        "capture_turns": True,
    }
    values.update(overrides)
    (home / "hivemem.json").write_text(
        json.dumps(values),
        encoding="utf-8",
    )


def _provider(
    hivemem_module,
    temp_hermes_home: Path,
    api_url: str,
    monkeypatch: pytest.MonkeyPatch,
    *,
    token: str = "test-token",
    **config_overrides,
):
    _isolate_hivemem_env(monkeypatch)
    _write_config(temp_hermes_home, api_url, **config_overrides)
    monkeypatch.setenv("HERMES_HIVEMEM_TOKEN", token)
    provider = hivemem_module.HermesHiveMemProvider()
    provider.initialize("session-1", hermes_home=str(temp_hermes_home), platform="cli", agent_context="primary")
    return provider


def test_normalize_api_url(hivemem_module):
    assert hivemem_module.normalize_api_url(None) == "http://localhost:18790"
    assert hivemem_module.normalize_api_url("example.test") == "https://example.test"
    assert hivemem_module.normalize_api_url("example.test:443/") == "https://example.test:443"
    assert hivemem_module.normalize_api_url("localhost:18790") == "http://localhost:18790"
    assert hivemem_module.normalize_api_url("http://127.0.0.1:18790") == "http://127.0.0.1:18790"
    for unsafe in (
        "http://example.test",
        "http://0.0.0.0:18790",
        "https://example.test/api/",
        "https://user@example.test",
        "https://example.test?token=bad",
    ):
        with pytest.raises(ValueError):
            hivemem_module.normalize_api_url(unsafe)


def test_is_available_uses_local_config_without_network(hivemem_module, temp_hermes_home, monkeypatch):
    _isolate_hivemem_env(monkeypatch)
    _write_config(temp_hermes_home, "https://not-contacted.example")
    monkeypatch.setenv("HERMES_HOME", str(temp_hermes_home))
    monkeypatch.setenv("HERMES_HIVEMEM_TOKEN", "test-token")
    provider = hivemem_module.HermesHiveMemProvider()
    assert provider.is_available() is True


def test_ca_env_override_and_legacy_tls_bypass_is_ignored(hivemem_module, temp_hermes_home, monkeypatch):
    _isolate_hivemem_env(monkeypatch)
    _write_config(temp_hermes_home, "https://example.test", verify_tls=False)
    monkeypatch.setenv("HERMES_HOME", str(temp_hermes_home))
    monkeypatch.setenv("HERMES_HIVEMEM_TOKEN", "test-token")
    monkeypatch.setenv("HERMES_HIVEMEM_CA_FILE", "/protected/hivemem-ca.pem")
    monkeypatch.setenv("HERMES_HIVEMEM_VERIFY_TLS", "false")
    provider = hivemem_module.HermesHiveMemProvider()
    provider.initialize("session-1", hermes_home=str(temp_hermes_home), platform="cli", agent_context="primary")
    assert "verify_tls" not in provider._config
    assert provider._config["ca_file"] == "/protected/hivemem-ca.pem"
    assert provider._client.ca_file == "/protected/hivemem-ca.pem"


def test_private_ca_positive_system_trust_negative_and_redirect_denied(hivemem_module, tmp_path):
    if shutil.which("openssl") is None:
        pytest.skip("openssl is required for the private-CA transport contract")
    certificate = tmp_path / "localhost.crt"
    private_key = tmp_path / "localhost.key"
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=DNS:localhost",
            "-keyout",
            str(private_key),
            "-out",
            str(certificate),
        ],
        check=True,
        capture_output=True,
    )
    requests: list[tuple[str, str | None]] = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 - stdlib handler contract
            requests.append((self.path, self.headers.get("Authorization")))
            if self.path == "/v1/health":
                body = b'{"status":"ok"}'
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if self.path == "/v1/redirect":
                self.send_response(302)
                self.send_header("location", f"https://localhost:{self.server.server_port}/v1/attacker")
                self.end_headers()
                return
            self.send_response(404)
            self.end_headers()

        def log_message(self, format, *args):  # noqa: A002 - stdlib handler contract
            del format, args

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certificate, private_key)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        url = f"https://localhost:{server.server_port}"
        trusted = hivemem_module.HiveMemClient(url, "scoped-token", ca_file=str(certificate))
        assert trusted.health()["status"] == "ok"
        with pytest.raises(hivemem_module.HiveMemAPIError) as redirect:
            trusted._request("GET", "/v1/redirect")
        assert redirect.value.status_code == 302
        assert [path for path, _ in requests] == ["/v1/health", "/v1/redirect"]
        assert all(auth == "Bearer scoped-token" for _, auth in requests)

        untrusted = hivemem_module.HiveMemClient(url, "scoped-token")
        with pytest.raises(hivemem_module.HiveMemAPIError, match="unreachable"):
            untrusted.health()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_tool_schemas_after_initialize(hivemem_module, temp_hermes_home, fake_hivemem_server, monkeypatch):
    provider = _provider(hivemem_module, temp_hermes_home, fake_hivemem_server["url"], monkeypatch)
    names = {schema["name"] for schema in provider.get_tool_schemas()}
    assert {"hivemem_store", "hivemem_search", "hivemem_get", "hivemem_update", "hivemem_delete"} <= names


def test_tool_schemas_available_before_initialize_for_hermes_registration(
    hivemem_module,
    temp_hermes_home,
    fake_hivemem_server,
    monkeypatch,
):
    _isolate_hivemem_env(monkeypatch)
    _write_config(temp_hermes_home, fake_hivemem_server["url"])
    monkeypatch.setenv("HERMES_HOME", str(temp_hermes_home))
    monkeypatch.setenv("HERMES_HIVEMEM_TOKEN", "test-token")

    provider = hivemem_module.HermesHiveMemProvider()
    indexed_tools = {schema["name"]: provider for schema in provider.get_tool_schemas()}
    assert "hivemem_store" in indexed_tools

    provider.initialize("session-1", hermes_home=str(temp_hermes_home), platform="cli", agent_context="primary")
    routed = json.loads(indexed_tools["hivemem_store"].handle_tool_call("hivemem_store", {"content": "registered before init"}))
    assert routed["stored"] is True


def test_tool_schemas_hidden_before_initialize_without_token(
    hivemem_module,
    temp_hermes_home,
    fake_hivemem_server,
    monkeypatch,
):
    _isolate_hivemem_env(monkeypatch)
    _write_config(temp_hermes_home, fake_hivemem_server["url"])
    monkeypatch.setenv("HERMES_HOME", str(temp_hermes_home))

    provider = hivemem_module.HermesHiveMemProvider()
    assert provider.get_tool_schemas() == []


def test_tool_schemas_hidden_before_initialize_when_disabled(
    hivemem_module,
    temp_hermes_home,
    fake_hivemem_server,
    monkeypatch,
):
    _isolate_hivemem_env(monkeypatch)
    _write_config(temp_hermes_home, fake_hivemem_server["url"], enabled=False)
    monkeypatch.setenv("HERMES_HOME", str(temp_hermes_home))
    monkeypatch.setenv("HERMES_HIVEMEM_TOKEN", "test-token")

    provider = hivemem_module.HermesHiveMemProvider()
    assert provider.get_tool_schemas() == []


def test_crud_like_tool_flow(hivemem_module, temp_hermes_home, fake_hivemem_server, monkeypatch):
    provider = _provider(hivemem_module, temp_hermes_home, fake_hivemem_server["url"], monkeypatch)

    stored = json.loads(
        provider.handle_tool_call(
            "hivemem_store",
            {"content": "remember the Hermes HiveMem test marker", "type": "semantic", "tags": ["hermes", "test"]},
        )
    )
    memory_id = stored["id"]
    assert stored["stored"] is True

    fetched = json.loads(provider.handle_tool_call("hivemem_get", {"id": memory_id}))
    assert fetched["memory"]["content"] == "remember the Hermes HiveMem test marker"

    searched = json.loads(provider.handle_tool_call("hivemem_search", {"query": "Hermes HiveMem test", "limit": 5}))
    assert searched["count"] == 1

    updated = json.loads(provider.handle_tool_call("hivemem_update", {"id": memory_id, "content": "updated Hermes marker"}))
    assert updated["updated"] is True

    deleted = json.loads(provider.handle_tool_call("hivemem_delete", {"id": memory_id}))
    assert deleted == {"deleted": True, "id": memory_id}


def test_advanced_store_and_search_contract(hivemem_module, temp_hermes_home, fake_hivemem_server, monkeypatch):
    provider = _provider(hivemem_module, temp_hermes_home, fake_hivemem_server["url"], monkeypatch)
    stored = json.loads(provider.handle_tool_call("hivemem_store", {
        "content": "advanced project knowledge",
        "type": "procedural",
        "source_ref": "repo://fixture/guide",
        "revision": "abc123",
        "observed_at": "2026-09-20T00:00:00Z",
        "expires_at": "2026-10-20T00:00:00Z",
        "freshness_class": "live_required",
        "entities": [{"entity_id": "service:hive", "name": "Hive", "type": "service"}],
        "sensitivity": "internal",
        "redaction_policy": "redact",
    }))
    record = fake_hivemem_server["store"][stored["id"]]
    assert record["type"] == "procedural"
    assert record["metadata"]["source_ref"] == "repo://fixture/guide"
    assert record["metadata"]["revision"] == "abc123"
    assert record["metadata"]["freshness_class"] == "live_required"
    assert record["metadata"]["entities"][0]["entity_id"] == "service:hive"
    searched = json.loads(provider.handle_tool_call("hivemem_search", {
        "query": "advanced project knowledge", "project_id": "fixture", "source_id": "repo:fixture",
        "publisher_ids": ["team-alpha"], "include_related": True, "as_of": "2026-09-21T00:00:00Z",
    }))
    assert searched["results"][0]["id"] == stored["id"]
    assert "ISO-8601" in json.loads(provider.handle_tool_call("hivemem_store", {
        "content": "invalid temporal record", "observed_at": "not-a-time",
    }))["error"]
    assert "UUID" in json.loads(provider.handle_tool_call("hivemem_store", {
        "content": "invalid successor", "supersedes": "not-a-uuid",
    }))["error"]


def test_typescript_core_hermes_plugin_contract(hivemem_module, temp_hermes_home, ts_hivemem_server, monkeypatch):
    provider = _provider(
        hivemem_module,
        temp_hermes_home,
        ts_hivemem_server["url"],
        monkeypatch,
        token=ts_hivemem_server["token"],
        workspace_id="default",
    )
    assert provider._client.health()["status"] == "ok"

    stored = json.loads(
        provider.handle_tool_call(
            "hivemem_store",
            {
                "content": "Hermes TypeScript core compatibility marker",
                "type": "semantic",
                "tags": ["hermes", "typescript"],
            },
        )
    )
    memory_id = stored["id"]
    assert stored["stored"] is True

    fetched = json.loads(provider.handle_tool_call("hivemem_get", {"id": memory_id}))
    assert fetched["memory"]["content"] == "Hermes TypeScript core compatibility marker"

    searched = json.loads(provider.handle_tool_call("hivemem_search", {"query": "TypeScript core compatibility", "limit": 5}))
    assert searched["count"] >= 1
    assert any(item["id"] == memory_id for item in searched["results"])

    browsed = json.loads(provider.handle_tool_call("hivemem_browse", {"limit": 10}))
    assert any(item["id"] == memory_id for item in browsed["results"])

    updated = json.loads(provider.handle_tool_call("hivemem_update", {"id": memory_id, "content": "updated Hermes TypeScript marker"}))
    assert updated["updated"] is True

    provider.on_turn_start(2, "sync test")
    provider.sync_turn("TS sync turn user", "TS sync turn assistant", session_id="session-1")
    provider.shutdown()
    turn_search = json.loads(provider.handle_tool_call("hivemem_search", {"query": "TS sync turn user", "limit": 5}))
    assert turn_search["count"] >= 1

    json.loads(provider.handle_tool_call("hivemem_store", {"content": "prefetch marker from TypeScript core"}))
    provider.queue_prefetch("prefetch marker TypeScript")
    provider.shutdown()
    context = provider.prefetch("prefetch marker TypeScript")
    assert "<hivemem-context>" in context
    assert "prefetch marker from TypeScript core" in context

    deleted = json.loads(provider.handle_tool_call("hivemem_delete", {"id": memory_id}))
    assert deleted == {"deleted": True, "id": memory_id}


def test_sync_turn_writes_conversation_memory(hivemem_module, temp_hermes_home, fake_hivemem_server, monkeypatch):
    provider = _provider(hivemem_module, temp_hermes_home, fake_hivemem_server["url"], monkeypatch)
    provider.on_turn_start(1, "hello")
    provider.sync_turn("user remembers tests", "assistant confirms tests", session_id="session-1")
    provider.shutdown()
    assert len(fake_hivemem_server["store"]) == 1
    record = next(iter(fake_hivemem_server["store"].values()))
    assert "user remembers tests" in record["content"]
    assert record["metadata"]["kind"] == "conversation_turn"


def test_queue_prefetch_returns_hivemem_context(hivemem_module, temp_hermes_home, fake_hivemem_server, monkeypatch):
    provider = _provider(hivemem_module, temp_hermes_home, fake_hivemem_server["url"], monkeypatch)
    json.loads(provider.handle_tool_call("hivemem_store", {"content": "prefetch marker for Hermes context"}))
    provider.queue_prefetch("prefetch marker")
    provider.shutdown()
    context = provider.prefetch("prefetch marker")
    assert "<hivemem-context>" in context
    assert "prefetch marker for Hermes context" in context


def test_deploy_script_dry_run(temp_hermes_home):
    script = Path(__file__).resolve().parents[1] / "scripts" / "deploy_hermes_plugin.sh"
    result = subprocess.run(
        [
            "bash",
            str(script),
            "--dry-run",
            "--hermes-home",
            str(temp_hermes_home),
            "--api-url",
            "example.test",
            "--set-active",
        ],
        check=True,
        capture_output=True,
        text=True,
        env={**os.environ, "HERMES_HIVEMEM_TOKEN": "test-token"},
    )
    assert "[dry-run]" in result.stdout
    assert "https://example.test" in result.stdout
    assert "test-token" not in result.stdout
    assert "test-token" not in result.stderr


def test_deploy_script_refreshes_endpoint_without_token(temp_hermes_home):
    script = Path(__file__).resolve().parents[1] / "scripts" / "deploy_hermes_plugin.sh"
    env_path = temp_hermes_home / ".env"
    env_path.write_text(
        "\n".join(
            [
                "HERMES_HIVEMEM_TOKEN=stale-duplicate-token",
                "HERMES_HIVEMEM_TOKEN=existing-token",
                "HERMES_HIVEMEM_API_URL=https://old.example.test",
                "HERMES_HIVEMEM_VERIFY_TLS=false",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    env = os.environ.copy()
    for key in ("HERMES_HIVEMEM_TOKEN", "HIVEMEM_TOKEN", "HIVEMEM_MCP_TOKEN"):
        env.pop(key, None)

    subprocess.run(
        [
            "bash",
            str(script),
            "--hermes-home",
            str(temp_hermes_home),
            "--api-url",
            "hive.example.com",
        ],
        check=True,
        capture_output=True,
        text=True,
        env=env,
    )

    lines = env_path.read_text(encoding="utf-8").splitlines()
    assert "HERMES_HIVEMEM_TOKEN=existing-token" in lines
    assert not any("stale-duplicate-token" in line for line in lines)
    assert sum(line.startswith("HERMES_HIVEMEM_TOKEN=") for line in lines) == 1
    assert "HERMES_HIVEMEM_API_URL=https://hive.example.com" in lines
    assert not any(line.startswith("HERMES_HIVEMEM_VERIFY_TLS=") for line in lines)
    assert env_path.stat().st_mode & 0o077 == 0
    config = json.loads((temp_hermes_home / "hivemem.json").read_text(encoding="utf-8"))
    assert "verify_tls" not in config
    assert config["ca_file"] == ""
    assert (temp_hermes_home / "hivemem.json").stat().st_mode & 0o077 == 0


def test_deploy_script_has_no_tls_or_credential_bypass_flags():
    script = Path(__file__).resolve().parents[1] / "scripts" / "deploy_hermes_plugin.sh"
    source = script.read_text(encoding="utf-8")
    assert "--ca-file" in source
    assert "StrictHostKeyChecking=yes" in source
    assert "BatchMode=yes" in source
    for forbidden in (
        "--insecure-tls",
        "--verify-tls",
        "--token",
        "--ssh-password",
        "sshpass",
        "accept-new",
        "StrictHostKeyChecking=no",
    ):
        assert forbidden not in source

    result = subprocess.run(
        ["bash", str(script), "--verify-tls", "false"],
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    assert "Unknown argument: --verify-tls" in result.stderr


def test_token_rotation_uses_pinned_key_only_ssh_and_stdin_secret_transfer():
    script = Path(__file__).resolve().parents[2] / "scripts" / "rotate-hermes-token.sh"
    source = script.read_text(encoding="utf-8")
    assert "StrictHostKeyChecking=yes" in source
    assert "PasswordAuthentication=no" in source
    assert "UserKnownHostsFile=" in source
    assert "credential-free backup" in source
    assert "IFS= read -r TOKEN" in source
    assert "TOKEN='$TOKEN'" not in source
    assert "StrictHostKeyChecking=accept-new" not in source


@pytest.mark.hermes
def test_real_hermes_memory_provider_contract(hivemem_module):
    memory_provider = pytest.importorskip("agent.memory_provider")
    provider = hivemem_module.HermesHiveMemProvider()
    assert isinstance(provider, memory_provider.MemoryProvider)
    assert provider.name == "hivemem"


@pytest.mark.hermes
def test_real_hermes_memory_manager_smoke(hivemem_module, temp_hermes_home, fake_hivemem_server, monkeypatch):
    memory_manager = pytest.importorskip("agent.memory_manager")
    manager_cls = getattr(memory_manager, "MemoryManager", None)
    if manager_cls is None:
        pytest.skip("Hermes MemoryManager is not available")

    _isolate_hivemem_env(monkeypatch)
    _write_config(temp_hermes_home, fake_hivemem_server["url"])
    monkeypatch.setenv("HERMES_HOME", str(temp_hermes_home))
    monkeypatch.setenv("HERMES_HIVEMEM_TOKEN", "test-token")
    provider = hivemem_module.HermesHiveMemProvider()
    manager = manager_cls()
    if not hasattr(manager, "add_provider"):
        pytest.skip("Installed Hermes MemoryManager does not expose add_provider")
    manager.add_provider(provider)
    if hasattr(manager, "initialize_all"):
        manager.initialize_all(session_id="session-1", platform="cli", hermes_home=str(temp_hermes_home))
    if hasattr(manager, "handle_tool_call"):
        result = manager.handle_tool_call("hivemem_store", {"content": "manager routed HiveMem memory"})
        assert "manager routed HiveMem memory" in result
    if hasattr(manager, "shutdown_all"):
        manager.shutdown_all()
