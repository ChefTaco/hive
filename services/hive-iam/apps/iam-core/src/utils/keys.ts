import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { calculateJwkThumbprint, exportJWK, importPKCS8, importSPKI } from 'jose'
import { env } from '../config/env.js'

type JWTKey = Parameters<typeof importPKCS8> extends [string, string, ...infer _] ? Awaited<ReturnType<typeof importPKCS8>> : never

let _privateKey: JWTKey | null = null
let _publicKey: JWTKey | null = null
let _publicKeyPem: string | null = null
let _signingKeyId: string | null = null
let _publishedSigningJwks: { keys: Record<string, unknown>[] } | null = null

const MAX_PUBLISHED_SIGNING_KEYS = 8

function publicPemFromPem(pem: string): string {
  try {
    return createPublicKey(pem).export({ type: 'spki', format: 'pem' }).toString()
  } catch {
    return createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'pem' }).toString()
  }
}

export async function keyIdForPem(pem: string): Promise<string> {
  const publicKey = await importSPKI(publicPemFromPem(pem), 'RS256')
  return calculateJwkThumbprint(await exportJWK(publicKey), 'sha256')
}

export async function getPrivateKey(): Promise<JWTKey> {
  if (_privateKey) return _privateKey
  const pem = await readFile(resolve(env.JWT_PRIVATE_KEY_PATH), 'utf-8')
  _privateKey = await importPKCS8(pem, 'RS256')
  return _privateKey
}

export async function getPublicKey(): Promise<JWTKey> {
  if (_publicKey) return _publicKey
  const pem = await readFile(resolve(env.JWT_PUBLIC_KEY_PATH), 'utf-8')
  _publicKey = await importSPKI(pem, 'RS256')
  return _publicKey
}

export async function getPublicKeyPem(): Promise<string> {
  if (_publicKeyPem) return _publicKeyPem
  _publicKeyPem = await readFile(resolve(env.JWT_PUBLIC_KEY_PATH), 'utf-8')
  return _publicKeyPem
}

export async function getSigningKeyId(): Promise<string> {
  if (_signingKeyId) return _signingKeyId
  const [privatePem, publicPem] = await Promise.all([
    readFile(resolve(env.JWT_PRIVATE_KEY_PATH), 'utf-8'),
    getPublicKeyPem(),
  ])
  const [privateKid, publicKid] = await Promise.all([
    keyIdForPem(privatePem),
    keyIdForPem(publicPem),
  ])
  if (privateKid !== publicKid) {
    throw new Error('JWT private and public signing keys do not match')
  }
  _signingKeyId = privateKid
  return privateKid
}

export async function getPublishedSigningJwks(): Promise<{ keys: Record<string, unknown>[] }> {
  if (_publishedSigningJwks) return _publishedSigningJwks
  const paths = [
    env.JWT_PUBLIC_KEY_PATH,
    ...env.JWT_PREVIOUS_PUBLIC_KEY_PATHS.split(',').map((entry) => entry.trim()).filter(Boolean),
  ]
  if (paths.length > MAX_PUBLISHED_SIGNING_KEYS) {
    throw new Error(`JWT signing keyring exceeds ${MAX_PUBLISHED_SIGNING_KEYS} published keys`)
  }

  const keys: Record<string, unknown>[] = []
  const seen = new Set<string>()
  for (const path of paths) {
    const pem = await readFile(resolve(path), 'utf-8')
    const publicKey = await importSPKI(publicPemFromPem(pem), 'RS256')
    const jwk = await exportJWK(publicKey)
    const kid = await calculateJwkThumbprint(jwk, 'sha256')
    if (seen.has(kid)) continue
    seen.add(kid)
    keys.push({ ...jwk, alg: 'RS256', use: 'sig', kid })
  }

  const activeKid = await getSigningKeyId()
  if (keys[0]?.['kid'] !== activeKid) {
    throw new Error('Active JWT public key is not first in the published keyring')
  }
  _publishedSigningJwks = { keys }
  return _publishedSigningJwks
}
