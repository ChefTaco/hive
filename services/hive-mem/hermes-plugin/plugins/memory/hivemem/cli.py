"""CLI commands for the Hermes HiveMem memory provider.

Hermes discovers this file conventionally when ``memory.provider`` is set to
``hivemem`` and exposes the commands as ``hermes hivemem ...``.
"""

from __future__ import annotations

import json
import sys
import uuid
import importlib.util
from pathlib import Path
from typing import Any

try:
    from . import HiveMemClient, load_config, redact_token
except Exception:  # Hermes may import cli.py without importing the provider package first.
    provider_init = Path(__file__).with_name("__init__.py")
    spec = importlib.util.spec_from_file_location(
        "_hivemem_provider_cli_bootstrap",
        provider_init,
        submodule_search_locations=[str(provider_init.parent)],
    )
    if not spec or not spec.loader:  # pragma: no cover - defensive import guard
        raise
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    HiveMemClient = module.HiveMemClient
    load_config = module.load_config
    redact_token = module.redact_token


def _print_json(data: dict[str, Any]) -> None:
    print(json.dumps(data, indent=2, sort_keys=True))


def _client_from_config(config: dict[str, Any]) -> HiveMemClient | None:
    token = str(config.get("token") or "")
    if not token:
        return None
    return HiveMemClient(
        str(config.get("api_url")),
        token,
        timeout=float(config.get("timeout_seconds") or 5.0),
        ca_file=str(config.get("ca_file") or ""),
    )


def _cmd_status(args) -> None:
    config = load_config(getattr(args, "hermes_home", None))
    token = str(config.get("token") or "")
    print("\nHiveMem provider status")
    print("─" * 40)
    print(f"  API URL:      {config.get('api_url')}")
    print(f"  Token:        {redact_token(token)}")
    print(f"  Workspace:    {config.get('workspace_id')}")
    print(f"  Scope:        {config.get('default_scope')}")
    print(f"  Recall mode:  {config.get('recall_mode')}")
    print(f"  TLS trust:    {config.get('ca_file') or 'system CA store'}")
    print(f"  Config file:  {config.get('config_path')}")
    if getattr(args, "no_health", False):
        print("  Health:       skipped")
        print()
        return
    client = _client_from_config(config)
    if not client:
        print("  Health:       not checked (token missing)")
        print()
        return
    try:
        health = client.health()
        print(f"  Health:       {health.get('status', 'unknown')}")
    except Exception as exc:
        print(f"  Health:       failed ({exc})")
    print()


def _cmd_config(args) -> None:
    config = dict(load_config(getattr(args, "hermes_home", None)))
    config["token"] = redact_token(str(config.get("token") or ""))
    _print_json(config)


def _cmd_test(args) -> None:
    config = load_config(getattr(args, "hermes_home", None))
    client = _client_from_config(config)
    if not client:
        print("ERROR: HERMES_HIVEMEM_TOKEN is not configured.", file=sys.stderr)
        raise SystemExit(1)

    print("Checking HiveMem health...", end=" ", flush=True)
    try:
        health = client.health()
    except Exception as exc:
        print("FAILED")
        print(f"  {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
    print(health.get("status", "ok"))

    if not getattr(args, "write_check", False):
        return

    marker = f"hermes-hivemem-cli-test-{uuid.uuid4()}"
    print("Running disposable write/search/delete check...", end=" ", flush=True)
    try:
        created = client.create_memory(
            {
                "content": f"Disposable Hermes HiveMem plugin test marker: {marker}",
                "type": "episodic",
                "scope": "private",
                "source": "system",
                "tags": ["hermes", "hivemem", "test"],
                "workspace_id": config.get("workspace_id", "default"),
                "metadata": {"source": "hermes_hivemem_cli", "marker": marker},
            }
        )
        memory_id = created["id"]
        searched = client.search_memories(
            {
                "query": marker,
                "scope": "private",
                "limit": 3,
                "workspace_id": config.get("workspace_id", "default"),
            }
        )
        if not searched.get("results"):
            raise RuntimeError("search returned no results for disposable marker")
        client.delete_memory(memory_id)
    except Exception as exc:
        print("FAILED")
        print(f"  {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
    print("OK")


def register_cli(subparser) -> None:
    """Build the ``hermes hivemem`` argparse tree."""
    subparser.add_argument(
        "--hermes-home",
        default=None,
        help="Override HERMES_HOME for config lookup.",
    )
    subs = subparser.add_subparsers(dest="hivemem_command")

    status = subs.add_parser("status", help="Show HiveMem provider status.")
    status.add_argument("--no-health", action="store_true", help="Skip the health check.")

    subs.add_parser("config", help="Print resolved HiveMem provider config without secrets.")

    test = subs.add_parser("test", help="Check HiveMem connectivity.")
    test.add_argument(
        "--write-check",
        action="store_true",
        help="Create, search, and soft-delete a disposable memory.",
    )

    def _dispatch(args) -> None:
        command = getattr(args, "hivemem_command", None)
        if command == "config":
            _cmd_config(args)
        elif command == "test":
            _cmd_test(args)
        else:
            _cmd_status(args)

    subparser.set_defaults(func=_dispatch)
