import { z } from 'zod'

/** GET /oauth/authorize query parameters */
export const AuthorizeQuerySchema = z.object({
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  response_type: z.string().min(1),
  code_challenge: z.string().optional(),
  code_challenge_method: z.enum(['S256']).optional(),
  scope: z.string().optional(),
  state: z.string().optional(),
})

/** POST /oauth/authorize — user consent approval */
export const AuthorizeConsentSchema = z.object({
  clientId: z.string().min(1),
  redirectUri: z.string().url(),
  responseType: z.string().min(1),
  codeChallenge: z.string().optional(),
  codeChallengeMethod: z.enum(['S256']).optional(),
  scope: z.string().optional(),
  state: z.string().optional(),
})

/** POST /oauth/token */
export const TokenExchangeSchema = z.object({
  grant_type: z.enum(['authorization_code', 'refresh_token', 'client_credentials']),
  code: z.string().optional(),
  redirect_uri: z.string().optional(),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  code_verifier: z.string().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  nonce: z.string().optional(),
})
