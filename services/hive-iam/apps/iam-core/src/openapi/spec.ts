import { zodToJsonSchema } from 'zod-to-json-schema'
import type { ZodType } from 'zod'
import {
  LoginSchema,
  RefreshSchema,
  ChangePasswordSchema,
  MfaVerifySchema,
  MfaChallengeSchema,
  MfaDisableSchema,
} from '../schemas/auth.js'
import { CreateUserSchema, UpdateUserSchema, AssignRolesSchema, RotatePasswordSchema } from '../schemas/users.js'
import { CreateRoleSchema, UpdateRoleSchema } from '../schemas/roles.js'
import { CreateClientSchema, RotateClientSecretSchema, UpdateClientSchema } from '../schemas/clients.js'
import { CreateServiceAccountSchema, UpdateServiceAccountSchema } from '../schemas/service-accounts.js'
import { CreateSystemUserSchema, UpdateSystemUserSchema } from '../schemas/system-users.js'

// ── Helpers ──

function zod(schema: ZodType) {
  return zodToJsonSchema(schema, { target: 'openApi3' })
}

function ref(name: string) {
  return { $ref: `#/components/schemas/${name}` }
}

function jsonBody(schemaRef: ReturnType<typeof ref>, description = '') {
  return {
    required: true,
    description,
    content: { 'application/json': { schema: schemaRef } },
  }
}

function success(schema: Record<string, unknown>, description = 'Success') {
  return { [200]: { description, content: { 'application/json': { schema } } } }
}

function created(schema: Record<string, unknown>, description = 'Created') {
  return { [201]: { description, content: { 'application/json': { schema } } } }
}

const err400 = { description: 'Validation error', content: { 'application/json': { schema: ref('ApiError') } } }
const err401 = { description: 'Unauthorized', content: { 'application/json': { schema: ref('ApiError') } } }
const err403 = { description: 'Forbidden', content: { 'application/json': { schema: ref('ApiError') } } }
const err404 = { description: 'Not found', content: { 'application/json': { schema: ref('ApiError') } } }
const err409 = { description: 'Conflict', content: { 'application/json': { schema: ref('ApiError') } } }

function qp(name: string, description: string, required = false, schema: Record<string, unknown> = { type: 'string' }) {
  return { name, in: 'query' as const, required, description, schema }
}

function pp(name: string, description: string) {
  return { name, in: 'path' as const, required: true, description, schema: { type: 'string' } }
}

// ── Build Spec ──

