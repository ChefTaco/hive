import 'dotenv/config'
import { PrismaClient } from '../src/db/generated/index.js'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import * as argon2 from 'argon2'
import { planSeedClientSecret } from './seed-client-secret.js'

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
}

const adapter = new PrismaBetterSqlite3({
  url: process.env['DATABASE_URL'] ?? 'file:./prisma/iam.db',
})
const prisma = new PrismaClient({ adapter })

const SYSTEM_ROLES = [
  {
    name: 'SUPER_ADMIN',
    label: 'Super Administrator',
    description: 'Full platform control — users, roles, clients, system config',
    isSystem: true,
    permissions: [
      'iam:users:read',
      'iam:users:write',
      'iam:users:delete',
      'iam:roles:read',
      'iam:roles:write',
      'iam:sa:read',
      'iam:sa:write',
      'iam:sa:delete',
      'iam:clients:read',
      'iam:clients:write',
      'iam:audit:read',
      'iam:sessions:revoke',
      'iam:system:login',
      'iam:system:sudo',
      'iam:system:deploy',
      'iam:tokens:introspect',
    ],
  },
  {
    name: 'IAM_ADMIN',
    label: 'IAM Administrator',
    description: 'Manage users, roles, service accounts, clients',
    isSystem: true,
    permissions: [
      'iam:users:read',
      'iam:users:write',
      'iam:users:delete',
      'iam:roles:read',
      'iam:roles:write',
      'iam:sa:read',
      'iam:sa:write',
      'iam:sa:delete',
      'iam:clients:read',
      'iam:clients:write',
      'iam:audit:read',
      'iam:sessions:revoke',
      'iam:tokens:introspect',
    ],
  },
  {
    name: 'OPERATOR',
    label: 'Operator',
    description: 'Read all resources, revoke sessions; cannot change roles or users',
    isSystem: true,
    permissions: [
      'iam:users:read',
      'iam:roles:read',
      'iam:sa:read',
      'iam:clients:read',
      'iam:audit:read',
      'iam:sessions:revoke',
      'iam:tokens:introspect',
    ],
  },
  {
    name: 'VIEWER',
    label: 'Viewer',
    description: 'Read-only access to audit logs and user listings',
    isSystem: true,
    permissions: ['iam:users:read', 'iam:audit:read'],
  },
  {
    name: 'SERVICE',
    label: 'Service Account',
    description: 'Assigned to service accounts; validate tokens from backends',
    isSystem: true,
    permissions: ['iam:tokens:introspect'],
  },
  {
    name: 'DEPLOY_AGENT',
    label: 'Deploy Agent',
    description: 'Authorize software deployment events via the Ubuntu agent',
    isSystem: true,
    permissions: ['iam:system:login', 'iam:system:deploy', 'iam:tokens:introspect'],
  },
]

