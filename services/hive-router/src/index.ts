import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:https';
import { serve } from '@hono/node-server';
import { loadEnv } from './config/env.js';
import { prisma } from './storage/client.js';
import { ensureSqliteSchema } from './storage/schema.js';
import { bootstrapStorage } from './storage/bootstrap.js';
import { syncBuiltinApiDocs } from './storage/api-docs.js';
import { createApiApp } from './api/app.js';
import { createAdminApp } from './admin/app.js';
import { runProviderHealthSweep } from './providers/health.js';
import { log } from './telemetry/logger.js';
import { startTraceRetention } from './telemetry/retention.js';

const env = loadEnv();

await ensureSqliteSchema();
await prisma.$connect();
await bootstrapStorage();
await syncBuiltinApiDocs(env.PUBLIC_ADMIN_URL);

const apiApp = createApiApp();
const adminApp = createAdminApp();

const useTls = Boolean(
  env.TLS_CERT_PATH
  && env.TLS_KEY_PATH
  && existsSync(env.TLS_CERT_PATH)
  && existsSync(env.TLS_KEY_PATH),
);

const tlsOptions = useTls
  ? {
      createServer,
      serverOptions: {
        cert: readFileSync(env.TLS_CERT_PATH!),
        key: readFileSync(env.TLS_KEY_PATH!),
      },
    }
  : undefined;

const apiServer = useTls
  ? serve({ fetch: apiApp.fetch, hostname: env.API_HOST, port: env.API_PORT, ...tlsOptions }, (info) => {
      log('info', 'API plane listening', { host: env.API_HOST, url: `${env.PUBLIC_API_URL}`, port: info.port, tls: true });
    })
  : serve({ fetch: apiApp.fetch, hostname: env.API_HOST, port: env.API_PORT }, (info) => {
      log('info', 'API plane listening', { host: env.API_HOST, url: `http://${env.API_HOST}:${info.port}`, port: info.port, tls: false });
    });

const adminServer = useTls
  ? serve({ fetch: adminApp.fetch, hostname: env.ADMIN_HOST, port: env.ADMIN_PORT, ...tlsOptions }, (info) => {
      log('info', 'Admin plane listening', { host: env.ADMIN_HOST, url: `${env.PUBLIC_ADMIN_URL}`, port: info.port, tls: true });
    })
  : serve({ fetch: adminApp.fetch, hostname: env.ADMIN_HOST, port: env.ADMIN_PORT }, (info) => {
      log('info', 'Admin plane listening', { host: env.ADMIN_HOST, url: `http://${env.ADMIN_HOST}:${info.port}`, port: info.port, tls: false });
    });

await runProviderHealthSweep();
const healthInterval = setInterval(() => {
  void runProviderHealthSweep().catch((error) => {
    log('error', 'Provider health sweep failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}, 30_000);
const traceRetentionInterval = startTraceRetention();

async function shutdown(signal: string): Promise<void> {
  clearInterval(healthInterval);
  clearInterval(traceRetentionInterval);
  log('info', 'Shutting down hive-router', { signal });
  await prisma.$disconnect();
  apiServer.close();
  adminServer.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
