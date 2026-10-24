import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeIamHealthPayload,
  normalizeMemoryHealthPayload,
  parseHiveStatusResponse,
  parseIamHealthPayload,
  parseMemoryHealthPayload,
  HIVE_REQUIRED_PORTS,
  HIVE_SERVICES,
  hiveServicesForHost,
  parseHiveHostTarget,
  renderHiveEndpoint,
  resolveHiveHosts,
} from '../src/index.js';

describe('hive status contracts', () => {
  it('parses a typed Hive status response with TLS details', () => {
    const parsed = parseHiveStatusResponse({
      generatedAt: '2026-07-06T00:00:00.000Z',
      uiUrl: 'https://hive.example.com',
      apps: [{
        key: 'router',
        name: 'Hive Router',
        role: 'traffic routing',
        status: 'online',
        summary: '2/2 providers enabled',
        internalUrl: 'https://hive.example.com',
        publicUrl: 'https://hive.example.com',
        consoleUrl: 'https://hive.example.com',
        checks: [{ name: 'tls-cert', status: 'pass', message: '60 days remaining.' }],
        details: {
          tlsCertificate: {
            configured: true,
            status: 'pass',
            message: '60 days remaining.',
            expectedHost: 'hive.example.com',
            hostnameMatched: true,
            daysRemaining: 60,
            domains: ['hive.example.com'],
          },
        },
      }],
    });

    assert.equal(parsed.apps[0]?.key, 'router');
    assert.equal(parsed.apps[0]?.checks[0]?.status, 'pass');
  });

  it('rejects invalid app status values', () => {
    assert.throws(() => parseHiveStatusResponse({
      generatedAt: '2026-07-06T00:00:00.000Z',
      uiUrl: 'https://hive.example.com',
      apps: [{ key: 'router', name: 'Router', role: 'routing', status: 'maybe', summary: 'x', internalUrl: 'x', publicUrl: 'x', consoleUrl: 'x', checks: [] }],
    }));
  });
});

describe('service manifest', () => {
  it('declares one source of truth for deployed services and ports', () => {
    assert.deepEqual(HIVE_SERVICES.map((service) => service.systemdService), ['hive-router', 'hive-iam', 'hivemem']);
    assert.deepEqual(HIVE_REQUIRED_PORTS, [443, 4020, 4200, 18443]);
    assert.ok(HIVE_SERVICES.every((service) => service.requiredEnvKeys.length > 0));
    assert.ok(HIVE_SERVICES.every((service) => service.backupPaths.length > 0));
  });

  it('renders host and fqdn endpoint templates', () => {
    assert.equal(
      renderHiveEndpoint('https://{fqdn}/health/ready on {host}', { host: 'hive', fqdn: 'hive.example.com' }),
      'https://hive.example.com/health/ready on hive',
    );
  });

  it('resolves hosts from HIVE_HOSTS with generic example defaults', () => {
    assert.deepEqual(resolveHiveHosts({}).map((target) => target.fqdn), ['hive.example.com', 'memory.example.com']);
    assert.deepEqual(resolveHiveHosts({ HIVE_HOSTS: 'primary:primary.internal.test:skills, mem:mem.internal.test' }), [
      { host: 'primary', fqdn: 'primary.internal.test', optionalServices: ['skills'] },
      { host: 'mem', fqdn: 'mem.internal.test' },
    ]);
    assert.deepEqual(parseHiveHostTarget('node1'), { host: 'node1', fqdn: 'node1' });
    assert.throws(() => parseHiveHostTarget('bad host'), /Invalid Hive host target/);
    assert.throws(() => parseHiveHostTarget('node1:node1.test:router'), /Unknown optional Hive service/);
  });

  it('adds optional services only for hosts that declare them', () => {
    assert.equal(hiveServicesForHost('hive').length, 4);
    assert.equal(hiveServicesForHost('memory-host').length, 3);
    assert.equal(hiveServicesForHost({ host: 'node1', fqdn: 'node1.test', optionalServices: ['skills'] }).length, 4);
  });
});


describe('service health contracts', () => {
  it('parses and normalizes IAM health payloads', () => {
    const payload = parseIamHealthPayload(JSON.stringify({
      status: 'healthy',
      version: '0.1.0',
      uptime: 42,
      timestamp: '2026-07-06T00:00:00.000Z',
      checks: [
        { name: 'database', status: 'pass', latencyMs: 2.5, message: 'connected' },
        { name: 'redis', status: 'pass', latencyMs: 1.2, message: 'connected' },
      ],
    }));

    assert.ok(payload);
    const normalized = normalizeIamHealthPayload(payload);
    assert.equal(normalized.status, 'healthy');
    assert.equal(normalized.checks.length, 2);
    assert.equal(normalized.raw.version, '0.1.0');
  });

  it('parses minimal and authenticated HiveMem health payloads', () => {
    const minimal = parseMemoryHealthPayload(JSON.stringify({ status: 'ok', checks: [{ name: 'qdrant', status: 'pass' }] }));
    assert.ok(minimal);
    assert.deepEqual(normalizeMemoryHealthPayload(minimal).checks, [{ name: 'qdrant', status: 'pass' }]);

    const rich = parseMemoryHealthPayload(JSON.stringify({
      status: 'degraded',
      version: '0.1.0',
      uptime_seconds: 9.5,
      qdrant: { connected: false, collections: [], error: 'connection refused' },
      embedding: { ready: true, model_path: '/models/embed', vector_dim: 384 },
      queue_worker: { enabled: true, running: false, in_flight: 0, max_workers: 2 },
      consolidation_cron: { enabled: false, running: false },
    }));

    assert.ok(rich);
    const normalized = normalizeMemoryHealthPayload(rich);
    assert.equal(normalized.status, 'degraded');
    assert.deepEqual(normalized.checks.map((check) => [check.name, check.status]), [
      ['qdrant', 'fail'],
      ['embedding', 'pass'],
      ['queue-worker', 'warn'],
      ['consolidation-cron', 'pass'],
    ]);
  });
});
