/**
 * Token refresh helper — call IAM Core to exchange a refresh token for fresh tokens.
 */
export async function refreshAccessToken(
  iamCoreUrl: string,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number } | null> {
  try {
    const res = await fetch(`${iamCoreUrl}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) return null

    return (await res.json()) as { accessToken: string; refreshToken: string; expiresIn: number }
  } catch {
    return null
  }
}
