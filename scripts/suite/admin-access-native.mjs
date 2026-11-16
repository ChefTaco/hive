// Runs in the owning product container. Purpose credentials never leave its environment.
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { createHash } from 'node:crypto';
export function nativeAdminRequest(input, environment = process.env, readCA = readFileSync) {
  if (!['hivemem', 'chattermost'].includes(input.component)
    || !['GET', 'POST'].includes(input.method)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.operationId)
    || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(input.serverName)
    || !/^[a-f0-9]{64}$/.test(environment.HIVE_ADMIN_PROVISIONING_SECRET || '')) throw new Error('ADMIN_ACCESS_NATIVE_REQUEST_INVALID');
  const port = Number(input.component === 'hivemem' ? environment.HIVEMEM_TS_CORE_PORT : environment.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ADMIN_ACCESS_NATIVE_PORT_INVALID');
  return { hostname: '127.0.0.1', servername: input.serverName, port,
    path: '/internal/hive/admin-accounts/' + input.operationId, method: input.method,
    ca: readCA(environment.NODE_EXTRA_CA_CERTS || '/config/authority.pem'), rejectUnauthorized: true, agent: false,
    headers: { 'content-type': 'application/json', 'x-hive-admin-provisioning-secret': environment.HIVE_ADMIN_PROVISIONING_SECRET } };
}
export function validateNativeAdminReceipt(input, receipt) {
  const memory = input.component === 'hivemem', body = input.body;
  const expected = memory ? { version: 1, issuer: body.issuer, subject: body.subject, local_id: body.local_id,
    username: body.username, display_name: body.display_name ?? body.username, operation_id: input.operationId }
    : { domain: 'chattermost.hive-admin-account.v1', version: 1, issuer: body.issuer, subject: body.subject,
      user_id: body.user_id, username: body.username, email: body.email.toLowerCase(), role: 'system_admin system_user' };
  const digest = createHash('sha256').update(JSON.stringify(expected)).digest('hex');
  const timestampValid = memory ? typeof receipt.created_at === 'string' && Number.isFinite(Date.parse(receipt.created_at))
    : Number.isSafeInteger(receipt.created_at) && receipt.created_at >= 0;
  const id = memory ? receipt.local_id : receipt.user_id;
  if (receipt.schema !== 1 || receipt.status !== 'committed' || receipt.operation_id !== input.operationId
    || receipt.issuer !== body.issuer || receipt.subject !== body.subject || id !== (memory ? body.local_id : body.user_id)
    || receipt.request_sha256 !== digest || !timestampValid || receipt.username !== body.username
    || (memory ? receipt.credential_generation !== 0 || receipt.active !== true || receipt.display_name !== expected.display_name
      : receipt.role !== expected.role || receipt.email !== expected.email)) throw new Error('ADMIN_ACCESS_NATIVE_RECEIPT_INVALID');
  return { issuer: receipt.issuer, subject: receipt.subject, localId: id, owned: true,
    ...(memory ? { active: true, credentialGeneration: 0 } : {}) };
}
export async function callNativeAdmin(input) {
  const options = nativeAdminRequest(input);
  return new Promise((resolve, reject) => {
    const request = httpsRequest(options, response => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { raw += chunk; if (raw.length > 32768) response.destroy(new Error('ADMIN_ACCESS_NATIVE_RESPONSE_TOO_LARGE')); });
      response.on('error', () => reject(new Error('ADMIN_ACCESS_NATIVE_RESPONSE_UNCERTAIN')));
      response.on('end', () => {
        if (response.statusCode === 404 && input.method === 'GET') { resolve({ missing: true }); return; }
        if (![200, 201].includes(response.statusCode)) { reject(new Error('ADMIN_ACCESS_NATIVE_HTTP_' + response.statusCode)); return; }
        try {
          const receipt = JSON.parse(raw);
          resolve({ receipt, normalized: validateNativeAdminReceipt(input, receipt) });
        } catch { reject(new Error('ADMIN_ACCESS_NATIVE_RECEIPT_INVALID')); }
      });
    });
    request.setTimeout(15000, () => request.destroy(new Error('ADMIN_ACCESS_NATIVE_TIMEOUT')));
    request.on('error', () => reject(new Error('ADMIN_ACCESS_NATIVE_OUTCOME_UNCERTAIN')));
    request.end(input.method === 'POST' ? JSON.stringify(input.body) : undefined);
  });
}
if (process.argv[1] === '--stdin') {
  try { const raw = readFileSync(0, 'utf8'); if (raw.length > 16384) throw new Error('ADMIN_ACCESS_NATIVE_REQUEST_INVALID'); console.log(JSON.stringify(await callNativeAdmin(JSON.parse(raw)))); }
  catch (error) { console.error(/^ADMIN_ACCESS_[A-Z_0-9]+$/.test(error.message) ? error.message : 'ADMIN_ACCESS_NATIVE_REFUSED'); process.exitCode = 1; }
}
