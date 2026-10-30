import { PrismaClient } from './generated/index.js'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { resolve } from 'node:path'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined }

function createPrismaClient(): PrismaClient {
  const dbUrl = process.env['DATABASE_URL'] ?? `file:${resolve('prisma/iam.db')}`
  const adapter = new PrismaBetterSqlite3({ url: dbUrl })
  return new PrismaClient({
    adapter,
    log:
      process.env['NODE_ENV'] === 'development'
        ? ['error', 'warn']
        : ['error'],
  })
}

export const prisma: PrismaClient =
  globalForPrisma.prisma ?? createPrismaClient()

if (process.env['NODE_ENV'] !== 'production') {
  globalForPrisma.prisma = prisma
}
