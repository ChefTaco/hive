import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HIVE_REQUIRED_PORTS,
  HIVE_SERVICES,
  hiveServicesForHost,
  parseHiveHostTarget,
  renderHiveEndpoint,
  resolveHiveHosts,
} from './lib/service-manifest.ts';

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
