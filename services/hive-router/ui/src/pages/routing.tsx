import { useState } from 'react';
import { adminApi, ApiError } from '../lib/api';
import { useStore } from '../lib/store';
import { useToast } from '../components/toast';
import { can } from '../lib/permissions';
import type { AdminUser, HeuristicRule, ModelAlias, RouteRule } from '../lib/types';
import { ROUTE_RULE_KINDS } from '../lib/constants';
import { formatJson, parseJsonObject } from '../lib/format';
import {
  Badge,
  Button,
  ConfirmDialog,
  Drawer,
  EmptyState,
  EnabledBadge,
  Field,
  IconButton,
  Panel,
  Select,
  TextArea,
  TextInput,
  Toggle,
} from '../components/ui';
import { Icon } from '../components/icons';

type Tab = 'aliases' | 'rules' | 'heuristics';

function errMessage(caught: unknown, fallback: string): string {
  if (caught instanceof ApiError) return caught.message;
  if (caught instanceof Error) return caught.message;
  return fallback;
}

export function RoutingPage({ currentUser }: { currentUser: AdminUser | null }) {
  const { data } = useStore();
  const [tab, setTab] = useState<Tab>('aliases');
  const canWriteRouting = can(currentUser, 'router:routing:write');

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Routing</h2>
          <p>Aliases, deterministic rules, and scoring heuristics that shape every request.</p>
        </div>
      </div>

      <div className="tabs">
        <button className={tab === 'aliases' ? 'tab tab--active' : 'tab'} onClick={() => setTab('aliases')}>
          Model Aliases <span className="tab-count">{data.aliases.length}</span>
        </button>
        <button className={tab === 'rules' ? 'tab tab--active' : 'tab'} onClick={() => setTab('rules')}>
          Route Rules <span className="tab-count">{data.routeRules.length}</span>
        </button>
        <button className={tab === 'heuristics' ? 'tab tab--active' : 'tab'} onClick={() => setTab('heuristics')}>
          Heuristics <span className="tab-count">{data.heuristics.length}</span>
        </button>
      </div>

      {tab === 'aliases' ? <AliasSection canWrite={canWriteRouting} /> : null}
      {tab === 'rules' ? <RuleSection canWrite={canWriteRouting} /> : null}
      {tab === 'heuristics' ? <HeuristicSection canWrite={canWriteRouting} /> : null}
    </>
  );
}

/* ===================== Model Aliases ===================== */

interface AliasForm {
  alias: string;
  providerId: string;
  upstreamModel: string;
  description: string;
  enabled: boolean;
}

