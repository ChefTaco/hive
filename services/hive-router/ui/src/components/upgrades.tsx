import { useEffect, useState } from 'react';
import { Button, Panel } from './ui';

interface Notice {
  installed: string;
  available?: string;
  notesUrl?: string;
  summary?: string;
  enabled: boolean;
  error?: string;
  canApply?: boolean;
  newRequiredEnv?: { name: string }[];
  migrations?: { impact: string }[];
}
interface Plan {
  hash: string;
  packages: Record<string, { from: string; to: string }>;
  changes: {
    newRequiredEnv: { name: string }[];
    removedEnv: { name: string }[];
    migrations: { component: string; id: string; impact: string }[];
  };
  target: {
    version: string;
    newRequiredEnv: { name: string }[];
    migrations: { component: string; id: string; impact: string }[];
  };
  attention: string[];
}
async function api(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await res.json();
  if (!res.ok) throw new Error(value.error || 'Upgrade request failed');
  return value;
}
export function UpgradesPanel({ canUpgrade }: { canUpgrade: boolean }) {
  const [notice, setNotice] = useState<Notice | null>(null),
    [plan, setPlan] = useState<Plan | null>(null),
    [result, setResult] = useState(''),
    [busy, setBusy] = useState(false);
  const [needsAuthentication, setNeedsAuthentication] = useState(false);
  const [password, setPassword] = useState('');
  function failure(error: unknown, fallback: string) {
    if (error instanceof Error && error.message === 'STEP_UP_REQUIRED') {
      setNeedsAuthentication(true);
      setPlan(null);
      setResult('Confirm your password, then review a new upgrade plan.');
    } else setResult(error instanceof Error ? error.message : fallback);
  }
  async function reauthenticate() {
    setBusy(true);
    try {
      await api('/api/auth/reauthenticate', { password });
      setNeedsAuthentication(false);
      setPlan(null);
      setResult('Authentication refreshed. Review the upgrade again.');
    } catch (e) {
      failure(e, 'Authentication failed');
    } finally {
      setPassword('');
      setBusy(false);
    }
  }
  useEffect(() => {
    let alive = true;
    void api('/api/hive/updates').then(
      (v) => {
        if (alive) setNotice(v as Notice);
      },
      () => {
        if (alive) setResult('Update status is unavailable.');
      },
    );
    return () => {
      alive = false;
    };
  }, []);
  async function prepare() {
    setBusy(true);
    try {
      setPlan((await api('/api/hive/upgrades/plan', {})) as Plan);
      setResult('');
    } catch (e) {
      failure(e, 'Could not prepare upgrade');
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!plan) return;
    setBusy(true);
    try {
      await api('/api/hive/upgrades/apply', { planHash: plan.hash });
      setResult('Upgrade started. The console will reconnect after the services restart.');
      setPlan(null);
    } catch (e) {
      failure(e, 'Could not apply upgrade');
    } finally {
      setBusy(false);
    }
  }
  async function status() {
    try {
      const value = (await api('/api/hive/upgrades/status')) as {
        busy: boolean;
        result: { state?: string; error?: string };
      };
      setResult(value.result.error || value.result.state || (value.busy ? 'running' : 'idle'));
    } catch {
      setResult('Services are restarting or the coordinator is unavailable. Try again shortly.');
    }
  }
  return (
    <Panel title="Hive updates" eyebrow="Installed services">
      <p>
        {notice
          ? `Installed ${notice.installed}${notice.available ? ` · ${notice.available} available` : ''}`
          : 'Checking update status…'}
      </p>
      {notice && !notice.enabled && (
        <p>
          Automatic update checks are disabled. Run <code>hive upgrade --dry-run</code> to check
          manually.
        </p>
      )}
      {notice?.summary && <p>{notice.summary}</p>}
      {notice?.notesUrl && (
        <p>
          <a href={notice.notesUrl} target="_blank" rel="noreferrer">
            Release notes
          </a>
        </p>
      )}
      {notice?.error && <p>{notice.error}</p>}
      {needsAuthentication && (
        <div>
          <label>
            Confirm your password{' '}
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <Button disabled={busy || !password} onClick={() => void reauthenticate()}>
            Confirm authentication
          </Button>
        </div>
      )}
      {notice?.newRequiredEnv?.length ? (
        <p>Required settings: {notice.newRequiredEnv.map((e) => e.name).join(', ')}</p>
      ) : null}
      {notice?.migrations?.some((m) => m.impact !== 'fast') && (
        <p>
          Migration requires operator review:{' '}
          {[...new Set(notice.migrations.map((m) => m.impact))].join(', ')}
        </p>
      )}
      {notice?.available && !notice.canApply && (
        <p>
          Run <code>hive upgrade --to {notice.available}</code> locally. Enroll the installation and
          enable UI upgrades to apply here.
        </p>
      )}
      {notice?.available && canUpgrade && notice.canApply && !needsAuthentication && (
        <Button disabled={busy} onClick={() => void prepare()}>
          Review upgrade
        </Button>
      )}
      {plan && (
        <div>
          <p>
            Upgrade to {plan.target.version}. Services pause while data is backed up and checked.
          </p>
          <ul>
            {Object.entries(plan.packages).map(([name, versions]) => (
              <li key={name}>
                {name}: {versions.from} → {versions.to}
              </li>
            ))}
          </ul>
          {plan.changes.newRequiredEnv.length > 0 && (
            <p>Required settings: {plan.changes.newRequiredEnv.map((e) => e.name).join(', ')}</p>
          )}
          {plan.changes.removedEnv.length > 0 && (
            <p>Removed settings: {plan.changes.removedEnv.map((e) => e.name).join(', ')}</p>
          )}
          {plan.changes.migrations.length > 0 && (
            <p>
              Migration impact:{' '}
              {[...new Set(plan.changes.migrations.map((m) => m.impact))].join(', ')}
            </p>
          )}
          {plan.attention.length > 0 && (
            <p>This release requires explicit approval: {plan.attention.join(', ')}.</p>
          )}
          <Button disabled={busy} onClick={() => void apply()}>
            Confirm upgrade to {plan.target.version}
          </Button>
          <Button onClick={() => setPlan(null)}>Cancel</Button>
        </div>
      )}
      <Button onClick={() => void status()}>Refresh upgrade status</Button>
      <p role="status">{result}</p>
    </Panel>
  );
}