export function buildOpenApiSpec() {
  const tags = [
    { name: 'Health', description: 'Service health check' },
    { name: 'Auth', description: 'Authentication — login, MFA, token management' },
    { name: 'Users', description: 'User CRUD and role assignment' },
    { name: 'Roles', description: 'Role and permission management' },
    { name: 'Service Accounts', description: 'Service account management' },
    { name: 'Clients', description: 'OAuth/API client management' },
    { name: 'Tokens', description: 'Token introspection and management' },
    { name: 'Sessions', description: 'Session listing and revocation' },
    { name: 'System Users', description: 'Linux system user mapping' },
    { name: 'Audit', description: 'Audit log querying, streaming, and export' },
    { name: 'Password Policy', description: 'Password policy configuration' },
  ]

  const componentSchemas: Record<string, unknown> = {
    // Request schemas from Zod
    LoginRequest: zod(LoginSchema),
    RefreshRequest: zod(RefreshSchema),
    ChangePasswordRequest: zod(ChangePasswordSchema),
    MfaVerifyRequest: zod(MfaVerifySchema),
    MfaChallengeRequest: zod(MfaChallengeSchema),
    MfaDisableRequest: zod(MfaDisableSchema),
    CreateUserRequest: zod(CreateUserSchema),
    UpdateUserRequest: zod(UpdateUserSchema),
    AssignRolesRequest: zod(AssignRolesSchema),
    RotatePasswordRequest: zod(RotatePasswordSchema),
    CreateRoleRequest: zod(CreateRoleSchema),
    UpdateRoleRequest: zod(UpdateRoleSchema),
    CreateClientRequest: zod(CreateClientSchema),
    UpdateClientRequest: zod(UpdateClientSchema),
    RotateClientSecretRequest: zod(RotateClientSecretSchema),
    CreateServiceAccountRequest: zod(CreateServiceAccountSchema),
    UpdateServiceAccountRequest: zod(UpdateServiceAccountSchema),
    CreateSystemUserRequest: zod(CreateSystemUserSchema),
    UpdateSystemUserRequest: zod(UpdateSystemUserSchema),

    // Response schemas (hand-written)
    ApiError: {
      type: 'object',
      properties: {
        error: { type: 'string' },
        message: { type: 'string' },
      },
    },
    User: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        username: { type: 'string' },
        email: { type: 'string' },
        displayName: { type: 'string' },
        status: { type: 'string', enum: ['ACTIVE', 'LOCKED', 'DISABLED'] },
        mfaEnabled: { type: 'boolean' },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
        roles: { type: 'array', items: ref('RoleSummary') },
      },
    },
    RoleSummary: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
      },
    },
    Role: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        permissions: { type: 'array', items: { type: 'string' } },
        isSystem: { type: 'boolean' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    Client: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        clientId: { type: 'string' },
        allowedIps: { type: 'string' },
        enabled: { type: 'boolean' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    ServiceAccount: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        keyPrefix: { type: 'string' },
        status: { type: 'string', enum: ['ACTIVE', 'DISABLED'] },
        allowedIps: { type: 'string' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    Session: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        userId: { type: 'string' },
        ipAddress: { type: 'string' },
        userAgent: { type: 'string' },
        expiresAt: { type: 'string', format: 'date-time' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    AuditEvent: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        eventType: { type: 'string' },
        category: { type: 'string' },
        action: { type: 'string' },
        outcome: { type: 'string', enum: ['SUCCESS', 'FAILURE', 'DENIED'] },
        actorType: { type: 'string' },
        actorId: { type: 'string' },
        actorEmail: { type: 'string' },
        ipAddress: { type: 'string' },
        hostName: { type: 'string' },
        timestamp: { type: 'string', format: 'date-time' },
      },
    },
    TokenInfo: {
      type: 'object',
      properties: {
        sub: { type: 'string' },
        email: { type: 'string' },
        roles: { type: 'array', items: { type: 'string' } },
        permissions: { type: 'array', items: { type: 'string' } },
        sessionId: { type: 'string' },
        exp: { type: 'number' },
        iat: { type: 'number' },
      },
    },
    PasswordPolicy: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        minLength: { type: 'integer' },
        requireUppercase: { type: 'boolean' },
        requireLowercase: { type: 'boolean' },
        requireNumbers: { type: 'boolean' },
        requireSpecial: { type: 'boolean' },
        maxAgeDays: { type: 'integer' },
        historyCount: { type: 'integer' },
      },
    },
  }

  const paths: Record<string, unknown> = {
    // ── Health ──
    '/api/v1/health': {
      get: {
        tags: ['Health'],
        summary: 'Compatibility dependency health check',
        operationId: 'getHealth',
        responses: success({ type: 'object', properties: { status: { type: 'string' }, timestamp: { type: 'string' }, checks: { type: 'array', items: { type: 'object' } } } }),
      },
    },
    '/api/v1/health/live': {
      get: {
        tags: ['Health'],
        summary: 'Dependency-free liveness check',
        operationId: 'getHealthLive',
        responses: success({ type: 'object', properties: { status: { type: 'string' }, timestamp: { type: 'string' }, checks: { type: 'array', items: { type: 'object' } } } }),
      },
    },
    '/api/v1/health/ready': {
      get: {
        tags: ['Health'],
        summary: 'Readiness check for SQLite and Redis',
        operationId: 'getHealthReady',
        responses: success({ type: 'object', properties: { status: { type: 'string' }, timestamp: { type: 'string' }, checks: { type: 'array', items: { type: 'object' } } } }),
      },
    },
    '/api/v1/health/dependencies': {
      get: {
        tags: ['Health'],
        summary: 'Dependency health check for SQLite and Redis',
        operationId: 'getHealthDependencies',
        responses: success({ type: 'object', properties: { status: { type: 'string' }, timestamp: { type: 'string' }, checks: { type: 'array', items: { type: 'object' } } } }),
      },
    },

    // ── Auth ──
    '/api/v1/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Login with username and password',
        operationId: 'login',
        requestBody: jsonBody(ref('LoginRequest')),
        responses: {
          ...success({ type: 'object', properties: { accessToken: { type: 'string' }, refreshToken: { type: 'string' }, expiresIn: { type: 'number' } } }, 'Login successful'),
          400: err400, 401: err401,
        },
      },
    },
    '/api/v1/auth/refresh': {
      post: {
        tags: ['Auth'],
        summary: 'Refresh access token',
        operationId: 'refreshToken',
        requestBody: jsonBody(ref('RefreshRequest')),
        responses: {
          ...success({ type: 'object', properties: { accessToken: { type: 'string' }, refreshToken: { type: 'string' }, expiresIn: { type: 'number' } } }),
          401: err401,
        },
      },
    },
    '/api/v1/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Logout and revoke session',
        operationId: 'logout',
        security: [{ BearerAuth: [] }],
        responses: success({ type: 'object', properties: { message: { type: 'string' } } }),
      },
    },
    '/api/v1/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'Get current authenticated user profile',
        operationId: 'getMe',
        security: [{ BearerAuth: [] }],
        responses: { ...success(ref('User')), 401: err401 },
      },
    },
    '/api/v1/auth/password': {
      post: {
        tags: ['Auth'],
        summary: 'Change password',
        operationId: 'changePassword',
        security: [{ BearerAuth: [] }],
        requestBody: jsonBody(ref('ChangePasswordRequest')),
        responses: { ...success({ type: 'object', properties: { message: { type: 'string' } } }), 400: err400, 401: err401 },
      },
    },
    '/api/v1/auth/public-key': {
      get: {
        tags: ['Auth'],
        summary: 'Get JWT RS256 public key (PEM)',
        operationId: 'getPublicKey',
        responses: success({ type: 'object', properties: { publicKey: { type: 'string' } } }),
      },
    },
    '/api/v1/auth/mfa/setup': {
      post: {
        tags: ['Auth'],
        summary: 'Initialize TOTP MFA setup',
        operationId: 'mfaSetup',
        security: [{ BearerAuth: [] }],
        responses: { ...success({ type: 'object', properties: { secret: { type: 'string' }, qrCode: { type: 'string' }, backupCodes: { type: 'array', items: { type: 'string' } } } }), 401: err401 },
      },
    },
    '/api/v1/auth/mfa/verify': {
      post: {
        tags: ['Auth'],
        summary: 'Verify TOTP code to enable MFA',
        operationId: 'mfaVerify',
        security: [{ BearerAuth: [] }],
        requestBody: jsonBody(ref('MfaVerifyRequest')),
        responses: { ...success({ type: 'object', properties: { message: { type: 'string' } } }), 400: err400, 401: err401 },
      },
    },
    '/api/v1/auth/mfa/challenge': {
      post: {
        tags: ['Auth'],
        summary: 'Complete MFA challenge during login',
        operationId: 'mfaChallenge',
        requestBody: jsonBody(ref('MfaChallengeRequest')),
        responses: {
          ...success({ type: 'object', properties: { accessToken: { type: 'string' }, refreshToken: { type: 'string' }, expiresIn: { type: 'number' } } }),
          400: err400, 401: err401,
        },
      },
    },
    '/api/v1/auth/mfa/disable': {
      post: {
        tags: ['Auth'],
        summary: 'Disable MFA for current user',
        operationId: 'mfaDisable',
        security: [{ BearerAuth: [] }],
        requestBody: jsonBody(ref('MfaDisableRequest')),
        responses: { ...success({ type: 'object', properties: { message: { type: 'string' } } }), 400: err400, 401: err401 },
      },
    },

    // ── Users ──
    '/api/v1/users': {
      get: {
        tags: ['Users'],
        summary: 'List users',
        operationId: 'listUsers',
        security: [{ BearerAuth: [] }],
        parameters: [
          qp('page', 'Page number', false, { type: 'integer', default: 1 }),
          qp('limit', 'Items per page', false, { type: 'integer', default: 50 }),
          qp('search', 'Search by username or email'),
          qp('status', 'Filter by status'),
        ],
        responses: {
          ...success({ type: 'object', properties: { users: { type: 'array', items: ref('User') }, total: { type: 'integer' } } }),
          401: err401, 403: err403,
        },
      },
      post: {
        tags: ['Users'],
        summary: 'Create user',
        operationId: 'createUser',
        security: [{ BearerAuth: [] }],
        requestBody: jsonBody(ref('CreateUserRequest')),
        responses: { ...created(ref('User')), 400: err400, 401: err401, 403: err403, 409: err409 },
      },
    },
    '/api/v1/users/{id}': {
      get: {
        tags: ['Users'],
        summary: 'Get user by ID',
        operationId: 'getUser',
        security: [{ BearerAuth: [] }],
        parameters: [pp('id', 'User ID')],
        responses: { ...success(ref('User')), 401: err401, 404: err404 },
      },
      patch: {
        tags: ['Users'],
        summary: 'Update user',
        operationId: 'updateUser',
        security: [{ BearerAuth: [] }],
        parameters: [pp('id', 'User ID')],
        requestBody: jsonBody(ref('UpdateUserRequest')),
        responses: { ...success(ref('User')), 400: err400, 401: err401, 403: err403, 404: err404 },
      },
      delete: {
        tags: ['Users'],
        summary: 'Delete user',
        operationId: 'deleteUser',
        security: [{ BearerAuth: [] }],
        parameters: [pp('id', 'User ID')],
        responses: { ...success({ type: 'object', properties: { message: { type: 'string' } } }), 401: err401, 403: err403, 404: err404 },
      },
    },
    '/api/v1/users/{id}/roles': {
      post: {
        tags: ['Users'],
        summary: 'Assign roles to user',
        operationId: 'assignRoles',
        security: [{ BearerAuth: [] }],
        parameters: [pp('id', 'User ID')],
        requestBody: jsonBody(ref('AssignRolesRequest')),
        responses: { ...success(ref('User')), 400: err400, 401: err401, 403: err403, 404: err404 },
      },
    },
    '/api/v1/users/{id}/rotate-password': {
      post: {
        tags: ['Users'],
        summary: 'Rotate and store a user password',
        operationId: 'rotateUserPassword',
        security: [{ BearerAuth: [] }],
        parameters: [pp('id', 'User ID')],
        requestBody: jsonBody(ref('RotatePasswordRequest')),
        responses: { ...success({ type: 'object', properties: { success: { type: 'boolean' } } }), 400: err400, 401: err401, 403: err403, 404: err404 },
      },
    },

    // ── Roles ──
    '/api/v1/roles': {
      get: {
        tags: ['Roles'],
        summary: 'List roles',
        operationId: 'listRoles',
        security: [{ BearerAuth: [] }],
        responses: { ...success({ type: 'object', properties: { roles: { type: 'array', items: ref('Role') } } }), 401: err401 },
      },
      post: {
        tags: ['Roles'],
        summary: 'Create role',
        operationId: 'createRole',
        security: [{ BearerAuth: [] }],
        requestBody: jsonBody(ref('CreateRoleRequest')),
        responses: { ...created(ref('Role')), 400: err400, 401: err401, 403: err403, 409: err409 },
      },
    },
    '/api/v1/roles/{id}': {
      get: {
        tags: ['Roles'],
        summary: 'Get role by ID',
        operationId: 'getRole',
        security: [{ BearerAuth: [] }],
        parameters: [pp('id', 'Role ID')],
        responses: { ...success(ref('Role')), 401: err401, 404: err404 },
      },
      patch: {
        tags: ['Roles'],
        summary: 'Update role',
        operationId: 'updateRole',
        security: [{ BearerAuth: [] }],
        parameters: [pp('id', 'Role ID')],
        requestBody: jsonBody(ref('UpdateRoleRequest')),
        responses: { ...success(ref('Role')), 400: err400, 401: err401, 403: err403, 404: err404 },
      },
      delete: {
        tags: ['Roles'],
        summary: 'Delete role',
        operationId: 'deleteRole',
        security: [{ BearerAuth: [] }],
        parameters: [pp('id', 'Role ID')],
        responses: { ...success({ type: 'object', properties: { message: { type: 'string' } } }), 401: err401, 403: err403, 404: err404 },
      },
    },

    // ── Service Accounts ──
    '/api/v1/service-accounts': {
      get: {
        tags: ['Service Accounts'],
        summary: 'List service accounts',
        operationId: 'listServiceAccounts',
        security: [{ BearerAuth: [] }],
        responses: { ...success({ type: 'object', properties: { serviceAccounts: { type: 'array', items: ref('ServiceAccount') } } }), 401: err401 },
      },
      post: {
        tags: ['Service Accounts'],
        summary: 'Create service account',
        operationId: 'createServiceAccount',
        security: [{ BearerAuth: [] }],
        requestBody: jsonBody(ref('CreateServiceAccountRequest')),
        responses: { ...created(ref('ServiceAccount')), 400: err400, 401: err401, 403: err403 },
      },
    },
    '/api/v1/service-accounts/{id}': {
      patch: {
        tags: ['Service Accounts'],
        summary: 'Update service account',
        operationId: 'updateServiceAccount',
        security: [{ BearerAuth: [] }],
        parameters: [pp('id', 'Service account ID')],
        requestBody: jsonBody(ref('UpdateServiceAccountRequest')),
        responses: { ...success(ref('ServiceAccount')), 400: err400, 401: err401, 403: err403, 404: err404 },
      },
      delete: {
        tags: ['Service Accounts'],
        summary: 'Delete service account',
        operationId: 'deleteServiceAccount',
        security: [{ BearerAuth: [] }],
        parameters: [pp('id', 'Service account ID')],
        responses: { ...success({ type: 'object', properties: { message: { type: 'string' } } }), 401: err401, 403: err403, 404: err404 },
      },
    },
    '/api/v1/service-accounts/{id}/rotate': {
      post: {
        tags: ['Service Accounts'],
        summary: 'Rotate API key for service account',
        operationId: 'rotateServiceAccountKey',
        security: [{ BearerAuth: [] }],
        parameters: [pp('id', 'Service account ID')],
        responses: { ...success({ type: 'object', properties: { apiKey: { type: 'string' }, message: { type: 'string' } } }), 401: err401, 403: err403, 404: err404 },
      },
    },

    // ── Clients ──
    '/api/v1/clients': {
      get: {
        tags: ['Clients'],
        summary: 'List clients',
        operationId: 'listClients',
        security: [{ BearerAuth: [] }],
        responses: { ...success({ type: 'object', properties: { clients: { type: 'array', items: ref('Client') } } }), 401: err401 },
      },
      post: {
        tags: ['Clients'],
        summary: 'Create client',
        operationId: 'createClient',
        security: [{ BearerAuth: [] }],
        requestBody: jsonBody(ref('CreateClientRequest')),
        responses: { ...created(ref('Client')), 400: err400, 401: err401, 403: err403 },
      },
    },
    '/api/v1/clients/{id}': {
      patch: {
        tags: ['Clients'],
        summary: 'Update client',
        operationId: 'updateClient',
        security: [{ BearerAuth: [] }],
        parameters: [pp('id', 'Client ID')],
        requestBody: jsonBody(ref('UpdateClientRequest')),
        responses: { ...success(ref('Client')), 400: err400, 401: err401, 403: err403, 404: err404 },
      },
      delete: {
        tags: ['Clients'],
        summary: 'Delete client',
        operationId: 'deleteClient',
        security: [{ BearerAuth: [] }],
        parameters: [pp('id', 'Client ID')],
        responses: { ...success({ type: 'object', properties: { message: { type: 'string' } } }), 401: err401, 403: err403, 404: err404 },
      },
    },
    '/api/v1/clients/{id}/rotate-secret': {
      post: {
        tags: ['Clients'],
        summary: 'Rotate a confidential client secret',
        operationId: 'rotateClientSecret',
        security: [{ BearerAuth: [] }],
        parameters: [pp('id', 'Client ID')],
        requestBody: jsonBody(ref('RotateClientSecretRequest')),
        responses: { ...success({ type: 'object', properties: { success: { type: 'boolean' } } }), 400: err400, 401: err401, 403: err403, 404: err404, 409: err409 },
      },
    },

    // ── Tokens ──
    '/api/v1/tokens/introspect': {
      post: {
        tags: ['Tokens'],
        summary: 'Introspect a JWT token',
        operationId: 'introspectToken',
        security: [{ BearerAuth: [] }],
        responses: { ...success(ref('TokenInfo')), 401: err401 },
      },
    },

    // ── Sessions ──
    '/api/v1/sessions': {
      get: {
        tags: ['Sessions'],
        summary: 'List active sessions',
        operationId: 'listSessions',
        security: [{ BearerAuth: [] }],
        parameters: [
          qp('userId', 'Filter by user ID'),
          qp('page', 'Page number', false, { type: 'integer', default: 1 }),
          qp('limit', 'Items per page', false, { type: 'integer', default: 50 }),
        ],
        responses: { ...success({ type: 'object', properties: { sessions: { type: 'array', items: ref('Session') }, total: { type: 'integer' } } }), 401: err401, 403: err403 },
      },
    },
    '/api/v1/sessions/{id}': {
      delete: {
        tags: ['Sessions'],
        summary: 'Revoke a session',
        operationId: 'revokeSession',
        security: [{ BearerAuth: [] }],
        parameters: [pp('id', 'Session ID')],
        responses: { ...success({ type: 'object', properties: { message: { type: 'string' } } }), 401: err401, 403: err403, 404: err404 },
      },
    },

    // ── System Users ──
    '/api/v1/system-users': {
      get: {
        tags: ['System Users'],
        summary: 'List system user mappings',
        operationId: 'listSystemUsers',
        security: [{ BearerAuth: [] }],
        responses: { ...success({ type: 'object', properties: { systemUsers: { type: 'array', items: { type: 'object' } } } }), 401: err401 },
      },
      post: {
        tags: ['System Users'],
        summary: 'Create system user mapping',
        operationId: 'createSystemUser',
        security: [{ BearerAuth: [] }],
        requestBody: jsonBody(ref('CreateSystemUserRequest')),
        responses: { ...created({ type: 'object' }), 400: err400, 401: err401, 403: err403 },
      },
    },
    '/api/v1/system-users/{id}': {
      patch: {
        tags: ['System Users'],
        summary: 'Update system user mapping',
        operationId: 'updateSystemUser',
        security: [{ BearerAuth: [] }],
        parameters: [pp('id', 'System user mapping ID')],
        requestBody: jsonBody(ref('UpdateSystemUserRequest')),
        responses: { ...success({ type: 'object' }), 400: err400, 401: err401, 403: err403, 404: err404 },
      },
      delete: {
        tags: ['System Users'],
        summary: 'Delete system user mapping',
        operationId: 'deleteSystemUser',
        security: [{ BearerAuth: [] }],
        parameters: [pp('id', 'System user mapping ID')],
        responses: { ...success({ type: 'object', properties: { success: { type: 'boolean' } } }), 401: err401, 403: err403, 404: err404 },
      },
    },

    // ── Audit ──
    '/api/v1/audit': {
      get: {
        tags: ['Audit'],
        summary: 'Query audit events',
        operationId: 'queryAuditEvents',
        security: [{ BearerAuth: [] }],
        parameters: [
          qp('page', 'Page number', false, { type: 'integer', default: 1 }),
          qp('limit', 'Items per page', false, { type: 'integer', default: 50 }),
          qp('category', 'Filter by category'),
          qp('actorId', 'Filter by actor ID'),
          qp('outcome', 'Filter by outcome'),
          qp('eventType', 'Filter by event type'),
          qp('from', 'Start date (ISO 8601)'),
          qp('to', 'End date (ISO 8601)'),
        ],
        responses: { ...success({ type: 'object', properties: { events: { type: 'array', items: ref('AuditEvent') }, total: { type: 'integer' } } }), 401: err401, 403: err403 },
      },
    },
    '/api/v1/audit/stats': {
      get: {
        tags: ['Audit'],
        summary: 'Get audit statistics (last 30 days)',
        operationId: 'getAuditStats',
        security: [{ BearerAuth: [] }],
        responses: {
          ...success({
            type: 'object',
            properties: {
              totalEvents: { type: 'integer' },
              successCount: { type: 'integer' },
              failureCount: { type: 'integer' },
              deniedCount: { type: 'integer' },
              byCategory: { type: 'object', additionalProperties: { type: 'integer' } },
            },
          }),
          401: err401, 403: err403,
        },
      },
    },
    '/api/v1/audit/export': {
      get: {
        tags: ['Audit'],
        summary: 'Export audit events as CSV, JSON, or syslog CEF',
        operationId: 'exportAuditEvents',
        security: [{ BearerAuth: [] }],
        parameters: [
          qp('format', 'Export format', false, { type: 'string', enum: ['csv', 'json', 'syslog'], default: 'csv' }),
          qp('from', 'Start date (ISO 8601)'),
          qp('to', 'End date (ISO 8601)'),
          qp('category', 'Filter by category'),
          qp('outcome', 'Filter by outcome'),
        ],
        responses: {
          200: {
            description: 'Export file download',
            content: {
              'text/csv': { schema: { type: 'string' } },
              'application/json': { schema: { type: 'object' } },
              'text/plain': { schema: { type: 'string' } },
            },
          },
          401: err401, 403: err403,
        },
      },
    },
    '/api/v1/audit/stream': {
      get: {
        tags: ['Audit'],
        summary: 'SSE live tail of audit events',
        operationId: 'streamAuditEvents',
        security: [{ BearerAuth: [] }],
        responses: {
          200: {
            description: 'Server-Sent Events stream',
            content: { 'text/event-stream': { schema: { type: 'string' } } },
          },
          401: err401, 403: err403,
        },
      },
    },
    '/api/v1/audit/ingest': {
      post: {
        tags: ['Audit'],
        summary: 'Ingest audit events from IAM agent',
        operationId: 'ingestAuditEvents',
        security: [{ AgentToken: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } },
        },
        responses: { ...success({ type: 'object', properties: { ingested: { type: 'integer' } } }), 401: err401 },
      },
    },

    // ── Password Policy ──
    '/api/v1/password-policy': {
      get: {
        tags: ['Password Policy'],
        summary: 'Get active password policy',
        operationId: 'getPasswordPolicy',
        security: [{ BearerAuth: [] }],
        responses: { ...success(ref('PasswordPolicy')), 401: err401 },
      },
      patch: {
        tags: ['Password Policy'],
        summary: 'Update password policy (admin only)',
        operationId: 'updatePasswordPolicy',
        security: [{ BearerAuth: [] }],
        requestBody: jsonBody({ type: 'object', properties: { minLength: { type: 'integer' }, requireUppercase: { type: 'boolean' }, maxAgeDays: { type: 'integer' }, historyCount: { type: 'integer' } } } as unknown as ReturnType<typeof ref>),
        responses: { ...success(ref('PasswordPolicy')), 400: err400, 401: err401, 403: err403 },
      },
    },
    '/api/v1/password-policy/strength': {
      post: {
        tags: ['Password Policy'],
        summary: 'Check password strength score',
        operationId: 'checkPasswordStrength',
        requestBody: jsonBody({ type: 'object', properties: { password: { type: 'string' } }, required: ['password'] } as unknown as ReturnType<typeof ref>),
        responses: { ...success({ type: 'object', properties: { score: { type: 'integer' }, label: { type: 'string' } } }) },
      },
    },
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Hive IAM Core API',
      version: '1.0.0',
      description: 'Centralized Identity & Access Management API for the Hive platform. Handles authentication (RS256 JWT), authorization (RBAC), user management, service accounts, audit logging, MFA, and password policies.',
    },
    servers: [
      { url: 'http://localhost:4200', description: 'Local development' },
    ],
    tags,
    components: {
      schemas: componentSchemas,
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'RS256 JWT access token obtained from POST /api/v1/auth/login',
        },
        AgentToken: {
          type: 'apiKey',
          in: 'header',
          name: 'x-agent-token',
          description: 'Shared secret for IAM agent authentication',
        },
        ClientSecret: {
          type: 'apiKey',
          in: 'header',
          name: 'x-client-secret',
          description: 'Client secret for OAuth client authentication',
        },
      },
    },
    paths,
  }
}
