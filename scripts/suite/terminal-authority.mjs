// A validation rejection proves each machine route is reachable without reserving any work.
export async function verifyTerminalAuthorityRoutes(baseUrl, token, request) {
  try {
    const base = new URL(baseUrl);
    if (base.protocol !== 'https:' || base.username || base.password || !token) throw new Error('Invalid native endpoint');
    for (const action of ['terminal-claim', 'terminal-receipt']) {
      const response = await request(baseUrl.replace(/\/$/, '') + '/api/v1/resource-leases/enrollment/' + action, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/json', 'x-node-token': token }, body: '{}',
      });
      if (![400, 422].includes(response.status)) throw new Error('Machine validation route unavailable');
    }
  } catch {
    throw new Error('Managed terminal authority routes are unavailable; repair the native ingress before enrollment');
  }
}

if (process.env.HIVE_TERMINAL_PREFLIGHT_ROOT) {
  try {
    const root = process.env.HIVE_TERMINAL_PREFLIGHT_ROOT;
    process.loadEnvFile(root + '/.env');
    const base = root + '/node_modules/@hivemagnus/magnus-agent/dist';
    const { controlApiFetch } = await import(base + '/tls.js');
    const { CONTROL_API_URL, NODE_MANAGER_SECRET } = await import(base + '/env.js');
    await verifyTerminalAuthorityRoutes(CONTROL_API_URL, NODE_MANAGER_SECRET, controlApiFetch);
  } catch {
    console.error('Magnus agent: Managed terminal authority preflight failed; repair the native ingress routes before enrollment');
    process.exitCode = 1;
  }
}
