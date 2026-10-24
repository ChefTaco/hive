import { importSPKI, type CryptoKey as JoseCryptoKey } from 'jose'
import ky from 'ky'

interface CacheEntry {
  key: JoseCryptoKey
  pem: string
  fetchedAt: number
}

export class PublicKeyCache {
  private entry: CacheEntry | null = null
  private pending: Promise<{ key: JoseCryptoKey; pem: string }> | null = null
  private readonly ttlMs: number
  private readonly url: string

  constructor(url: string, ttlMs = 3_600_000) {
    this.url = url
    this.ttlMs = ttlMs
  }

  async getKey(): Promise<{ key: JoseCryptoKey; pem: string }> {
    if (this.entry && Date.now() - this.entry.fetchedAt < this.ttlMs) {
      return { key: this.entry.key, pem: this.entry.pem }
    }
    // Deduplicate concurrent refresh calls
    if (!this.pending) {
      this.pending = this.refresh().finally(() => { this.pending = null })
    }
    return this.pending
  }

  async refresh(): Promise<{ key: JoseCryptoKey; pem: string }> {
    const pem = await ky.get(this.url, { retry: 2 }).text()
    const key = await importSPKI(pem, 'RS256')
    this.entry = { key, pem, fetchedAt: Date.now() }
    return { key, pem }
  }
}
