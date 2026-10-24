export interface VerifyHiveMemWebhookOptions {
  secret: string;
  body: string | Uint8Array;
  signature: string;
  timestamp: string;
  nonce: string;
  toleranceSeconds?: number;
  seenNonces?: Set<string>;
}

const encoder = new TextEncoder();

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? encoder.encode(value) : value;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function hex(input: ArrayBuffer): string {
  return Array.from(new Uint8Array(input), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256(secret: string, data: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, data as Uint8Array<ArrayBuffer>));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signHiveMemWebhookBody(secret: string, body: string | Uint8Array, timestamp: string, nonce: string): Promise<string> {
  const signed = concatBytes([bytes(timestamp), bytes("."), bytes(nonce), bytes("."), bytes(body)]);
  return `sha256=${await hmacSha256(secret, signed)}`;
}

export async function verifyHiveMemWebhook(options: VerifyHiveMemWebhookOptions): Promise<boolean> {
  const toleranceSeconds = options.toleranceSeconds ?? 300;
  if (!/^\d+$/.test(options.timestamp) || !Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) return false;
  const ts = Number(options.timestamp);
  if (!Number.isSafeInteger(ts)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > toleranceSeconds) return false;
  if (!options.nonce) return false;
  if (options.seenNonces?.has(options.nonce)) return false;
  const expected = await signHiveMemWebhookBody(options.secret, options.body, options.timestamp, options.nonce);
  if (!constantTimeEqual(options.signature, expected)) return false;
  // Signing yields to WebCrypto. Recheck after it resolves so concurrent calls
  // sharing this set cannot both accept the same valid nonce.
  if (options.seenNonces?.has(options.nonce)) return false;
  options.seenNonces?.add(options.nonce);
  return true;
}
