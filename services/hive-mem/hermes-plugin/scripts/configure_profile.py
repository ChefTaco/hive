#!/usr/bin/env python3
"""Atomically configure a Hermes profile for the HiveMem provider."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import tempfile
from typing import Any


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def _read_object(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _update_env(path: Path, payload: dict[str, Any]) -> None:
    token = str(payload.get("token") or "")
    force = bool(payload.get("force"))
    replacements = {
        "HERMES_HIVEMEM_API_URL": str(payload["api_url"]),
    }
    ca_file = str(payload.get("ca_file") or "")
    if ca_file:
        replacements["HERMES_HIVEMEM_CA_FILE"] = ca_file

    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    output: list[str] = []
    seen: set[str] = set()
    existing_token = ""
    for line in lines:
        if line.startswith("HERMES_HIVEMEM_TOKEN="):
            existing_token = line.split("=", 1)[1]
            continue
        if line.startswith("HERMES_HIVEMEM_VERIFY_TLS="):
            continue
        matched = next((name for name in replacements if line.startswith(f"{name}=")), None)
        if matched:
            if matched not in seen:
                output.append(f"{matched}={replacements[matched]}")
                seen.add(matched)
            continue
        if line.startswith("HERMES_HIVEMEM_CA_FILE="):
            continue
        output.append(line)

    chosen_token = token if token and (force or not existing_token) else existing_token
    if chosen_token:
        if "\n" in chosen_token or "\r" in chosen_token:
            raise ValueError("HiveMem token contains a line break")
        output.append(f"HERMES_HIVEMEM_TOKEN={chosen_token}")
    for name, value in replacements.items():
        if name not in seen:
            output.append(f"{name}={value}")
    _atomic_write(path, "\n".join(output).rstrip() + "\n")


def _activate_provider(path: Path) -> None:
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    lines = text.splitlines()
    output: list[str] = []
    in_memory = False
    memory_seen = False
    provider_written = False
    for line in lines:
        stripped = line.strip()
        if stripped == "memory:" and not line.startswith(" "):
            memory_seen = True
            in_memory = True
            output.append(line)
            continue
        if in_memory and line and not line.startswith(" "):
            if not provider_written:
                output.append("  provider: hivemem")
                provider_written = True
            in_memory = False
        if in_memory and re.match(r"^\s+provider\s*:", line):
            if not provider_written:
                output.append("  provider: hivemem")
                provider_written = True
            continue
        output.append(line)
    if in_memory and not provider_written:
        output.append("  provider: hivemem")
    if not memory_seen:
        if output and output[-1].strip():
            output.append("")
        output.extend(["memory:", "  provider: hivemem"])
    _atomic_write(path, "\n".join(output).rstrip() + "\n")


def configure(home: Path, payload_path: Path) -> None:
    if payload_path.is_symlink() or not payload_path.is_file():
        raise ValueError("deployment payload must be a regular file")
    payload = _read_object(payload_path)
    required = {"api_url", "workspace_id", "default_scope", "recall_mode"}
    if not required.issubset(payload):
        raise ValueError("deployment payload is incomplete")
    ca_file = str(payload.get("ca_file") or "")
    if ca_file and (Path(ca_file).is_symlink() or not Path(ca_file).is_file()):
        raise ValueError("configured HiveMem CA file is unavailable")

    config_path = home / "hivemem.json"
    config = _read_object(config_path)
    config.pop("verify_tls", None)
    config.update(
        {
            "api_url": str(payload["api_url"]),
            "workspace_id": str(payload["workspace_id"]),
            "default_scope": str(payload["default_scope"]),
            "recall_mode": str(payload["recall_mode"]),
            "ca_file": ca_file,
            "capture_turns": True,
            "max_recall_results": 5,
            "context_tokens": 1200,
            "enabled": True,
        }
    )
    _atomic_write(config_path, json.dumps(config, indent=2, sort_keys=True) + "\n")
    _update_env(home / ".env", payload)
    if bool(payload.get("set_active")):
        _activate_provider(home / "config.yaml")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", required=True, type=Path)
    parser.add_argument("--payload", required=True, type=Path)
    args = parser.parse_args()
    configure(args.home.expanduser(), args.payload)


if __name__ == "__main__":
    main()
