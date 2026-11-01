import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Read-only preflight: never imports config/app/db, seeds, or creates state. */
export function checkConfiguration(env: NodeJS.ProcessEnv): number {
  let failures = 0;
  const check = (ok: boolean, message: string) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${message}`); if (!ok) failures++; };
  const port = Number(env.HIVE_SKILLS_PORT ?? '4030');
  check(Number.isInteger(port) && port > 0 && port <= 65535, 'HIVE_SKILLS_PORT is valid');
  check((env.HIVE_SKILLS_SESSION_SECRET?.trim().length ?? 0) >= 32, 'HIVE_SKILLS_SESSION_SECRET has at least 32 characters');
  let hostname: string | undefined;
  try {
    const url = new URL(env.HIVE_SKILLS_PUBLIC_URL ?? `https://localhost:${port}`);
    hostname = url.hostname.replace(/^\[|\]$/g, '');
    check(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, 'HIVE_SKILLS_PUBLIC_URL is an HTTPS URL without credentials');
  } catch { check(false, 'HIVE_SKILLS_PUBLIC_URL must be a valid HTTPS URL'); }
  try {
    const cert = new X509Certificate(readFileSync(env.HIVE_SKILLS_TLS_CERT_FILE ?? ''));
    const key = createPrivateKey(readFileSync(env.HIVE_SKILLS_TLS_KEY_FILE ?? ''));
    check(cert.checkPrivateKey(key), 'TLS certificate and key match');
    check(Date.parse(cert.validTo) > Date.now() && Date.parse(cert.validFrom) <= Date.now(), 'TLS certificate is currently valid');
    if (hostname) check(Boolean(isIP(hostname) ? cert.checkIP(hostname) : cert.checkHost(hostname)), 'TLS certificate covers the public URL hostname');
  } catch { check(false, 'HIVE_SKILLS_TLS_CERT_FILE and HIVE_SKILLS_TLS_KEY_FILE must be readable valid PEM files'); }
  const data = resolve(env.HIVE_SKILLS_DATA_DIR ?? './data');
  try {
    let ancestor = data;
    while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
    accessSync(ancestor, constants.W_OK | constants.X_OK);
    check(statSync(ancestor).isDirectory(), 'Skills data directory exists and is writable, or can be created');
  } catch { check(false, 'Skills data directory must be writable'); }
  const database = resolve(data, 'registry.sqlite');
  if (existsSync(database)) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(database, { readOnly: true });
      check(db.prepare('PRAGMA quick_check').get()?.quick_check === 'ok', 'SQLite integrity');
      check(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'SQLite foreign keys');
      db.prepare('SELECT slug FROM skills LIMIT 1').get();
    } catch { check(false, 'Existing database must be a readable Skills registry'); }
    finally { db?.close(); }
  } else console.log('  info  Registry database will be created on first start; catalog starts empty');
  if (!env.HIVE_SKILLS_ADMIN_USERS?.trim()) console.log('  !     HIVE_SKILLS_ADMIN_USERS is empty; OS administration is disabled');
  console.log(failures ? `Result: ${failures} problem(s)` : 'Result: ready to start');
  return failures ? 1 : 0;
}
