#!/usr/bin/env python3
"""Backup all Qdrant collections to local or configured storage.

Usage:
    python scripts/backup.py

Or via cron:
    0 5 * * * /opt/hivemem/.venv/bin/python /opt/hivemem/scripts/backup.py >> /var/log/hivemem-backup.log 2>&1
"""

import os
import shutil
import sys
from datetime import datetime

import httpx

QDRANT_URL = os.environ.get("HIVEMEM_QDRANT_URL", "http://localhost:6333")
BACKUP_BASE = os.environ.get("HIVEMEM_BACKUP_PATH", "/var/opt/hivemem/backups")
RETENTION_DAYS = int(os.environ.get("HIVEMEM_BACKUP_RETENTION_DAYS", "30"))


def backup():
    today = datetime.now().strftime("%Y-%m-%d")
    backup_dir = os.path.join(BACKUP_BASE, today)
    os.makedirs(backup_dir, exist_ok=True)

    # List all collections
    resp = httpx.get(f"{QDRANT_URL}/collections", timeout=10)
    resp.raise_for_status()
    collections = [c["name"] for c in resp.json()["result"]["collections"]]

    if not collections:
        print("No collections to back up.")
        return

    backed_up = []
    for coll in collections:
        # Create snapshot
        snap_resp = httpx.post(f"{QDRANT_URL}/collections/{coll}/snapshots", timeout=60)
        if snap_resp.status_code not in (200, 201):
            print(f"WARNING: Could not snapshot {coll}: {snap_resp.status_code}", file=sys.stderr)
            continue
        snap_name = snap_resp.json()["result"]["name"]

        # Download snapshot
        snap_path = os.path.join(backup_dir, f"{coll}.snapshot")
        with open(snap_path, "wb") as f:
            with httpx.stream("GET", f"{QDRANT_URL}/collections/{coll}/snapshots/{snap_name}", timeout=120) as dl_resp:
                dl_resp.raise_for_status()
                for chunk in dl_resp.iter_bytes():
                    f.write(chunk)

        size_mb = os.path.getsize(snap_path) / 1_048_576
        print(f"  ✓ {coll} → {snap_path} ({size_mb:.1f} MB)")
        backed_up.append(coll)

    print(f"Backup complete: {len(backed_up)} collections → {backup_dir}")

    # Prune old backups
    _prune_old_backups()


def _prune_old_backups():
    if not os.path.isdir(BACKUP_BASE):
        return
    now = datetime.now()
    for entry in sorted(os.listdir(BACKUP_BASE)):
        entry_path = os.path.join(BACKUP_BASE, entry)
        if not os.path.isdir(entry_path):
            continue
        try:
            entry_dt = datetime.strptime(entry, "%Y-%m-%d")
        except ValueError:
            continue
        age_days = (now - entry_dt).days
        if age_days > RETENTION_DAYS:
            shutil.rmtree(entry_path)
            print(f"  🗑  Pruned old backup: {entry} ({age_days} days old)")


if __name__ == "__main__":
    backup()
