#!/usr/bin/env python3
"""Seed test data into a local HiveMem instance for development.

Usage:
    HIVEMEM_TOKEN=<agent_token> python scripts/seed_test_data.py

Creates a set of sample episodic and semantic memories across both
private and shared scopes.  The server embeds text automatically.
"""

import os
import random
import sys

import httpx

API_URL = os.environ.get("HIVEMEM_API_URL", "http://localhost:18790")
TOKEN = os.environ.get("HIVEMEM_TOKEN", "")

if not TOKEN:
    print("ERROR: Set HIVEMEM_TOKEN env var.", file=sys.stderr)
    sys.exit(1)

HEADERS = {"Authorization": f"Bearer {TOKEN}"}

SAMPLE_MEMORIES = [
    # Episodic private
    {"content": "Completed initial scaffolding of HiveMem project.", "type": "episodic", "scope": "private", "tags": ["dev", "hivemem"]},
    {"content": "Rebooted the memory host after a kernel update.", "type": "episodic", "scope": "private", "tags": ["ops", "hive"]},
    {"content": "Tested Qdrant search with nomic-embed-text-v1.5 embeddings — results look good.", "type": "episodic", "scope": "private", "tags": ["dev", "qdrant"]},

    # Semantic private
    {"content": "Qdrant's cosine distance requires unit-normalized vectors for correct similarity scores.", "type": "semantic", "scope": "private", "tags": ["qdrant", "embeddings"]},
    {"content": "The HIVEMEM_JWT_SECRET must be set in .env before starting the API.", "type": "semantic", "scope": "private", "tags": ["config", "auth"]},

    # Episodic shared
    {"content": "Alice requested an overview of current active skills.", "type": "episodic", "scope": "shared", "tags": ["alice", "skills"]},
    {"content": "The example network was unreachable for about 10 minutes during a test outage.", "type": "episodic", "scope": "shared", "tags": ["network", "incident"]},

    # Semantic shared
    {"content": "All agent tokens are long-lived JWTs (1 year). Rotation requires re-registration.", "type": "semantic", "scope": "shared", "tags": ["auth", "policy"]},
    {"content": "The shared embedding model is configured by HIVEMEM_EMBEDDING_MODEL_PATH and defaults under /var/opt/hivemem/models.", "type": "semantic", "scope": "shared", "tags": ["embeddings", "config"]},
    {"content": "Deduplication threshold is 0.95 cosine similarity. Lower values produce more aggressive dedup.", "type": "semantic", "scope": "shared", "tags": ["dedup", "config"]},
]


def seed():
    print(f"Seeding {len(SAMPLE_MEMORIES)} memories into {API_URL} …\n")
    for mem in SAMPLE_MEMORIES:
        payload = {
            "content": mem["content"],
            "type": mem["type"],
            "scope": mem["scope"],
            "source": "system",
            "confidence": round(random.uniform(0.7, 0.95), 2),
            "tags": mem.get("tags", []),
        }
        resp = httpx.post(f"{API_URL}/v1/memories", json=payload, headers=HEADERS, timeout=10)
        if resp.status_code == 201:
            mid = resp.json()["id"]
            print(f"  ✓ [{mem['scope']:7s}/{mem['type']:9s}] {mem['content'][:60]}…  (id={mid[:8]}…)")
        else:
            print(f"  ✗ {resp.status_code}: {resp.text[:120]}", file=sys.stderr)

    print(f"\nDone.")


if __name__ == "__main__":
    seed()
