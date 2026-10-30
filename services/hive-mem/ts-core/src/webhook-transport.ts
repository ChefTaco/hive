import { readFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19));
  }
  return isIP(address) === 6 && /^[23]/i.test(address) && !address.toLowerCase().startsWith('2001:db8:');
}

export interface WebhookRequest { url: string; headers: Record<string, string>; payload: unknown; secret?: string }

export function allowedPrivateWebhookHost(hostname: string): boolean {
  return (process.env.HIVEMEM_WEBHOOK_ALLOWED_PRIVATE_HOSTS ?? '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean).includes(hostname.toLowerCase());
}

export class WebhookDeliveryError extends Error {
  constructor(readonly code: 'dns' | 'timeout' | 'http' | 'response_limit' | 'connection', readonly responseStatus: number | null = null) {
    super(responseStatus === null ? 'Webhook delivery failed: ' + code : 'Webhook receiver returned HTTP ' + responseStatus);
  }
}

export async function deliverWebhook(input: WebhookRequest): Promise<number> {
  const url = new URL(input.url);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Webhook requires HTTPS without URL credentials');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let timeout: NodeJS.Timeout | undefined;
  const addresses = await Promise.race([lookup(hostname, { all: true }).catch(() => { throw new WebhookDeliveryError('dns'); }), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new WebhookDeliveryError('timeout')), 5000); })]).finally(() => { if (timeout) clearTimeout(timeout); });
  if (!addresses.length || !allowedPrivateWebhookHost(hostname) && addresses.some((entry) => !publicAddress(entry.address))) throw new Error('Webhook destination is not permitted');
  const target = addresses[0]!;
  const payload = JSON.stringify(input.payload);
  if (Buffer.byteLength(payload) > 1024 * 1024) throw new Error('Webhook payload exceeds 1 MiB');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID();
  const headers: Record<string, string> = { ...input.headers, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), 'x-hivemem-timestamp': timestamp, 'x-hivemem-nonce': nonce };
  if (input.secret) headers['x-hivemem-signature'] = 'sha256=' + createHmac('sha256', input.secret).update(`${timestamp}.${nonce}.${payload}`).digest('hex');
  return new Promise<number>((resolve, reject) => {
    const req = request(url, {
      method: 'POST', headers, ...(process.env.HIVEMEM_WEBHOOK_CA_FILE ? { ca: readFileSync(process.env.HIVEMEM_WEBHOOK_CA_FILE) } : {}), signal: AbortSignal.timeout(10_000), rejectUnauthorized: true,
      // Pin the validated resolution for this connection; preserve TLS SNI.
      lookup: (_hostname, options, callback) => {
        if ((options as { all?: boolean }).all) (callback as unknown as (error: null, addresses: Array<{ address: string; family: number }>) => void)(null, [target]);
        else callback(null, target.address, target.family);
      },
    }, (response) => {
      let size = 0;
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 64 * 1024) response.destroy(new WebhookDeliveryError('response_limit', response.statusCode ?? null)); });
      response.on('error', reject);
      response.on('end', () => {
        const status = response.statusCode ?? 502;
        if (status < 200 || status >= 300) reject(new WebhookDeliveryError('http', status));
        else resolve(status);
      });
    });
    req.on('error', (error) => reject(error instanceof WebhookDeliveryError ? error : new WebhookDeliveryError(error.name === 'AbortError' ? 'timeout' : 'connection')));
    req.end(payload);
  });
}
