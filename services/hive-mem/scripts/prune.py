#!/usr/bin/env python3
"""Prune stale records from HiveMem.

Calls POST /v1/admin/prune which hard-deletes:
- Soft-deleted records older than HIVEMEM_PRUNE_SOFT_DELETE_DAYS (default 30)
- Expired records (past their expires_at)
- Superseded records older than HIVEMEM_PRUNE_SUPERSEDED_DAYS (default 30)

Usage:
    python scripts/prune.py

Or via cron:
    0 4 * * 0 /opt/hivemem/.venv/bin/python /opt/hivemem/scripts/prune.py >> /var/log/hivemem-prune.log 2>&1
"""

import json
import os
import sys
from datetime import datetime

import httpx

API_URL = os.environ.get("HIVEMEM_API_URL", "http://localhost:18790")
ADMIN_TOKEN_FILE = os.environ.get("HIVEMEM_ADMIN_TOKEN_FILE", "/var/opt/hivemem/config/admin-token.secret")


def get_admin_token() -> str:
    token = os.environ.get("HIVEMEM_ADMIN_TOKEN")
    if token:
        return token
    if os.path.exists(ADMIN_TOKEN_FILE):
        with open(ADMIN_TOKEN_FILE) as f:
            return f.read().strip()
    print("ERROR: No admin token found. Set HIVEMEM_ADMIN_TOKEN or create", ADMIN_TOKEN_FILE, file=sys.stderr)
    sys.exit(1)


def prune():
    token = get_admin_token()
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] Starting prune ...")

    try:
        resp = httpx.post(
            f"{API_URL}/v1/admin/prune",
            headers={"Authorization": f"Bearer {token}"},
            timeout=120,
        )
        resp.raise_for_status()
    except httpx.HTTPStatusError as e:
        print(f"ERROR: Prune failed (HTTP {e.response.status_code}): {e.response.text}", file=sys.stderr)
        sys.exit(1)
    except httpx.ConnectError:
        print(f"ERROR: Cannot connect to {API_URL}", file=sys.stderr)
        sys.exit(1)

    result = resp.json()
    total = result["total_pruned"]

    if total == 0:
        print("  No stale records to prune.")
    else:
        print(f"  Pruned {total} records:")
        for coll, counts in result["pruned"].items():
            parts = []
            if counts.get("soft_deleted"):
                parts.append(f"{counts['soft_deleted']} soft-deleted")
            if counts.get("expired"):
                parts.append(f"{counts['expired']} expired")
            if counts.get("superseded"):
                parts.append(f"{counts['superseded']} superseded")
            if counts.get("decayed"):
                parts.append(f"{counts['decayed']} decayed")
            print(f"    {coll}: {', '.join(parts)}")

    print(f"Prune complete: {total} records removed.")


if __name__ == "__main__":
    prune()
