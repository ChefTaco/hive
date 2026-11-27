// Runs inside Magnus; only its existing HTTPS API owns package and profile changes.
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MODES = new Set(['inspect', 'plan', 'package-install', 'create', 'operation', 'resume', 'check']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROFILE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
const STEPS = new Set(['profile-check', 'profile-create', 'service-start', 'identity-soul', 'identity-identity',
  'hivemem-enroll', 'config-save', 'skill-set', 'service-restart', 'ready-probe']);
const STEP_STATES = new Set(['pending', 'running', 'succeeded', 'skipped', 'failed']);
const API_CODES = new Set(['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_ERROR', 'CONFLICT',
  'DEPENDENCY_UNAVAILABLE', 'ARDENT_NOT_INSTALLED', 'PROFILE_EXISTS', 'PORT_IN_USE', 'OPERATION_RUNNING',
  'OPERATION_NOT_RESUMABLE', 'COMMAND_OWNER_UNSETTLED', 'AGENT_UPGRADE_REQUIRED', 'HIVEMEM_ENROLLMENT_UNAVAILABLE',
  'EMBERPATH_UNAVAILABLE', 'RESOURCE_LEASE_HELD', 'RESOURCE_LEASE_CONFLICT', 'ARDENT_OUTCOME_UNKNOWN', 'ADMISSION_FENCED',
  'ARDENT_SCOPE_REQUIRED']);
// Magnus admits managed Ardent actions only on a node whose Ardent scope is active while the whole
// node is draining for enrollment or enrolled (assertArdentScope), and only while its admission is open.
const WHOLE_NODE_STATES = new Set(['legacy', 'draining', 'enrolled']);
const MAX_RESPONSE = 512 * 1024;

export class ArdentSetupError extends Error {
  constructor(code, { httpStatus, apiCode, ambiguous = false, settled = false } = {}) {
    super(code); this.name = 'ArdentSetupError'; this.code = code; this.ambiguous = ambiguous;
    // A refusal Magnus answered after a POST, where the node was then seen to hold nothing.
    if (settled) Object.defineProperty(this, 'settled', { value: true });
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
    if (apiCode !== undefined) this.apiCode = apiCode;
  }
}
function requireValue(condition, code = 'ARDENT_SETUP_RESPONSE_INVALID') {
  if (!condition) throw new ArdentSetupError(code);
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function exact(value, keys) { return object(value) && Object.keys(value).every(key => keys.includes(key)); }
function version(value) { requireValue(typeof value === 'string' && VERSION.test(value)); return value; }
function nullableVersion(value) { return value === null ? null : version(value); }

export function validateArdentSetupRequest(value) {
  const invalid = 'ARDENT_SETUP_REQUEST_INVALID';
  requireValue(exact(value, ['mode', 'nodeId', 'profile', 'model', 'operationId']), invalid);
  requireValue(MODES.has(value.mode) && typeof value.nodeId === 'string' && ID.test(value.nodeId)
    && typeof value.profile === 'string' && PROFILE.test(value.profile), invalid);
  const request = { mode: value.mode, nodeId: value.nodeId, profile: value.profile };
  if (['plan', 'create'].includes(value.mode)) {
    const model = value.model;
    if (exact(model, ['emberpath_alias']) && typeof model.emberpath_alias === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model.emberpath_alias)) {
      request.model = { emberpath_alias: model.emberpath_alias };
    } else {
      requireValue(exact(model, ['base_url', 'model']) && typeof model.base_url === 'string'
        && model.base_url.length <= 2048 && /^https?:\/\//.test(model.base_url)
        && !/[\x00-\x20\x7f?#]/.test(model.base_url) && typeof model.model === 'string'
        && model.model.trim().length > 0 && model.model.length <= 200 && !/[\x00-\x1f\x7f]/.test(model.model), invalid);
      let url;
      try { url = new URL(model.base_url); } catch { throw new ArdentSetupError(invalid); }
      requireValue(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, invalid);
      request.model = { base_url: url.href, model: model.model };
    }
  } else requireValue(!Object.hasOwn(value, 'model'), invalid);
  if (['operation', 'resume'].includes(value.mode)) {
    requireValue(typeof value.operationId === 'string' && UUID.test(value.operationId), invalid);
    request.operationId = value.operationId;
  } else requireValue(!Object.hasOwn(value, 'operationId'), invalid);
  return request;
}

export function ardentSetupDeployPayload(request) {
  const input = validateArdentSetupRequest(request);
  requireValue(['plan', 'create'].includes(input.mode), 'ARDENT_SETUP_REQUEST_INVALID');
  return { nodeId: input.nodeId, profile: input.profile,
    soul_md: '# Assistant\n\nHelp the user with clear, accurate answers. Ask when essential information is missing. Respect the user\'s permissions and keep secrets private.\n',
    identity_md: `# Identity\n\nName: Assistant\nProfile: ${input.profile}\nPurpose: A general-purpose assistant managed by Magnus.\n`,
    model: input.model, skills: [], hivemem: true };
}
function payloadDigest(payload) { return createHash('sha256').update(JSON.stringify(payload)).digest('hex'); }

function installationView(data, nodeId) {
  requireValue(object(data) && data.nodeId === nodeId && typeof data.installed === 'boolean'
    && typeof data.reachable === 'boolean' && Array.isArray(data.profiles) && data.profiles.length <= 256
    && Array.isArray(data.commandOwners) && data.commandOwners.length <= 1000);
  const profiles = data.profiles.map(row => {
    requireValue(object(row) && typeof row.id === 'string' && PROFILE.test(row.id) && typeof row.running === 'boolean'
      && (row.apiPort === null || Number.isInteger(row.apiPort) && row.apiPort > 0 && row.apiPort <= 65535)
      && [null, 'llamacpp', 'codex'].includes(row.backend));
    const state = row.hivemem?.state ?? null;
    requireValue([null, 'ok', 'renewal-failing', 'expired'].includes(state));
    return { id: row.id, apiPort: row.apiPort, running: row.running, backend: row.backend,
      error: Boolean(row.error), hivememState: state };
  });
  const owners = data.commandOwners.map(row => {
    requireValue(object(row) && typeof row.commandId === 'string' && ID.test(row.commandId)
      && ['reserved', 'running', 'unknown'].includes(row.state) && typeof row.ardent === 'boolean');
    requireValue(row.profile === null || typeof row.profile === 'string' && PROFILE.test(row.profile));
    requireValue(row.action === null || typeof row.action === 'string' && /^[a-z][a-z-]{0,63}$/.test(row.action));
    return { commandId: row.commandId, state: row.state, profile: row.profile, action: row.action, ardent: row.ardent };
  });
  requireValue(typeof data.owner === 'string' && /^[a-z_][a-z0-9_-]{0,63}\$?$/.test(data.owner));
  const staged = data.stagedPackage ?? null;
  requireValue(staged === null || object(staged) && typeof staged.sha256 === 'string' && /^[a-f0-9]{64}$/.test(staged.sha256));
  const studio = data.capabilities?.studio ?? null;
  requireValue(studio === null || Number.isSafeInteger(studio) && studio >= 0);
  return { installed: data.installed, reachable: data.reachable, version: nullableVersion(data.version), owner: data.owner,
    stagedPackage: staged === null ? null : { version: version(staged.version), sha256: staged.sha256 },
    stagedPackageError: Boolean(data.stagedPackageError), capabilities: { studio }, profiles, commandOwners: owners };
}
function operationView(data, request) {
  requireValue(object(data) && data.id === request.operationId && data.nodeId === request.nodeId && data.profile === request.profile
    && data.kind === 'deploy' && ['running', 'succeeded', 'failed'].includes(data.status)
    && Number.isSafeInteger(data.attempts) && data.attempts >= 1 && Array.isArray(data.steps) && data.steps.length <= STEPS.size);
  const steps = data.steps.map(step => {
    requireValue(object(step) && STEPS.has(step.name) && STEP_STATES.has(step.status));
    return { name: step.name, status: step.status };
  });
  requireValue(new Set(steps.map(step => step.name)).size === steps.length);
  return { operationId: data.id, kind: data.kind, status: data.status, attempts: data.attempts, steps,
    failedStep: steps.find(step => step.status === 'failed')?.name ?? null };
}
async function responseJson(response) {
  requireValue(Number.isInteger(response.status) && response.body);
  const length = response.headers.get('content-length');
  requireValue(length === null || /^\d+$/.test(length) && Number(length) <= MAX_RESPONSE);
  const reader = response.body.getReader(); const chunks = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength; requireValue(total <= MAX_RESPONSE); chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new ArdentSetupError('ARDENT_SETUP_RESPONSE_INVALID'); }
}

/** No transport retries. A failed or ambiguous POST remains the caller's durable intent. */
export async function runArdentSetup(raw, { apiSecret, port = '4000', fetchImpl = globalThis.fetch, timeoutMs,
  settleMs = 60_000, pollMs = 2_000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const request = validateArdentSetupRequest(raw);
  requireValue(typeof apiSecret === 'string' && apiSecret.trim().length > 0 && apiSecret.length <= 8192
    && !/[\x00-\x1f\x7f]/.test(apiSecret), 'ARDENT_SETUP_AUTH_UNAVAILABLE');
  const packageTimeout = timeoutMs ?? 660_000;
  timeoutMs ??= 120_000;
  const maxTimeout = request.mode === 'package-install' ? 660_000 : 180_000;
  requireValue(/^[0-9]{1,5}$/.test(String(port)) && Number(port) > 0 && Number(port) <= 65535
    && Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= maxTimeout, 'ARDENT_SETUP_TRANSPORT_INVALID');
  const api = `https://localhost:${Number(port)}/api/v1`;
  const base = api + '/ardent';
  const common = { schema: 1, mode: request.mode, nodeId: request.nodeId, profile: request.profile };
  let postAttempted = false;
  async function call(path, method = 'GET', body, optional = false) {
    let response;
    if (method === 'POST') postAttempted = true;
    try { response = await fetchImpl((path.startsWith('/resource-leases/') ? api : base) + path, { method, redirect: 'error', signal: AbortSignal.timeout(method === 'POST' && request.mode === 'package-install' ? packageTimeout : timeoutMs),
      headers: { 'x-api-secret': apiSecret, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
    catch { throw new ArdentSetupError('ARDENT_SETUP_TRANSPORT_FAILED', { ambiguous: method === 'POST' }); }
    if (optional && [404, 405].includes(response.status)) { await response.body?.cancel().catch(() => undefined); return null; }
    let reply;
    try { reply = await responseJson(response); }
    catch { throw new ArdentSetupError('ARDENT_SETUP_RESPONSE_INVALID', { httpStatus: response.status, ambiguous: method === 'POST' }); }
    if (response.status < 200 || response.status >= 300 || !object(reply) || reply.success !== true) {
      const apiCode = API_CODES.has(reply?.error?.code) ? reply.error.code : undefined;
      throw new ArdentSetupError('ARDENT_SETUP_API_REFUSED', { httpStatus: response.status,
        ...(apiCode && !apiCode.includes(apiSecret) ? { apiCode } : {}), ambiguous: method === 'POST' });
    }
    return reply.data;
  }
  const installation = async () => installationView(await call('/installations/' + encodeURIComponent(request.nodeId)), request.nodeId);
  const actionPath = '/installations/' + encodeURIComponent(request.nodeId) + '/profiles/' + encodeURIComponent(request.profile) + '/action';
  // Whether Magnus would admit a managed Ardent action on this node now, from its own enrollment
  // and admission records. Reading them changes nothing.
  const readiness = async () => {
    const node = encodeURIComponent(request.nodeId);
    const scope = await call('/resource-leases/enrollment/' + node + '/ardent-scope');
    const admission = await call('/resource-leases/admission/' + node);
    requireValue(object(scope) && scope.nodeId === request.nodeId && typeof scope.wholeNodeState === 'string'
      && object(scope.scope) && ['active', 'pending'].includes(scope.scope.state)
      && object(admission) && admission.nodeId === request.nodeId && typeof admission.closed === 'boolean');
    const wholeNode = WHOLE_NODE_STATES.has(scope.wholeNodeState) ? scope.wholeNodeState : 'unknown';
    const enrolled = scope.scope.state === 'active' && ['draining', 'enrolled'].includes(wholeNode);
    return { ardentScope: scope.scope.state, wholeNode, admissionClosed: admission.closed, ready: enrolled && !admission.closed };
  };
  const requireReady = async () => {
    const ready = await readiness();
    requireValue(ready.ardentScope === 'active' && ['draining', 'enrolled'].includes(ready.wholeNode), 'ARDENT_SETUP_NODE_NOT_ENROLLED');
    requireValue(!ready.admissionClosed, 'ARDENT_SETUP_ADMISSION_CLOSED');
  };
  // A command that just finished (such as this setup's own package install) releases its owner
  // shortly after it answers. Wait a bounded time for reserved or running owners to settle; an
  // unknown owner is held work and is returned at once, as is any owner still there afterwards.
  const settled = async () => {
    let current = await installation();
    for (const deadline = Date.now() + settleMs; current.reachable && current.commandOwners.length > 0
      && current.commandOwners.every(owner => owner.state === 'reserved' || owner.state === 'running') && Date.now() < deadline;) {
      await sleep(pollMs);
      current = await installation();
    }
    return current;
  };
  try {
    let result;
    if (request.mode === 'plan') {
      const payload = ardentSetupDeployPayload(request);
      result = { ...common, requestSHA256: payloadDigest(payload), model: payload.model };
    } else if (request.mode === 'inspect') {
      const current = await installation();
      // Status still answers from a Magnus whose enrollment records cannot be read: null.
      let enrollment = null;
      try { enrollment = await readiness(); } catch { /* reported as null; setup refuses it before any POST */ }
      result = { ...common, ...current, enrollment };
    }
    else if (request.mode === 'create' || request.mode === 'package-install') {
      const current = await settled();
      requireValue(current.reachable && current.commandOwners.length === 0, 'ARDENT_SETUP_NODE_NOT_READY');
      if (request.mode === 'create') {
        requireValue(current.installed && !current.profiles.some(profile => profile.id === request.profile), 'ARDENT_SETUP_PROFILE_CONFLICT');
        await requireReady();
        const payload = ardentSetupDeployPayload(request); const data = await call('/agents', 'POST', payload);
        requireValue(object(data) && typeof data.operationId === 'string' && UUID.test(data.operationId));
        result = { ...common, operationId: data.operationId, requestSHA256: payloadDigest(payload) };
      } else {
        requireValue(current.stagedPackage !== null && !current.stagedPackageError, 'ARDENT_SETUP_PACKAGE_UNAVAILABLE');
        await requireReady();
        let data;
        try { data = await call(actionPath, 'POST', { action: 'package-install' }); }
        catch (error) {
          // Magnus answered with a refusal. When the node then holds no command and has no package,
          // nothing is running and nothing was installed: the install may simply be tried again (it
          // installs the same verified package). Anything else stays ambiguous.
          if (!(error instanceof ArdentSetupError) || error.code !== 'ARDENT_SETUP_API_REFUSED' || error.httpStatus === undefined
            || error.apiCode === 'ARDENT_OUTCOME_UNKNOWN') throw error;
          let after;
          try { after = await settled(); } catch { throw error; }
          if (!after.reachable || after.commandOwners.length > 0 || after.installed) throw error;
          throw new ArdentSetupError('ARDENT_SETUP_PACKAGE_REFUSED', { httpStatus: error.httpStatus,
            ...(error.apiCode ? { apiCode: error.apiCode } : {}), settled: true });
        }
        requireValue(object(data) && data.installed === true && typeof data.changed === 'boolean');
        requireValue(version(data.version) === current.stagedPackage.version);
        result = { ...common, installed: true, version: data.version, changed: data.changed };
      }
    } else if (request.mode === 'operation' || request.mode === 'resume') {
      const path = '/agents/operations/' + request.operationId;
      const operation = operationView(await call(path), request);
      if (request.mode === 'operation') result = { ...common, ...operation };
      else {
        requireValue(operation.kind === 'deploy' && ['failed', 'running'].includes(operation.status), 'ARDENT_SETUP_OPERATION_NOT_RESUMABLE');
        const data = await call(path + '/resume', 'POST');
        requireValue(object(data) && data.operationId === request.operationId);
        result = { ...common, operationId: data.operationId };
      }
    } else {
      const prefix = '/installations/' + encodeURIComponent(request.nodeId) + '/profiles/' + encodeURIComponent(request.profile);
      const status = await call(prefix + '/status'); const memory = await call(prefix + '/memory/status');
      requireValue(object(status) && status.profile === request.profile && status.backend === 'llamacpp'
        && object(memory) && ['ready', 'degraded'].includes(memory.status));
      const runtime = { version: version(status.version), backend: status.backend };
      const tested = await call(actionPath, 'POST', { action: 'provider-test' }, true);
      requireValue(tested === null || object(tested) && tested.backend === 'llamacpp' && typeof tested.answer === 'string' && tested.answer.length <= 16384);
      const provider = { supported: tested !== null, ready: tested !== null, answered: tested !== null && tested.answer.trim().length > 0,
        expectedReady: tested !== null && /^READY\.?$/.test(tested.answer.trim()) };
      result = { ...common, ready: memory.status === 'ready' && provider.ready && provider.answered,
        runtime, hivemem: { ready: memory.status === 'ready' }, provider };
    }
    requireValue(!JSON.stringify(result).includes(apiSecret));
    return result;
  } catch (error) {
    if (error instanceof ArdentSetupError) {
      if (postAttempted && !error.settled) error.ambiguous = true;
      throw error;
    }
    throw new ArdentSetupError('ARDENT_SETUP_FAILED', { ambiguous: postAttempted });
  }
}

export async function ardentSetupMain(env = process.env) {
  try {
    requireValue(typeof env.HIVE_ARDENT_SETUP === 'string' && Buffer.byteLength(env.HIVE_ARDENT_SETUP) <= 16 * 1024,
      'ARDENT_SETUP_REQUEST_INVALID');
    requireValue(env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', 'ARDENT_SETUP_TLS_UNAVAILABLE');
    let input;
    try { input = JSON.parse(env.HIVE_ARDENT_SETUP); } catch { throw new ArdentSetupError('ARDENT_SETUP_REQUEST_INVALID'); }
    return await runArdentSetup(input, { apiSecret: env.API_SECRET, port: env.CONTROL_API_PORT ?? '4000' });
  } catch (error) {
    if (error instanceof ArdentSetupError) throw error;
    throw new ArdentSetupError('ARDENT_SETUP_FAILED');
  }
}
export async function ardentSetupCLI(env = process.env, write = value => console.log(value)) {
  try { write(JSON.stringify(await ardentSetupMain(env))); }
  catch (error) {
    const value = error instanceof ArdentSetupError ? error : new ArdentSetupError('ARDENT_SETUP_FAILED');
    write(JSON.stringify({ schema: 1, success: false, error: { code: value.code, ambiguous: value.ambiguous,
      ...(value.httpStatus === undefined ? {} : { httpStatus: value.httpStatus }), ...(value.apiCode ? { apiCode: value.apiCode } : {}) } }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await ardentSetupCLI();
