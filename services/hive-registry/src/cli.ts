#!/usr/bin/env node
// Runs inside the container. The installer reaches the private API through this client
// over `docker compose exec`, so a controller and a host need no Node runtime and the
// write credential stays in its protected file, mounted only in this container.
import { readFileSync } from 'node:fs';

const port = process.env.HIVE_REGISTRY_PORT ?? '8095';
const base = `http://127.0.0.1:${port}`;

async function stdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function credential(kind: string): string | undefined {
  if (kind === 'public') return undefined;
  const file = kind === 'write' ? (process.env.HIVE_REGISTRY_WRITE_TOKEN_FILE ?? '/config/write-token') : (process.env.HIVE_REGISTRY_READ_TOKEN_FILE ?? '/config/read-token');
  return readFileSync(file, 'utf8').trim();
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'health': {
    const response = await fetch(`${base}/health/ready`, { signal: AbortSignal.timeout(3000) }).catch(() => undefined);
    process.exit(response?.ok ? 0 : 1);
    break;
  }
  case '--version': {
    console.log((JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version);
    break;
  }
  case 'migrate': {
    // Explicit, signed release migrations for existing data. Rehearsals run it on copies.
    const { loadConfig } = await import('./config.js');
    const { openDatabase } = await import('./store.js');
    const config = loadConfig();
    openDatabase({ dataDirectory: config.dataDirectory, autoMigrate: true, readOnly: false }).close();
    break;
  }
  case 'request': {
    const [method, path, kind = 'read'] = args;
    if (!method || !path || !/^(GET|POST|PUT|DELETE)$/.test(method) || !/^\/v1\/[A-Za-z0-9/_?=&-]*$/.test(path) || !/^(public|read|write)$/.test(kind)) {
      console.error('Usage: request METHOD /v1/PATH [public|read|write]');
      process.exit(2);
    }
    const token = credential(kind);
    const response = await fetch(base + path, {
      method,
      signal: AbortSignal.timeout(30_000),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(method === 'GET' || method === 'DELETE' ? {} : { 'Content-Type': 'application/json' }) },
      ...(method === 'POST' || method === 'PUT' ? { body: await stdin() } : {}),
    });
    const text = await response.text();
    if (response.ok) console.log(text);
    else {
      console.error(text);
      process.exit(1);
    }
    break;
  }
  default:
    console.error('Usage: cli.js health|migrate|request|--version');
    process.exit(2);
}
