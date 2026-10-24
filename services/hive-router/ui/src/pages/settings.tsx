import { useState } from 'react';
import { adminApi, ApiError } from '../lib/api';
import { useStore } from '../lib/store';
import { useToast } from '../components/toast';
import { Button, EmptyState, Field, JsonBlock, Panel, TextArea } from '../components/ui';
import { can } from '../lib/permissions';
import type { AdminUser, ConfigImportRequest, RoutingGoal, RoutingObjectiveConfig } from '../lib/types';
import { Icon } from '../components/icons';

const ROUTING_GOALS: Array<{ value: RoutingGoal; label: string; copy: string }> = [
  { value: 'balanced', label: 'Balanced', copy: 'Use quality, throughput, and cost together.' },
  { value: 'cheapest', label: 'Cheapest', copy: 'Prefer providers with lower declared token cost.' },
  { value: 'fastest', label: 'Fastest', copy: 'Prefer providers with higher declared throughput.' },
  { value: 'highest-quality', label: 'Quality', copy: 'Prefer providers with higher manual quality scores.' },
];

function parseRoutingObjective(settings: Array<{ key: string; parsed?: unknown }>): RoutingObjectiveConfig {
  const setting = settings.find((entry) => entry.key === 'routing.objective');
  const parsed = setting?.parsed;
  if (typeof parsed !== 'object' || parsed === null) {
    return { goal: 'balanced' };
  }
  const goal = (parsed as { goal?: unknown }).goal;
  return {
    ...(parsed as RoutingObjectiveConfig),
    goal: goal === 'cheapest' || goal === 'fastest' || goal === 'highest-quality' || goal === 'balanced' ? goal : 'balanced',
  };
}

export function SettingsPage({ currentUser }: { currentUser: AdminUser | null }) {
  const { data, refresh } = useStore();
  const toast = useToast();
  const canWriteSettings = can(currentUser, 'router:settings:write');
  const canWriteRouting = can(currentUser, 'router:routing:write');
  const [exporting, setExporting] = useState(false);
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);
  const [savingObjective, setSavingObjective] = useState(false);
  const currentObjective = parseRoutingObjective(data.runtimeSettings);

  async function handleExport() {
    setExporting(true);
    try {
      const config = await adminApi.exportConfig();
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `hive-router-config-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success('Config exported');
    } catch (caught) {
      toast.error('Export failed', caught instanceof Error ? caught.message : 'Could not export config');
    } finally {
      setExporting(false);
    }
  }

  async function handleImport() {
    let payload: ConfigImportRequest;
    try {
      payload = JSON.parse(importText) as ConfigImportRequest;
    } catch {
      toast.error('Invalid JSON', 'The import payload is not valid JSON.');
      return;
    }
    setImporting(true);
    try {
      await adminApi.importConfig(payload);
      toast.success('Config imported', 'Settings reconciled from payload.');
      setImportText('');
      await refresh();
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : caught instanceof Error ? caught.message : 'Could not import config';
      toast.error('Import failed', message);
    } finally {
      setImporting(false);
    }
  }

  async function saveRoutingObjective(goal: RoutingGoal) {
    setSavingObjective(true);
    try {
      await adminApi.updateRoutingObjective({ ...currentObjective, goal });
      toast.success('Routing objective saved', ROUTING_GOALS.find((entry) => entry.value === goal)?.label ?? goal);
      await refresh();
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : caught instanceof Error ? caught.message : 'Could not save routing objective';
      toast.error('Save failed', message);
    } finally {
      setSavingObjective(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Settings</h2>
          <p>Runtime configuration and full-config portability.</p>
        </div>
      </div>

      <div className="grid-2">
        <Panel title="Routing Objective" eyebrow="Provider scoring">
          <div className="segmented-grid">
            {ROUTING_GOALS.map((goal) => (
              <button
                key={goal.value}
                type="button"
                className={`segmented-card${currentObjective.goal === goal.value ? ' segmented-card--active' : ''}`}
                disabled={!canWriteRouting || savingObjective}
                onClick={() => void saveRoutingObjective(goal.value)}
              >
                <span>{goal.label}</span>
                <small>{goal.copy}</small>
              </button>
            ))}
          </div>
        </Panel>

        <Panel
          title="Export Configuration"
          eyebrow="Backup"
          actions={
            <Button variant="primary" size="sm" icon={<Icon.Download className="btn-ico" />} loading={exporting} onClick={handleExport}>
              Download
            </Button>
          }
        >
          <p style={{ color: 'var(--muted-light)', lineHeight: 1.6 }}>
            Download a complete snapshot of providers, aliases, routing rules, and heuristics as a portable JSON file.
          </p>
        </Panel>

        <Panel title="Import Configuration" eyebrow="Restore">
          <Field label="Config JSON" hint="Paste a previously exported configuration payload">
            <TextArea
              value={importText}
              onChange={setImportText}
              spellCheck={false}
              rows={6}
              placeholder='{ "providers": [], "aliases": [] }'
            />
          </Field>
          <div className="inline-actions" style={{ justifyContent: 'flex-end' }}>
            <Button
              variant="primary"
              icon={<Icon.Upload className="btn-ico" />}
              loading={importing}
              disabled={!canWriteSettings || !importText.trim()}
              onClick={handleImport}
            >
              Import
            </Button>
          </div>
        </Panel>
      </div>

      <Panel title="Runtime Settings" eyebrow={`${data.runtimeSettings.length} keys`}>
        {data.runtimeSettings.length === 0 ? (
          <EmptyState icon={<Icon.Settings width={34} height={34} />} message="No runtime settings configured." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {data.runtimeSettings.map((setting) => (
                  <tr key={setting.key}>
                    <td className="cell-strong">{setting.key}</td>
                    <td>
                      <JsonBlock value={setting.parsed ?? setting.valueJson} />
                    </td>
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
