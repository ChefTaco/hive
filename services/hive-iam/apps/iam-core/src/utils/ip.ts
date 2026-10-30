import type { Context } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import { checkIpAllowlist } from './ip-allowlist.js'

function remoteAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote?.address;
  } catch {
    return undefined;
  }
}

export function resolveClientIp(
  headers: { forwarded?: string; realIp?: string },
  remote: string | undefined,
  trustedProxies: readonly string[],
): string {
  if (remote && trustedProxies.length > 0 && checkIpAllowlist([...trustedProxies], remote)) {
    const first = headers.forwarded?.split(',')[0]?.trim()
    if (first) return first
    if (headers.realIp) return headers.realIp
  }
  return remote ?? 'unknown'
}

/**
 * Extracts the real client IP from a Hono request context,
 * honouring common proxy headers and falling back to the
 * connection's remote address.
 */
export function getClientIp(c: Context): string {
  const remote = remoteAddress(c)
  const trustedProxies = (process.env['TRUSTED_PROXY_IPS'] ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)
  return resolveClientIp({ forwarded: c.req.header('x-forwarded-for'), realIp: c.req.header('x-real-ip') }, remote, trustedProxies)
}
