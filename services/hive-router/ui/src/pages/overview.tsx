import { useMemo } from 'react';
import { useStore } from '../lib/store';
import { Badge, EmptyState, HealthBadge, JsonBlock, Panel, StatCard } from '../components/ui';
import { Icon } from '../components/icons';
import { compactNumber, relativeTime } from '../lib/format';
import type { HiveAppState, HiveAppStatus, HiveHealthCheck } from '../lib/types';

type ActionItem = {
  id: string;
  tone: 'amber' | 'coral' | 'sky';
  title: string;
  detail: string;
  target: string;
  label: string;
};

type ActivityItem = {
  id: string;
  tone: 'amber' | 'coral' | 'sky' | 'teal' | 'muted';
  title: string;
  meta: string;
  target: string;
};

const APP_TARGETS: Record<string, string> = {
  iam: 'iam-overview',
  memory: 'memories',
  router: 'routers',
};

function stateTone(state: HiveAppState | string | undefined): 'teal' | 'amber' | 'coral' | 'muted' {
  return state === 'online' ? 'teal' : state === 'degraded' ? 'amber' : state === 'offline' ? 'coral' : 'muted';
}

function checkTone(status: string | undefined): 'teal' | 'amber' | 'coral' | 'muted' {
  return status === 'pass' ? 'teal' : status === 'warn' ? 'amber' : status === 'fail' ? 'coral' : 'muted';
}

function serviceTarget(app: HiveAppStatus): string {
  return APP_TARGETS[app.key] ?? 'hive';
}

function guidanceFor(app: HiveAppStatus, check: HiveHealthCheck): string {
  const text = `${check.name} ${check.message ?? ''}`.toLowerCase();
  if (text.includes('redis')) return 'Check redis-server on the IAM host, then restart hive-iam.service after Redis is healthy.';
  if (text.includes('qdrant')) return 'Check Qdrant reachability and HiveMem Qdrant env before restarting hivemem.service.';
  if (text.includes('tls') || text.includes('cert')) return 'Renew the TLS certificate through the Router deploy and confirm TLS_CERT_PATH.';
  if (text.includes('provider')) return 'Open Providers, refresh health, and disable or deprioritize failing upstreams.';
  if (text.includes('queue')) return 'Open Memory and inspect queue depth, worker state, and stuck jobs.';
  if (text.includes('auth') || text.includes('iam')) return 'Open IAM status and verify the Router IAM proxy client secret and IAM readiness.';
  return `Open ${app.name} details and inspect ${check.name}.`;
}

