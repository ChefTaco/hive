/**
 * Group Service — CRUD for groups, member/role management, effective permissions.
 */

import { nanoid } from 'nanoid'
import { prisma } from '../db/client.js'
import { ApiError } from '../types/index.js'

// ── List groups ──

export async function listGroups(opts?: { search?: string }) {
  const where = opts?.search
    ? { name: { contains: opts.search } }
    : {}

  const groups = await prisma.group.findMany({
    where,
    include: {
      _count: { select: { members: true, roles: true } },
    },
    orderBy: { name: 'asc' },
  })

  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    description: g.description,
    system: g.system,
    memberCount: g._count.members,
    roleCount: g._count.roles,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  }))
}

// ── Get group by ID ──

export async function getGroupById(id: string) {
  const group = await prisma.group.findUnique({
    where: { id },
    include: {
      members: {
        include: {
          user: { select: { id: true, email: true, username: true, displayName: true } },
        },
      },
      roles: {
        include: {
          role: { select: { id: true, name: true, label: true, permissions: true } },
        },
      },
    },
  })

  if (!group) throw new ApiError(404, 'NOT_FOUND', 'Group not found')
  return group
}

// ── Create group ──

export async function createGroup(data: {
  name: string
  description?: string
}) {
  const existing = await prisma.group.findUnique({ where: { name: data.name } })
  if (existing) throw new ApiError(409, 'CONFLICT', 'Group name already exists')

  return prisma.group.create({
    data: {
      id: nanoid(),
      name: data.name,
      description: data.description,
    },
  })
}

// ── Update group ──

export async function updateGroup(id: string, data: { name?: string; description?: string }) {
  const group = await prisma.group.findUnique({ where: { id } })
  if (!group) throw new ApiError(404, 'NOT_FOUND', 'Group not found')
  if (group.system) throw new ApiError(403, 'FORBIDDEN', 'Cannot modify system groups')

  if (data.name && data.name !== group.name) {
    const conflict = await prisma.group.findUnique({ where: { name: data.name } })
    if (conflict) throw new ApiError(409, 'CONFLICT', 'Group name already exists')
  }

  return prisma.group.update({
    where: { id },
    data: {
      ...(data.name ? { name: data.name } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
    },
  })
}

// ── Delete group ──

export async function deleteGroup(id: string) {
  const group = await prisma.group.findUnique({ where: { id } })
  if (!group) throw new ApiError(404, 'NOT_FOUND', 'Group not found')
  if (group.system) throw new ApiError(403, 'FORBIDDEN', 'Cannot delete system groups')

  await prisma.group.delete({ where: { id } })
}

// ── Add members ──

export async function addMembers(groupId: string, userIds: string[]) {
  const group = await prisma.group.findUnique({ where: { id: groupId } })
  if (!group) throw new ApiError(404, 'NOT_FOUND', 'Group not found')

  // Verify all users exist
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true },
  })
  if (users.length !== userIds.length) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'One or more users not found')
  }

  // Filter out already-existing members, then create
  const existing = await prisma.groupMember.findMany({
    where: { groupId, userId: { in: userIds } },
    select: { userId: true },
  })
  const existingSet = new Set(existing.map((m) => m.userId))
  const newUserIds = userIds.filter((id) => !existingSet.has(id))

  if (newUserIds.length > 0) {
    await prisma.groupMember.createMany({
      data: newUserIds.map((userId) => ({
        id: nanoid(),
        groupId,
        userId,
      })),
    })
  }
}

// ── Remove member ──

export async function removeMember(groupId: string, userId: string) {
  const member = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId } },
  })
  if (!member) throw new ApiError(404, 'NOT_FOUND', 'Member not found in group')

  await prisma.groupMember.delete({
    where: { id: member.id },
  })
}

// ── Assign roles to group ──

export async function assignRoles(groupId: string, roleIds: string[]) {
  const group = await prisma.group.findUnique({ where: { id: groupId } })
  if (!group) throw new ApiError(404, 'NOT_FOUND', 'Group not found')

  // Verify all roles exist
  const roles = await prisma.role.findMany({
    where: { id: { in: roleIds } },
    select: { id: true },
  })
  if (roles.length !== roleIds.length) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'One or more roles not found')
  }

  // Filter out already-assigned roles, then create
  const existingAssignments = await prisma.groupRoleAssignment.findMany({
    where: { groupId, roleId: { in: roleIds } },
    select: { roleId: true },
  })
  const existingRoleSet = new Set(existingAssignments.map((a) => a.roleId))
  const newRoleIds = roleIds.filter((id) => !existingRoleSet.has(id))

  if (newRoleIds.length > 0) {
    await prisma.groupRoleAssignment.createMany({
      data: newRoleIds.map((roleId) => ({
        id: nanoid(),
        groupId,
        roleId,
      })),
    })
  }
}

// ── Remove role from group ──

export async function removeRole(groupId: string, roleId: string) {
  const assignment = await prisma.groupRoleAssignment.findUnique({
    where: { groupId_roleId: { groupId, roleId } },
  })
  if (!assignment) throw new ApiError(404, 'NOT_FOUND', 'Role not assigned to group')

  await prisma.groupRoleAssignment.delete({
    where: { id: assignment.id },
  })
}

// ── Get effective permissions for a user (direct + group-derived) ──

export async function getEffectivePermissions(userId: string): Promise<string[]> {
  // Direct role permissions
  const directRoles = await prisma.userRoleAssignment.findMany({
    where: { userId },
    include: { role: { select: { permissions: true } } },
  })

  // Group-derived role permissions
  const groups = await prisma.groupMember.findMany({
    where: { userId },
    include: {
      group: {
        include: {
          roles: {
            include: { role: { select: { permissions: true } } },
          },
        },
      },
    },
  })

  const allPermissions = new Set<string>()

  // Add direct permissions
  for (const dr of directRoles) {
    const perms: string[] = JSON.parse(dr.role.permissions)
    for (const p of perms) allPermissions.add(p)
  }

  // Add group permissions
  for (const gm of groups) {
    for (const gr of gm.group.roles) {
      const perms: string[] = JSON.parse(gr.role.permissions)
      for (const p of perms) allPermissions.add(p)
    }
  }

  return [...allPermissions]
}
