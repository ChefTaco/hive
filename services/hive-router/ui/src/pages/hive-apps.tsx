import { useEffect, useMemo, useState } from 'react';
import { Badge, EmptyState, JsonBlock, Panel, StatCard } from '../components/ui';
import { Icon } from '../components/icons';
import { useStore } from '../lib/store';
import type { HiveAppKey, HiveAppState, HiveAppStatus, TlsCertificateStatus } from '../lib/types';
import { compactNumber, relativeTime } from '../lib/format';

const APP_ACCENTS: Record<HiveAppKey, 'amber' | 'teal' | 'sky' | 'violet' | 'coral'> = {
  iam: 'violet',
  memory: 'teal',
  router: 'amber',
};

function stateTone(status: HiveAppState): 'teal' | 'amber' | 'coral' {
  if (status === 'online') return 'teal';
  if (status === 'degraded') return 'amber';
  return 'coral';
}

function findApp(apps: HiveAppStatus[], key: HiveAppKey): HiveAppStatus | null {
  return apps.find((app) => app.key === key) ?? null;
}

function tlsCertificateFrom(app: HiveAppStatus | null): TlsCertificateStatus | null {
  const value = app?.details?.tlsCertificate;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const cert = value as Partial<TlsCertificateStatus>;
  if (typeof cert.configured !== 'boolean' || !cert.status || typeof cert.message !== 'string' || !Array.isArray(cert.domains)) {
    return null;
  }
  return cert as TlsCertificateStatus;
}

interface JwksLifetimeStatus {
  state: 'uninitialized' | 'healthy' | 'warning' | 'critical' | 'expired';
  remainingMs: number;
  trustedKeyCount: number;
}

function jwksLifetimeFrom(app: HiveAppStatus | null): JwksLifetimeStatus | null {
  const value = app?.details?.securityExporterJwks;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const status = value as Partial<JwksLifetimeStatus>;
  if (
    !status.state
    || typeof status.remainingMs !== 'number'
    || typeof status.trustedKeyCount !== 'number'
  ) return null;
  return status as JwksLifetimeStatus;
}

function certTone(status: TlsCertificateStatus['status']): 'teal' | 'amber' | 'coral' {
  if (status === 'pass') return 'teal';
  if (status === 'warn') return 'amber';
  return 'coral';
}

function formatCertDate(value?: string): string {
  if (!value) return 'unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function CertificatePanel({ certificate }: { certificate: TlsCertificateStatus | null }) {
  if (!certificate) {
    return null;
  }

  const domains = certificate.domains.length > 0 ? certificate.domains.join(', ') : certificate.expectedHost ?? 'unknown';
  return (
    <Panel
      title="TLS Certificate"
      eyebrow="Public UI"
      actions={
        <Badge tone={certTone(certificate.status)} dot>
          {certificate.status}
        </Badge>
      }
    >
      <div className="check-list">
        <div className="check-row">
          <div>
            <strong>{certificate.expectedHost ?? 'public host'}</strong>
            <span>{certificate.message}</span>
          </div>
          <Badge tone={certificate.hostnameMatched === false ? 'coral' : 'teal'} dot>
            {certificate.hostnameMatched === false ? 'mismatch' : 'matched'}
          </Badge>
        </div>
        <div className="check-row">
          <div>
            <strong>Expires</strong>
            <span>{formatCertDate(certificate.validTo)}{typeof certificate.daysRemaining === 'number' ? ` (${certificate.daysRemaining} days)` : ''}</span>
          </div>
        </div>
        <div className="check-row">
          <div>
            <strong>Domains</strong>
            <span>{domains}</span>
          </div>
        </div>
        <div className="check-row">
          <div>
            <strong>Issuer</strong>
            <span>{certificate.issuer ?? 'unknown'}</span>
          </div>
        </div>
      </div>
    </Panel>
  );
}

function AppStatusCard({ app, onNavigate }: { app: HiveAppStatus; onNavigate?: (view: string) => void }) {
  const openLabel = app.key === 'router' ? 'Open console' : 'Open native';
  const focusTarget = app.key === 'iam' ? 'iam-overview' : app.key === 'memory' ? 'memories' : 'routers';
  return (
    <article className={`app-status-card app-status-card--${app.key}`}>
      <div className="app-status-top">
        <div>
          <p className="panel-eyebrow">{app.key}</p>
          <h3>{app.name}</h3>
        </div>
        <Badge tone={stateTone(app.status)} dot>
          {app.status}
        </Badge>
      </div>
      <p className="app-status-role">{app.role}</p>
      <div className="app-status-summary">
        <span>{app.summary}</span>
        {typeof app.latencyMs === 'number' ? <span>{app.latencyMs} ms</span> : null}
      </div>
      <div className="service-actions">
        {onNavigate ? (
          <button className="btn btn--ghost btn--sm" onClick={() => onNavigate(focusTarget)}>
            <Icon.Hexagon className="btn-ico" />
            Focus
          </button>
        ) : null}
        <a className="btn btn--ghost btn--sm" href={app.consoleUrl} target="_blank" rel="noreferrer">
          <Icon.Route className="btn-ico" />
          {openLabel}
        </a>
      </div>
    </article>
  );
}

