import { describe, expect, it } from 'vitest';
import { redactHeaders, shouldCopyResponseHeader, shouldForwardClientHeader } from '../../src/security/headers.js';

describe('security/headers', () => {
  it('redacts secrets before trace persistence', () => {
    expect(redactHeaders({
      authorization: 'Bearer client-secret',
      'x-api-key': 'sk-test',
      accept: 'application/json',
    })).toEqual({
      authorization: '[redacted]',
      'x-api-key': '[redacted]',
      accept: 'application/json',
    });
  });

  it('does not forward caller credentials or spoofable proxy headers upstream', () => {
    expect(shouldForwardClientHeader('authorization')).toBe(false);
    expect(shouldForwardClientHeader('cookie')).toBe(false);
    expect(shouldForwardClientHeader('x-forwarded-for')).toBe(false);
    expect(shouldForwardClientHeader('accept')).toBe(true);
  });

  it('does not relay upstream cookies to API clients', () => {
    expect(shouldCopyResponseHeader('set-cookie')).toBe(false);
    expect(shouldCopyResponseHeader('transfer-encoding')).toBe(false);
    expect(shouldCopyResponseHeader('content-type')).toBe(true);
  });
});
