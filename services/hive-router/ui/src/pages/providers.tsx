import { useEffect, useState } from 'react';
import { adminApi, ApiError } from '../lib/api';
import { useStore } from '../lib/store';
import { useToast } from '../components/toast';
import { can } from '../lib/permissions';
import type { AdminUser, CodexOAuthCheck, CodexOAuthStart, CodexOAuthStatus, Provider, ProviderModelWriteRequest, ProviderWriteRequest } from '../lib/types';
import { AUTH_MODES, PROVIDER_KINDS } from '../lib/constants';
import { formatJson, parseJsonObject, relativeTime } from '../lib/format';
import {
  Badge,
  Button,
  ConfirmDialog,
  CopyField,
  Drawer,
  EmptyState,
  EnabledBadge,
  Field,
  HealthBadge,
  IconButton,
  Panel,
  Select,
  TextArea,
  TextInput,
  Toggle,
} from '../components/ui';
import { Icon } from '../components/icons';

function parseStringRecord(value: string): Record<string, string> {
  const parsed = parseJsonObject(value);
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry !== 'string') {
      throw new Error('Header ' + key + ' must be a string');
    }
  }
  return parsed as Record<string, string>;
}

function parseProviderModels(value: string): ProviderModelWriteRequest[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
    throw new Error('Models must be a JSON array of objects');
  }
  return parsed as ProviderModelWriteRequest[];
}
interface ProviderForm {
  slug: string;
  name: string;
  kind: string;
  baseUrl: string;
  authMode: string;
  authHeaderName: string;
  authSecret: string;
  defaultHeaders: string;
  capabilities: string;
  models: string;
  timeoutMs: string;
  maxRetries: string;
  concurrency: string;
  priority: string;
  weight: string;
  failoverGroup: string;
  enabled: boolean;
}

function emptyForm(): ProviderForm {
  return {
    slug: '',
    name: '',
    kind: 'OPENAI_GENERIC',
    baseUrl: 'https://api.openai.com/v1',
    authMode: 'BEARER',
    authHeaderName: 'Authorization',
    authSecret: '',
    defaultHeaders: '{}',
    capabilities: '{}',
    models: '[]',
    timeoutMs: '120000',
    maxRetries: '1',
    concurrency: '16',
    priority: '100',
    weight: '100',
    failoverGroup: '',
    enabled: true,
  };
}

function formFromProvider(provider: Provider): ProviderForm {
  return {
    slug: provider.slug,
    name: provider.name,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    authMode: provider.authMode,
    authHeaderName: provider.authHeaderName,
    authSecret: '',
    defaultHeaders: formatJson(provider.defaultHeaders ?? {}),
    capabilities: formatJson(provider.capabilities ?? {}),
    models: formatJson(provider.models ?? []),
    timeoutMs: String(provider.timeoutMs),
    maxRetries: String(provider.maxRetries),
    concurrency: String(provider.concurrency),
    priority: String(provider.priority),
    weight: String(provider.weight),
    failoverGroup: provider.failoverGroup ?? '',
    enabled: provider.enabled,
  };
}

