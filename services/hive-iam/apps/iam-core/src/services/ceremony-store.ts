import { createHash } from 'node:crypto';

interface CeremonyRedis { set(key: string, value: string, expiry: 'EX', seconds: number): Promise<unknown>; getdel(key: string): Promise<string | null> }

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('WebAuthn challenge store unavailable')), 5000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
export class CeremonyStore {
  constructor(private readonly redis: CeremonyRedis, private readonly prefix: string) {}
  private key(user: string, purpose: string, binding: string, challenge: string): string {
    return this.prefix + ':webauthn:' + createHash('sha256').update(JSON.stringify([user, purpose, binding, challenge])).digest('hex');
  }
  async save(user: string, purpose: string, binding: string, challenge: string): Promise<void> {
    await bounded(this.redis.set(this.key(user, purpose, binding, challenge), challenge, 'EX', 300));
  }
  async consume(user: string, purpose: string, binding: string, response: unknown): Promise<string> {
    const credential = response as { response?: { clientDataJSON?: unknown } };
    const encoded = credential?.response?.clientDataJSON;
    if (typeof encoded !== 'string' || encoded.length > 16_384) throw new Error('Invalid ceremony client data');
    const client = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as { challenge?: unknown };
    if (typeof client.challenge !== 'string' || client.challenge.length > 1024) throw new Error('Invalid ceremony challenge');
    const stored = await bounded(this.redis.getdel(this.key(user, purpose, binding, client.challenge)));
    if (!stored) throw new Error('Ceremony expired, consumed, or bound to another session');
    return stored;
  }
}
