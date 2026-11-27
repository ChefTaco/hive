import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ardentSetupDeployPayload, validateArdentSetupRequest, runArdentSetup, ardentSetupMain, ardentSetupCLI } from './ardent-setup.mjs';

const secret = 'fixture-api-secret-never-return-this-value';
const operationId = '11111111-1111-4111-8111-111111111111';
const model = { base_url: 'https://inference.example.com/v1', model: 'fixture-model' };
const request = mode => ({ mode, nodeId: 'fixture-node', profile: 'assistant',
  ...(['plan', 'create'].includes(mode) ? { model } : {}),
  ...(['operation', 'resume'].includes(mode) ? { operationId } : {}) });
const state = () => ({ nodeId: 'fixture-node', installed: true, reachable: true, version: '3.1.3', owner: 'operator',
  profiles: [], stagedPackage: { version: '3.1.3', sha256: 'a'.repeat(64) }, stagedPackageError: null,
  capabilities: { studio: 3 }, commandOwners: [] });
const op = () => ({ id: operationId, nodeId: 'fixture-node', profile: 'assistant', kind: 'deploy', status: 'running', attempts: 1,
  steps: [{ name: 'profile-create', status: 'succeeded', receipt: { token: secret } }, { name: 'config-save', status: 'running' }],
  error: secret, request: { token: secret } });
const reply = (data, status = 200) => new Response(JSON.stringify({ success: true, data }), { status, headers: { 'content-type': 'application/json' } });
// Magnus's enrollment and admission records, which create and package-install read before any POST
// (and inspect reports). They answer from these values and are recorded apart from `calls`.
const scopeOf = (patch = {}) => ({ nodeId: 'fixture-node', nodeFqdn: 'fixture.example.com', wholeNodeState: 'enrolled', epoch: 1,
  barrierId: 'barrier', schedulerSnapshotSha256: 'b'.repeat(64), scope: { state: 'active', decisionId: 'decision' }, ...patch });
const admissionOf = (patch = {}) => ({ nodeId: 'fixture-node', nodeFqdn: 'fixture.example.com', closed: false, releaseId: null, ...patch });
function fake(responses, { scope = scopeOf(), admission = admissionOf() } = {}) {
  const calls = []; const readiness = [];
  const fetchImpl = async (url, options) => {
    if (url.startsWith('https://localhost:4000/api/v1/resource-leases/')) {
      readiness.push({ url, ...options }); assert.equal(options.method ?? 'GET', 'GET'); assert.equal(options.headers['x-api-secret'], secret);
      const value = url.endsWith('/ardent-scope') ? scope : admission;
      if (value instanceof Error) throw value;
      return value instanceof Response ? value : reply(value);
    }
    calls.push({ url, ...options });
    assert.equal(options.redirect, 'error'); assert.equal(options.headers['x-api-secret'], secret);
    assert(options.signal instanceof AbortSignal);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    assert(next, 'Unexpected additional HTTP request');
    return typeof next === 'function' ? next(url, options) : next;
  };
  return { calls, readiness, options: { apiSecret: secret, fetchImpl } };
}
async function rejectsWithoutNetwork(input) {
  let calls = 0;
  await assert.rejects(runArdentSetup(input, { apiSecret: secret, fetchImpl: () => { calls++; } }), { code: 'ARDENT_SETUP_REQUEST_INVALID' });
  assert.equal(calls, 0);
}

