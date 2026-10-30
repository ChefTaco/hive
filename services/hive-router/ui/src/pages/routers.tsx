import { useMemo } from 'react';
import { Badge, EmptyState, HealthBadge, JsonBlock, Panel, StatCard } from '../components/ui';
import { Icon } from '../components/icons';
import { compactNumber, relativeTime } from '../lib/format';
import { useStore } from '../lib/store';

export function RoutersPage({ onNavigate }: { onNavigate: (view: string) => void }) {
  const { data } = useStore();
  const app = data.hiveStatus?.apps.find((entry) => entry.key === 'router');
  const healthy = useMemo(
    () => data.providers.filter((provider) => (provider.lastHealthStatus ?? '').toLowerCase() === 'healthy').length,
    [data.providers],
  );
  const enabledProviders = data.providers.filter((provider) => provider.enabled).length;
  const totals = data.telemetry?.totals ?? { traces: 0, failures: 0, failovers: 0 };
  const successRate = totals.traces > 0 ? Math.round(((totals.traces - totals.failures) / totals.traces) * 100) : 100;

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Routers</h2>
          <p>Provider fleet, route policy, health, and trace evidence in one operations page.</p>
        </div>
        {app ? (
          <Badge tone={app.status === 'online' ? 'teal' : app.status === 'degraded' ? 'amber' : 'coral'} dot>
            {app.status}
          </Badge>
        ) : null}
      </div>

      <div className="stats-grid">
        <StatCard label="Providers" value={data.providers.length} sub={`${enabledProviders} enabled / ${healthy} healthy`} accent="amber" emphasize />
        <StatCard label="Route Rules" value={data.routeRules.length} sub={`${data.heuristics.length} heuristics`} accent="violet" />
        <StatCard label="Traces" value={compactNumber(totals.traces)} sub={`${successRate}% succeeded`} accent="sky" emphasize />
        <StatCard label="Failures" value={compactNumber(totals.failures)} sub={`${totals.failovers} failovers`} accent="coral" />
      </div>

      <div className="grid-2">
        <Panel title="Router Workbench" eyebrow="Controls">
          <div className="workbench-actions">
            <button className="btn btn--ghost" onClick={() => onNavigate('providers')}>
              <Icon.Server className="btn-ico" />
              Providers
            </button>
            <button className="btn btn--ghost" onClick={() => onNavigate('routing')}>
              <Icon.Route className="btn-ico" />
              Routing
            </button>
            <button className="btn btn--ghost" onClick={() => onNavigate('testing')}>
              <Icon.Hexagon className="btn-ico" />
              Testing
            </button>
            <button className="btn btn--ghost" onClick={() => onNavigate('traces')}>
              <Icon.Activity className="btn-ico" />
              Traces
            </button>
          </div>
        </Panel>

        <Panel title="Latest Trace" eyebrow="Evidence" actions={<button className="btn btn--ghost btn--sm" onClick={() => onNavigate('traces')}>View all</button>}>
          {data.telemetry?.latestTrace ? <JsonBlock value={data.telemetry.latestTrace} /> : <EmptyState icon={<Icon.Activity width={34} height={34} />} message="No traces recorded yet." />}
        </Panel>
      </div>

      <Panel title="Provider Pulse" eyebrow="Health" actions={<button className="btn btn--ghost btn--sm" onClick={() => onNavigate('providers')}>Manage</button>}>
        {data.providers.length === 0 ? (
          <EmptyState icon={<Icon.Server width={34} height={34} />} message="No providers registered yet." />
        ) : (
          <div className="pulse-grid">
            {data.providers.map((provider) => (
              <article className="pulse-card" key={provider.id}>
                <div className="pulse-top">
                  <span className="pulse-name">{provider.name}</span>
                  <HealthBadge status={provider.lastHealthStatus} />
                </div>
                <p className="pulse-meta"><Badge tone="muted">{provider.kind}</Badge></p>
                <p className="pulse-meta" style={{ marginTop: 8 }}>{provider.baseUrl}</p>
                {provider.lastHealthAt ? <p className="pulse-meta" style={{ marginTop: 6 }}>checked {relativeTime(provider.lastHealthAt)}</p> : null}
              </article>
            ))}
          </div>
        )}
      </Panel>
    </>
  );
}
