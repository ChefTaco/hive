import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { compareDeployments, loadSnapshots, runAudit } from './audit-deployments.ts';

const tmp = mkdtempSync(join(tmpdir(), 'hive-audit-test-'));

after(() => rmSync(tmp, { recursive: true, force: true }));

function service(name: 'hive-router' | 'hive-iam' | 'hivemem', overrides: Record<string, unknown> = {}) {
  const envKeys = name === 'hive-router'
    ? ['NODE_ENV', 'PUBLIC_ADMIN_URL', 'HIVE_IAM_INTERNAL_URL', 'HIVEMEM_INTERNAL_URL', 'HIVE_ROUTER_IAM_CLIENT_SECRET', 'HIVE_ROUTER_MEMORY_PROXY_TOKEN', 'HIVE_ROUTER_AUTH_MODE', 'HIVE_ROUTER_SECRET', 'TLS_CERT_PATH', 'TLS_KEY_PATH']
    : name === 'hive-iam'
      ? ['NODE_ENV', 'DATABASE_URL', 'REDIS_URL', 'JWT_PRIVATE_KEY_PATH', 'JWT_PUBLIC_KEY_PATH', 'COOKIE_SECRET', 'IAM_AGENT_SECRET', 'TLS_CERT_PATH', 'TLS_KEY_PATH']
      : ['HIVEMEM_JWT_SECRET', 'HIVEMEM_HOST', 'HIVEMEM_PORT'];
  const systemd = name === 'hive-router'
    ? { ProtectSystem: 'strict', PrivateTmp: 'yes', PrivateDevices: 'yes', NoNewPrivileges: 'no', RestrictSUIDSGID: 'no', User: 'hive-router', Group: 'hive-router', ReadWritePaths: '/opt/hive-router/data' }
    : name === 'hive-iam'
      ? { ProtectSystem: 'strict', PrivateTmp: 'yes', PrivateDevices: 'yes', NoNewPrivileges: 'yes', User: 'hive-iam', Group: 'hive-iam', ReadWritePaths: '/opt/hive-iam/prisma /opt/hive-iam/audit-logs' }
      : {};
  return { name, active: true, enabled: true, envKeys, systemd, ...overrides };
}

function snapshot(host: string, fqdn: string, overrides: Record<string, unknown> = {}) {
  return {
    host,
    fqdn,
    collectedAt: '2026-07-06T00:00:00Z',
    services: [service('hive-router'), service('hive-iam'), service('hivemem'), ...(host === 'hive' ? [{ name: 'hive-skills' as const, active: true, envKeys: ['HIVE_SKILLS_PUBLIC_URL', 'HIVE_SKILLS_DATA_DIR', 'HIVE_SKILLS_SESSION_SECRET', 'HIVE_SKILLS_TLS_CERT_FILE', 'HIVE_SKILLS_TLS_KEY_FILE'], systemd: { ProtectSystem: 'strict', PrivateTmp: 'yes' } }] : [])],
    ports: [{ port: 443 }, { port: 4020 }, { port: 4200 }, { port: 18443 }, ...(host === 'hive' ? [{ port: 4030 }] : [])],
    certificate: { subject: `CN=${fqdn}`, issuer: 'CN=Example CA', notAfter: '2030-01-01T00:00:00Z', sans: [fqdn] },
    hiveStatus: { apps: [{ key: 'iam', status: 'online' }, { key: 'memory', status: 'online' }, { key: 'router', status: 'online' }] },
    ...overrides,
  };
}

