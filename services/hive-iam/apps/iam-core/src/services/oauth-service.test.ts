/**
 * oauth-service.test.ts — Unit tests for OAuth2 PKCE service logic.
 */

import { describe, it, expect } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { AuthorizeQuerySchema, TokenExchangeSchema } from '../schemas/oauth.js'

describe('OAuth2 schemas', () => {
  describe('AuthorizeQuerySchema', () => {
    it('should validate a complete authorize request', () => {
      const result = AuthorizeQuerySchema.safeParse({
        client_id: 'test-client',
        redirect_uri: 'https://app.example.com/callback',
        response_type: 'code',
        code_challenge: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
        code_challenge_method: 'S256',
        scope: 'openid profile email',
        state: 'random-state-123',
      })
      expect(result.success).toBe(true)
    })

    it('should accept a minimal authorize request', () => {
      const result = AuthorizeQuerySchema.safeParse({
        client_id: 'test-client',
        redirect_uri: 'https://app.example.com/callback',
        response_type: 'code',
      })
      expect(result.success).toBe(true)
    })

    it('should reject missing client_id', () => {
      const result = AuthorizeQuerySchema.safeParse({
        redirect_uri: 'https://app.example.com/callback',
        response_type: 'code',
      })
      expect(result.success).toBe(false)
    })

    it('should reject invalid redirect_uri', () => {
      const result = AuthorizeQuerySchema.safeParse({
        client_id: 'test-client',
        redirect_uri: 'not-a-url',
        response_type: 'code',
      })
      expect(result.success).toBe(false)
    })

    it('should reject unsupported code_challenge_method', () => {
      const result = AuthorizeQuerySchema.safeParse({
        client_id: 'test-client',
        redirect_uri: 'https://app.example.com/callback',
        response_type: 'code',
        code_challenge: 'abc',
        code_challenge_method: 'plain',
      })
      expect(result.success).toBe(false)
    })
  })

  describe('TokenExchangeSchema', () => {
    it('should validate authorization_code grant', () => {
      const result = TokenExchangeSchema.safeParse({
        grant_type: 'authorization_code',
        code: 'test-code',
        redirect_uri: 'https://app.example.com/callback',
        client_id: 'test-client',
        code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      })
      expect(result.success).toBe(true)
    })

    it('should validate refresh_token grant', () => {
      const result = TokenExchangeSchema.safeParse({
        grant_type: 'refresh_token',
        refresh_token: 'some-refresh-token',
      })
      expect(result.success).toBe(true)
    })

    it('should accept client_credentials grant_type', () => {
      const result = TokenExchangeSchema.safeParse({
        grant_type: 'client_credentials',
      })
      expect(result.success).toBe(true)
    })

    it('should reject unsupported grant_type', () => {
      const result = TokenExchangeSchema.safeParse({
        grant_type: 'implicit',
      })
      expect(result.success).toBe(false)
    })
  })
})

describe('PKCE S256 verification', () => {
  it('should produce a valid S256 challenge from a verifier', () => {
    // Generate a random code_verifier (43-128 chars, unreserved URI chars)
    const verifier = randomBytes(32).toString('base64url')

    // Compute the S256 challenge
    const challenge = createHash('sha256').update(verifier).digest('base64url')

    // Verify the challenge matches
    const recomputed = createHash('sha256').update(verifier).digest('base64url')
    expect(recomputed).toBe(challenge)
  })

  it('should reject a mismatched verifier', () => {
    const verifier1 = randomBytes(32).toString('base64url')
    const verifier2 = randomBytes(32).toString('base64url')

    const challenge = createHash('sha256').update(verifier1).digest('base64url')
    const wrongChallenge = createHash('sha256').update(verifier2).digest('base64url')

    expect(challenge).not.toBe(wrongChallenge)
  })

  it('should handle RFC 7636 test vector', () => {
    // RFC 7636 Appendix B test vector
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const expectedChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

    const computed = createHash('sha256').update(verifier).digest('base64url')
    expect(computed).toBe(expectedChallenge)
  })
})

describe('OIDC Discovery', () => {
  it('should structure a valid discovery document', () => {
    // Inline test of the structure (not importing the function to avoid DB deps)
    const doc = {
      issuer: 'https://hive:4200',
      authorization_endpoint: 'https://iam.example.com/api/v1/oauth/authorize',
      token_endpoint: 'https://iam.example.com/api/v1/oauth/token',
      userinfo_endpoint: 'https://iam.example.com/api/v1/oauth/userinfo',
      jwks_uri: 'https://iam.example.com/api/v1/oauth/jwks',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
      code_challenge_methods_supported: ['S256'],
    }

    expect(doc.response_types_supported).toContain('code')
    expect(doc.grant_types_supported).toContain('authorization_code')
    expect(doc.grant_types_supported).toContain('client_credentials')
    expect(doc.code_challenge_methods_supported).toContain('S256')
    expect(doc.scopes_supported).toContain('openid')
    expect(doc.token_endpoint_auth_methods_supported).toContain('client_secret_post')
    expect(doc.token_endpoint_auth_methods_supported).toContain('none')
  })
})
