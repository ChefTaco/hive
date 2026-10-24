import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { getRequestListener } from '@hono/node-server';
import { config, requireProductionSecrets } from './config.js';
import app from './app.js';
import { startDeploymentWorker } from './deployment-worker.js';

requireProductionSecrets();
const tls = config.tlsKeyFile && config.tlsCertFile ? { key: readFileSync(config.tlsKeyFile), cert: readFileSync(config.tlsCertFile), minVersion: 'TLSv1.2' as const } : undefined;
if (!tls) throw new Error('HIVE_SKILLS_TLS_KEY_FILE and HIVE_SKILLS_TLS_CERT_FILE are required');
createServer(tls, getRequestListener(app.fetch)).listen(config.port, config.host, () => console.log(`hive-skills listening at ${config.publicUrl}`));

startDeploymentWorker();
