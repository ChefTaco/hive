# Scoped token renewal

The server can issue a separate renewal grant for one agent identity. Configure an independent, private `HIVEMEM_RENEWAL_SECRET` on each HiveMem installation. Do not distribute this signing secret to clients.

An administrator calls `POST /v1/auth/renewal-grants` with explicit `agent_id`, `scopes`, and, where applicable, `workspace_ids`. The response contains a renewal grant and its expiry. Store the grant as a mode 0600 file on the consumer host. Grants are valid for at most one year and cannot carry admin or wildcard scopes.

The consumer calls `POST /v1/auth/renew` with the grant as its bearer credential. The response is a new access token with the same identity, scopes, and workspaces, valid for at most 30 days and never beyond the grant expiry. Credential generation changes invalidate the grant. Existing access tokens and renewal grants are signed by different keys and audiences; neither can substitute for the other.

Server and Router admin tokens are rotated locally on the host of each installation using the private JWT signing key. They must never use an agent renewal grant. Monitor grant expiry as well as access-token expiry and reprovision grants before their annual deadline.
