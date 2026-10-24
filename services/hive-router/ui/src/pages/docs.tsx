import { useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import type { ApiDoc } from '../lib/types';
import { Badge, Button, Drawer, EmptyState, JsonBlock, Panel } from '../components/ui';
import { Icon } from '../components/icons';

const RUNBOOKS = [
  {
    title: 'Secret rotation',
    symptom: 'Planned credential change or suspected exposure',
    action: 'Run a dry-run rotation, review the redacted plan, then apply during a maintenance window.',
    command: 'npm run rotate:secrets -- --host hive --kind all',
    target: 'settings',
  },
  {
    title: 'Rollback',
    symptom: 'Router deploy fails health or the UI regresses after release',
    action: 'Roll Router back to the previous retained release, then verify readiness and audit drift.',
    command: 'npm run deploy -- --rollback',
    target: 'routers',
  },
  {
    title: 'Dependency degraded',
    symptom: 'IAM Redis, Memory Qdrant, provider health, or SQLite checks are degraded',
    action: 'Open the service page, inspect failing checks, repair the dependency, then restart only the affected service.',
    command: 'npm run audit:deployments',
    target: 'hive',
  },
  {
    title: 'Certificate warning',
    symptom: 'TLS cert is expired, near expiry, or does not match the public FQDN',
    action: 'Redeploy Router with the expected certificate domain and verify the parsed TLS details.',
    command: 'HIVE_ROUTER_CERT_DOMAIN=hive.example.com npm run deploy:router',
    target: 'hive',
  },
  {
    title: 'Memory queue backlog',
    symptom: 'HiveMem queue or worker checks show warn/fail',
    action: 'Open Memory, inspect queue state, retry or cancel stuck jobs, and check Qdrant before restarting HiveMem.',
    command: 'curl --fail https://hive.example.com/v1/health/dependencies',
    target: 'memories',
  },
  {
    title: 'IAM lockout',
    symptom: 'Operator cannot sign in or sessions are failing step-up/auth checks',
    action: 'Use OS/PAM break-glass login, inspect IAM sessions/audit, then reset the admin password only if needed.',
    command: 'IAM_RESET_PASSWORD=<known-password> npm run reset:admin',
    target: 'iam-sessions',
  },
] as const;

function methodTone(method?: string): 'teal' | 'sky' | 'amber' | 'coral' | 'muted' {
  switch ((method ?? '').toUpperCase()) {
    case 'GET':
      return 'sky';
    case 'POST':
      return 'teal';
    case 'PUT':
    case 'PATCH':
      return 'amber';
    case 'DELETE':
      return 'coral';
    default:
      return 'muted';
  }
}

export function DocsPage({ onNavigate }: { onNavigate?: (view: string) => void }) {
  const { data } = useStore();
  const [selected, setSelected] = useState<ApiDoc | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<string, ApiDoc[]>();
    for (const doc of data.docs) {
      const scope = doc.scope ?? 'general';
      const list = map.get(scope) ?? [];
      list.push(doc);
      map.set(scope, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data.docs]);

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Docs</h2>
          <p>Runbooks and endpoint surface grouped by scope.</p>
        </div>
      </div>

      <Panel title="Operator Runbooks" eyebrow={`${RUNBOOKS.length} repairs`}>
        <div className="runbook-grid">
          {RUNBOOKS.map((runbook) => (
            <article className="runbook-card" key={runbook.title}>
              <div>
                <h3>{runbook.title}</h3>
                <p>{runbook.symptom}</p>
              </div>
              <p className="runbook-action">{runbook.action}</p>
              <code>{runbook.command}</code>
              {onNavigate ? (
                <button className="btn btn--ghost btn--sm" onClick={() => onNavigate(runbook.target)}>
                  Open
                </button>
              ) : null}
            </article>
          ))}
        </div>
      </Panel>

      {data.docs.length === 0 ? (
        <Panel title="Endpoints" eyebrow="0 documented">
          <EmptyState icon={<Icon.Book width={34} height={34} />} message="No API documentation available." />
        </Panel>
      ) : (
        grouped.map(([scope, docs]) => (
          <Panel key={scope} title={scope} eyebrow={`${docs.length} endpoints`}>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Method</th>
                    <th>Path</th>
                    <th>Summary</th>
                  </tr>
                </thead>
                <tbody>
                  {docs.map((doc, i) => (
                    <tr key={doc.id ?? `${scope}-${i}`} className="row-clickable" onClick={() => setSelected(doc)}>
                      <td>
                        <Badge tone={methodTone(doc.method)}>{doc.method ?? '—'}</Badge>
                      </td>
                      <td className="cell-mono">{doc.path ?? doc.title ?? '—'}</td>
                      <td>{doc.summary ?? doc.description ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        ))
      )}

      <Drawer
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        eyebrow={selected?.method ?? 'Endpoint'}
        title={selected?.path ?? selected?.title ?? ''}
        footer={
          <Button variant="ghost" onClick={() => setSelected(null)}>
            Close
          </Button>
        }
      >
        {selected ? (
          <>
            {selected.description ? <p style={{ color: 'var(--text)', lineHeight: 1.6 }}>{selected.description}</p> : null}
            <p className="panel-eyebrow" style={{ marginTop: 18 }}>
              Definition
            </p>
            <JsonBlock value={selected} />
          </>
        ) : null}
      </Drawer>
    </>
  );
}
