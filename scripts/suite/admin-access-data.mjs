// Pure policy planning. Native account provisioning and protected publication belong to the host.
import { pathToFileURL } from 'node:url';
const COMPONENTS = new Set(['hive-registry', 'oathweave', 'oathweave-redis', 'hivexui', 'ingress',
  'emberpath', 'hivemem', 'hivemem-qdrant', 'hiveskills', 'magnus', 'magnus-gateway',
  'magnus-postgres', 'magnus-redis', 'cindertrace', 'cindertrace-postgres', 'cindertrace-redis',
  'chattermost', 'chattermost-postgres', 'emberfold', 'ardentstudio', 'embermend', 'embermend-worker', 'embermend-postgres']);
const LINK_KEYS = {
  magnus: ['MAGNUS_OATHWEAVE_IDENTITIES_JSON', 'localUserId'],
  'magnus-gateway': ['MAGNUS_OATHWEAVE_IDENTITIES_JSON', 'localUserId'],
  emberpath: ['EMBERPATH_OATHWEAVE_IDENTITIES_JSON', 'localId'],
  hivemem: ['HIVEMEM_OATHWEAVE_IDENTITIES_JSON', 'localId'],
  hiveskills: ['HIVESKILLS_OATHWEAVE_IDENTITIES_JSON', 'localId'],
  cindertrace: ['CINDERTRACE_OATHWEAVE_IDENTITIES_JSON', 'localUserId'],
  chattermost: ['OATHWEAVE_CHAT_IDENTITIES_JSON', 'localUserId'],
  ardentstudio: ['ARDENT_STUDIO_OATHWEAVE_IDENTITIES_JSON', 'localUserId'],
};
const ID_PRODUCTS = new Set(['magnus', 'emberpath', 'hivemem', 'hiveskills', 'cindertrace', 'chattermost', 'ardentstudio']);
export const EMBERMEND_ADMIN_PERMISSIONS = Object.freeze([
  'read', 'evidence', 'assess', 'prepare', 'propose', 'publish-explanation', 'ingest', 'policy',
]);
const TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const USERNAME = /^[A-Za-z0-9_.-]{1,64}$/;
const EMBERPATH_USERNAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const LOCAL_ID = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function need(condition, code = 'ADMIN_ACCESS_INPUT_INVALID') {
  if (!condition) throw new AdminAccessDataError(code);
}
export class AdminAccessDataError extends Error {
  constructor(code) { super(code); this.name = 'AdminAccessDataError'; this.code = code; }
}
function exact(value, keys) { return object(value) && Object.keys(value).every(key => keys.includes(key)); }
function text(value, max = 256) { return typeof value === 'string' && value.length > 0 && value.length <= max && TEXT.test(value); }
function issuer(value) {
  if (!text(value, 512) || /\s|[?#\\]/u.test(value)) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }
  catch { return false; }
}
function localId(value) { return typeof value === 'string' && LOCAL_ID.test(value)
  && value !== 'system' && !value.startsWith('service:'); }
function stable(value) {
  return Array.isArray(value) ? value.map(stable) : object(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
}
const same = (left, right) => JSON.stringify(stable(left)) === JSON.stringify(stable(right));

export function validateIdentity(value) {
  need(exact(value, ['issuer', 'subject', 'username', 'email', 'displayName'])
    && issuer(value.issuer) && text(value.subject) && value.subject.trim() === value.subject
    && typeof value.username === 'string' && USERNAME.test(value.username)
    && text(value.email, 254) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.email)
    && text(value.displayName, 120) && value.displayName.trim() === value.displayName);
  return { issuer: value.issuer, subject: value.subject, username: value.username,
    email: value.email, displayName: value.displayName };
}

// JSON.parse alone silently accepts repeated keys. Reject them at every depth before planning.
function json(raw) {
  need(typeof raw === 'string' && Buffer.byteLength(raw) <= 1024 * 1024, 'ADMIN_ACCESS_POLICY_INVALID');
  let result;
  try { result = JSON.parse(raw); } catch { throw new AdminAccessDataError('ADMIN_ACCESS_POLICY_INVALID'); }
  let at = 0;
  const space = () => { while (/\s/u.test(raw[at] ?? '') && at < raw.length) at++; };
  function string() {
    const start = at++;
    while (at < raw.length) {
      if (raw[at] === '\\') { at += 2; continue; }
      if (raw[at++] === '"') return JSON.parse(raw.slice(start, at));
    }
    throw new AdminAccessDataError('ADMIN_ACCESS_POLICY_INVALID');
  }
  function value(depth) {
    need(depth <= 32, 'ADMIN_ACCESS_POLICY_INVALID'); space();
    if (raw[at] === '"') { string(); return; }
    if (raw[at] === '{') {
      at++; space(); const keys = new Set();
      if (raw[at] === '}') { at++; return; }
      for (;;) {
        space(); const key = string();
        need(!keys.has(key) && !['__proto__', 'constructor', 'prototype'].includes(key), 'ADMIN_ACCESS_POLICY_DUPLICATE');
        keys.add(key); space(); at++; value(depth + 1); space();
        if (raw[at++] === '}') return;
      }
    }
    if (raw[at] === '[') {
      at++; space(); if (raw[at] === ']') { at++; return; }
      for (;;) { value(depth + 1); space(); if (raw[at++] === ']') return; }
    }
    while (at < raw.length && !/[\s,\]}]/u.test(raw[at])) at++;
  }
  value(0); space(); need(at === raw.length, 'ADMIN_ACCESS_POLICY_INVALID');
  return result;
}
function array(raw) { const result = json(raw); need(Array.isArray(result) && result.length <= 10000, 'ADMIN_ACCESS_POLICY_INVALID'); return result; }
function append(raw, entry) {
  const rows = array(raw); const end = raw.lastIndexOf(']');
  need(rows.length < 10000, 'ADMIN_ACCESS_POLICY_INVALID');
  return raw.slice(0, end) + (rows.length ? ',' : '') + JSON.stringify(entry) + raw.slice(end);
}
function links(raw, product) {
  const rows = array(raw), identities = new Set(), ids = new Set();
  const localKey = LINK_KEYS[product][1];
  const allowed = product === 'hivemem' ? ['issuer', 'subject', 'localId', 'credentialGeneration']
    : product === 'ardentstudio' ? ['issuer', 'subject', 'localUserId', 'displayName', 'permissions']
    : ['magnus', 'magnus-gateway', 'cindertrace'].includes(product) ? ['issuer', 'subject', 'localUserId', 'role']
    : ['issuer', 'subject', localKey];
  for (const row of rows) {
    need(exact(row, allowed) && issuer(row.issuer) && text(row.subject) && localId(row[localKey]), 'ADMIN_ACCESS_POLICY_INVALID');
    if (['magnus', 'magnus-gateway', 'cindertrace'].includes(product)) need(
      ['ADMIN', 'OPERATOR', 'VIEWER', ...(product !== 'cindertrace' ? ['ARDENT_SERVICE'] : [])].includes(row.role), 'ADMIN_ACCESS_POLICY_INVALID');
    if (row.credentialGeneration !== undefined) need(Number.isSafeInteger(row.credentialGeneration) && row.credentialGeneration >= 0, 'ADMIN_ACCESS_POLICY_INVALID');
    if (row.displayName !== undefined) need(text(row.displayName, 120), 'ADMIN_ACCESS_POLICY_INVALID');
    if (row.permissions !== undefined) need(Array.isArray(row.permissions) && row.permissions.every(p => text(p, 128))
      && new Set(row.permissions).size === row.permissions.length, 'ADMIN_ACCESS_POLICY_INVALID');
    const key = JSON.stringify([row.issuer, row.subject]);
    need(!identities.has(key), 'ADMIN_ACCESS_IDENTITY_DUPLICATE'); identities.add(key);
    need(!ids.has(row[localKey]), 'ADMIN_ACCESS_LOCAL_ID_REUSED'); ids.add(row[localKey]);
  }
  return rows;
}
function names(raw) {
  need(typeof raw === 'string' && raw.length <= 65536, 'ADMIN_ACCESS_POLICY_INVALID');
  const values = raw ? raw.split(',').map(value => value.trim()) : [];
  need(values.every(value => text(value, 128) && !/\s/u.test(value))
    && new Set(values).size === values.length, 'ADMIN_ACCESS_POLICY_INVALID');
  return values;
}
function grants(raw) {
  const rows = array(raw), seen = new Set();
  for (const row of rows) {
    need(exact(row, ['subject', 'kind', 'permissions', 'scope']) && text(row.subject)
      && ['operator', 'coordinator', 'integration'].includes(row.kind) && Array.isArray(row.permissions)
      && row.permissions.every(value => text(value, 128)) && new Set(row.permissions).size === row.permissions.length
      && exact(row.scope, ['installationId', 'applicationIds', 'targetIds']) && text(row.scope.installationId, 128)
      && ['applicationIds', 'targetIds'].every(key => Array.isArray(row.scope[key]) && row.scope[key].length <= 1000
        && row.scope[key].every(value => text(value, 128)) && new Set(row.scope[key]).size === row.scope[key].length), 'ADMIN_ACCESS_POLICY_INVALID');
    need(!seen.has(row.subject), 'ADMIN_ACCESS_IDENTITY_DUPLICATE'); seen.add(row.subject);
  }
  return rows;
}