export function OverviewPage({ onNavigate }: { onNavigate: (view: string) => void }) {
  const { data } = useStore();

  const healthy = useMemo(
    () => data.providers.filter((p) => (p.lastHealthStatus ?? '').toLowerCase() === 'healthy').length,
    [data.providers],
  );
  const enabledProviders = data.providers.filter((p) => p.enabled).length;
  const unhealthyProviders = data.providers.filter((p) => p.enabled && (p.lastHealthStatus ?? '').toLowerCase() !== 'healthy');
  const totals = data.telemetry?.totals ?? { traces: 0, failures: 0, failovers: 0 };
  const successRate = totals.traces > 0 ? Math.round(((totals.traces - totals.failures) / totals.traces) * 100) : 100;
  const apps = data.hiveStatus?.apps ?? [];
  const appCounts = useMemo(() => ({
    online: apps.filter((app) => app.status === 'online').length,
    degraded: apps.filter((app) => app.status === 'degraded').length,
    offline: apps.filter((app) => app.status === 'offline').length,
  }), [apps]);
  const nonPassingChecks = useMemo(() => apps.flatMap((app) => app.checks
    .filter((check) => check.status !== 'pass')
    .map((check) => ({ app, check }))), [apps]);
  const openIncidents = data.incidents.filter((incident) => incident.status === 'open');
  const criticalIncidents = openIncidents.filter((incident) => incident.severity === 'critical').length;
  const latestIncident = data.incidents[0];
  const actionItems = useMemo<ActionItem[]>(() => {
    const items: ActionItem[] = [];
    for (const incident of openIncidents.slice(0, 2)) {
      items.push({
        id: `incident-${incident.id}`,
        tone: incident.severity === 'critical' ? 'coral' : 'amber',
        title: incident.title,
        detail: incident.summary,
        target: 'incidents',
        label: 'Incidents',
      });
    }
    for (const { app, check } of nonPassingChecks.slice(0, Math.max(0, 4 - items.length))) {
      items.push({
        id: `${app.key}-${check.name}`,
        tone: check.status === 'fail' ? 'coral' : 'amber',
        title: `${app.name}: ${check.name}`,
        detail: check.message ? `${check.message} ${guidanceFor(app, check)}` : guidanceFor(app, check),
        target: serviceTarget(app),
        label: app.name.replace('Hive ', ''),
      });
    }
    if (items.length < 4 && unhealthyProviders.length > 0) {
      items.push({
        id: 'providers-unhealthy',
        tone: 'amber',
        title: `${unhealthyProviders.length} provider${unhealthyProviders.length === 1 ? '' : 's'} need health review`,
        detail: 'Open provider health, refresh checks, and disable failing upstreams before they affect routing.',
        target: 'providers',
        label: 'Providers',
      });
    }
    return items;
  }, [nonPassingChecks, openIncidents, unhealthyProviders.length]);
  const activity = useMemo<ActivityItem[]>(() => {
    const incidentItems = data.incidents.slice(0, 4).map((incident): ActivityItem => ({
      id: `incident-${incident.id}`,
      tone: incident.severity === 'critical' ? 'coral' : incident.severity === 'warning' ? 'amber' : 'sky',
      title: incident.title,
      meta: `${incident.services.join(', ') || 'hive'} · ${relativeTime(incident.startedAt)}`,
      target: 'incidents',
    }));
    const auditItems = data.audit.slice(0, 5).map((event): ActivityItem => ({
      id: `audit-${event.id}`,
      tone: event.action.toLowerCase().includes('fail') ? 'coral' : event.action.toLowerCase().includes('denied') ? 'amber' : 'muted',
      title: event.action,
      meta: `${event.adminUser?.username ?? event.actorType} · ${relativeTime(event.createdAt)}`,
      target: 'audit',
    }));
    const traceItems = data.traces.slice(0, 3).map((trace): ActivityItem => ({
      id: `trace-${trace.id}`,
      tone: trace.outcome === 'SUCCEEDED' ? 'teal' : trace.outcome.includes('FAIL') ? 'coral' : 'sky',
      title: trace.providerModel ?? trace.routeKey ?? trace.path,
      meta: `${trace.provider?.name ?? 'provider'} · ${relativeTime(trace.createdAt)}`,
      target: 'traces',
    }));
    return [...incidentItems, ...auditItems, ...traceItems].slice(0, 8);
  }, [data.audit, data.incidents, data.traces]);

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Command Center</h2>
          <p>Identity, memory, routing, incidents, and traffic posture.</p>
        </div>
        {data.hiveStatus?.generatedAt ? <Badge tone="muted">sampled {relativeTime(data.hiveStatus.generatedAt)}</Badge> : null}
      </div>

      <div className="stats-grid">
        <StatCard
          label="Hive Apps"
          value={`${appCounts.online}/${apps.length || 3}`}
          sub={`${appCounts.degraded} degraded · ${appCounts.offline} offline`}
          accent={appCounts.offline > 0 ? 'coral' : appCounts.degraded > 0 ? 'amber' : 'teal'}
          emphasize
        />
        <StatCard label="Open Incidents" value={openIncidents.length} sub={`${criticalIncidents} critical`} accent={criticalIncidents > 0 ? 'coral' : openIncidents.length > 0 ? 'amber' : 'teal'} />
        <StatCard label="Providers" value={data.providers.length} sub={`${enabledProviders} enabled · ${healthy} healthy`} accent={unhealthyProviders.length > 0 ? 'amber' : 'sky'} />
        <StatCard label="Traces" value={compactNumber(totals.traces)} sub={`${successRate}% succeeded`} accent="teal" emphasize />
        <StatCard label="Actors" value={data.actors.length} sub={`${data.actors.filter((actor) => actor.status === 'active').length} active`} accent="violet" />
        <StatCard label="Attention" value={actionItems.length} sub={`${nonPassingChecks.length} checks flagged`} accent={actionItems.some((item) => item.tone === 'coral') ? 'coral' : actionItems.length > 0 ? 'amber' : 'teal'} />
      </div>

      <div className="grid-2">
        <Panel
          title="Attention Queue"
          eyebrow="Now"
          actions={latestIncident ? (
            <button className="btn btn--ghost btn--sm" onClick={() => onNavigate('incidents')}>
              Incidents
            </button>
          ) : null}
        >
          {actionItems.length === 0 ? (
            <EmptyState icon={<Icon.Check width={34} height={34} />} message="No immediate action flagged." />
          ) : (
            <div className="action-queue">
              {actionItems.map((item) => (
                <button className={`action-item action-item--${item.tone}`} key={item.id} onClick={() => onNavigate(item.target)}>
                  <span className="action-rail" />
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.detail}</small>
                  </span>
                  <Badge tone={item.tone}>{item.label}</Badge>
                </button>
              ))}
            </div>
          )}
        </Panel>

        <Panel
          title="Live Activity"
          eyebrow="Rail"
          actions={
            <button className="btn btn--ghost btn--sm" onClick={() => onNavigate('audit')}>
              Audit
            </button>
          }
        >
          {activity.length === 0 ? (
            <EmptyState icon={<Icon.Activity width={34} height={34} />} message="No activity recorded." />
          ) : (
            <div className="activity-rail">
              {activity.map((item) => (
                <button className="activity-item" key={item.id} onClick={() => onNavigate(item.target)}>
                  <span className={`activity-dot activity-dot--${item.tone}`} />
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.meta}</small>
                  </span>
                </button>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <div className="service-command-grid">
        {apps.length === 0 ? (
          <Panel title="Hive Apps" eyebrow="Status">
            <EmptyState icon={<Icon.Hexagon width={34} height={34} />} message="Hive app status is not available." />
          </Panel>
        ) : apps.map((app) => (
          <article className={`service-command service-command--${app.status}`} key={app.key}>
            <div className="service-command__top">
              <div>
                <p>{app.role}</p>
                <h3>{app.name}</h3>
              </div>
              <Badge tone={stateTone(app.status)} dot>{app.status}</Badge>
            </div>
            <p className="service-command__summary">{app.summary}</p>
            <div className="service-command__checks">
              {app.checks.slice(0, 4).map((check) => (
                <span className={`mini-check mini-check--${checkTone(check.status)}`} key={check.name}>
                  {check.name}
                </span>
              ))}
            </div>
            <button className="btn btn--ghost btn--sm" onClick={() => onNavigate(serviceTarget(app))}>
              Inspect
            </button>
          </article>
        ))}
      </div>

      <div className="grid-2">
        <Panel
          title="Provider Pulse"
          eyebrow="Health"
          actions={
            <button className="btn btn--ghost btn--sm" onClick={() => onNavigate('providers')}>
              Manage
            </button>
          }
        >
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
                  <p className="pulse-meta">
                    <Badge tone="muted">{provider.kind}</Badge>
                  </p>
                  <p className="pulse-meta" style={{ marginTop: 8 }}>
                    {provider.baseUrl}
                  </p>
                  {provider.lastHealthAt ? (
                    <p className="pulse-meta" style={{ marginTop: 6 }}>
                      checked {relativeTime(provider.lastHealthAt)}
                    </p>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </Panel>

        <Panel
          title="Latest Trace"
          eyebrow="Observability"
          actions={
            <button className="btn btn--ghost btn--sm" onClick={() => onNavigate('traces')}>
              View all
            </button>
          }
        >
          {data.telemetry?.latestTrace ? (
            <JsonBlock value={data.telemetry.latestTrace} />
          ) : (
            <EmptyState icon={<Icon.Activity width={34} height={34} />} message="No traces recorded yet." />
          )}
        </Panel>
      </div>

      <Panel
        title="Recent Activity"
        eyebrow="Audit"
        actions={
          <button className="btn btn--ghost btn--sm" onClick={() => onNavigate('audit')}>
            View log
          </button>
        }
      >
        {data.audit.length === 0 ? (
          <EmptyState icon={<Icon.Scroll width={34} height={34} />} message="No audit events recorded." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Entity</th>
                  <th>Actor</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {data.audit.slice(0, 8).map((event) => (
                  <tr key={event.id}>
                    <td className="cell-strong">{event.action}</td>
                    <td className="cell-mono">{event.entityType ?? '—'}</td>
                    <td className="cell-mono">{event.adminUser?.username ?? event.actorType}</td>
                    <td className="cell-mono">{relativeTime(event.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
