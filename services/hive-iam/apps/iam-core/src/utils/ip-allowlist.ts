import { isIPv4, isIPv6 } from 'node:net'

/**
 * Check whether a request IP matches an allowlist of IP patterns.
 *
 * Supports:
 * - Exact match: `192.168.1.100`
 * - CIDR notation: `10.0.0.0/8`, `192.168.1.0/24`
 * - Wildcard: `192.168.1.*`, `10.*.*.*`
 *
 * Returns `true` if `allowedIps` is null, undefined, or empty (no restriction).
 */
export function checkIpAllowlist(
  allowedIps: string[] | null | undefined,
  requestIp: string,
): boolean {
  if (!allowedIps || allowedIps.length === 0) return true

  const normalizedIp = normalizeIp(requestIp)
  return allowedIps.some((pattern) => matchIpPattern(pattern.trim(), normalizedIp))
}

function normalizeIp(ip: string): string {
  // Strip IPv6 prefix for IPv4-mapped addresses (::ffff:192.168.1.1)
  if (ip.startsWith('::ffff:')) return ip.slice(7)
  return ip
}

function matchIpPattern(pattern: string, ip: string): boolean {
  // CIDR notation
  if (pattern.includes('/')) {
    return matchCidr(pattern, ip)
  }

  // Wildcard notation
  if (pattern.includes('*')) {
    return matchWildcard(pattern, ip)
  }

  // Exact match
  return normalizeIp(pattern) === ip
}

function matchCidr(cidr: string, ip: string): boolean {
  const [subnet, prefixStr] = cidr.split('/')
  if (!subnet || !prefixStr) return false

  const prefix = parseInt(prefixStr, 10)
  if (isNaN(prefix)) return false

  if (isIPv4(subnet) && isIPv4(ip)) {
    return matchCidrV4(subnet, prefix, ip)
  }

  if (isIPv6(subnet) && isIPv6(ip)) {
    return matchCidrV6(subnet, prefix, ip)
  }

  return false
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.')
  return (
    ((parseInt(parts[0]!, 10) << 24) |
      (parseInt(parts[1]!, 10) << 16) |
      (parseInt(parts[2]!, 10) << 8) |
      parseInt(parts[3]!, 10)) >>>
    0
  )
}

function matchCidrV4(subnet: string, prefix: number, ip: string): boolean {
  if (prefix < 0 || prefix > 32) return false
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
  return (ipv4ToInt(subnet) & mask) === (ipv4ToInt(ip) & mask)
}

function ipv6ToBytes(ip: string): number[] {
  // Expand :: notation
  const halves = ip.split('::')
  let groups: string[]

  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(':') : []
    const right = halves[1] ? halves[1].split(':') : []
    const missing = 8 - left.length - right.length
    groups = [...left, ...Array(missing).fill('0'), ...right]
  } else {
    groups = ip.split(':')
  }

  const bytes: number[] = []
  for (const group of groups) {
    const val = parseInt(group, 16)
    bytes.push((val >> 8) & 0xff, val & 0xff)
  }
  return bytes
}

function matchCidrV6(subnet: string, prefix: number, ip: string): boolean {
  if (prefix < 0 || prefix > 128) return false

  const subnetBytes = ipv6ToBytes(subnet)
  const ipBytes = ipv6ToBytes(ip)
  const fullBytes = Math.floor(prefix / 8)
  const remainingBits = prefix % 8

  for (let i = 0; i < fullBytes; i++) {
    if (subnetBytes[i] !== ipBytes[i]) return false
  }

  if (remainingBits > 0 && fullBytes < 16) {
    const mask = (0xff << (8 - remainingBits)) & 0xff
    if (((subnetBytes[fullBytes]!) & mask) !== ((ipBytes[fullBytes]!) & mask)) return false
  }

  return true
}

function matchWildcard(pattern: string, ip: string): boolean {
  // Only support IPv4 wildcards
  if (!isIPv4(ip) && !ip.match(/^\d+\.\d+\.\d+\.\d+$/.source.replace(/\d\+/g, '[\\d*]+'))) {
    return false
  }

  const patternParts = pattern.split('.')
  const ipParts = ip.split('.')

  if (patternParts.length !== ipParts.length) return false

  return patternParts.every((part, i) => part === '*' || part === ipParts[i])
}
