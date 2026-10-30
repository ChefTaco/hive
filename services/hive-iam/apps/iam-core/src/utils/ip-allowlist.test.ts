import { describe, it, expect } from 'vitest'
import { checkIpAllowlist } from './ip-allowlist.js'

describe('checkIpAllowlist', () => {
  it('returns true when allowedIps is null or empty', () => {
    expect(checkIpAllowlist(null, '10.0.0.1')).toBe(true)
    expect(checkIpAllowlist(undefined, '10.0.0.1')).toBe(true)
    expect(checkIpAllowlist([], '10.0.0.1')).toBe(true)
  })

  it('matches exact IP', () => {
    expect(checkIpAllowlist(['192.168.1.100'], '192.168.1.100')).toBe(true)
    expect(checkIpAllowlist(['192.168.1.100'], '192.168.1.101')).toBe(false)
  })

  it('matches CIDR /24', () => {
    expect(checkIpAllowlist(['192.168.1.0/24'], '192.168.1.50')).toBe(true)
    expect(checkIpAllowlist(['192.168.1.0/24'], '192.168.1.255')).toBe(true)
    expect(checkIpAllowlist(['192.168.1.0/24'], '192.168.2.1')).toBe(false)
  })

  it('matches CIDR /8', () => {
    expect(checkIpAllowlist(['10.0.0.0/8'], '10.255.255.255')).toBe(true)
    expect(checkIpAllowlist(['10.0.0.0/8'], '11.0.0.1')).toBe(false)
  })

  it('matches CIDR /32 (single host)', () => {
    expect(checkIpAllowlist(['10.0.0.5/32'], '10.0.0.5')).toBe(true)
    expect(checkIpAllowlist(['10.0.0.5/32'], '10.0.0.6')).toBe(false)
  })

  it('matches wildcard patterns', () => {
    expect(checkIpAllowlist(['192.168.1.*'], '192.168.1.42')).toBe(true)
    expect(checkIpAllowlist(['192.168.1.*'], '192.168.2.42')).toBe(false)
    expect(checkIpAllowlist(['10.*.*.*'], '10.0.0.1')).toBe(true)
    expect(checkIpAllowlist(['10.*.*.*'], '11.0.0.1')).toBe(false)
  })

  it('matches any pattern in the list', () => {
    const list = ['192.168.1.0/24', '10.0.0.0/8', '172.16.0.5']
    expect(checkIpAllowlist(list, '192.168.1.10')).toBe(true)
    expect(checkIpAllowlist(list, '10.50.0.1')).toBe(true)
    expect(checkIpAllowlist(list, '172.16.0.5')).toBe(true)
    expect(checkIpAllowlist(list, '8.8.8.8')).toBe(false)
  })

  it('handles IPv6-mapped IPv4 addresses', () => {
    expect(checkIpAllowlist(['192.168.1.100'], '::ffff:192.168.1.100')).toBe(true)
  })
})