function CheckList({ app }: { app: HiveAppStatus | null }) {
  if (!app) {
    return <EmptyState icon={<Icon.Alert width={34} height={34} />} message="Status data is not available." />;
  }

  if (app.checks.length === 0) {
    return <EmptyState icon={<Icon.Info width={34} height={34} />} message={app.summary} />;
  }

  return (
    <div className="check-list">
      {app.checks.map((check) => (
        <div className="check-row" key={check.name}>
          <div>
            <strong>{check.name}</strong>
            {check.message ? <span>{check.message}</span> : null}
          </div>
          <Badge tone={check.status === 'pass' ? 'teal' : check.status === 'warn' ? 'amber' : 'coral'} dot>
            {check.status}
          </Badge>
        </div>
      ))}
    </div>
  );
}

export function HiveOverviewPage({ onNavigate }: { onNavigate: (view: string) => void }) {
  const { data } = useStore();
  const [skills, setSkills] = useState<{ configured?: boolean; ready?: boolean; publicUrl?: string; error?: string; catalog?: Array<{ slug: string; name: string }> } | null>(null);
  useEffect(() => { const controller = new AbortController(); void fetch('/api/hive/skills', { signal: controller.signal }).then((response) => response.json()).then(setSkills).catch(() => { if (!controller.signal.aborted) setSkills({ configured: true, ready: false, error: 'Registry status unavailable' }); }); return () => controller.abort(); }, [data.hiveStatus?.generatedAt]);
  const apps = data.hiveStatus?.apps ?? [];
  const online = apps.filter((app) => app.status === 'online').length;
  const degraded = apps.filter((app) => app.status === 'degraded').length;
  const offline = apps.filter((app) => app.status === 'offline').length;
  const generatedAt = data.hiveStatus?.generatedAt;
  const routerApp = findApp(apps, 'router');
  const tlsCertificate = tlsCertificateFrom(routerApp);
  const jwksLifetime = jwksLifetimeFrom(routerApp);

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Hive Control Surface</h2>
          <p>Identity, memory, and routing status in one operator shell.</p>
        </div>
        {generatedAt ? <Badge tone="muted">sampled {relativeTime(generatedAt)}</Badge> : null}
      </div>

      {skills?.configured && <Panel title="Skills registry" eyebrow={skills.ready ? 'Ready' : 'Unavailable'}>
        {skills.error && <p role="alert">{skills.error}</p>}
        <p>{skills.catalog?.length ?? 0} enabled skills on this installation.</p>
        {skills.publicUrl && <a href={skills.publicUrl} target="_blank" rel="noreferrer">Open catalog and release channels</a>}
      </Panel>}
      <section className="hive-lattice" aria-label="Hive service lattice">
        <div className="lattice-core">
          <Icon.Hexagon width={42} height={42} />
          <strong>Hive</strong>
        </div>
        {apps.map((app) => (
          <button
            key={app.key}
            className={`lattice-node lattice-node--${app.key} lattice-node--${app.status}`}
            onClick={() => onNavigate(app.key === 'iam' ? 'iam-overview' : app.key === 'memory' ? 'memories' : 'routers')}
          >
            <span>{app.name.replace('Hive ', '')}</span>
            <small>{app.status}</small>
          </button>
        ))}
      </section>

      <div className="stats-grid">
        <StatCard label="Apps Online" value={online} sub={`${apps.length} registered`} accent="teal" emphasize />
        <StatCard label="Degraded" value={degraded} sub="needs attention" accent="amber" />
        <StatCard label="Offline" value={offline} sub="not reachable" accent="coral" />
        <StatCard label="Router Traces" value={compactNumber(data.telemetry?.totals.traces ?? 0)} sub="traffic evidence" accent="sky" />
        <StatCard label="TLS Cert" value={tlsCertificate?.status ?? 'unknown'} sub={tlsCertificate?.message ?? 'not reported'} accent={tlsCertificate?.status === 'pass' ? 'teal' : tlsCertificate?.status === 'warn' ? 'amber' : 'coral'} />
        <StatCard
          label="Exporter JWKS"
          value={jwksLifetime?.state ?? 'unknown'}
          sub={jwksLifetime ? `${Math.ceil(jwksLifetime.remainingMs / 1000)}s remaining; ${jwksLifetime.trustedKeyCount} keys` : 'not reported'}
          accent={jwksLifetime?.state === 'healthy' ? 'teal' : jwksLifetime?.state === 'expired' ? 'coral' : 'amber'}
        />
      </div>

      <CertificatePanel certificate={tlsCertificate} />

      <div className="app-status-grid">
        {apps.map((app) => (
          <AppStatusCard app={app} key={app.key} onNavigate={onNavigate} />
        ))}
      </div>
    </>
  );
}