export function ProvidersPage({ currentUser }: { currentUser: AdminUser | null }) {
  const { data, refresh } = useStore();
  const toast = useToast();
  const canWriteProviders = can(currentUser, 'router:providers:write');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [form, setForm] = useState<ProviderForm>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Provider | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [codexOpen, setCodexOpen] = useState(false);
  const [codexBusy, setCodexBusy] = useState(false);
  const [codexStatus, setCodexStatus] = useState<CodexOAuthStatus | null>(null);
  const [codexFlow, setCodexFlow] = useState<CodexOAuthStart | null>(null);
  const [codexCheck, setCodexCheck] = useState<CodexOAuthCheck | null>(null);

  const patch = (changes: Partial<ProviderForm>) => setForm((current) => ({ ...current, ...changes }));

  function openCreate() {
    setEditing(null);
    setForm(emptyForm());
    setDrawerOpen(true);
  }

  function openEdit(provider: Provider) {
    setEditing(provider);
    setForm(formFromProvider(provider));
    setDrawerOpen(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const body: ProviderWriteRequest = {
        slug: form.slug.trim(),
        name: form.name.trim(),
        kind: form.kind,
        baseUrl: form.baseUrl.trim(),
        authMode: form.authMode,
        authHeaderName: form.authHeaderName.trim() || 'Authorization',
        ...(form.authSecret ? { authSecret: form.authSecret } : {}),
        defaultHeaders: parseStringRecord(form.defaultHeaders),
        capabilities: parseJsonObject(form.capabilities),
        models: parseProviderModels(form.models),
        timeoutMs: Number(form.timeoutMs),
        maxRetries: Number(form.maxRetries),
        concurrency: Number(form.concurrency),
        priority: Number(form.priority),
        weight: Number(form.weight),
        ...(form.failoverGroup.trim() ? { failoverGroup: form.failoverGroup.trim() } : {}),
        enabled: form.enabled,
      };
      if (editing) {
        await adminApi.updateProvider(editing.id, body);
        toast.success('Provider updated', form.name);
      } else {
        await adminApi.createProvider(body);
        toast.success('Provider created', form.name);
      }
      setDrawerOpen(false);
      await refresh();
    } catch (caught) {
      const message =
        caught instanceof ApiError ? caught.message : caught instanceof Error ? caught.message : 'Could not save provider';
      toast.error('Save failed', message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await adminApi.deleteProvider(deleteTarget.id);
      toast.success('Provider removed', deleteTarget.name);
      setDeleteTarget(null);
      await refresh();
    } catch (caught) {
      toast.error('Delete failed', caught instanceof Error ? caught.message : 'Could not delete provider');
    } finally {
      setDeleting(false);
    }
  }

  async function loadCodexStatus() {
    setCodexBusy(true);
    try {
      const status = await adminApi.codexOAuthStatus();
      setCodexStatus(status.data);
    } catch (caught) {
      toast.error('Codex status failed', caught instanceof Error ? caught.message : 'Could not load Codex authorization status');
    } finally {
      setCodexBusy(false);
    }
  }

  function applyCodexCheck(check: CodexOAuthCheck) {
    setCodexCheck(check);
    if (check.status === 'authorized') {
      setCodexFlow(null);
      setCodexStatus({
        authorized: true,
        provider: check.provider ?? null,
        accountIdMasked: check.accountIdMasked ?? null,
        planType: check.planType ?? null,
        lastRefreshAt: check.lastRefreshAt ?? null,
        refreshTokenQuarantined: false,
      });
    }
  }

  async function startCodexAuthorization() {
    setCodexBusy(true);
    setCodexCheck(null);
    try {
      const started = await adminApi.startCodexOAuth();
      setCodexFlow(started.data);
      setCodexCheck({ status: 'pending' });
      toast.info('Codex authorization started', 'Open the authorization link and enter the displayed code.');
    } catch (caught) {
      toast.error('Codex authorization failed', caught instanceof Error ? caught.message : 'Could not start Codex OAuth');
    } finally {
      setCodexBusy(false);
    }
  }

  async function checkCodexAuthorization(manual = true) {
    if (!codexFlow) return;
    if (manual) setCodexBusy(true);
    try {
      const checked = await adminApi.checkCodexOAuth(codexFlow.loginId);
      applyCodexCheck(checked.data);
      if (checked.data.status === 'authorized') {
        toast.success('Codex authorized', 'OpenAI Codex is now registered as a provider.');
        await refresh();
      } else if (manual && checked.data.status === 'pending') {
        toast.info('Still waiting', 'Complete the device authorization in the OpenAI window.');
      }
    } catch (caught) {
      toast.error('Codex check failed', caught instanceof Error ? caught.message : 'Could not check Codex authorization');
    } finally {
      if (manual) setCodexBusy(false);
    }
  }

  useEffect(() => {
    if (!codexOpen) return;
    void loadCodexStatus();
  }, [codexOpen]);

  useEffect(() => {
    if (!codexOpen || !codexFlow || codexCheck?.status === 'authorized') {
      return;
    }

    const timer = window.setInterval(() => {
      void adminApi.checkCodexOAuth(codexFlow.loginId).then(async (checked) => {
        applyCodexCheck(checked.data);
        if (checked.data.status === 'authorized') {
          toast.success('Codex authorized', 'OpenAI Codex is now registered as a provider.');
          await refresh();
        }
      }).catch(() => {
        // Keep the modal usable; the manual Check authorization button will show the full error.
      });
    }, Math.max(3, codexFlow.intervalSeconds) * 1000);

    return () => window.clearInterval(timer);
  }, [codexOpen, codexFlow?.loginId, codexFlow?.intervalSeconds, codexCheck?.status, refresh, toast]);

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Providers</h2>
          <p>Upstream registry · failover groups · health posture.</p>
        </div>
        <div className="inline-actions">
          <Button variant="ghost" icon={<Icon.Key className="btn-ico" />} onClick={() => setCodexOpen(true)}>
            Authorize Codex
          </Button>
        <Button variant="primary" icon={<Icon.Plus className="btn-ico" />} disabled={!canWriteProviders} onClick={openCreate}>
            Add Provider
          </Button>
        </div>
      </div>

      <Panel title="Registered Providers" eyebrow={`${data.providers.length} total`}>
        {data.providers.length === 0 ? (
          <EmptyState icon={<Icon.Server width={34} height={34} />} message="No providers yet — register your first upstream." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kind</th>
                  <th>Base URL</th>
                  <th>Priority</th>
                  <th>Health</th>
                  <th>Status</th>
                  <th>Checked</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.providers.map((provider) => (
                  <tr key={provider.id} className="row-clickable" onClick={() => openEdit(provider)}>
                    <td>
                      <span className="cell-strong">{provider.name}</span>
                      <div className="cell-mono">{provider.slug}</div>
                    </td>
                    <td>
                      <Badge tone="sky">{provider.kind}</Badge>
                    </td>
                    <td className="cell-mono">{provider.baseUrl}</td>
                    <td className="cell-mono">{provider.priority}</td>
                    <td>
                      <HealthBadge status={provider.lastHealthStatus} />
                    </td>
                    <td>
                      <EnabledBadge enabled={provider.enabled} />
                    </td>
                    <td className="cell-mono">{provider.lastHealthAt ? relativeTime(provider.lastHealthAt) : '—'}</td>
                    <td>
                      <div className="cell-actions" onClick={(e) => e.stopPropagation()}>
                        <IconButton label="Edit" icon={<Icon.Edit />} onClick={() => openEdit(provider)} />
                        <IconButton label="Delete" variant="danger" icon={<Icon.Trash />} disabled={!canWriteProviders} onClick={() => setDeleteTarget(provider)} />
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
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        eyebrow={editing ? 'Edit provider' : 'New provider'}
        title={editing ? editing.name : 'Register Upstream'}
        footer={
          <>
            {editing ? (
              <span className="spacer">
                <HealthBadge status={editing.lastHealthStatus} />
              </span>
            ) : null}
            <Button variant="ghost" onClick={() => setDrawerOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleSave} loading={saving} disabled={!canWriteProviders} icon={<Icon.Check className="btn-ico" />}>
              {editing ? 'Save changes' : 'Create provider'}
            </Button>
          </>
        }
      >
        <div className="field-grid">
          <Field label="Slug" hint="Unique identifier">
            <TextInput value={form.slug} onChange={(v) => patch({ slug: v })} placeholder="openai-primary" />
          </Field>
          <Field label="Name">
            <TextInput value={form.name} onChange={(v) => patch({ name: v })} placeholder="OpenAI Primary" />
          </Field>
          <Field label="Kind">
            <Select value={form.kind} onChange={(v) => patch({ kind: v })} options={PROVIDER_KINDS.map((k) => ({ value: k, label: k }))} />
          </Field>
          <Field label="Base URL">
            <TextInput value={form.baseUrl} onChange={(v) => patch({ baseUrl: v })} placeholder="https://api.openai.com/v1" />
          </Field>
          <Field label="Auth Mode">
            <Select value={form.authMode} onChange={(v) => patch({ authMode: v })} options={AUTH_MODES.map((m) => ({ value: m, label: m }))} />
          </Field>
          <Field label="Auth Header">
            <TextInput value={form.authHeaderName} onChange={(v) => patch({ authHeaderName: v })} />
          </Field>
        </div>

        <Field label="Auth Secret" hint={editing ? 'Leave blank to keep the current secret' : 'Stored encrypted at rest'}>
          <TextInput
            type="password"
            value={form.authSecret}
            onChange={(v) => patch({ authSecret: v })}
            placeholder={editing && editing.authSecretMasked ? editing.authSecretMasked : 'sk-...'}
          />
        </Field>

        <div className="field-grid">
          <Field label="Timeout (ms)">
            <TextInput value={form.timeoutMs} onChange={(v) => patch({ timeoutMs: v })} inputMode="numeric" />
          </Field>
          <Field label="Max Retries">
            <TextInput value={form.maxRetries} onChange={(v) => patch({ maxRetries: v })} inputMode="numeric" />
          </Field>
          <Field label="Concurrency">
            <TextInput value={form.concurrency} onChange={(v) => patch({ concurrency: v })} inputMode="numeric" />
          </Field>
          <Field label="Priority" hint="Lower wins">
            <TextInput value={form.priority} onChange={(v) => patch({ priority: v })} inputMode="numeric" />
          </Field>
          <Field label="Weight">
            <TextInput value={form.weight} onChange={(v) => patch({ weight: v })} inputMode="numeric" />
          </Field>
          <Field label="Failover Group" hint="Optional">
            <TextInput value={form.failoverGroup} onChange={(v) => patch({ failoverGroup: v })} placeholder="frontier" />
          </Field>
        </div>

        <Field label="Default Headers (JSON object)">
          <TextArea value={form.defaultHeaders} onChange={(v) => patch({ defaultHeaders: v })} spellCheck={false} />
        </Field>
        <Field label="Capabilities (JSON object)">
          <TextArea value={form.capabilities} onChange={(v) => patch({ capabilities: v })} spellCheck={false} />
        </Field>
        <Field label="Models (JSON array)" hint='e.g. [{"model":"gpt-4o","enabled":true}]'>
          <TextArea value={form.models} onChange={(v) => patch({ models: v })} spellCheck={false} />
        </Field>

        <div className="inline-actions">
          <Toggle checked={form.enabled} onChange={(v) => patch({ enabled: v })} label="Enabled" />
        </div>

        {editing && editing.lastHealthError ? (
          <div className="error-banner">
            <Icon.Alert />
            {editing.lastHealthError}
          </div>
        ) : null}
      </Drawer>

      {codexOpen ? (
        <div className="modal-center" onClick={() => setCodexOpen(false)}>
          <section className="codex-oauth-modal" role="dialog" aria-modal="true" aria-labelledby="codex-oauth-title" onClick={(e) => e.stopPropagation()}>
            <div className="codex-oauth-head">
              <div>
                <p className="panel-eyebrow">Subscription-backed provider</p>
                <h3 id="codex-oauth-title">Authorize OpenAI Codex</h3>
              </div>
              <IconButton label="Close" icon={<Icon.Close />} onClick={() => setCodexOpen(false)} />
            </div>

            <p className="codex-oauth-copy">
              Connect Codex through OpenAI OAuth so hive-router can route eligible requests through the ChatGPT/Codex subscription path without storing an API key.
            </p>

            <div className="codex-oauth-status">
              <div>
                <span className="panel-eyebrow">Current authorization</span>
                <div className="inline-actions">
                  <Badge tone={codexStatus?.authorized ? 'teal' : codexStatus?.refreshTokenQuarantined ? 'coral' : 'amber'} dot>
                    {codexStatus?.authorized ? 'authorized' : codexStatus?.refreshTokenQuarantined ? 'reauthorize' : 'not authorized'}
                  </Badge>
                  {codexStatus?.provider ? <Badge tone="sky">{codexStatus.provider.slug}</Badge> : null}
                  {codexStatus?.planType ? <Badge tone="muted">{codexStatus.planType}</Badge> : null}
                </div>
              </div>
              <Button variant="ghost" size="sm" loading={codexBusy && !codexFlow} onClick={() => void loadCodexStatus()}>
                Refresh status
              </Button>
            </div>

            {codexStatus?.accountIdMasked ? (
              <div className="kv-list">
                <div className="kv-row">
                  <span>Account</span>
                  <span className="cell-mono">{codexStatus.accountIdMasked}</span>
                </div>
                <div className="kv-row">
                  <span>Last refresh</span>
                  <span className="cell-mono">{codexStatus.lastRefreshAt ? relativeTime(codexStatus.lastRefreshAt) : 'never'}</span>
                </div>
              </div>
            ) : null}

            {codexFlow ? (
              <div className="codex-device-card">
                <div className="codex-device-top">
                  <div>
                    <span className="panel-eyebrow">Device authorization</span>
                    <strong>Enter this code at OpenAI</strong>
                  </div>
                  <Badge tone={codexCheck?.status === 'authorized' ? 'teal' : codexCheck?.status === 'error' ? 'coral' : 'amber'}>
                    {codexCheck?.status ?? 'pending'}
                  </Badge>
                </div>
                <CopyField value={codexFlow.userCode} label="Copy Codex code" />
                <a className="btn btn--primary" href={codexFlow.verificationUrl} target="_blank" rel="noreferrer">
                  Open authorization link
                </a>
                <span className="field-hint">Expires {relativeTime(codexFlow.expiresAt)}. This modal checks automatically every {codexFlow.intervalSeconds}s.</span>
                {codexCheck?.message ? <div className="error-banner"><Icon.Alert />{codexCheck.message}</div> : null}
              </div>
            ) : null}

            <div className="confirm-actions">
              <Button variant="ghost" onClick={() => setCodexOpen(false)}>
                Close
              </Button>
              {codexFlow ? (
                <Button variant="primary" onClick={() => void checkCodexAuthorization()} loading={codexBusy} disabled={!canWriteProviders} icon={<Icon.Refresh className="btn-ico" />}>
                  Check authorization
                </Button>
              ) : (
                <Button variant="primary" onClick={() => void startCodexAuthorization()} loading={codexBusy} disabled={!canWriteProviders} icon={<Icon.Key className="btn-ico" />}>
                  Start device authorization
                </Button>
              )}
            </div>
          </section>
        </div>
      ) : null}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete provider?"
        message={`This permanently removes "${deleteTarget?.name ?? ''}" and its model registry. Routing rules referencing it may stop resolving.`}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
        loading={deleting}
      />
    </>
  );
}