function AliasSection({ canWrite }: { canWrite: boolean }) {
  const { data, refresh } = useStore();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ModelAlias | null>(null);
  const [form, setForm] = useState<AliasForm>({ alias: '', providerId: '', upstreamModel: '', description: '', enabled: true });
  const [saving, setSaving] = useState(false);
  const [target, setTarget] = useState<ModelAlias | null>(null);
  const [deleting, setDeleting] = useState(false);

  const patch = (c: Partial<AliasForm>) => setForm((f) => ({ ...f, ...c }));
  const defaultProviderId = () => data.providers[0]?.id ?? '';
  const selectedProvider = data.providers.find((provider) => provider.id === form.providerId);
  const selectedProviderIsLlamaCpp = selectedProvider?.kind === 'LLAMACPP';

  function openCreate() {
    setEditing(null);
    setForm({ alias: '', providerId: defaultProviderId(), upstreamModel: '', description: '', enabled: true });
    setOpen(true);
  }
  function openEdit(alias: ModelAlias) {
    setEditing(alias);
    setForm({
      alias: alias.alias,
      providerId: alias.providerId ?? '',
      upstreamModel: alias.upstreamModel,
      description: alias.description ?? '',
      enabled: alias.enabled,
    });
    setOpen(true);
  }

  async function save() {
    setSaving(true);
    try {
      const body = {
        alias: form.alias.trim(),
        upstreamModel: selectedProviderIsLlamaCpp ? '' : form.upstreamModel.trim(),
        enabled: form.enabled,
        ...(form.providerId ? { providerId: form.providerId } : {}),
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
      };
      if (editing) {
        await adminApi.updateAlias(editing.id, body);
        toast.success('Alias updated', form.alias);
      } else {
        await adminApi.createAlias(body);
        toast.success('Alias created', form.alias);
      }
      setOpen(false);
      await refresh();
    } catch (caught) {
      toast.error('Save failed', errMessage(caught, 'Could not save alias'));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!target) return;
    setDeleting(true);
    try {
      await adminApi.deleteAlias(target.id);
      toast.success('Alias removed', target.alias);
      setTarget(null);
      await refresh();
    } catch (caught) {
      toast.error('Delete failed', errMessage(caught, 'Could not delete alias'));
    } finally {
      setDeleting(false);
    }
  }

  const providerOptions = [
    ...data.providers.map((p) => ({ value: p.id, label: `${p.name} (${p.kind})` })),
    { value: '', label: 'Dynamic provider selection' },
  ];

  function updateProvider(providerId: string) {
    const provider = data.providers.find((entry) => entry.id === providerId);
    patch({
      providerId,
      ...(provider?.kind === 'LLAMACPP' ? { upstreamModel: '' } : {}),
    });
  }

  function modelSummary(alias: ModelAlias): string {
    if (alias.provider?.kind === 'LLAMACPP' && !alias.upstreamModel) {
      return 'provider native default (model omitted)';
    }
    return alias.upstreamModel || 'model omitted';
  }

  return (
    <Panel
      title="Model Aliases"
      eyebrow="Friendly name → upstream model"
      actions={
        <Button variant="primary" size="sm" icon={<Icon.Plus className="btn-ico" />} disabled={!canWrite} onClick={openCreate}>
          Add Alias
        </Button>
      }
    >
      {data.aliases.length === 0 ? (
        <EmptyState icon={<Icon.Alias width={34} height={34} />} message="No aliases defined." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Alias</th>
                <th>Upstream Model</th>
                <th>Provider</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.aliases.map((alias) => (
                <tr key={alias.id} className="row-clickable" onClick={() => openEdit(alias)}>
                  <td className="cell-strong">{alias.alias}</td>
                  <td className="cell-mono">{modelSummary(alias)}</td>
                  <td>{alias.provider ? <Badge tone={alias.provider.kind === 'LLAMACPP' ? 'teal' : 'sky'}>{alias.provider.name}</Badge> : <Badge tone="muted">dynamic</Badge>}</td>
                  <td>
                    <EnabledBadge enabled={alias.enabled} />
                  </td>
                  <td>
                    <div className="cell-actions" onClick={(e) => e.stopPropagation()}>
                      <IconButton label="Edit" icon={<Icon.Edit />} disabled={!canWrite} onClick={() => openEdit(alias)} />
                      <IconButton label="Delete" variant="danger" icon={<Icon.Trash />} disabled={!canWrite} onClick={() => setTarget(alias)} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        eyebrow={editing ? 'Edit alias' : 'New alias'}
        title={editing ? editing.alias : 'Create Alias'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} loading={saving} disabled={!canWrite} icon={<Icon.Check className="btn-ico" />}>
              {editing ? 'Save changes' : 'Create alias'}
            </Button>
          </>
        }
      >
        <Field label="Alias" hint="The model name clients request">
          <TextInput value={form.alias} onChange={(v) => patch({ alias: v })} placeholder="gpt-4o" />
        </Field>
        <Field
          label="Upstream Model"
          hint={selectedProviderIsLlamaCpp ? 'llama.cpp uses the model already loaded by the server; hive-router will omit the model field.' : 'The real model sent to the selected provider. Verified on save when the provider exposes a model list.'}
        >
          <TextInput
            value={selectedProviderIsLlamaCpp ? '' : form.upstreamModel}
            onChange={(v) => patch({ upstreamModel: v })}
            placeholder={selectedProviderIsLlamaCpp ? 'Not required for llama.cpp' : 'gpt-4o-2024-08-06'}
            disabled={selectedProviderIsLlamaCpp}
          />
        </Field>
        <Field label="Provider" hint="New aliases default to a concrete provider; choose Dynamic only when the router should decide at runtime.">
          <Select value={form.providerId} onChange={updateProvider} options={providerOptions} />
        </Field>
        {selectedProviderIsLlamaCpp ? (
          <div className="info-banner">
            <Icon.Info />
            llama.cpp model selection is provider-native. This alias will save with an omitted upstream model and route to the selected llama.cpp provider.
          </div>
        ) : null}
        <Field label="Description" hint="Optional">
          <TextInput value={form.description} onChange={(v) => patch({ description: v })} />
        </Field>
        <div className="inline-actions">
          <Toggle checked={form.enabled} onChange={(v) => patch({ enabled: v })} label="Enabled" />
        </div>
      </Drawer>

      <ConfirmDialog
        open={Boolean(target)}
        title="Delete alias?"
        message={`Clients requesting "${target?.alias ?? ''}" will no longer resolve through this alias.`}
        onConfirm={remove}
        onCancel={() => setTarget(null)}
        loading={deleting}
      />
    </Panel>
  );
}

/* ===================== Route Rules ===================== */

interface RuleForm {
  name: string;
  kind: string;
  priority: string;
  matchJson: string;
  actionJson: string;
  enabled: boolean;
}

function RuleSection({ canWrite }: { canWrite: boolean }) {
  const { data, refresh } = useStore();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<RouteRule | null>(null);
  const [form, setForm] = useState<RuleForm>({
    name: '',
    kind: 'MODEL_ALIAS',
    priority: '100',
    matchJson: '{}',
    actionJson: '{}',
    enabled: true,
  });
  const [saving, setSaving] = useState(false);
  const [target, setTarget] = useState<RouteRule | null>(null);
  const [deleting, setDeleting] = useState(false);

  const patch = (c: Partial<RuleForm>) => setForm((f) => ({ ...f, ...c }));

  function openCreate() {
    setEditing(null);
    setForm({ name: '', kind: 'MODEL_ALIAS', priority: '100', matchJson: '{}', actionJson: '{}', enabled: true });
    setOpen(true);
  }
  function openEdit(rule: RouteRule) {
    setEditing(rule);
    setForm({
      name: rule.name,
      kind: rule.kind,
      priority: String(rule.priority),
      matchJson: formatJson(rule.matchJson),
      actionJson: formatJson(rule.actionJson),
      enabled: rule.enabled,
    });
    setOpen(true);
  }

  async function save() {
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(),
        kind: form.kind,
        priority: Number(form.priority),
        enabled: form.enabled,
        matchJson: parseJsonObject(form.matchJson),
        actionJson: parseJsonObject(form.actionJson),
      };
      if (editing) {
        await adminApi.updateRouteRule(editing.id, body);
        toast.success('Rule updated', form.name);
      } else {
        await adminApi.createRouteRule(body);
        toast.success('Rule created', form.name);
      }
      setOpen(false);
      await refresh();
    } catch (caught) {
      toast.error('Save failed', errMessage(caught, 'Could not save rule'));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!target) return;
    setDeleting(true);
    try {
      await adminApi.deleteRouteRule(target.id);
      toast.success('Rule removed', target.name);
      setTarget(null);
      await refresh();
    } catch (caught) {
      toast.error('Delete failed', errMessage(caught, 'Could not delete rule'));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Panel
      title="Route Rules"
      eyebrow="Deterministic match → action"
      actions={
        <Button variant="primary" size="sm" icon={<Icon.Plus className="btn-ico" />} disabled={!canWrite} onClick={openCreate}>
          Add Rule
        </Button>
      }
    >
      {data.routeRules.length === 0 ? (
        <EmptyState icon={<Icon.Route width={34} height={34} />} message="No route rules defined." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Priority</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.routeRules.map((rule) => (
                <tr key={rule.id} className="row-clickable" onClick={() => openEdit(rule)}>
                  <td className="cell-strong">{rule.name}</td>
                  <td>
                    <Badge tone="violet">{rule.kind}</Badge>
                  </td>
                  <td className="cell-mono">{rule.priority}</td>
                  <td>
                    <EnabledBadge enabled={rule.enabled} />
                  </td>
                  <td>
                    <div className="cell-actions" onClick={(e) => e.stopPropagation()}>
                      <IconButton label="Edit" icon={<Icon.Edit />} disabled={!canWrite} onClick={() => openEdit(rule)} />
                      <IconButton label="Delete" variant="danger" icon={<Icon.Trash />} disabled={!canWrite} onClick={() => setTarget(rule)} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        eyebrow={editing ? 'Edit rule' : 'New rule'}
        title={editing ? editing.name : 'Create Route Rule'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} loading={saving} disabled={!canWrite} icon={<Icon.Check className="btn-ico" />}>
              {editing ? 'Save changes' : 'Create rule'}
            </Button>
          </>
        }
      >
        <div className="field-grid">
          <Field label="Name">
            <TextInput value={form.name} onChange={(v) => patch({ name: v })} placeholder="Prefer local for code" />
          </Field>
          <Field label="Priority" hint="Lower runs first">
            <TextInput value={form.priority} onChange={(v) => patch({ priority: v })} inputMode="numeric" />
          </Field>
        </div>
        <Field label="Kind">
          <Select value={form.kind} onChange={(v) => patch({ kind: v })} options={ROUTE_RULE_KINDS.map((k) => ({ value: k, label: k }))} />
        </Field>
        <Field label="Match (JSON object)" hint="Conditions that activate this rule">
          <TextArea value={form.matchJson} onChange={(v) => patch({ matchJson: v })} spellCheck={false} rows={6} />
        </Field>
        <Field label="Action (JSON object)" hint="What the router does on match">
          <TextArea value={form.actionJson} onChange={(v) => patch({ actionJson: v })} spellCheck={false} rows={6} />
        </Field>
        <div className="inline-actions">
          <Toggle checked={form.enabled} onChange={(v) => patch({ enabled: v })} label="Enabled" />
        </div>
      </Drawer>

      <ConfirmDialog
        open={Boolean(target)}
        title="Delete route rule?"
        message={`"${target?.name ?? ''}" will no longer influence routing decisions.`}
        onConfirm={remove}
        onCancel={() => setTarget(null)}
        loading={deleting}
      />
    </Panel>
  );
}

/* ===================== Heuristics ===================== */

interface HeuristicForm {
  name: string;
  category: string;
  pattern: string;
  score: string;
  actionJson: string;
  enabled: boolean;
}

function HeuristicSection({ canWrite }: { canWrite: boolean }) {
  const { data, refresh } = useStore();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<HeuristicRule | null>(null);
  const [form, setForm] = useState<HeuristicForm>({
    name: '',
    category: '',
    pattern: '',
    score: '10',
    actionJson: '{"action":"rerank"}',
    enabled: true,
  });
  const [saving, setSaving] = useState(false);
  const [target, setTarget] = useState<HeuristicRule | null>(null);
  const [deleting, setDeleting] = useState(false);

  const patch = (c: Partial<HeuristicForm>) => setForm((f) => ({ ...f, ...c }));

  function openCreate() {
    setEditing(null);
    setForm({ name: '', category: '', pattern: '', score: '10', actionJson: '{"action":"rerank"}', enabled: true });
    setOpen(true);
  }
  function openEdit(rule: HeuristicRule) {
    setEditing(rule);
    setForm({
      name: rule.name,
      category: rule.category,
      pattern: rule.pattern,
      score: String(rule.score),
      actionJson: formatJson(rule.actionJson),
      enabled: rule.enabled,
    });
    setOpen(true);
  }

  async function save() {
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(),
        category: form.category.trim(),
        pattern: form.pattern,
        score: Number(form.score),
        enabled: form.enabled,
        actionJson: parseJsonObject(form.actionJson),
      };
      if (editing) {
        await adminApi.updateHeuristic(editing.id, body);
        toast.success('Heuristic updated', form.name);
      } else {
        await adminApi.createHeuristic(body);
        toast.success('Heuristic created', form.name);
      }
      setOpen(false);
      await refresh();
    } catch (caught) {
      toast.error('Save failed', errMessage(caught, 'Could not save heuristic'));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!target) return;
    setDeleting(true);
    try {
      await adminApi.deleteHeuristic(target.id);
      toast.success('Heuristic removed', target.name);
      setTarget(null);
      await refresh();
    } catch (caught) {
      toast.error('Delete failed', errMessage(caught, 'Could not delete heuristic'));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Panel
      title="Heuristics"
      eyebrow="Pattern → score adjustment"
      actions={
        <Button variant="primary" size="sm" icon={<Icon.Plus className="btn-ico" />} disabled={!canWrite} onClick={openCreate}>
          Add Heuristic
        </Button>
      }
    >
      {data.heuristics.length === 0 ? (
        <EmptyState icon={<Icon.Signal width={34} height={34} />} message="No heuristics defined." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Category</th>
                <th>Pattern</th>
                <th>Score</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.heuristics.map((rule) => (
                <tr key={rule.id} className="row-clickable" onClick={() => openEdit(rule)}>
                  <td className="cell-strong">{rule.name}</td>
                  <td>
                    <Badge tone="amber">{rule.category}</Badge>
                  </td>
                  <td className="cell-mono">{rule.pattern}</td>
                  <td className="cell-mono">{rule.score}</td>
                  <td>
                    <EnabledBadge enabled={rule.enabled} />
                  </td>
                  <td>
                    <div className="cell-actions" onClick={(e) => e.stopPropagation()}>
                      <IconButton label="Edit" icon={<Icon.Edit />} disabled={!canWrite} onClick={() => openEdit(rule)} />
                      <IconButton label="Delete" variant="danger" icon={<Icon.Trash />} disabled={!canWrite} onClick={() => setTarget(rule)} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        eyebrow={editing ? 'Edit heuristic' : 'New heuristic'}
        title={editing ? editing.name : 'Create Heuristic'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} loading={saving} disabled={!canWrite} icon={<Icon.Check className="btn-ico" />}>
              {editing ? 'Save changes' : 'Create heuristic'}
            </Button>
          </>
        }
      >
        <div className="field-grid">
          <Field label="Name">
            <TextInput value={form.name} onChange={(v) => patch({ name: v })} placeholder="Long context boost" />
          </Field>
          <Field label="Category">
            <TextInput value={form.category} onChange={(v) => patch({ category: v })} placeholder="context" />
          </Field>
        </div>
        <Field label="Pattern" hint="Regex or keyword matched against the request">
          <TextInput value={form.pattern} onChange={(v) => patch({ pattern: v })} placeholder="(?i)summarize" />
        </Field>
        <Field label="Score" hint="Weight applied when the pattern matches">
          <TextInput value={form.score} onChange={(v) => patch({ score: v })} inputMode="numeric" />
        </Field>
        <Field label="Action (JSON object)">
          <TextArea value={form.actionJson} onChange={(v) => patch({ actionJson: v })} spellCheck={false} rows={5} />
        </Field>
        <div className="inline-actions">
          <Toggle checked={form.enabled} onChange={(v) => patch({ enabled: v })} label="Enabled" />
        </div>
      </Drawer>

      <ConfirmDialog
        open={Boolean(target)}
        title="Delete heuristic?"
        message={`"${target?.name ?? ''}" will no longer adjust routing scores.`}
        onConfirm={remove}
        onCancel={() => setTarget(null)}
        loading={deleting}
      />
    </Panel>
  );
}
