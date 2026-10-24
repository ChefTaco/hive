import { useRef, useState } from 'react';
import { adminApi, ApiError } from '../lib/api';
import { useStore } from '../lib/store';
import { useToast } from '../components/toast';
import { can } from '../lib/permissions';
import type { AdminUser, ClientKey } from '../lib/types';
import { formatTime, relativeTime } from '../lib/format';
import {
  Badge,
  Button,
  ConfirmDialog,
  CopyField,
  Drawer,
  EmptyState,
  EnabledBadge,
  Field,
  IconButton,
  Panel,
  JsonBlock,
  TextArea,
  TextInput,
  Toggle,
} from '../components/ui';
import { Icon } from '../components/icons';

type KeyDrawerMode = 'create' | 'edit';

function metadataToText(metadataJson?: string | null): string {
  if (!metadataJson) return '{}';
  try {
    const parsed = JSON.parse(metadataJson) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return JSON.stringify(parsed, null, 2);
    }
  } catch {
    // keep raw value for manual repair
  }
  return metadataJson;
}

function parseMetadataInput(input: string): Record<string, unknown> {
  const normalized = input.trim();
  if (!normalized) return {};
  const parsed = JSON.parse(normalized) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Metadata must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function metadataSummary(metadataJson?: string | null): string {
  if (!metadataJson) return '—';
  try {
    const parsed = JSON.parse(metadataJson) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    if (keys.length === 0) return '{}';
    return `${keys.length} entries`;
  } catch {
    return 'invalid';
  }
}

export function KeysPage({ currentUser }: { currentUser: AdminUser | null }) {
  const { data, refresh } = useStore();
  const toast = useToast();
  const canWriteKeys = can(currentUser, 'router:keys:write');
  const [mode, setMode] = useState<KeyDrawerMode | null>(null);
  const [name, setName] = useState('');
  const [metadataText, setMetadataText] = useState('{}');
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<{ name: string; apiKey: string } | null>(null);
  const [target, setTarget] = useState<ClientKey | null>(null);
  const [deleting, setDeleting] = useState(false);
  const usageGeneration = useRef(0);
  const [usage, setUsage] = useState<unknown>(null);
  const [usageError, setUsageError] = useState<string | null>(null);

  const openCreate = () => {
    setMode('create');
    setName('');
    setMetadataText('{}');
    setEnabled(true);
    setCreated(null);
    setTarget(null);
  };

  const openEdit = (key: ClientKey) => {
    setUsage(null); setUsageError(null);
    const generation = ++usageGeneration.current;
    void fetch(`/api/client-keys/${encodeURIComponent(key.id)}/usage`).then(async (response) => { if (!response.ok) throw new Error('Usage accounting unavailable'); const value = await response.json(); if (generation === usageGeneration.current) setUsage(value); }).catch((error: unknown) => { if (generation === usageGeneration.current) setUsageError(error instanceof Error ? error.message : 'Usage unavailable'); });
    setMode('edit');
    setName(key.name);
    setMetadataText(metadataToText(key.metadataJson));
    setEnabled(key.enabled);
    setCreated(null);
    setTarget(key);
  };

  const closeDrawer = () => {
    setMode(null);
    setName('');
    setMetadataText('{}');
    setEnabled(true);
    setCreated(null);
    setTarget(null);
  };

  async function save() {
    let metadata: Record<string, unknown>;
    try {
      metadata = parseMetadataInput(metadataText);
    } catch (error) {
      toast.error('Invalid metadata', error instanceof Error ? error.message : 'Could not parse metadata JSON');
      return;
    }

    const trimmedName = name.trim();
    if (trimmedName.length < 2) {
      toast.error('Name required', 'Key name must be at least 2 characters');
      return;
    }

    setSaving(true);
    try {
      if (mode === 'edit' && target) {
        await adminApi.updateClientKey(target.id, { name: trimmedName, enabled, metadata });
        toast.success('API key updated', 'Changes were saved.');
        closeDrawer();
      } else {
        const result = await adminApi.createClientKey({ name: trimmedName, metadata });
        setCreated({ name: trimmedName, apiKey: result.data.apiKey });
        toast.success('API key created', 'Copy it now — it is shown only once.');
      }
      await refresh();
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : caught instanceof Error ? caught.message : 'Could not save key';
      toast.error('Save failed', message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnable(key: ClientKey, next: boolean) {
    setDeleting(true);
    try {
      await adminApi.updateClientKey(key.id, { enabled: next });
      toast.success('API key updated', `Key ${next ? 'enabled' : 'disabled'}`);
      await refresh();
    } catch (caught) {
      toast.error('Update failed', caught instanceof Error ? caught.message : 'Could not update key');
    } finally {
      setDeleting(false);
    }
  }

  async function remove() {
    if (!target) return;
    setDeleting(true);
    try {
      await adminApi.deleteClientKey(target.id);
      toast.success('Key deleted', target.name);
      setTarget(null);
      await refresh();
    } catch (caught) {
      toast.error('Delete failed', caught instanceof Error ? caught.message : 'Could not delete key');
    } finally {
      setDeleting(false);
    }
  }

  const isCreate = mode === 'create';
  const isDrawerOpen = mode !== null;
  const drawerTitle = isCreate ? 'Issue API Key' : 'Edit API Key';
  const createdKeyMessage = created ? `Key "${created.name}" was created and is valid once.` : '';

  return (
    <>
      <div className="page-head">
        <div>
          <h2>API Keys</h2>
          <p>OpenAI-compatible API credentials that downstream services use to reach the router.</p>
        </div>
        <Button variant="primary" icon={<Icon.Plus className="btn-ico" />} disabled={!canWriteKeys} onClick={openCreate}>
          Issue Key
        </Button>
      </div>

      <Panel title="Issued Keys" eyebrow={`${data.clientKeys.length} total`}>
        {data.clientKeys.length === 0 ? (
          <EmptyState icon={<Icon.Key width={34} height={34} />} message="No client keys issued yet." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Prefix</th>
                  <th>Metadata</th>
                  <th>Created</th>
                  <th>Last Used</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.clientKeys.map((key) => (
                  <tr key={key.id}>
                    <td className="cell-strong">{key.name}</td>
                    <td className="cell-mono">{key.keyPrefix}…</td>
                    <td>{metadataSummary(key.metadataJson)}</td>
                    <td className="cell-mono">{key.createdAt ? formatTime(key.createdAt) : '—'}</td>
                    <td className="cell-mono">{key.lastUsedAt ? relativeTime(key.lastUsedAt) : 'never'}</td>
                    <td>
                      <EnabledBadge enabled={key.enabled} />
                    </td>
                    <td>
                      <div className="cell-actions">
                        <IconButton
                          label="Edit"
                          variant="default"
                          icon={<Icon.Edit />}
                          disabled={!canWriteKeys}
                          onClick={() => openEdit(key)}
                        />
                        <Button size="sm" variant={key.enabled ? 'ghost' : 'primary'} disabled={!canWriteKeys} onClick={() => toggleEnable(key, !key.enabled)}>
                          {key.enabled ? 'Disable' : 'Enable'}
                        </Button>
                        <IconButton
                          label="Delete"
                          variant="danger"
                          icon={<Icon.Trash />}
                          disabled={!canWriteKeys}
                          onClick={() => setTarget(key)}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Drawer
        open={isDrawerOpen}
        onClose={closeDrawer}
        eyebrow={drawerTitle}
        title="API key details"
        footer={
          created && isCreate ? (
            <Button variant="primary" onClick={closeDrawer} icon={<Icon.Check className="btn-ico" />}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={closeDrawer}>
                Cancel
              </Button>
              <Button variant="primary" onClick={save} loading={saving} disabled={!canWriteKeys || name.trim().length < 2} icon={<Icon.Key className="btn-ico" />}>
                {isCreate ? 'Generate key' : 'Save changes'}
              </Button>
            </>
          )
        }
      >
        {created && isCreate ? (
          <>
            <div className="error-banner" style={{ borderColor: 'var(--teal)', color: 'var(--teal)' }}>
              <Icon.Info />
              {createdKeyMessage}
            </div>
            <p>{'The key is shown once and will not be displayed again. Copy it now.'}</p>
            <Field label={`Key for "${created.name}"`}>
              <CopyField value={created.apiKey} label="Copy API key" />
            </Field>
          </>
        ) : (
          <>
            <p>{`When ${isCreate ? 'issuing' : 'editing'}, provide a JSON metadata object. This field is optional.`}</p>
            <Field label="Name" hint="Identify the consumer of this key">
              <TextInput
                value={name}
                onChange={setName}
                placeholder={isCreate ? 'my-api production' : 'existing key name'}
              />
            </Field>
            <Field label="Enabled">
              <Toggle checked={enabled} onChange={setEnabled} label="Enable this key immediately" />
            </Field>
            <div className="inline-actions"><Button onClick={() => { try { setMetadataText(JSON.stringify({ ...parseMetadataInput(metadataText), tracePrivacy: 'metadata-only' }, null, 2)); } catch { toast.error('Invalid metadata'); } }}>Use metadata-only traces</Button></div>
        {usageError && <p role="alert">{usageError}</p>}
        {usage !== null && <Panel title="Usage and budgets" eyebrow="Null cost means price or usage is unknown"><JsonBlock value={usage} /></Panel>}
        <Field label="Metadata" hint='Optional JSON object e.g. {"service":"my-api","env":"prod"}'>
              <TextArea value={metadataText} onChange={setMetadataText} rows={7} placeholder="{}" />
            </Field>
            <Badge tone={isCreate ? 'sky' : 'muted'}>{created ? createdKeyMessage : ''}</Badge>
          </>
        )}
      </Drawer>

      <ConfirmDialog
        open={Boolean(target) && isDrawerOpen === false}
        title={target ? `Delete key "${target?.name ?? ''}"?` : 'Delete key'}
        confirmLabel="Delete"
        message={`"${target?.name ?? ''}" will be removed permanently.`}
        onConfirm={remove}
        onCancel={() => setTarget(null)}
        loading={deleting}
      />
    </>
  );
}
