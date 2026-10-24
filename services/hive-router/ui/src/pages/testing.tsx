import { useMemo, useState } from 'react';
import { adminApi, ApiError } from '../lib/api';
import { useStore } from '../lib/store';
import { useToast } from '../components/toast';
import type { RouteRule, RoutingTestResult } from '../lib/types';
import { Badge, Button, Drawer, Field, Panel, TextArea, EmptyState, JsonBlock } from '../components/ui';
import { Icon } from '../components/icons';

interface TestCategory {
  alias: string;
  title: string;
  prompt: string;
  rationale: string;
}

interface RuleAction {
  providerKinds?: string[];
  providerIds?: string[];
  requiredTag?: string;
  deny?: boolean;
  denyReason?: string;
}

interface AuditCheck {
  label: string;
  expected: string;
  actual: string;
  ok: boolean;
}

interface AuditDiffRow {
  path: string;
  expected: string;
  actual: string;
  status: 'match' | 'diff' | 'missing';
}

const TEST_CASES: TestCategory[] = [
  {
    alias: 'standard',
    title: 'Standard reasoning',
    rationale: 'Default trait for general chat, light tool-use, summaries, and routine planning.',
    prompt: 'Draft a concise status update for a software team that explains what was shipped, what is blocked, and the next 3 tactical priorities.',
  },
  {
    alias: 'dangerous',
    title: 'Sensitive / safety-critical',
    rationale: 'Trait for high-stakes prompts that require stronger policy-aware routing.',
    prompt:
      'List security hardening checks for an API gateway before release, including key rotation, secret storage, and request allowlisting.',
  },
  {
    alias: 'internet_data',
    title: 'Internet-facing data',
    rationale: 'Trait for web, search, scrape, provider comparison, and external-data workflows.',
    prompt:
      'What are the top 3 performance and governance differences to verify when comparing cloud LLM providers for production routing?',
  },
  {
    alias: 'hard',
    title: 'Hard reasoning',
    rationale: 'Trait for multi-step reasoning, planning, hard coding, and architecture work.',
    prompt:
      'Design a resilient event processing architecture for multi-region ingestion with idempotency guarantees and exactly-once side effects.',
  },
  {
    alias: 'coding',
    title: 'Coding',
    rationale: 'Dedicated coding profile for implementation, debugging, refactoring, and code-review tasks.',
    prompt:
      'Write a minimal TypeScript hello world program with a greet(name) function and one example call. Return only the code.',
  },
];

function parseRuleAction(rule: RouteRule): RuleAction {
  try {
    return JSON.parse(rule.actionJson) as RuleAction;
  } catch {
    return {};
  }
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseRuleModels(rule: RouteRule): string[] {
  try {
    const parsed = JSON.parse(rule.matchJson) as { models?: string[] };
    return Array.isArray(parsed.models)
      ? parsed.models.filter((value): value is string => typeof value === 'string' && value.length > 0)
      : [];
  } catch {
    return [];
  }
}

function expectedProvidersForAlias(alias: string, rules: RouteRule[]): string[] {
  const rule = routingRuleForAlias(alias, rules);
  if (!rule) {
    return [];
  }
  return parseRuleAction(rule).providerKinds ?? [];
}

function routingRuleForAlias(alias: string, rules: RouteRule[]): RouteRule | undefined {
  return [...rules]
    .filter((entry) => entry.enabled)
    .sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name))
    .find((entry) => parseRuleModels(entry).includes(alias));
}

function requestModel(requestBody: string): string | null {
  try {
    const parsed = JSON.parse(requestBody) as { model?: unknown };
    return typeof parsed.model === 'string' ? parsed.model : null;
  } catch {
    return null;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)].filter(Boolean);
}

function formatAuditValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length > 0 ? value.map((entry) => formatAuditValue(entry)).join(', ') : '[]';
  }
  if (value === null || value === undefined || value === '') {
    return 'none';
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function diffRow(path: string, expected: unknown, actual: unknown, ok: boolean): AuditDiffRow {
  return {
    path,
    expected: formatAuditValue(expected),
    actual: formatAuditValue(actual),
    status: ok ? 'match' : actual === null || actual === undefined || actual === '' ? 'missing' : 'diff',
  };
}

function diffTone(status: AuditDiffRow['status']): 'teal' | 'coral' | 'amber' {
  return status === 'match' ? 'teal' : status === 'missing' ? 'amber' : 'coral';
}

function buildAuditJson(
  alias: string,
  rule: RouteRule | undefined,
  result: RoutingTestResult,
  expectedProviders: string[],
): { expected: unknown; actual: unknown; checks: AuditCheck[]; diffRows: AuditDiffRow[] } {
  const upstreamRequestModel = requestModel(result.requestBody);
  const action = rule ? parseRuleAction(rule) : {};
  const selectedProviderKind = result.selectedProvider?.kind ?? result.decision.selectedProviderKind ?? null;
  const selectedProviderId = result.selectedProvider?.id ?? result.decision.selectedProviderId ?? null;
  const candidateProviderKinds = unique(result.candidates.map((candidate) => candidate.kind));
  const candidateProviderIds = result.candidates.map((candidate) => candidate.id);
  const expectedProviderIds = action.providerIds ?? [];
  const ruleMatched = rule ? result.decision.triggeredRuleNames.includes(rule.name) : false;
  const providerKindMatched = expectedProviders.length === 0 || Boolean(selectedProviderKind && expectedProviders.includes(selectedProviderKind));
  const providerIdMatched = expectedProviderIds.length === 0 || Boolean(selectedProviderId && expectedProviderIds.includes(selectedProviderId));
  const providerMatched = Boolean(selectedProviderKind || selectedProviderId) && providerKindMatched && providerIdMatched;
  const candidatesMatched = expectedProviders.length === 0
    ? candidateProviderIds.length > 0
    : candidateProviderKinds.length > 0 && candidateProviderKinds.every((kind) => expectedProviders.includes(kind));
  const expectedTargetModel = result.targetModel ?? alias;
  const modelMatched = upstreamRequestModel === expectedTargetModel;
  const expectedExecution = action.deny ? action.denyReason ?? 'denied by route rule' : '2xx provider response';
  const executionMatched = action.deny ? Boolean(result.decision.denialReason) : result.success;

  const diffRows = [
    diffRow('match.models[0]', alias, result.modelAlias, result.modelAlias === alias),
    diffRow('routeRule.name -> decision.triggeredRuleNames', rule?.name ?? 'model-alias route rule', result.decision.triggeredRuleNames, ruleMatched),
    diffRow(
      'routeRule.action.providerKinds -> actual.selectedProvider.kind',
      expectedProviders.length > 0 ? expectedProviders : 'any enabled provider kind',
      selectedProviderKind,
      providerKindMatched && Boolean(selectedProviderKind),
    ),
    diffRow(
      'routeRule.action.providerIds -> actual.selectedProvider.id',
      expectedProviderIds.length > 0 ? expectedProviderIds : 'no provider-id constraint',
      selectedProviderId,
      expectedProviderIds.length > 0 ? providerIdMatched : true,
    ),
    diffRow(
      'candidateProviderKinds',
      expectedProviders.length > 0 ? `subset of ${expectedProviders.join(', ')}` : 'any enabled provider kind',
      candidateProviderKinds,
      candidatesMatched,
    ),
    diffRow('requestBody.model', expectedTargetModel, upstreamRequestModel, modelMatched),
    diffRow('execution.status', expectedExecution, result.success ? `${result.statusCode}` : result.providerError ?? `${result.statusCode}`, executionMatched),
  ];

  return {
    expected: {
      modelAlias: alias,
      routeRule: rule
        ? {
            name: rule.name,
            kind: rule.kind,
            priority: rule.priority,
            enabled: rule.enabled,
            match: parseJsonValue(rule.matchJson),
            action: parseJsonValue(rule.actionJson),
          }
        : null,
      expectedProviderKinds: expectedProviders,
      expectedProviderIds,
      assertions: {
        ruleMustTrigger: rule?.name ?? null,
        selectedProviderKindMustBeOneOf: expectedProviders,
        selectedProviderIdMustBeOneOf: expectedProviderIds,
        upstreamRequestModelMustEqual: expectedTargetModel,
        executionMust: expectedExecution,
      },
    },
    actual: {
      request: {
        modelAlias: result.modelAlias,
        targetModel: result.targetModel,
        upstreamRequestModel,
        requestId: result.requestId,
      },
      decision: {
        triggeredRuleNames: result.decision.triggeredRuleNames,
        selectedProviderKind: result.decision.selectedProviderKind,
        selectedProviderId: result.decision.selectedProviderId,
        candidateProviderKinds,
        candidateProviderIds,
        fallbackProviderIds: result.decision.fallbackProviderIds,
        confidence: result.decision.confidence,
        denialReason: result.decision.denialReason,
      },
      execution: {
        success: result.success,
        statusCode: result.statusCode,
        latencyMs: result.latencyMs,
        selectedProvider: result.selectedProvider,
        attempts: result.attempts,
      },
    },
    checks: [
      {
        label: 'Rule',
        expected: rule?.name ?? 'model rule',
        actual: result.decision.triggeredRuleNames.join(', ') || 'none',
        ok: ruleMatched,
      },
      {
        label: 'Provider',
        expected: expectedProviders.join(', ') || expectedProviderIds.join(', ') || 'any enabled provider',
        actual: expectedProviderIds.length > 0 ? selectedProviderId ?? 'none' : selectedProviderKind ?? 'none',
        ok: providerMatched,
      },
      {
        label: 'Upstream model',
        expected: expectedTargetModel,
        actual: upstreamRequestModel ?? 'unavailable',
        ok: modelMatched,
      },
      {
        label: 'Execution',
        expected: expectedExecution,
        actual: result.success ? `${result.statusCode}` : result.providerError ?? `${result.statusCode}`,
        ok: executionMatched,
      },
    ],
    diffRows,
  };
}

function RouteAuditDiff({
  alias,
  rule,
  result,
  expectedProviders,
}: {
  alias: string;
  rule: RouteRule | undefined;
  result: RoutingTestResult;
  expectedProviders: string[];
}) {
  const audit = buildAuditJson(alias, rule, result, expectedProviders);

  return (
    <div className="route-audit">
      <div className="route-audit-head">
        <div>
          <span className="panel-eyebrow">Expected rule JSON -&gt; actual route</span>
          <strong>{rule?.name ?? 'No model rule matched'}</strong>
        </div>
        <Badge tone={audit.checks.every((check) => check.ok) ? 'teal' : 'coral'}>
          {audit.checks.every((check) => check.ok) ? 'audit pass' : 'audit review'}
        </Badge>
      </div>

      <div className="audit-check-grid">
        {audit.checks.map((check) => (
          <div className="audit-check" key={check.label}>
            <div className="audit-check-top">
              <span>{check.label}</span>
              <Badge tone={check.ok ? 'teal' : 'coral'}>{check.ok ? 'match' : 'diff'}</Badge>
            </div>
            <div className="audit-check-values">
              <span className="cell-mono">expected: {check.expected}</span>
              <span className="cell-mono">actual: {check.actual}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="route-diff-table" aria-label="Expected rule to actual route diff">
        <div className="route-diff-head">
          <span>Audit path</span>
          <span>Expected</span>
          <span>Actual route</span>
          <span>Status</span>
        </div>
        {audit.diffRows.map((row) => (
          <div className={`route-diff-row route-diff-row--${row.status}`} key={row.path}>
            <span className="cell-mono">{row.path}</span>
            <span className="route-diff-value">{row.expected}</span>
            <span className="route-diff-value">{row.actual}</span>
            <span>
              <Badge tone={diffTone(row.status)}>{row.status}</Badge>
            </span>
          </div>
        ))}
      </div>

      <div className="audit-json-flow">
        <div>
          <p className="audit-json-label">Expected rule JSON</p>
          <JsonBlock value={audit.expected} />
        </div>
        <div className="audit-json-arrow" aria-hidden="true">-&gt;</div>
        <div>
          <p className="audit-json-label">Actual route JSON</p>
          <JsonBlock value={audit.actual} />
        </div>
      </div>
    </div>
  );
}

export function TestingPage() {
  const { data } = useStore();
  const toast = useToast();
  const [running, setRunning] = useState<string | null>(null);
  const [runningAll, setRunningAll] = useState(false);
  const [results, setResults] = useState<Record<string, RoutingTestResult>>({});
  const [proposed, setProposed] = useState('{}');
  const proposedObject = useMemo<Record<string, unknown> | null>(() => { try { const value: unknown = JSON.parse(proposed); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; } }, [proposed]);
  const [baseRevision, setBaseRevision] = useState('');
  const [previousRevision, setPreviousRevision] = useState('');
  const [preview, setPreview] = useState<unknown>(null);
  const [selected, setSelected] = useState<RoutingTestResult | null>(null);

  const availableCases = useMemo(
    () => TEST_CASES.filter((entry) => data.aliases.some((alias) => alias.alias === entry.alias)),
    [data.aliases],
  );

  async function runCase(category: TestCategory) {
    setRunning(category.alias);
    try {
      const result = await adminApi.runRoutingTest({
        category: category.title,
        modelAlias: category.alias,
        prompt: category.prompt,
        maxResponseChars: 1800,
      });
      setResults((current) => ({
        ...current,
        [category.alias]: result.data,
      }));
      setSelected((current) => (current?.modelAlias === category.alias ? result.data : current));
      toast.success(`${category.title} test complete`);
    } catch (caught) {
      toast.error('Run failed', caught instanceof ApiError ? caught.message : 'Unable to run routing test');
    } finally {
      setRunning(null);
    }
  }

  async function runAll() {
    setRunningAll(true);
    try {
      for (const category of availableCases) {
        await runCase(category);
      }
    } finally {
      setRunningAll(false);
    }
  }

  function expectedProviders(alias: string): string[] {
    return expectedProvidersForAlias(alias, data.routeRules);
  }

  function formatRuleHint(alias: string): string {
    const rule = routingRuleForAlias(alias, data.routeRules);
    if (!rule) {
      return 'No explicit model rule found.';
    }

    const action = parseRuleAction(rule);
    if (action.deny) {
      return action.denyReason ?? `Denied by rule: ${rule.name}`;
    }

    const kinds = action.providerKinds ?? [];
    return kinds.length > 0 ? `Route rule ${rule.name} targets providers: ${kinds.join(', ')}` : `Route rule ${rule.name} uses custom provider matching.`;
  }

  return (
    <>
      <Panel title="Selection preview" eyebrow="No model calls">
        <Field label="Proposed configuration" hint="JSON patch with objective, aliases, or rules. Alias and rule arrays replace their complete lists."><TextArea rows={7} value={proposed} onChange={setProposed} /></Field>
        <Button onClick={() => { void fetch('/api/routing/revisions').then((response) => response.json()).then((value) => { setBaseRevision(value.revision); setProposed(JSON.stringify(value.config, null, 2)); }).catch(() => toast.error('Configuration unavailable')); }}>Load current configuration</Button>
        <Button disabled={!baseRevision || !proposedObject} onClick={() => { void fetch('/api/routing/revisions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseRevision, patch: proposedObject }) }).then(async (response) => { const value = await response.json(); if (!response.ok) throw new Error(value.error); setPreviousRevision(value.previousRevision); setBaseRevision(value.revision); toast.success('Routing configuration applied'); }).catch((error: unknown) => toast.error(error instanceof Error ? error.message : 'Apply failed')); }}>Apply configuration</Button>
        <Button disabled={!previousRevision} onClick={() => { void fetch('/api/routing/revisions/' + previousRevision + '/rollback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseRevision }) }).then(async (response) => { const value = await response.json(); if (!response.ok) throw new Error(value.error); setBaseRevision(value.revision); setProposed(JSON.stringify(value.config, null, 2)); setPreviousRevision(''); toast.success('Previous configuration restored'); }).catch(() => toast.error('Rollback failed')); }}>Restore previous configuration</Button>
        <Button disabled={!proposedObject} onClick={() => { void fetch('/api/testing/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...proposedObject, cases: TEST_CASES.map((sample) => ({ modelAlias: sample.alias, prompt: sample.prompt })) }) }).then(async (response) => { const value = await response.json(); if (!response.ok) throw new Error(value.message ?? value.error); setPreview(value); }).catch((error: unknown) => toast.error(error instanceof Error ? error.message : 'Preview failed')); }}>Compare proposed selection</Button>
        {preview !== null && <JsonBlock value={preview} />}
      </Panel>
      <div className="page-head">
        <div>
          <h2>Testing</h2>
          <p>Profile the routing engine against seeded categories and measure provider selection + latency.</p>
        </div>
        <Button
          variant="ghost"
          icon={<Icon.Refresh className="btn-ico" />}
          loading={runningAll}
          onClick={() => void runAll()}
          disabled={running !== null}
        >
          Run all categories
        </Button>
      </div>

      {availableCases.length === 0 ? (
        <Panel title="Routing categories" eyebrow="No seeded categories found">
          <EmptyState icon={<Icon.Route width={34} height={34} />} message="Add model aliases first, then return here to run routing tests." />
        </Panel>
      ) : (
        <div className="testing-grid">
          {availableCases.map((category) => {
            const alias = data.aliases.find((entry) => entry.alias === category.alias);
            const rule = routingRuleForAlias(category.alias, data.routeRules);
            const result = results[category.alias];
            const expected = expectedProviders(category.alias);
            const expectedRoutingMatch =
              !result?.selectedProvider || !expected.length
                ? null
                : expected.includes(result.selectedProvider.kind)
                  ? true
                  : false;
            const statusTone: 'amber' | 'teal' | 'coral' =
              result ? (!result.success ? 'coral' : expectedRoutingMatch === false ? 'amber' : 'teal') : 'amber';

            return (
              <Panel
                key={category.alias}
                title={`${category.title} · ${category.alias}`}
                eyebrow={alias?.description ?? category.rationale}
                actions={
                  <div className="inline-actions">
                    <Badge tone="amber">{category.alias}</Badge>
                    <span className="muted">/</span>
                    <Badge tone={statusTone}>{result ? (result.success ? 'executed' : 'failed') : 'idle'}</Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={running === category.alias}
                      onClick={() => void runCase(category)}
                      disabled={running !== null || runningAll}
                      icon={<Icon.Activity className="btn-ico" />}
                    >
                      Run
                    </Button>
                  </div>
                }
              >
                <Field label="Seeded behavior">
                  <TextArea
                    value={formatRuleHint(category.alias)}
                    onChange={() => undefined}
                    readOnly
                    rows={3}
                    spellCheck={false}
                  />
                </Field>

                <Field label="Sample prompt">
                  <TextArea value={category.prompt} onChange={() => undefined} readOnly rows={5} spellCheck={false} />
                </Field>

                {expected.length > 0 ? (
                  <div className="test-tag-row">
                    <span className="panel-eyebrow">Expected providers</span>
                    <div className="test-tags">
                      {expected.map((kind) => (
                        <Badge key={kind} tone="sky">
                          {kind}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ) : null}

                {result ? (
                  <div className="kv-list" style={{ marginTop: 12 }}>
                    <div className="kv-row">
                      <span>Latency</span>
                      <span className="cell-mono">{result.latencyMs} ms</span>
                    </div>
                    <div className="kv-row">
                      <span>Upstream model</span>
                      <span className="cell-mono">{result.targetModel ?? result.modelAlias}</span>
                    </div>
                    <div className="kv-row">
                      <span>HTTP status</span>
                      <span className="cell-mono">{result.statusCode}</span>
                    </div>
                    <div className="kv-row">
                      <span>Selected provider</span>
                      <span className="cell-mono">
                        {result.selectedProvider ? `${result.selectedProvider.name} (${result.selectedProvider.kind})` : 'none'}
                      </span>
                    </div>
                    <div className="kv-row">
                      <span>Route status</span>
                      <span>
                        <Badge tone={result.success ? 'teal' : 'coral'}>{result.success ? 'succeeded' : 'failed'}</Badge>
                      </span>
                    </div>
                    {result.providerError ? (
                      <div className="kv-row">
                        <span>Provider error</span>
                        <span className="cell-mono">{result.providerError}</span>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {result ? (
                  <RouteAuditDiff alias={category.alias} rule={rule} result={result} expectedProviders={expected} />
                ) : null}

                {result ? (
                  <>
                    <Field label="Output preview" hint="Top-level reply content returned by the routed provider">
                      <TextArea value={result.responsePreview} onChange={() => undefined} readOnly rows={5} spellCheck={false} />
                    </Field>
                    <div className="inline-actions" style={{ justifyContent: 'flex-end' }}>
                      <Button variant="ghost" size="sm" onClick={() => setSelected(result)}>
                        View decision JSON
                      </Button>
                    </div>
                  </>
                ) : null}
              </Panel>
            );
          })}
        </div>
      )}

      <Drawer
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        eyebrow={selected ? selected.category : 'Routing decision'}
        title={selected ? `${selected.category} · ${selected.modelAlias}` : ''}
        footer={
          <Button variant="ghost" onClick={() => setSelected(null)}>
            Close
          </Button>
        }
      >
        {selected ? (
          <>
            <div className="kv-list">
              <div className="kv-row">
                <span>Request ID</span>
                <span className="cell-mono">{selected.requestId}</span>
              </div>
              <div className="kv-row">
                <span>Candidates</span>
                <span className="cell-mono">{selected.candidates.map((item) => item.kind).join(' → ') || 'none'}</span>
              </div>
              <div className="kv-row">
                <span>Selected provider kind</span>
                <span className="cell-mono">
                  {selected.selectedProvider?.kind ?? 'none'}
                </span>
              </div>
              <div className="kv-row">
                <span>Confidence</span>
                <span className="cell-mono">{Math.round(selected.decision.confidence * 100)}%</span>
              </div>
            </div>
            <p className="panel-eyebrow" style={{ marginTop: 18 }}>
              Decision payload
            </p>
            <JsonBlock value={selected.decision} />
            <p className="panel-eyebrow" style={{ marginTop: 18 }}>
              Candidate providers
            </p>
            <JsonBlock value={selected.candidates} />
            <p className="panel-eyebrow" style={{ marginTop: 18 }}>
              Provider attempts
            </p>
            <JsonBlock value={selected.attempts} />
          </>
        ) : null}
      </Drawer>
    </>
  );
}
