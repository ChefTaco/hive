import 'dotenv/config'
import * as argon2 from 'argon2'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { PrismaClient } from '../db/generated/index.js'

const username = process.env['IAM_RESET_USERNAME'] ?? process.env['SEED_ADMIN_USERNAME'] ?? 'admin'
const email = process.env['IAM_RESET_EMAIL'] ?? process.env['SEED_ADMIN_EMAIL'] ?? 'admin@iam.local'
const passwordInput = process.env['IAM_RESET_PASSWORD'] ?? process.env['SEED_ADMIN_PASSWORD']

if (!passwordInput || passwordInput.length < 8) {
  console.error('IAM_RESET_PASSWORD must be set and at least 8 characters long.')
  process.exit(1)
}
const password: string = passwordInput

const adapter = new PrismaBetterSqlite3({
  url: process.env['DATABASE_URL'] ?? 'file:./prisma/iam.db',
})
const prisma = new PrismaClient({ adapter })

async function main() {
  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  })

  const role = await prisma.role.findUnique({ where: { name: 'SUPER_ADMIN' } })
  if (!role) throw new Error('SUPER_ADMIN role does not exist. Run db:seed first.')

  const existing = await prisma.user.findFirst({ where: { OR: [{ username }, { email }] } })
  const user = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: {
          username,
          email,
          displayName: existing.displayName || 'IAM Administrator',
          passwordHash,
          encryptedPassword: null,
          passwordChangedAt: new Date(),
          active: true,
          failedAttempts: 0,
          lockedUntil: null,
        },
      })
    : await prisma.user.create({
        data: {
          username,
          email,
          displayName: 'IAM Administrator',
          passwordHash,
          encryptedPassword: null,
          passwordChangedAt: new Date(),
          active: true,
        },
      })

  await prisma.userRoleAssignment.upsert({
    where: { userId_roleId: { userId: user.id, roleId: role.id } },
    update: {},
    create: { userId: user.id, roleId: role.id },
  })

  console.log(`IAM admin password reset for ${username} (${email}).`)
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
