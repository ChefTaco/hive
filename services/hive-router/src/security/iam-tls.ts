import { readFileSync } from 'node:fs';
import type { ConnectionOptions } from 'node:tls';
import type { Env } from '../config/env.js';

type IamTlsEnv = Pick<
  Env,
  'NODE_ENV' | 'HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS' | 'HIVE_ROUTER_IAM_CA_CERT_PATH'
>;

type HiveMemTlsEnv = Pick<
  Env,
  'NODE_ENV' | 'HIVE_STATUS_ALLOW_INSECURE_TLS' | 'HIVEMEM_CA_CERT_PATH'
>;

const caCache = new Map<string, Buffer>();

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]'
    || hostname === 'localhost';
}

function readPinnedCa(path: string): Buffer {
  const cached = caCache.get(path);
  if (cached) return cached;
  const ca = readFileSync(path);
  caCache.set(path, ca);
  return ca;
}

export function iamTlsOptions(url: URL, env: IamTlsEnv): ConnectionOptions {
  if (url.protocol !== 'https:') return {};
  if (env.HIVE_ROUTER_IAM_CA_CERT_PATH) {
    return {
      rejectUnauthorized: true,
      ca: readPinnedCa(env.HIVE_ROUTER_IAM_CA_CERT_PATH),
    };
  }
  if (env.HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS) {
    if (env.NODE_ENV === 'production' || !isLoopbackHostname(url.hostname)) {
      throw new Error(
        'HIVE_ROUTER_IAM_ALLOW_INSECURE_TLS is restricted to loopback development',
      );
    }
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true };
}

export function hiveMemTlsOptions(url: URL, env: HiveMemTlsEnv): ConnectionOptions {
  if (url.protocol !== 'https:') return {};
  if (env.HIVEMEM_CA_CERT_PATH) {
    return {
      rejectUnauthorized: true,
      ca: readPinnedCa(env.HIVEMEM_CA_CERT_PATH),
    };
  }
  if (env.HIVE_STATUS_ALLOW_INSECURE_TLS) {
    if (env.NODE_ENV === 'production' || !isLoopbackHostname(url.hostname)) {
      throw new Error('HIVE_STATUS_ALLOW_INSECURE_TLS is restricted to loopback development');
    }
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true };
}
