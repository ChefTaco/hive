import { z } from 'zod'

export const LoginSchema = z.object({
  username: z.string().min(1).max(254),
  password: z.string().min(1).max(256),
})

export const RefreshSchema = z.object({
  refreshToken: z.string().min(1),
})

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8).max(256),
})

export const MfaVerifySchema = z.object({
  code: z.string().min(6).max(6),
})

export const MfaChallengeSchema = z.object({
  mfaToken: z.string().min(1),
  code: z.string().min(1).max(12), // 6-digit TOTP or backup code
})

export const MfaDisableSchema = z.object({
  password: z.string().min(1).max(256),
  code: z.string().min(6).max(6),
})

export const ForgotPasswordSchema = z.object({
  email: z.email(),
})

export const ResetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8).max(256),
})