test('strict request validation rejects unknown fields, IDs, modes and misplaced operation/model fields', async () => {
  for (const input of [null, [], {}, { ...request('inspect'), mode: 'delete' }, { ...request('inspect'), apiSecret: secret },
    { ...request('inspect'), nodeId: '../other' }, { ...request('inspect'), profile: '../other' },
    { ...request('inspect'), profile: 'a'.repeat(65) }, { ...request('inspect'), operationId },
    { ...request('inspect'), model }, { ...request('operation'), operationId: '../../x' },
    { ...request('operation'), operationId: undefined }, { ...request('create'), model: undefined }]) await rejectsWithoutNetwork(input);
});
test('models allow only credential-free explicit OpenAI URLs/models or the exact alias shape', async () => {
  for (const value of [{ base_url: 'https://user:password@inference.example.com/v1', model: 'x' },
    { base_url: 'https://inference.example.com/v1?token=fake', model: 'x' },
    { base_url: 'https://inference.example.com/v1#fragment', model: 'x' },
    { base_url: 'https://inference.example.com/v1?', model: 'x' }, { base_url: 'https://inference.example.com/v1#', model: 'x' },
    { base_url: 'file:///tmp/model', model: 'x' }, { base_url: 'http:\\inference.example.com', model: 'x' },
    { ...model, api_key: secret }, { ...model, api_key_env: 'FAKE_KEY' }, { ...model, model: ' ' },
    { emberpath_alias: 'alias', base_url: model.base_url }, { emberpath_alias: '../bad alias' }])
    await rejectsWithoutNetwork({ ...request('plan'), model: value });
  assert.deepEqual(validateArdentSetupRequest({ ...request('plan'), model: { emberpath_alias: 'lab:assistant' } }).model, { emberpath_alias: 'lab:assistant' });
  assert.equal(validateArdentSetupRequest({ ...request('plan'), model: { base_url: 'http://inference.example.com:8000/v1', model: 'x' } }).model.model, 'x');
});
test('plan performs no HTTP request and binds exactly the immutable default deployment payload', async () => {
  const f = fake([]); const plan = await runArdentSetup(request('plan'), f.options);
  const payload = ardentSetupDeployPayload(request('plan'));
  assert.equal(plan.requestSHA256, createHash('sha256').update(JSON.stringify(payload)).digest('hex'));
  assert.deepEqual(plan.model, model); assert.equal(f.calls.length, 0);
  assert.equal(payload.profile, 'assistant'); assert.equal(payload.hivemem, true); assert.deepEqual(payload.skills, []);
  assert(payload.soul_md.length > 0 && payload.identity_md.includes('Assistant'));
});
test('inspect retains bounded ownership metadata and strips raw errors, credentials and arbitrary fields', async () => {
  const data = state(); data.error = secret; data.stagedPackageError = secret; data.environment = { secret };
  data.profiles = [{ id: 'existing', apiPort: 9910, running: false, backend: 'llamacpp', error: secret, hivemem: { state: 'ok', token: secret } }];
  data.commandOwners = [{ commandId: 'native-one', state: 'unknown', profile: 'existing', action: 'service-start', ardent: true, label: secret }];
  const f = fake([reply(data)]); const result = await runArdentSetup(request('inspect'), f.options);
  assert.equal(f.calls[0].url, 'https://localhost:4000/api/v1/ardent/installations/fixture-node');
  assert.equal(result.commandOwners[0].state, 'unknown'); assert.equal(result.profiles[0].error, true);
  assert.equal(result.stagedPackageError, true); assert(!JSON.stringify(result).includes(secret));
});
test('create refuses existing profiles or held work before any POST', async () => {
  for (const update of [s => s.profiles.push({ id: 'assistant', apiPort: 9910, running: true, backend: 'llamacpp' }),
    s => s.commandOwners.push({ commandId: 'native-one', state: 'unknown', profile: null, action: null, ardent: false }),
    s => { s.reachable = false; }, s => { s.installed = false; }]) {
    const s = state(); update(s); const f = fake([reply(s)]);
    await assert.rejects(runArdentSetup(request('create'), f.options)); assert.equal(f.calls.length, 1);
  }
});
test('create waits for a settling owner (the just-finished package install), but never for held work', async () => {
  const busy = state(); busy.commandOwners = [{ commandId: 'native-install', state: 'running', profile: null, action: 'package-install', ardent: true }];
  const f = fake([reply(busy), reply(busy), reply(state()), reply({ operationId }, 202)]); let slept = 0;
  const result = await runArdentSetup(request('create'), { ...f.options, sleep: async () => { slept++; } });
  assert.equal(result.operationId, operationId); assert.equal(slept, 2);
  assert.deepEqual(f.calls.map(call => call.method ?? 'GET'), ['GET', 'GET', 'GET', 'POST']);
  const held = state(); held.commandOwners = [{ commandId: 'native-one', state: 'unknown', profile: null, action: null, ardent: false }];
  const h = fake([reply(held)]);
  await assert.rejects(runArdentSetup(request('create'), { ...h.options, sleep: async () => assert.fail('waited for held work') }),
    error => error.code === 'ARDENT_SETUP_NODE_NOT_READY' && error.ambiguous === false);
  assert.equal(h.calls.length, 1);
  const stuck = fake([reply(busy), reply(busy), reply(busy)]); let now = 0; const realNow = Date.now;
  Date.now = () => now;
  try {
    await assert.rejects(runArdentSetup(request('create'), { ...stuck.options, settleMs: 3_000, pollMs: 1_500, sleep: async ms => { now += ms; } }),
      error => error.code === 'ARDENT_SETUP_NODE_NOT_READY' && error.ambiguous === false);
  } finally { Date.now = realNow; }
  assert.equal(stuck.calls.filter(call => call.method === 'POST').length, 0);
});
test('create dispatches exactly once through New Agent and returns the planned request hash', async () => {
  const f = fake([reply(state()), reply({ operationId }, 202)]);
  const result = await runArdentSetup(request('create'), f.options);
  assert.equal(result.operationId, operationId); assert.equal(f.calls[1].url, 'https://localhost:4000/api/v1/ardent/agents');
  assert.equal(f.calls[1].method, 'POST'); assert.deepEqual(JSON.parse(f.calls[1].body), ardentSetupDeployPayload(request('create')));
  const plan = await runArdentSetup(request('plan'), fake([]).options); assert.equal(result.requestSHA256, plan.requestSHA256);
});
test('package install uses only the owning fixed action and requires the verified staged artifact', async () => {
  const f = fake([reply(state()), reply({ installed: true, version: '3.1.3', changed: false, token: secret })]);
  assert.deepEqual(await runArdentSetup(request('package-install'), f.options), { schema: 1, mode: 'package-install', nodeId: 'fixture-node', profile: 'assistant', installed: true, version: '3.1.3', changed: false });
  assert.deepEqual(JSON.parse(f.calls[1].body), { action: 'package-install' });
  const s = state(); s.stagedPackage = null; const refused = fake([reply(s)]);
  await assert.rejects(runArdentSetup(request('package-install'), refused.options), { code: 'ARDENT_SETUP_PACKAGE_UNAVAILABLE' });
  assert.equal(refused.calls.length, 1);
});
test('operation output preserves only durable state and verifies exact node/profile/operation ownership', async () => {
  const f = fake([reply(op())]); const result = await runArdentSetup(request('operation'), f.options);
  assert.deepEqual(result.steps, [{ name: 'profile-create', status: 'succeeded' }, { name: 'config-save', status: 'running' }]);
  assert.equal(result.failedStep, null); assert(!JSON.stringify(result).includes(secret));
  for (const patch of [{ nodeId: 'foreign' }, { profile: 'foreign' }, { id: '22222222-2222-4222-8222-222222222222' }]) {
    const x = fake([reply({ ...op(), ...patch })]);
    await assert.rejects(runArdentSetup(request('resume'), x.options), { code: 'ARDENT_SETUP_RESPONSE_INVALID' }); assert.equal(x.calls.length, 1);
  }
});
test('explicit resume reads the bound operation and sends one POST, never resumes completed operations', async () => {
  const operation = { ...op(), status: 'failed' }; const f = fake([reply(operation), reply({ operationId }, 202)]);
  assert.equal((await runArdentSetup(request('resume'), f.options)).operationId, operationId);
  assert.equal(f.calls[1].url, 'https://localhost:4000/api/v1/ardent/agents/operations/' + operationId + '/resume');
  assert.equal(f.calls[1].method, 'POST'); assert.equal(f.calls[1].body, undefined);
  const done = fake([reply({ ...op(), status: 'succeeded' })]);
  await assert.rejects(runArdentSetup(request('resume'), done.options), { code: 'ARDENT_SETUP_OPERATION_NOT_RESUMABLE' }); assert.equal(done.calls.length, 1);
});
test('check reads runtime/memory and executes one real provider test without returning model text', async () => {
  const f = fake([reply({ version: '3.1.3', profile: 'assistant', backend: 'llamacpp', token: secret }), reply({ status: 'ready', token: secret }), reply({ backend: 'llamacpp', answer: 'READY', usage: { private: secret } })]);
  const result = await runArdentSetup(request('check'), f.options);
  assert.equal(result.ready, true); assert.equal(result.provider.expectedReady, true); assert(!JSON.stringify(result).includes(secret));
  assert.equal(f.calls.length, 3); assert.deepEqual(JSON.parse(f.calls[2].body), { action: 'provider-test' });
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});
test('unsupported provider probes and degraded memory never claim readiness', async () => {
  const f = fake([reply({ version: '3.1.3', profile: 'assistant', backend: 'llamacpp' }), reply({ status: 'ready' }), new Response('', { status: 404 })]);
  const result = await runArdentSetup(request('check'), f.options); assert.equal(result.ready, false); assert.equal(result.provider.supported, false);
  const degraded = fake([reply({ version: '3.1.3', profile: 'assistant', backend: 'llamacpp' }), reply({ status: 'degraded', reason: secret }), reply({ backend: 'llamacpp', answer: 'READY' })]);
  assert.equal((await runArdentSetup(request('check'), degraded.options)).ready, false);
});
test('HTTP refusal exposes only allowlisted code/status, never raw API errors or secrets', async () => {
  for (const code of ['COMMAND_OWNER_UNSETTLED', secret]) {
    const f = fake([reply(state()), new Response(JSON.stringify({ success: false, error: { code, message: secret, token: secret } }), { status: 409 })]);
    await assert.rejects(runArdentSetup(request('create'), f.options), error => {
      assert.equal(error.code, 'ARDENT_SETUP_API_REFUSED'); assert.equal(error.httpStatus, 409); assert.equal(error.ambiguous, true);
      assert.equal(error.apiCode, code === secret ? undefined : code); assert(!JSON.stringify(error).includes(secret)); return true;
    }); assert.equal(f.calls.length, 2);
  }
});
test('POST timeouts, redirects, malformed bodies and malformed accepted IDs remain ambiguous without retries', async () => {
  for (const response of [new Error(secret), new Response(secret, { status: 302 }), new Response(secret, { status: 200 }), reply({ operationId: 'invalid' }, 202)]) {
    const f = fake([reply(state()), response]);
    await assert.rejects(runArdentSetup(request('create'), f.options), error => { assert.equal(error.ambiguous, true); assert(!JSON.stringify(error).includes(secret)); return true; });
    assert.equal(f.calls.length, 2);
  }
});
test('bounded responses refuse declared and streamed oversize before returning contents', async () => {
  for (const response of [new Response('{}', { headers: { 'content-length': String(1024 * 1024) } }), new Response('x'.repeat(600 * 1024))]) {
    const f = fake([response]); await assert.rejects(runArdentSetup(request('inspect'), f.options), { code: 'ARDENT_SETUP_RESPONSE_INVALID' });
  }
});
test('empty secret, invalid port, unsupported timeout and absent environment fail without HTTP', async () => {
  for (const options of [{ apiSecret: '' }, { apiSecret: '  ' }, { apiSecret: secret, port: 'https://foreign.example.com' }, { apiSecret: secret, timeoutMs: 180001 }]) {
    let calls = 0;
    await assert.rejects(runArdentSetup(request('plan'), { ...options, fetchImpl: () => { calls++; } })); assert.equal(calls, 0);
  }
  await assert.rejects(ardentSetupMain({}), { code: 'ARDENT_SETUP_REQUEST_INVALID' });
  await assert.rejects(ardentSetupMain({ HIVE_ARDENT_SETUP: '{', API_SECRET: secret }), { code: 'ARDENT_SETUP_REQUEST_INVALID' });
});
test('entrypoint is inert on import and direct execution returns safe JSON/nonzero for invalid environment', async () => {
  const child = spawnSync(process.execPath, [new URL('./ardent-setup.mjs', import.meta.url).pathname], { encoding: 'utf8', env: { PATH: process.env.PATH, HIVE_ARDENT_SETUP: 'invalid', API_SECRET: secret } });
  assert.equal(child.status, 1); assert.equal(child.stderr, ''); assert(!child.stdout.includes(secret));
  assert.equal(JSON.parse(child.stdout).error.code, 'ARDENT_SETUP_REQUEST_INVALID');
  const previous = process.exitCode; const lines = [];
  await ardentSetupCLI({ HIVE_ARDENT_SETUP: 'invalid', API_SECRET: secret }, line => lines.push(line));
  assert.equal(JSON.parse(lines[0]).success, false); process.exitCode = previous;
});

