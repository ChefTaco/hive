import { expect, it } from 'vitest';
import { CeremonyStore } from './ceremony-store.js';

it('keeps concurrent ceremonies separate, binds purpose/session, and consumes once', async () => {
  const data = new Map<string, string>();
  const redis = { set: async (key: string, value: string) => { data.set(key, value); }, getdel: async (key: string) => { const value = data.get(key); data.delete(key); return value ?? null; } };
  const store = new CeremonyStore(redis, 'fixture');
  const response = (challenge: string) => ({ response: { clientDataJSON: Buffer.from(JSON.stringify({ challenge })).toString('base64url') } });
  await store.save('user', 'register', 'session', 'first');
  await store.save('user', 'register', 'session', 'second');
  await expect(store.consume('user', 'authenticate', 'session', response('first'))).rejects.toThrow();
  await expect(store.consume('user', 'register', 'other', response('first'))).rejects.toThrow();
  expect(await store.consume('user', 'register', 'session', response('first'))).toBe('first');
  expect(await new CeremonyStore(redis, 'fixture').consume('user', 'register', 'session', response('second'))).toBe('second');
  await expect(store.consume('user', 'register', 'session', response('first'))).rejects.toThrow();
});
