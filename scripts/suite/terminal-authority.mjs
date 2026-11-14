// A validation rejection proves each machine route is reachable without reserving any work.
// With node keys only (a release pinning Magnus 3.0.0 or later) the preflight has no shared
// secret to send and the ingress relays none: Magnus's own refusal of the unsigned request, a 401
// that carries its server time header, proves the route reaches Magnus's node authentication.
export async function verifyTerminalAuthorityRoutes(baseUrl, token, request, { nodeKeysOnly = false } = {}) {
  try {
    const base = new URL(baseUrl);
    if (base.protocol !== 'https:' || base.username || base.password || (!token && !nodeKeysOnly)) throw new Error('Invalid native endpoint');
    for (const action of ['terminal-claim', 'terminal-receipt']) {
      const response = await request(baseUrl.replace(/\/$/, '') + '/api/v1/resource-leases/enrollment/' + action, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/json', ...(nodeKeysOnly ? {} : { 'x-node-token': token }) }, body: '{}',
      });
      if (nodeKeysOnly) {
        if (response.status !== 401 || !/^[0-9]{10,16}$/.test(response.headers?.get?.('x-magnus-server-time') ?? '')) throw new Error('Machine route unavailable');
      } else if (![400, 422].includes(response.status)) throw new Error('Machine validation route unavailable');
    }
  } catch {
    throw new Error('Managed terminal authority routes are unavailable; repair the native ingress before enrollment');
  }
}

if (process.env.HIVE_TERMINAL_PREFLIGHT_ROOT) {
  try {
    const root = process.env.HIVE_TERMINAL_PREFLIGHT_ROOT;
    const nodeKeysOnly = process.env.HIVE_TERMINAL_PREFLIGHT_NODE_KEYS_ONLY === 'true';
    process.loadEnvFile(root + '/.env');
    const base = root + '/node_modules/@hivemagnus/magnus-agent/dist';
    const { controlApiFetch } = await import(base + '/tls.js');
    const { CONTROL_API_URL, NODE_MANAGER_SECRET } = await import(base + '/env.js');
    await verifyTerminalAuthorityRoutes(CONTROL_API_URL, nodeKeysOnly ? '' : NODE_MANAGER_SECRET, controlApiFetch, { nodeKeysOnly });
  } catch {
    console.error('Magnus agent: Managed terminal authority preflight failed; repair the native ingress routes before enrollment');
    process.exitCode = 1;
  }
}