test('check refuses a foreign profile, wrong backend or malformed runtime before provider POST', async () => {
  for (const patch of [{ profile: 'foreign' }, { backend: 'codex' }, { version: 'invalid' }]) {
    const f = fake([reply({ version: '3.1.3', profile: 'assistant', backend: 'llamacpp', ...patch }), reply({ status: 'ready' })]);
    await assert.rejects(runArdentSetup(request('check'), f.options), { code: 'ARDENT_SETUP_RESPONSE_INVALID', ambiguous: false });
    assert(f.calls.every(call => call.method === 'GET'));
  }
});
test('a package result cannot silently claim a version other than the inspected staged release', async () => {
  const f = fake([reply(state()), reply({ installed: true, version: '3.1.2', changed: true })]);
  await assert.rejects(runArdentSetup(request('package-install'), f.options), { code: 'ARDENT_SETUP_RESPONSE_INVALID', ambiguous: true });
});
test('an actual AbortSignal deadline terminates the one POST attempt and retains uncertainty', async () => {
  let calls = 0;
  const fetchImpl = async (url, options) => {
    if (url.includes('/resource-leases/')) return reply(url.endsWith('/ardent-scope') ? scopeOf() : admissionOf());
    calls++;
    if (calls === 1) return reply(state());
    return new Promise((_resolve, reject) => {
      const guard = setTimeout(() => reject(new Error('fixture-deadline-missed')), 1000);
      options.signal.addEventListener('abort', () => { clearTimeout(guard); reject(new Error(secret)); }, { once: true });
    });
  };
  await assert.rejects(runArdentSetup(request('create'), { apiSecret: secret, fetchImpl, timeoutMs: 5 }),
    { code: 'ARDENT_SETUP_TRANSPORT_FAILED', ambiguous: true });
  assert.equal(calls, 2);
});
test('CLI rejects disabled TLS verification and suppresses unexpected environment/parser errors', async () => {
  await assert.rejects(ardentSetupMain({ HIVE_ARDENT_SETUP: JSON.stringify(request('plan')), API_SECRET: secret, NODE_TLS_REJECT_UNAUTHORIZED: '0' }), { code: 'ARDENT_SETUP_TLS_UNAVAILABLE' });
  const old = process.exitCode; const lines = [];
  await ardentSetupCLI({ HIVE_ARDENT_SETUP: JSON.stringify({ ...request('create'), token: secret }), API_SECRET: secret }, value => lines.push(value));
  assert.equal(JSON.parse(lines[0]).error.code, 'ARDENT_SETUP_REQUEST_INVALID'); assert(!lines[0].includes(secret)); process.exitCode = old;
});

