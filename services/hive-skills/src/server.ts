import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { getRequestListener } from '@hono/node-server';
import { config, requireProductionSecrets } from './config.js';
import { skillsMigration } from './upgrade.js';

requireProductionSecrets();
const tls = config.tlsKeyFile && config.tlsCertFile ? { key: readFileSync(config.tlsKeyFile), cert: readFileSync(config.tlsCertFile), minVersion: 'TLSv1.2' as const } : undefined;
if (!tls) throw new Error('HIVE_SKILLS_TLS_KEY_FILE and HIVE_SKILLS_TLS_CERT_FILE are required');
await skillsMigration([], true);
const { default: app } = await import('./app.js');
const { startDeploymentWorker } = await import('./deployment-worker.js');
const server = createServer(tls, getRequestListener(app.fetch)).listen(config.port, config.host, () => console.log(`hive-skills listening at ${config.publicUrl}`));

const stopWorker = startDeploymentWorker();
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  if (closing) return;
  closing = true;
  void Promise.all([stopWorker(), new Promise<void>((done) => server.close(() => done()))]).then(() => process.exit(0));
});

(await import('./release/runtime.js')).startUpdateChecks(JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version);