describe('audit-deployments', () => {
  it('reports no findings for matching healthy snapshots', () => {
    const findings = compareDeployments([
      snapshot('hive', 'hive.example.com'),
      snapshot('memory-host', 'memory.example.com'),
    ]);
    assert.deepEqual(findings, []);
  });

  it('detects missing env keys, inactive services, bad certs, closed ports, and status drift', () => {
    const bad = snapshot('memory-host', 'memory.example.com', {
      services: [
        service('hive-router', { envKeys: ['NODE_ENV', 'HIVE_IAM_INTERNAL_URL'], systemd: { ProtectSystem: 'full' } }),
        service('hive-iam', { active: false }),
        service('hivemem'),
      ],
      ports: [{ port: 443 }, { port: 4020 }],
      certificate: { subject: 'CN=wrong', issuer: 'CN=Example CA', notAfter: '2030-01-01T00:00:00Z', sans: ['wrong.example.com'] },
      hiveStatus: { apps: [{ key: 'iam', status: 'degraded' }, { key: 'router', status: 'online' }] },
    });
    const findings = compareDeployments([snapshot('hive', 'hive.example.com'), bad]);
    const messages = findings.map((finding) => finding.message).join('\n');

    assert.match(messages, /Port 4200 is not listening/);
    assert.match(messages, /hive-router is missing required env keys/);
    assert.match(messages, /HIVE_ROUTER_IAM_CLIENT_SECRET/);
    assert.match(messages, /HIVE_ROUTER_MEMORY_PROXY_TOKEN/);
    assert.match(messages, /hive-iam is not active/);
    assert.match(messages, /Certificate does not cover memory/);
    assert.match(messages, /memory/);
    assert.ok(findings.some((finding) => finding.area === 'drift/systemd'));
  });

  it('treats an unreadable /api/hive/status as an info note, not per-app drift', () => {
    const noStatus = snapshot('hive', 'hive.example.com', { hiveStatus: null });
    const findings = compareDeployments([noStatus]);
    const statusFindings = findings.filter((finding) => finding.area === 'hive-status');
    assert.equal(statusFindings.length, 1);
    assert.equal(statusFindings[0]?.severity, 'info');
    assert.ok(!findings.some((finding) => finding.severity === 'fail'));
    assert.ok(!findings.some((finding) => finding.message.includes('did not report')));
  });

  it('ignores host-specific env keys but flags portable service-config drift across hosts', () => {
    const base = snapshot('hive', 'hive.example.com', {
      services: [
        service('hive-router'),
        service('hive-iam'),
        service('hivemem', { envKeys: ['HIVEMEM_JWT_SECRET', 'HIVEMEM_HOST', 'HIVEMEM_PORT', 'HIVEMEM_RUNTIME', 'SSH_HOST2', 'HIVEMEM_SERVER_FQDN', 'HIVEMEM_WEB_PORT2'] }),
      ],
    });
    // memory-host lacks only the host-specific keys -> no drift expected.
    const memoryHostClean = snapshot('memory-host', 'memory.example.com', {
      services: [
        service('hive-router'),
        service('hive-iam'),
        service('hivemem', { envKeys: ['HIVEMEM_JWT_SECRET', 'HIVEMEM_HOST', 'HIVEMEM_PORT', 'HIVEMEM_RUNTIME'] }),
      ],
    });
    assert.ok(!compareDeployments([base, memoryHostClean]).some((finding) => finding.area === 'drift/env'));

    // memory-host also missing the portable HIVEMEM_RUNTIME -> real drift flagged.
    const memoryHostDrift = snapshot('memory-host', 'memory.example.com', {
      services: [
        service('hive-router'),
        service('hive-iam'),
        service('hivemem', { envKeys: ['HIVEMEM_JWT_SECRET', 'HIVEMEM_HOST', 'HIVEMEM_PORT'] }),
      ],
    });
    assert.ok(compareDeployments([base, memoryHostDrift]).some((finding) => finding.area === 'drift/env'));
  });

  it('loads snapshots from JSON and supports CLI snapshot comparison', () => {
    const file = join(tmp, 'snapshots.json');
    writeFileSync(file, JSON.stringify([snapshot('hive', 'hive.example.com')], null, 2));

    assert.equal(loadSnapshots(file).length, 1);

    const result = runAudit(['--snapshots', file]);
    assert.equal(result.hasFailures, false);
    assert.match(result.output, /No deployment drift detected/);
  });
});