/** Native receipts are normalized by the privileged owner after verifying product-owned evidence.
 * This pure function cannot establish ownership itself and never provisions an account or token. */
export function planAdminAccess(request, { preview = false } = {}) {
  need(exact(request, ['identity', 'installation', 'localIds', 'environments', 'components', 'nativeReceipts']));
  const identity = validateIdentity(request.identity);
  need(typeof request.installation === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(request.installation));
  need(Array.isArray(request.components) && request.components.length > 0 && request.components.length <= COMPONENTS.size
    && request.components.every(name => COMPONENTS.has(name)) && new Set(request.components).size === request.components.length);
  need(object(request.environments) && object(request.localIds)
    && Object.keys(request.environments).every(key => COMPONENTS.has(key))
    && Object.keys(request.localIds).every(key => ID_PRODUCTS.has(key)));
  const selected = new Set(request.components), environments = {};
  for (const [component, env] of Object.entries(request.environments)) {
    need(object(env) && Object.entries(env).every(([key, value]) => /^[A-Z][A-Z0-9_]*$/.test(key)
      && typeof value === 'string' && Buffer.byteLength(value) <= 1024 * 1024));
    environments[component] = { ...env };
  }
  const requiredProducts = new Set(request.components.filter(name => ID_PRODUCTS.has(name)));
  if (selected.has('magnus-gateway')) requiredProducts.add('magnus');
  for (const product of requiredProducts) {
    const id = request.localIds[product]; need(localId(id) && id !== identity.subject, 'ADMIN_ACCESS_LOCAL_ID_INVALID');
    if (product === 'hivemem') need(/^[a-z0-9_-]{2,32}$/.test(id), 'ADMIN_ACCESS_LOCAL_ID_INVALID');
    if (product === 'emberpath') need(/^[A-Za-z0-9_-]{16,128}$/.test(id), 'ADMIN_ACCESS_LOCAL_ID_INVALID');
  }
  const suppliedIds = Object.values(request.localIds);
  need(suppliedIds.every(localId) && new Set(suppliedIds).size === suppliedIds.length, 'ADMIN_ACCESS_LOCAL_ID_REUSED');
  const receipts = request.nativeReceipts ?? {};
  need(exact(receipts, ['hivemem', 'chattermost']));
  for (const product of ['hivemem', 'chattermost']) {
    if (!selected.has(product) || preview) continue;
    const receipt = receipts[product];
    need(exact(receipt, ['issuer', 'subject', 'localId', 'owned', ...(product === 'hivemem' ? ['active', 'credentialGeneration'] : [])])
      && receipt.issuer === identity.issuer && receipt.subject === identity.subject
      && receipt.localId === request.localIds[product] && receipt.owned === true
      && (product !== 'hivemem' || receipt.active === true && receipt.credentialGeneration === 0), 'ADMIN_ACCESS_NATIVE_RECEIPT_REQUIRED');
  }
  const changes = [], parsed = new Map();
  const set = (component, key, after) => {
    const before = environments[component][key];
    if (after !== before) { environments[component][key] = after; changes.push({ component, key, before, after }); }
  };
  for (const component of request.components) {
    if (!LINK_KEYS[component] && !['embermend', 'embermend-worker'].includes(component)) continue;
    const env = environments[component];
    need(env && env.OATHWEAVE_ISSUER === identity.issuer, 'ADMIN_ACCESS_ISSUER_MISMATCH');
    if (LINK_KEYS[component]) {
      const [key, localKey] = LINK_KEYS[component];
      const rows = links(env[key], component); parsed.set(component, rows);
      for (const row of rows) if (suppliedIds.includes(row[localKey])) need(
        row.issuer === identity.issuer && row.subject === identity.subject
        && row[localKey] === request.localIds[component === 'magnus-gateway' ? 'magnus' : component], 'ADMIN_ACCESS_LOCAL_ID_REUSED');
    } else parsed.set(component, grants(env.EMBERMEND_IDENTITY_GRANTS));
  }
  for (const [left, right] of [['magnus', 'magnus-gateway'], ['embermend', 'embermend-worker']]) {
    if (selected.has(right)) need(selected.has(left), 'ADMIN_ACCESS_PAIRED_COMPONENT_REQUIRED');
    if (selected.has(left) && selected.has(right)) need(same(parsed.get(left), parsed.get(right)), 'ADMIN_ACCESS_PAIRED_POLICY_MISMATCH');
  }
  for (const [component, rows] of parsed) {
    if (LINK_KEYS[component]) {
      const [key, localKey] = LINK_KEYS[component], product = component === 'magnus-gateway' ? 'magnus' : component;
      const entry = { issuer: identity.issuer, subject: identity.subject, [localKey]: request.localIds[product] };
      if (['magnus', 'magnus-gateway', 'cindertrace'].includes(component)) entry.role = 'ADMIN';
      if (component === 'hivemem') entry.credentialGeneration = 0;
      // Like the initializer, Studio has no link ceiling; its token still grants only requested permissions.
      if (component === 'ardentstudio') entry.displayName = identity.displayName;
      const existing = rows.find(row => row.issuer === identity.issuer && row.subject === identity.subject);
      need(!existing || same(existing, entry), 'ADMIN_ACCESS_EXISTING_POLICY_CONFLICT');
      if (!existing) set(component, key, append(environments[component][key], entry));
      if (component === 'hiveskills') {
        const raw = environments[component].HIVE_SKILLS_ADMIN_USERS;
        if (!names(raw).includes(entry.localId)) set(component, 'HIVE_SKILLS_ADMIN_USERS', raw + (raw ? ',' : '') + entry.localId);
      }
      if (component === 'emberpath') {
        const env = environments[component], raw = env.HIVE_ROUTER_ADMIN_USERS;
        const nativeName = EMBERPATH_USERNAME.test(identity.username) ? identity.username : 'hive_admin_' + entry.localId;
        if (!names(raw).includes(nativeName)) set(component, 'HIVE_ROUTER_ADMIN_USERS', raw + (raw ? ',' : '') + nativeName);
        const initial = array(env.EMBERPATH_INITIAL_ADMIN_IDENTITIES_JSON), usernames = new Set(), ids = new Set();
        need(initial.length <= 100, 'ADMIN_ACCESS_POLICY_INVALID');
        const allowed = names(environments[component].HIVE_ROUTER_ADMIN_USERS);
        for (const row of initial) {
          need(exact(row, ['username', 'localId']) && typeof row.username === 'string' && EMBERPATH_USERNAME.test(row.username)
            && typeof row.localId === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(row.localId), 'ADMIN_ACCESS_POLICY_INVALID');
          need(!usernames.has(row.username) && !ids.has(row.localId), 'ADMIN_ACCESS_IDENTITY_DUPLICATE');
          need(allowed.includes(row.username), 'ADMIN_ACCESS_POLICY_INVALID');
          usernames.add(row.username); ids.add(row.localId);
          need(row.username !== nativeName || row.localId === entry.localId, 'ADMIN_ACCESS_EXISTING_POLICY_CONFLICT');
          need(row.localId !== entry.localId || row.username === nativeName, 'ADMIN_ACCESS_LOCAL_ID_REUSED');
        }
        if (!usernames.has(nativeName)) {
          need(initial.length < 100, 'ADMIN_ACCESS_POLICY_INVALID');
          set(component, 'EMBERPATH_INITIAL_ADMIN_IDENTITIES_JSON', append(env.EMBERPATH_INITIAL_ADMIN_IDENTITIES_JSON, { username: nativeName, localId: entry.localId }));
        }
      }
    } else {
      const entry = { subject: identity.subject, kind: 'operator', permissions: [...EMBERMEND_ADMIN_PERMISSIONS],
        scope: { installationId: request.installation, applicationIds: [], targetIds: [] } };
      const existing = rows.find(row => row.subject === identity.subject);
      need(!existing || same(existing, entry), 'ADMIN_ACCESS_EXISTING_POLICY_CONFLICT');
      if (!existing) set(component, 'EMBERMEND_IDENTITY_GRANTS', append(environments[component].EMBERMEND_IDENTITY_GRANTS, entry));
    }
  }
  return { environments, changes, nativeProvisioningVerified: !preview };
}

/** Explicit stdin transport for the pinned Node runtime; normal module imports perform no I/O. */
export async function adminAccessDataCLI(input = process.stdin, output = process.stdout, options = {}) {
  try {
    input.setEncoding?.('utf8');
    let raw = '';
    for await (const chunk of input) {
      raw += chunk.toString('utf8');
      need(Buffer.byteLength(raw) <= 1024 * 1024, 'ADMIN_ACCESS_INPUT_INVALID');
    }
    output.write(JSON.stringify(planAdminAccess(json(raw), options)) + '\n');
    return 0;
  } catch (error) {
    const code = error instanceof AdminAccessDataError ? error.code : 'ADMIN_ACCESS_INPUT_INVALID';
    output.write(JSON.stringify({ error: { code } }) + '\n');
    return 1;
  }
}
if (process.argv[1] === '--stdin' || (process.argv[2] === '--stdin' && process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href)) process.exitCode = await adminAccessDataCLI();