test('operation reads never adopt a HiveMem backfill as a New Agent deployment', async () => {
  const f = fake([reply({ ...op(), kind: 'hivemem', status: 'succeeded' })]);
  await assert.rejects(runArdentSetup(request('operation'), f.options), { code: 'ARDENT_SETUP_RESPONSE_INVALID', ambiguous: false });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'GET');
});
test('explicit resume never repurposes a different operation kind on the same profile', async () => {
  const f = fake([reply({ ...op(), kind: 'hivemem', status: 'failed' })]);
  await assert.rejects(runArdentSetup(request('resume'), f.options), { code: 'ARDENT_SETUP_RESPONSE_INVALID', ambiguous: false });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'GET');
});

test('inspect reports whether Magnus admits managed Ardent actions on the node, or null when it cannot tell', async () => {
  const f = fake([reply(state())]);
  const result = await runArdentSetup(request('inspect'), f.options);
  assert.deepEqual(result.enrollment, { ardentScope: 'active', wholeNode: 'enrolled', admissionClosed: false, ready: true });
  assert.deepEqual(f.readiness.map(call => call.url), ['https://localhost:4000/api/v1/resource-leases/enrollment/fixture-node/ardent-scope',
    'https://localhost:4000/api/v1/resource-leases/admission/fixture-node']);
  const pending = fake([reply(state())], { scope: scopeOf({ wholeNodeState: 'legacy', scope: { state: 'pending' } }) });
  assert.deepEqual((await runArdentSetup(request('inspect'), pending.options)).enrollment,
    { ardentScope: 'pending', wholeNode: 'legacy', admissionClosed: false, ready: false });
  for (const scope of [new Error(secret), new Response(JSON.stringify({ success: false, error: { code: 'FORBIDDEN' } }), { status: 403 }),
    scopeOf({ nodeId: 'foreign' }), scopeOf({ scope: { state: secret } })]) {
    const unknown = fake([reply(state())], { scope });
    const result = await runArdentSetup(request('inspect'), unknown.options);
    assert.equal(result.enrollment, null); assert(!JSON.stringify(result).includes(secret));
  }
});
test('create and package-install refuse a node Magnus would not admit before any POST, unambiguously', async () => {
  const cases = [[{ scope: scopeOf({ wholeNodeState: 'legacy', scope: { state: 'pending' } }) }, 'ARDENT_SETUP_NODE_NOT_ENROLLED'],
    [{ scope: scopeOf({ wholeNodeState: 'draining', scope: { state: 'pending' } }) }, 'ARDENT_SETUP_NODE_NOT_ENROLLED'],
    [{ scope: scopeOf({ wholeNodeState: 'legacy' }) }, 'ARDENT_SETUP_NODE_NOT_ENROLLED'],
    [{ admission: admissionOf({ closed: true, releaseId: 'maintenance' }) }, 'ARDENT_SETUP_ADMISSION_CLOSED']];
  for (const mode of ['create', 'package-install']) {
    for (const [records, code] of cases) {
      const s = state(); if (mode === 'package-install') s.installed = false;
      const f = fake([reply(s)], records);
      await assert.rejects(runArdentSetup(request(mode), f.options), error => error.code === code && error.ambiguous === false);
      assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
    }
    const s = state(); if (mode === 'package-install') s.installed = false;
    const unread = fake([reply(s)], { scope: new Response(JSON.stringify({ success: false, error: { code: 'DEPENDENCY_UNAVAILABLE' } }), { status: 503 }) });
    await assert.rejects(runArdentSetup(request(mode), unread.options), error => error.ambiguous === false);
    assert.equal(unread.calls.filter(call => call.method === 'POST').length, 0);
  }
  // A whole node draining for enrollment with its Ardent scope active (prepare-ardent) is admitted.
  const draining = fake([reply(state()), reply({ operationId }, 202)], { scope: scopeOf({ wholeNodeState: 'draining' }) });
  assert.equal((await runArdentSetup(request('create'), draining.options)).operationId, operationId);
});
test('a package installation Magnus refused is settled only when the node then holds no command and no package', async () => {
  const refusal = () => new Response(JSON.stringify({ success: false, error: { code: 'DEPENDENCY_UNAVAILABLE', message: secret } }), { status: 503 });
  const fresh = () => ({ ...state(), installed: false });
  const f = fake([reply(fresh()), refusal(), reply(fresh())]);
  await assert.rejects(runArdentSetup(request('package-install'), f.options), error => {
    assert.equal(error.code, 'ARDENT_SETUP_PACKAGE_REFUSED'); assert.equal(error.ambiguous, false);
    assert.equal(error.httpStatus, 503); assert.equal(error.apiCode, 'DEPENDENCY_UNAVAILABLE'); assert(!JSON.stringify(error).includes(secret)); return true;
  });
  assert.deepEqual(f.calls.map(call => call.method ?? 'GET'), ['GET', 'POST', 'GET']);
  // The owner of the refused command still releasing: wait for it, as before a create.
  const releasing = { ...fresh(), commandOwners: [{ commandId: 'native-install', state: 'running', profile: null, action: 'package-install', ardent: true }] };
  const w = fake([reply(fresh()), refusal(), reply(releasing), reply(fresh())]);
  await assert.rejects(runArdentSetup(request('package-install'), { ...w.options, sleep: async () => undefined }),
    error => error.code === 'ARDENT_SETUP_PACKAGE_REFUSED' && error.ambiguous === false);
  // Anything that may have started or finished stays ambiguous: a held owner, an installed package,
  // an unknown outcome, no answer, or a node that cannot be read again.
  const unknownOwner = { ...fresh(), commandOwners: [{ commandId: 'native-install', state: 'unknown', profile: null, action: 'package-install', ardent: true }] };
  const outcomeUnknown = new Response(JSON.stringify({ success: false, error: { code: 'ARDENT_OUTCOME_UNKNOWN' } }), { status: 409 });
  for (const [answer, after] of [[refusal(), reply(unknownOwner)], [refusal(), reply(state())], [outcomeUnknown, reply(fresh())],
    [new Error(secret), reply(fresh())], [new Response(secret, { status: 502 }), reply(fresh())], [refusal(), new Error(secret)]]) {
    const x = fake([reply(fresh()), answer, after]);
    await assert.rejects(runArdentSetup(request('package-install'), { ...x.options, settleMs: 0 }), error => {
      assert.notEqual(error.code, 'ARDENT_SETUP_PACKAGE_REFUSED'); assert.equal(error.ambiguous, true); return true;
    });
    assert.equal(x.calls.filter(call => call.method === 'POST').length, 1);
  }
});
test('the CLI reports a settled package refusal as unambiguous', async () => {
  const realFetch = globalThis.fetch; const lines = []; const previous = process.exitCode;
  const responses = [reply({ ...state(), installed: false }), new Response(JSON.stringify({ success: false, error: { code: 'DEPENDENCY_UNAVAILABLE' } }), { status: 503 }),
    reply({ ...state(), installed: false })];
  globalThis.fetch = async url => url.includes('/resource-leases/') ? reply(url.endsWith('/ardent-scope') ? scopeOf() : admissionOf()) : responses.shift();
  try { await ardentSetupCLI({ HIVE_ARDENT_SETUP: JSON.stringify(request('package-install')), API_SECRET: secret }, line => lines.push(line)); }
  finally { globalThis.fetch = realFetch; }
  assert.deepEqual(JSON.parse(lines[0]), { schema: 1, success: false,
    error: { code: 'ARDENT_SETUP_PACKAGE_REFUSED', ambiguous: false, httpStatus: 503, apiCode: 'DEPENDENCY_UNAVAILABLE' } });
  assert.equal(process.exitCode, 1); process.exitCode = previous;
});
