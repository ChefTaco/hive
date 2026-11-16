// Runs inside Oathweave. Its own store resolves the exact human account; no credential is read.
import { readFileSync } from 'node:fs';
const ADMIN = new Set(['SUPER_ADMIN', 'IAM_ADMIN', 'SUITE_ADMIN']);
const USERNAME = /^[A-Za-z0-9_.-]{1,64}$/;
export function administratorIdentity(user, issuer, { allowBlocked = false } = {}) {
  if (!user || (!allowBlocked && (!user.active || (user.lockedUntil && Date.parse(user.lockedUntil) > Date.now())
    || !user.roles?.some(({ role }) => ADMIN.has(role.name)))) || !USERNAME.test(user.username)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(user.id)) throw new Error('ADMIN_ACCESS_ACCOUNT_UNAVAILABLE');
  const url = new URL(issuer);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || !url.pathname.endsWith('/api/oathweave')) throw new Error('ADMIN_ACCESS_ISSUER_INVALID');
  return { issuer, subject: user.id, username: user.username, email: user.email,
    displayName: user.displayName || user.username };
}
export async function adminAccessIdentity(request, prisma, issuer) {
  if (!['list', 'resolve', 'status', 'grant'].includes(request.mode)) throw new Error('ADMIN_ACCESS_MODE_INVALID');
  const select = { id: true, username: true, email: true, displayName: true, active: true,
    lockedUntil: true, roles: { select: { role: { select: { name: true, permissions: true } } } } };
  if (request.mode === 'list') {
    const users = await prisma.user.findMany({ select, orderBy: { createdAt: 'asc' } });
    return { administrators: users.flatMap(user => {
      try { return [administratorIdentity(user, issuer)]; } catch { return []; }
    }) };
  }
  if (!USERNAME.test(request.username)) throw new Error('ADMIN_ACCESS_USERNAME_INVALID');
  const inspect = async tx => administratorIdentity(await tx.user.findUnique({ where: { username: request.username }, select }), issuer);
  if (request.mode === 'status') {
    const user = await prisma.user.findUnique({ where: { username: request.username }, select });
    const identity = administratorIdentity(user, issuer, { allowBlocked: true });
    let eligible = true;
    try { administratorIdentity(user, issuer); } catch { eligible = false; }
    return { identity, eligible };
  }
  if (request.mode === 'resolve') {
    const identity = await inspect(prisma);
    const role = await prisma.role.findUnique({ where: { name: 'SUITE_ADMIN' } });
    if (!role) throw new Error('ADMIN_ACCESS_SUITE_ROLE_MISSING');
    const permissions = JSON.parse(role.permissions);
    if (!Array.isArray(permissions) || !permissions.every(value => typeof value === 'string')) throw new Error('ADMIN_ACCESS_SUITE_ROLE_INVALID');
    const user = await prisma.user.findUnique({ where: { username: request.username }, select });
    const effective = [...permissions, ...user.roles.flatMap(assignment => JSON.parse(assignment.role.permissions || '[]'))];
    return { identity, terminalPermissionAfterSetup: effective.some(permission => ['magnus:terminal', 'magnus:*', '*'].includes(permission)) };
  }
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(request.operationId || '')) throw new Error('ADMIN_ACCESS_OPERATION_INVALID');
  return prisma.$transaction(async tx => {
    const identity = await inspect(tx);
    if (JSON.stringify(identity) !== JSON.stringify(request.identity)) throw new Error('ADMIN_ACCESS_ACCOUNT_CHANGED');
    const role = await tx.role.findUnique({ where: { name: 'SUITE_ADMIN' } });
    if (!role) throw new Error('ADMIN_ACCESS_SUITE_ROLE_MISSING');
    const current = await tx.userRoleAssignment.findUnique({ where: { userId_roleId: { userId: identity.subject, roleId: role.id } } });
    if (!current) {
      await tx.userRoleAssignment.create({ data: { userId: identity.subject, roleId: role.id, grantedBy: 'hive-admin-access:' + request.operationId } });
      await tx.auditEvent.create({ data: { eventType: 'user.roles_assigned', category: 'ROLE_MANAGEMENT', actorType: 'SYSTEM',
        resourceType: 'user', resourceId: identity.subject, action: 'assign_roles', source: 'hive-admin-access',
        detail: JSON.stringify({ roleIds: [role.id], operationId: request.operationId, installationOwner: request.approvedBy ?? null }) } });
    }
    return { identity, suiteAdministrator: true, assignmentAdded: !current };
  });
}
if (process.argv[1] === '--stdin') {
  let prisma;
  try {
    const raw = readFileSync(0, 'utf8');
    if (raw.length > 16384) throw new Error('ADMIN_ACCESS_REQUEST_TOO_LARGE');
    ({ prisma } = await import('/app/apps/iam-core/dist/db/client.js'));
    const request = JSON.parse(raw);
    const issuer = process.env.IAM_BROWSER_ISSUER;
    console.log(JSON.stringify(await adminAccessIdentity(request, prisma, issuer)));
  } catch (error) {
    const code = /^ADMIN_ACCESS_[A-Z_]+$/.test(error.message) ? error.message : 'ADMIN_ACCESS_IDENTITY_REFUSED';
    console.error(code); process.exitCode = 1;
  } finally { if (prisma) await prisma.$disconnect(); }
}
