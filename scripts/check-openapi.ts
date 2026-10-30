import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildRouterOpenApiDocument } from '../services/hive-router/src/openapi/spec.ts';
import { buildOpenApiSpec as buildIamOpenApiSpec } from '../services/hive-iam/apps/iam-core/src/openapi/spec.ts';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface Snapshot {
  name: string;
  path: string;
  document: JsonValue;
}

function sortJson(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sortJson(child)]));
  }
  return null;
}

function pretty(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function operation(summary: string): JsonValue {
  return {
    summary,
    responses: {
      '200': {
        description: 'Success',
      },
    },
  };
}

function buildHiveMemOpenApiSpec(): JsonValue {
  return {
    openapi: '3.1.0',
    info: {
      title: 'HiveMem TypeScript Core API',
      version: '1.0.0',
      description: 'Core HiveMem REST surface. See services/hive-mem/HIVEMEM_API.md for the full reference.',
    },
    servers: [{ url: 'http://127.0.0.1:18790' }],
    paths: {
      '/v1/health': { get: operation('Health') },
      '/v1/health/live': { get: operation('Liveness') },
      '/v1/health/ready': { get: operation('Readiness') },
      '/v1/auth/login': { post: operation('Token compatibility login') },
      '/v1/memories': { get: operation('List memories'), post: operation('Create memory') },
      '/v1/memories/{id}': { get: operation('Get memory'), patch: operation('Update memory'), delete: operation('Delete memory') },
      '/v1/memories/search': { post: operation('Search memories') },
      '/v1/context': { post: operation('Build context pack') },
      '/v1/queue/jobs': { get: operation('List queue jobs'), post: operation('Create queue job') },
      '/v1/queue/jobs/{id}/run': { post: operation('Run queue job') },
      '/v1/queue/operations/{id}': { get: operation('Get queue operation receipt') },
      '/v1/peers/{peerId}/conclusions': { get: operation('List peer conclusions (supports paginate and cursor)') },
      '/v1/conclusions/{id}': { get: operation('Get conclusion (supports include_history)'), delete: operation('Delete conclusion') },
      '/v1/agents': { get: operation('List agents'), post: operation('Register agent') },
      '/v1/workspaces': { get: operation('List workspaces'), post: operation('Create workspace') },
      '/dashboard-data': { get: operation('Dashboard data') },
      '/dashboard/memories': { get: operation('Dashboard memory list') },
      '/dashboard/queue': { get: operation('Dashboard queue') },
      '/metrics': { get: operation('Prometheus metrics') },
    },
  };
}

function snapshots(rootDir: string): Snapshot[] {
  return [
    {
      name: 'router',
      path: resolve(rootDir, 'docs/openapi/router.openapi.json'),
      document: sortJson(buildRouterOpenApiDocument('http://127.0.0.1:9443')),
    },
    {
      name: 'iam',
      path: resolve(rootDir, 'docs/openapi/iam.openapi.json'),
      document: sortJson(buildIamOpenApiSpec()),
    },
    {
      name: 'hivemem',
      path: resolve(rootDir, 'docs/openapi/hivemem.openapi.json'),
      document: buildHiveMemOpenApiSpec(),
    },
  ];
}

function main(): void {
  const rootDir = resolve(process.cwd());
  const write = process.argv.includes('--write');
  const failures: string[] = [];

  for (const snapshot of snapshots(rootDir)) {
    const expected = pretty(snapshot.document);
    if (write) {
      mkdirSync(dirname(snapshot.path), { recursive: true });
      writeFileSync(snapshot.path, expected);
      continue;
    }
    if (!existsSync(snapshot.path)) {
      failures.push(`${snapshot.name}: missing ${snapshot.path}`);
      continue;
    }
    const actual = readFileSync(snapshot.path, 'utf8');
    if (actual !== expected) {
      failures.push(`${snapshot.name}: OpenAPI snapshot is out of date. Run npm run generate:openapi.`);
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
  console.log('OpenAPI snapshots are current.');
}

main();
