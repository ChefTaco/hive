# HiveMem Python SDK

Official source package for Python clients integrating with HiveMem.

## Install from this repository

```bash
pip install -e sdks/python
```

## Quick start

```python
from hivemem_sdk import HiveMemClient

client = HiveMemClient(
    base_url="http://localhost:18790",
    token="<agent-or-admin-jwt>",
    workspace_id="default",
    # Optional private-PKI trust anchor; system trust is used when omitted.
    ca_file="/etc/hivemem/client-ca.pem",
)

memory = client.create_memory(
    content="The user prefers concise implementation notes.",
    type="semantic",
    scope="private",
    tags=["preference"],
)

results = client.search_memories("communication preferences", limit=5, explain=True)
context = client.context(tokens=2000, search_query="current project state")
openai_messages = context.to_openai()
```

Configuration precedence: explicit constructor arguments, then `HIVEMEM_API_URL`, `HIVEMEM_TOKEN`/`HIVEMEM_MCP_TOKEN`, `HIVEMEM_WORKSPACE_ID`, `HIVEMEM_CA_FILE`, then local defaults. Non-loopback endpoints require HTTPS; certificate and hostname verification cannot be disabled, and redirects are never followed with bearer credentials.