export function IamPage() {
  const { data } = useStore();
  const app = findApp(data.hiveStatus?.apps ?? [], 'iam');

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Hive IAM</h2>
          <p>Identity core, OAuth clients, roles, groups, and Linux user mapping.</p>
        </div>
        {app ? (
          <Badge tone={stateTone(app.status)} dot>
            {app.status}
          </Badge>
        ) : null}
      </div>

      <div className="stats-grid">
        <StatCard label="State" value={app?.status ?? 'unknown'} sub={app?.summary} accent={APP_ACCENTS.iam} emphasize />
        <StatCard label="Checks" value={app?.checks.length ?? 0} sub="health probes" accent="sky" />
        <StatCard label="Endpoint" value="4200" sub={app?.internalUrl ?? 'unconfigured'} accent="violet" />
      </div>

      <div className="grid-2">
        <Panel
          title="IAM Health"
          eyebrow="Checks"
          actions={
            app ? (
              <a className="btn btn--ghost btn--sm" href={app.consoleUrl} target="_blank" rel="noreferrer">
                <Icon.Book className="btn-ico" />
                Docs
              </a>
            ) : null
          }
        >
          <CheckList app={app} />
        </Panel>
        <Panel title="Last Payload" eyebrow="Raw">
          {app?.details ? <JsonBlock value={app.details} /> : <EmptyState icon={<Icon.Info width={34} height={34} />} message="No IAM payload." />}
        </Panel>
      </div>
    </>
  );
}

export function MemoryPage() {
  const { data } = useStore();
  const app = findApp(data.hiveStatus?.apps ?? [], 'memory');

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Hive Memory</h2>
          <p>Semantic memory, task history, consolidation, and relationship graph.</p>
        </div>
        {app ? (
          <Badge tone={stateTone(app.status)} dot>
            {app.status}
          </Badge>
        ) : null}
      </div>

      <div className="stats-grid">
        <StatCard label="State" value={app?.status ?? 'unknown'} sub={app?.summary} accent={APP_ACCENTS.memory} emphasize />
        <StatCard label="Checks" value={app?.checks.length ?? 0} sub="memory service probes" accent="amber" />
        <StatCard label="Dashboard" value="/dashboard" sub={app?.publicUrl ?? 'unconfigured'} accent="teal" />
      </div>

      <div className="grid-2">
        <Panel
          title="Memory Health"
          eyebrow="Checks"
          actions={
            app ? (
              <a className="btn btn--ghost btn--sm" href={app.consoleUrl} target="_blank" rel="noreferrer">
                <Icon.Activity className="btn-ico" />
                Dashboard
              </a>
            ) : null
          }
        >
          <CheckList app={app} />
        </Panel>
        <Panel title="Last Payload" eyebrow="Raw">
          {app?.details ? <JsonBlock value={app.details} /> : <EmptyState icon={<Icon.Info width={34} height={34} />} message="No memory payload." />}
        </Panel>
      </div>
    </>
  );
}

export function RouterPage({ onNavigate }: { onNavigate: (view: string) => void }) {
  const { data } = useStore();
  const app = findApp(data.hiveStatus?.apps ?? [], 'router');
  const totals = data.telemetry?.totals ?? { traces: 0, failures: 0, failovers: 0 };
  const enabledProviders = useMemo(() => data.providers.filter((provider) => provider.enabled).length, [data.providers]);

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Hive Router</h2>
          <p>Provider fleet, routing rules, failover posture, and traffic traces.</p>
        </div>
        {app ? (
          <Badge tone={stateTone(app.status)} dot>
            {app.status}
          </Badge>
        ) : null}
      </div>

      <div className="stats-grid">
        <StatCard label="Providers" value={data.providers.length} sub={`${enabledProviders} enabled`} accent="amber" emphasize />
        <StatCard label="Route Rules" value={data.routeRules.length} sub={`${data.heuristics.length} heuristics`} accent="violet" />
        <StatCard label="Traces" value={compactNumber(totals.traces)} sub={`${totals.failures} failures`} accent="sky" />
        <StatCard label="Failovers" value={compactNumber(totals.failovers)} sub="provider re-routes" accent="teal" />
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
        <Panel title="Router Health" eyebrow="Checks">
          <CheckList app={app} />
        </Panel>
      </div>
    </>
  );
}