async function main() {
  console.log('Seeding IAM database...')

  // Upsert all system roles
  for (const role of SYSTEM_ROLES) {
    const data = {
      ...role,
      permissions: JSON.stringify(role.permissions),
    }
    await prisma.role.upsert({
      where: { name: role.name },
      update: {
        label: data.label,
        description: data.description,
        permissions: data.permissions,
      },
      create: data,
    })
    console.log(`  ✓ Role: ${role.name}`)
  }

  // Create default super admin user
  const adminEmail = process.env['SEED_ADMIN_EMAIL'] ?? 'admin@iam.local'
  const adminPassword = process.env['SEED_ADMIN_PASSWORD']
  const adminUsername = process.env['SEED_ADMIN_USERNAME'] ?? 'admin'
  if (!adminPassword || adminPassword.length < 16) {
    throw new Error('SEED_ADMIN_PASSWORD is required and must contain at least 16 characters')
  }

  const passwordHash = await argon2.hash(adminPassword, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  })

  const superAdminRole = await prisma.role.findUniqueOrThrow({ where: { name: 'SUPER_ADMIN' } })

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      username: adminUsername,
      displayName: 'IAM Administrator',
      passwordHash,
      encryptedPassword: null,
      passwordChangedAt: new Date(),
      active: true,
    },
  })

  await prisma.userRoleAssignment.upsert({
    where: { userId_roleId: { userId: admin.id, roleId: superAdminRole.id } },
    update: {},
    create: { userId: admin.id, roleId: superAdminRole.id },
  })
  console.log(`  ✓ Admin user: ${adminEmail}`)

  // Create default client for Hive
  const hiveClientSecretFromEnv = process.env['SEED_HIVE_CLIENT_SECRET']
  if (hiveClientSecretFromEnv && hiveClientSecretFromEnv.length < 32) {
    throw new Error('SEED_HIVE_CLIENT_SECRET must contain at least 32 characters')
  }
  const existingHiveClient = await prisma.client.findUnique({ where: { name: 'hive' } })
  const hiveSecretPlan = planSeedClientSecret({
    clientName: 'hive',
    envName: 'SEED_HIVE_CLIENT_SECRET',
    clientExists: existingHiveClient !== null,
    existingSecretHash: existingHiveClient?.secretHash ?? null,
    suppliedSecret: hiveClientSecretFromEnv,
  })
  const hiveClientSecretHash = hiveSecretPlan === 'preserve'
    ? undefined
    : await argon2.hash(hiveClientSecretFromEnv!, ARGON2_OPTIONS)

  const configuredHivePublicUrl = process.env['SEED_HIVE_PUBLIC_URL']?.replace(/\/+$/, '')
  const hivePublicUrl = configuredHivePublicUrl ?? 'https://hive.example.com'
  await prisma.client.upsert({
    where: { name: 'hive' },
    update: {
      firstParty: true,
      clientType: 'confidential',
      ...(configuredHivePublicUrl ? { redirectUris: JSON.stringify([configuredHivePublicUrl]) } : {}),
      grantTypes: '["authorization_code","refresh_token","client_credentials"]',
      ...(hiveSecretPlan === 'provision' ? { secretHash: hiveClientSecretHash } : {}),
    },
    create: {
      name: 'hive',
      description: 'Hive Control Plane',
      secretHash: hiveClientSecretHash!,
      active: true,
      clientType: 'confidential',
      firstParty: true,
      redirectUris: JSON.stringify([hivePublicUrl]),
      grantTypes: '["authorization_code","refresh_token","client_credentials"]',
    },
  })
  console.log(`  ✓ Client: hive`)

  const configuredRouterRedirectUri = process.env['SEED_HIVE_ROUTER_REDIRECT_URI']
    ?? (configuredHivePublicUrl ? `${configuredHivePublicUrl}/api/auth/oidc/callback` : undefined)
  const routerRedirectUri = configuredRouterRedirectUri ?? `${hivePublicUrl}/api/auth/oidc/callback`
  const routerClientSecretFromEnv = process.env['SEED_HIVE_ROUTER_CLIENT_SECRET']
  if (routerClientSecretFromEnv && routerClientSecretFromEnv.length < 32) {
    throw new Error('SEED_HIVE_ROUTER_CLIENT_SECRET must contain at least 32 characters')
  }
  const existingRouterClient = await prisma.client.findUnique({ where: { id: 'hive-router' } })
  const routerSecretPlan = planSeedClientSecret({
    clientName: 'hive-router',
    envName: 'SEED_HIVE_ROUTER_CLIENT_SECRET',
    clientExists: existingRouterClient !== null,
    existingSecretHash: existingRouterClient?.secretHash ?? null,
    suppliedSecret: routerClientSecretFromEnv,
  })
  const routerClientSecretHash = routerSecretPlan === 'preserve'
    ? undefined
    : await argon2.hash(routerClientSecretFromEnv!, ARGON2_OPTIONS)

  await prisma.client.upsert({
    where: { id: 'hive-router' },
    update: {
      name: 'hive-router',
      description: 'Hive Router Admin UI OIDC Client',
      active: true,
      firstParty: true,
      clientType: 'confidential',
      ...(configuredRouterRedirectUri ? { redirectUris: JSON.stringify([configuredRouterRedirectUri]) } : {}),
      grantTypes: '["authorization_code","refresh_token","client_credentials"]',
      ...(routerSecretPlan === 'provision' ? { secretHash: routerClientSecretHash } : {}),
    },
    create: {
      id: 'hive-router',
      name: 'hive-router',
      description: 'Hive Router Admin UI OIDC Client',
      secretHash: routerClientSecretHash!,
      active: true,
      clientType: 'confidential',
      firstParty: true,
      redirectUris: JSON.stringify([routerRedirectUri]),
      grantTypes: '["authorization_code","refresh_token","client_credentials"]',
    },
  })
  console.log(`  ✓ Client: hive-router`)

  const securityExporterSecret = process.env['SEED_SECURITY_EXPORTER_CLIENT_SECRET']
  if (securityExporterSecret) {
    if (securityExporterSecret.length < 32) {
      throw new Error('SEED_SECURITY_EXPORTER_CLIENT_SECRET must contain at least 32 characters')
    }
    const existingSecurityExporterClient = await prisma.client.findUnique({ where: { id: 'security-exporter' } })
    const securityExporterSecretPlan = planSeedClientSecret({
      clientName: 'security-exporter',
      envName: 'SEED_SECURITY_EXPORTER_CLIENT_SECRET',
      clientExists: existingSecurityExporterClient !== null,
      existingSecretHash: existingSecurityExporterClient?.secretHash ?? null,
      suppliedSecret: securityExporterSecret,
    })
    const securityExporterSecretHash = securityExporterSecretPlan === 'preserve'
      ? undefined
      : await argon2.hash(securityExporterSecret, ARGON2_OPTIONS)
    await prisma.client.upsert({
      where: { id: 'security-exporter' },
      update: {
        name: 'security-exporter',
        description: 'Read-only IAM audit and security event exporter',
        active: true,
        firstParty: true,
        clientType: 'confidential',
        redirectUris: '[]',
        grantTypes: '["client_credentials"]',
        ...(securityExporterSecretPlan === 'provision' ? { secretHash: securityExporterSecretHash } : {}),
      },
      create: {
        id: 'security-exporter',
        name: 'security-exporter',
        description: 'Read-only IAM audit and security event exporter',
        secretHash: securityExporterSecretHash!,
        active: true,
        clientType: 'confidential',
        firstParty: true,
        redirectUris: '[]',
        grantTypes: '["client_credentials"]',
      },
    })
    console.log('  ✓ Client: security-exporter (iam:audit:read only)')
  }

  const examplePortalSecret = process.env['SEED_EXAMPLE_PORTAL_CLIENT_SECRET']
  if (examplePortalSecret) {
    if (examplePortalSecret.length < 32) {
      throw new Error('SEED_EXAMPLE_PORTAL_CLIENT_SECRET must contain at least 32 characters')
    }
    const existingExamplePortalClient = await prisma.client.findUnique({ where: { id: 'example-portal' } })
    const examplePortalSecretPlan = planSeedClientSecret({
      clientName: 'example-portal',
      envName: 'SEED_EXAMPLE_PORTAL_CLIENT_SECRET',
      clientExists: existingExamplePortalClient !== null,
      existingSecretHash: existingExamplePortalClient?.secretHash ?? null,
      suppliedSecret: examplePortalSecret,
    })
    const examplePortalSecretHash = examplePortalSecretPlan === 'preserve'
      ? undefined
      : await argon2.hash(examplePortalSecret, ARGON2_OPTIONS)
    const examplePortalRedirectUri = process.env['SEED_EXAMPLE_PORTAL_REDIRECT_URI']
      ?? 'https://client.example.com/api/auth/callback/hive-iam'
    await prisma.client.upsert({
      where: { id: 'example-portal' },
      update: {
        name: 'example-portal',
        description: 'Example Portal read-only OIDC client',
        active: true,
        firstParty: true,
        clientType: 'confidential',
        redirectUris: JSON.stringify([examplePortalRedirectUri]),
        grantTypes: '["authorization_code","refresh_token","client_credentials"]',
        ...(examplePortalSecretPlan === 'provision' ? { secretHash: examplePortalSecretHash } : {}),
      },
      create: {
        id: 'example-portal',
        name: 'example-portal',
        description: 'Example Portal read-only OIDC client',
        secretHash: examplePortalSecretHash!,
        active: true,
        clientType: 'confidential',
        firstParty: true,
        redirectUris: JSON.stringify([examplePortalRedirectUri]),
        grantTypes: '["authorization_code","refresh_token","client_credentials"]',
      },
    })
    console.log('  ✓ Client: example-portal (aud=example-portal, example-portal:read only)')
  }

  console.log('\nSeed completed.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
