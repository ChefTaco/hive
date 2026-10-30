#!/usr/bin/env python3
"""Register a new agent with HiveMem.

Usage:
    python scripts/register_agent.py --agent-id agent-alpha --display-name "Agent Alpha"

Requires HIVEMEM_ADMIN_TOKEN env var (or pass via --token).
The generated JWT is shown once — save it to your secret store
(for example, ~/.hivemem/credentials/hivemem.json).
"""

import argparse
import json
import os
import sys

import httpx


def main():
    parser = argparse.ArgumentParser(description="Register a new HiveMem agent")
    parser.add_argument("--agent-id", required=True, help="Unique lowercase agent ID (a-z0-9_-)")
    parser.add_argument("--display-name", required=True, help="Human-readable agent name")
    parser.add_argument("--description", default=None, help="Optional description")
    parser.add_argument(
        "--api-url",
        default=os.environ.get("HIVEMEM_API_URL", "http://localhost:18790"),
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("HIVEMEM_ADMIN_TOKEN"),
        help="Admin JWT token",
    )
    args = parser.parse_args()

    if not args.token:
        print("ERROR: Admin token required. Set HIVEMEM_ADMIN_TOKEN or pass --token.", file=sys.stderr)
        sys.exit(1)

    payload = {
        "agent_id": args.agent_id,
        "display_name": args.display_name,
    }
    if args.description:
        payload["description"] = args.description

    resp = httpx.post(
        f"{args.api_url}/v1/agents/register",
        json=payload,
        headers={"Authorization": f"Bearer {args.token}"},
        timeout=15,
    )

    if resp.status_code == 409:
        print(f"ERROR: Agent '{args.agent_id}' is already registered.", file=sys.stderr)
        sys.exit(1)

    if resp.status_code not in (200, 201):
        print(f"ERROR: Registration failed ({resp.status_code}): {resp.text}", file=sys.stderr)
        sys.exit(1)

    data = resp.json()
    token = data["token"]
    cred_path = os.path.expanduser(os.environ.get("HIVEMEM_CREDENTIAL_FILE", "~/.hivemem/credentials/hivemem.json"))

    print(f"\n✅ Agent '{args.agent_id}' registered successfully.")
    print(f"   Collections: {', '.join(data['private_collections'])}")
    print(f"\n⚠️  Save this token — it will NOT be shown again:\n")
    print(f"   {token}\n")
    print(f"Credential file format (save to {cred_path}):")
    print(json.dumps({"token": token}, indent=2))


if __name__ == "__main__":
    main()
