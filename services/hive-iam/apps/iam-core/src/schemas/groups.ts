import { z } from 'zod'

export const CreateGroupSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
})

export const UpdateGroupSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
})

export const AddMembersSchema = z.object({
  userIds: z.array(z.string().min(1)).min(1),
})

export const AssignRolesSchema = z.object({
  roleIds: z.array(z.string().min(1)).min(1),
})
