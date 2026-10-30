import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import type { Trace } from '../lib/types';
import { formatTime, relativeTime } from '../lib/format';
import { Badge, Button, Drawer, EmptyState, JsonBlock, OutcomeBadge, Panel } from '../components/ui';
import { Icon } from '../components/icons';

export function TracesPage() {
  const { data, refresh, refreshing } = useStore();
  const [selected, setSelected] = useState<Trace | null>(null);

  useEffect(() => { const id = new URLSearchParams(location.search).get('trace'); if (id) setSelected(data.traces.find((trace) => trace.id === id) ?? null); }, [data.traces]);
  function selectTrace(trace: Trace | null) { setSelected(trace); const url = new URL(location.href); if (trace) url.searchParams.set('trace', trace.id); else url.searchParams.delete('trace'); history.replaceState(null, '', url); }
  return (
    <>
      <div className="page-head">
        <div>
          <h2>Traces</h2>
          <p>Per-request routing evidence — provider selection, outcome, and timing.</p>
        </div>
        <Button variant="ghost" icon={<Icon.Refresh className="btn-ico" />} loading={refreshing} onClick={() => void refresh()}>
          Refresh
        </Button>
      </div>

      <Panel title="Recent Requests" eyebrow={`${data.traces.length} traces`}>
        {data.traces.length === 0 ? (
          <EmptyState icon={<Icon.Activity width={34} height={34} />} message="No traces recorded yet." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Route</th>
                  <th>Provider</th>
                  <th>Model</th>
                  <th>Outcome</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.traces.map((trace) => (
                  <tr key={trace.id} className="row-clickable" onClick={() => selectTrace(trace)}>
                    <td className="cell-mono" title={formatTime(trace.createdAt)}>
                      {relativeTime(trace.createdAt)}
                    </td>
                    <td>
                      <span className="cell-strong">{trace.routeKey ?? trace.path}</span>
                      <div className="cell-mono">
                        {trace.method} {trace.path}
                      </div>
                    </td>
                    <td>{trace.provider?.name ? <Badge tone="sky">{trace.provider.name}</Badge> : <Badge tone="muted">—</Badge>}</td>
                    <td className="cell-mono">{trace.providerModel ?? '—'}</td>
                    <td>
                      <OutcomeBadge outcome={trace.outcome} />
                    </td>
                    <td className="cell-mono">{trace.statusCode ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Drawer
        open={Boolean(selected)}
        onClose={() => selectTrace(null)}
        eyebrow="Trace detail"
        title={selected ? `${selected.method} ${selected.path}` : ''}
        footer={
          <Button variant="ghost" onClick={() => selectTrace(null)}>
            Close
          </Button>
        }
      >
        {selected ? (
          <>
            <div className="kv-list">
              <div className="kv-row">
                <span>Outcome</span>
                <OutcomeBadge outcome={selected.outcome} />
              </div>
              <div className="kv-row">
                <span>Status</span>
                <span className="cell-mono">{selected.statusCode ?? '—'}</span>
              </div>
              <div className="kv-row">
                <span>Provider</span>
                <span className="cell-mono">{selected.provider?.name ?? selected.providerKind ?? '—'}</span>
              </div>
              <div className="kv-row">
                <span>Model</span>
                <span className="cell-mono">{selected.providerModel ?? '—'}</span>
              </div>
              <div className="kv-row">
                <span>Route key</span>
                <span className="cell-mono">{selected.routeKey ?? '—'}</span>
              </div>
              <div className="kv-row">
                <span>Time</span>
                <span className="cell-mono">{formatTime(selected.createdAt)}</span>
              </div>
            </div>

            {selected.events && selected.events.length > 0 ? (
              <>
                <p className="panel-eyebrow" style={{ marginTop: 22 }}>
                  Event timeline
                </p>
                <JsonBlock value={selected.events} />
              </>
            ) : null}

            <p className="panel-eyebrow" style={{ marginTop: 22 }}>
              Raw trace
            </p>
            <JsonBlock value={selected} />
          </>
        ) : null}
      </Drawer>
    </>
  );
}
