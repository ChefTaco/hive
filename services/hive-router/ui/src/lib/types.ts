// Shared admin-plane entity contracts (owned locally by the UI).

export interface AdminUser {
  id: string;
  username: string;
  displayName?: string | null;
  roles?: string[];
  permissions?: string[];
}

export interface HiveActor {
  id: string;
  kind: 'user' | 'service-account' | 'system-user' | 'router-key' | 'memory-agent';
  label: string;
  status: 'active' | 'inactive' | 'unknown';
  sources: string[];
  identifiers: Record<string, unknown>;
  capabilities: string[];
  lastActivityAt: string | null;
  linkedResourceCount: number;
}

export interface HiveActorCreateRequest {
  workspaceId?: string;
  owningProject?: string;
  expiresHours?: number;
  agentId: string;
  displayName: string;
  description?: string;
  iamClientId: string;
  roleIds?: string[];
  scopes?: string[];
  hostLabel?: string;
  allowedIps?: string[];
}

export interface HiveActorLifecycleRequest {
  operationId?: string;
  kind?: HiveActor['kind'];
  label?: string;
  identifiers?: Record<string, unknown>;
}

export interface HiveActorLifecycleResponse extends Record<string, unknown> {
  ok: boolean;
  identifiers?: Record<string, unknown>;
  secrets?: Record<string, string | null>;
  steps?: Array<Record<string, unknown>>;
}

export interface HiveIncidentEvent {
  id: string;
  service: 'router' | 'iam' | 'memory';
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  timestamp: string;
  title: string;
  requestId: string | null;
  actor: string | null;
  outcome: string | null;
  details: Record<string, unknown>;
}

export interface HiveIncident {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  status: 'open' | 'resolved';
  title: string;
  summary: string;
  startedAt: string;
  endedAt: string;
  requestIds: string[];
  services: string[];
  actors: string[];
  events: HiveIncidentEvent[];
}

export interface MemoryConsoleData {
  configured: boolean;
  error?: string;
  stats: Record<string, unknown> | null;
  queue: Record<string, unknown> | null;
  memories: Array<Record<string, unknown>>;
  memoryTotal: unknown;
  sessions: Array<Record<string, unknown>>;
  agents: Array<Record<string, unknown>>;
  graphEntities: Array<Record<string, unknown>>;
}

export interface MemorySearchResponse extends Record<string, unknown> {
  results?: Array<Record<string, unknown>>;
  memories?: Array<Record<string, unknown>>;
  items?: Array<Record<string, unknown>>;
}

export type {
  HiveAppKey,
  HiveAppState,
  HiveAppStatus,
  HiveHealthCheck,
  HiveStatusResponse as HiveStatus,
  TlsCertificateStatus,
} from '@hivemem/contracts';

export type {
  IamAssignRolesRequest,
  IamCreateClientRequest as CreateIamClientRequest,
  IamCreateRoleRequest as CreateIamRoleRequest,
  IamCreateServiceAccountRequest as CreateIamServiceAccountRequest,
  IamCreateSystemUserRequest as CreateIamSystemUserRequest,
  IamCreateUserRequest as CreateIamUserRequest,
  IamRotatePasswordRequest,
  IamUpdateClientRequest as UpdateIamClientRequest,
  IamUpdateRoleRequest as UpdateIamRoleRequest,
  IamUpdateServiceAccountRequest as UpdateIamServiceAccountRequest,
  IamUpdateSystemUserRequest as UpdateIamSystemUserRequest,
  IamUpdateUserRequest as UpdateIamUserRequest,
} from '@hivemem/contracts/ui-api';

export interface IamLoginResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  sessionId: string;
  user: {
    id: string;
    email: string;
    username: string;
    displayName?: string | null;
    roles: string[];
    permissions: string[];
  };
}

export interface IamRoleSummary {
  name: string;
  label: string;
}

export interface IamRoleAssignment {
  roleId?: string;
  grantedAt?: string;
  grantedBy?: string | null;
  role: IamRoleSummary;
}

export interface IamUser {
  id: string;
  email: string;
  username: string;
  displayName: string | null;
  active: boolean;
  lockedUntil?: string | null;
  failedAttempts?: number;
  mfaEnabled?: boolean;
  mfaVerifiedAt?: string | null;
  passkeyCount?: number;
  trustedDeviceCount?: number;
  passwordChangedAt?: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  roles: IamRoleAssignment[];
}

export interface IamRole {
  id: string;
  name: string;
  label: string;
  description: string | null;
  permissions: string[];
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IamClient {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  clientType: 'public' | 'confidential';
  redirectUris: string[];
  grantTypes: string[];
  allowedIps?: string[];
  firstParty: boolean;
  createdAt: string;
  updatedAt?: string;
}

export interface IamServiceAccount {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  apiKeyPrefix?: string | null;
  keyPrefix?: string | null;
  allowedIps?: string[];
  expiresAt?: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  roles: IamRoleAssignment[];
  client?: { name: string } | null;
}

export interface IamSystemUser {
  id: string;
  userId: string;
  linuxUsername: string;
  sudoEnabled: boolean;
  sshPublicKey?: string | null;
  authorizedHosts: string[];
  createdAt: string;
  user?: { email: string; username: string; displayName: string | null; active: boolean } | null;
}

export interface IamSession {
  id: string;
  userId: string;
  ipAddress: string | null;
  userAgent: string | null;
  riskScore?: number;
  riskFactors?: string[] | string | null;
  stepUpVerifiedAt?: string | null;
  createdAt: string;
  expiresAt: string;
  user?: { email: string; username: string; displayName: string | null } | null;
}

export interface IamPasswordPolicy {
  name: string;
  minLength: number;
  maxLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumbers: boolean;
  requireSpecial: boolean;
  maxAgeDays: number;
  historyCount: number;
  lockoutAttempts: number;
  lockoutDurationMin: number;
}

export interface IamAuditStats {
  totalEvents: number;
  successCount: number;
  failureCount: number;
  deniedCount: number;
  byCategory: Record<string, number>;
}

export interface IamAuditEvent {
  id: string;
  timestamp: string;
  eventType: string;
  category: string;
  actorId?: string | null;
  actorType: string;
  actorEmail?: string | null;
  ipAddress?: string | null;
  hostName?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  action: string;
  outcome: string;
  source?: string | null;
  detail?: Record<string, unknown>;
}

export interface ProviderModel {
  id?: string;
  model: string;
  displayName?: string | null;
  enabled?: boolean;
  maxContextWindow?: number | null;
  capabilityJson?: string;
}

export interface ProviderModelWriteRequest {
  model: string;
  displayName?: string | null;
  enabled?: boolean;
  maxContextWindow?: number | null;
  capabilityJson?: Record<string, unknown>;
}

export interface ProviderWriteRequest {
  slug: string;
  name: string;
  kind: string;
  baseUrl: string;
  authMode: string;
  authHeaderName: string;
  authSecret?: string;
  defaultHeaders: Record<string, string>;
  capabilities: Record<string, unknown>;
  models: ProviderModelWriteRequest[];
  timeoutMs: number;
  maxRetries: number;
  concurrency: number;
  priority: number;
  weight: number;
  failoverGroup?: string;
  enabled: boolean;
}

export interface Provider {
  id: string;
  slug: string;
  name: string;
  kind: string;
  baseUrl: string;
  authMode: string;
  authHeaderName: string;
  authSecretMasked?: string | null;
  defaultHeaders: Record<string, string>;
  capabilities: Record<string, unknown>;
  timeoutMs: number;
  maxRetries: number;
  concurrency: number;
  priority: number;
  weight: number;
  failoverGroup?: string | null;
  enabled: boolean;
  lastHealthStatus?: string | null;
  lastHealthError?: string | null;
  lastHealthAt?: string | null;
  models: ProviderModel[];
}

export interface CodexOAuthStatus {
  authorized: boolean;
  provider?: Provider | null;
  accountIdMasked?: string | null;
  planType?: string | null;
  lastRefreshAt?: string | null;
  refreshTokenQuarantined?: boolean;
}

export interface CodexOAuthStart {
  loginId: string;
  deviceAuthId: string;
  verificationUrl: string;
  userCode: string;
  intervalSeconds: number;
  expiresAt: string;
}

export interface CodexOAuthCheck {
  status: 'pending' | 'authorized' | 'expired' | 'error';
  message?: string;
  provider?: Provider | null;
  accountIdMasked?: string | null;
  planType?: string | null;
  lastRefreshAt?: string | null;
}

export interface ModelAlias {
  id: string;
  alias: string;
  providerId?: string | null;
  upstreamModel: string;
  enabled: boolean;
  description?: string | null;
  provider?: { id: string; name: string; slug: string; kind?: string } | null;
}

export interface RouteRule {
  id: string;
  name: string;
  kind: string;
  priority: number;
  enabled: boolean;
  matchJson: string;
  actionJson: string;
}

export interface HeuristicRule {
  id: string;
  name: string;
  category: string;
  pattern: string;
  score: number;
  enabled: boolean;
  actionJson: string;
}

export interface ModelAliasWriteRequest {
  alias: string;
  providerId?: string;
  upstreamModel: string;
  enabled: boolean;
  description?: string;
}

export interface RouteRuleWriteRequest {
  name: string;
  kind: string;
  priority: number;
  enabled: boolean;
  matchJson: Record<string, unknown>;
  actionJson: Record<string, unknown>;
}

export interface HeuristicWriteRequest {
  name: string;
  category: string;
  pattern: string;
  score: number;
  enabled: boolean;
  actionJson: Record<string, unknown>;
}

export interface ClientKeyMetadataInput {
  owner?: string;
  purpose?: string;
  scopes?: string[];
  tags?: string[];
  environment?: 'dev' | 'test' | 'staging' | 'prod';
  expiresAt?: string;
  rotation?: {
    cadenceDays?: number;
    lastRotatedAt?: string;
    nextRotateBy?: string;
  };
  notes?: string;
  labels?: Record<string, string>;
}

export interface ClientKeyCreateRequest {
  name: string;
  metadata?: ClientKeyMetadataInput;
}

export interface ClientKeyUpdateRequest {
  name?: string;
  enabled?: boolean;
  metadata?: ClientKeyMetadataInput;
}

export interface ConfigImportRequest {
  data?: {
    providers?: Array<Record<string, unknown>>;
    aliases?: Array<Record<string, unknown>>;
    routeRules?: Array<Record<string, unknown>>;
    heuristicRules?: Array<Record<string, unknown>>;
    runtimeSettings?: Array<{ key: string; valueJson: string }>;
  };
}

export interface ClientKey {
  id: string;
  name: string;
  keyPrefix: string;
  enabled: boolean;
  createdAt?: string;
  lastUsedAt?: string | null;
  metadataJson?: string | null;
}

export interface Telemetry {
  totals: { traces: number; failures: number; failovers: number };
  latestTrace?: Record<string, unknown> | null;
}

export interface Trace {
  id: string;
  createdAt: string;
  method: string;
  path: string;
  routeKey?: string;
  outcome: string;
  statusCode?: number | null;
  providerKind?: string | null;
  providerModel?: string | null;
  provider?: { name?: string; slug?: string } | null;
  events?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface AuditEvent {
  id: string;
  createdAt: string;
  actorType: string;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  metadataJson?: string | null;
  adminUser?: { username?: string } | null;
}

export interface RoutingTestResult {
  requestId: string;
  category: string;
  modelAlias: string;
  prompt: string;
  requestBody: string;
  targetModel?: string | null;
  latencyMs: number;
  success: boolean;
  statusCode: number;
  providerError?: string | null;
  responsePreview: string;
  decision: {
    selectedProviderId?: string | null;
    selectedProviderKind?: string | null;
    targetModel?: string | null;
    candidateProviderIds: string[];
    fallbackProviderIds: string[];
    observations: unknown[];
    triggeredRuleNames: string[];
    confidence: number;
    denialReason?: string | null;
    passthroughTargetPath?: string | null;
  };
  candidates: Array<{
    id: string;
    name: string;
    slug: string;
    kind: string;
  }>;
  attempts: Array<{
    provider: {
      id: string;
      name: string;
      slug: string;
      kind: string;
    };
    latencyMs: number;
    statusCode: number;
    success: boolean;
    error?: string | null;
  }>;
  selectedProvider: { id: string; name: string; slug: string; kind: string; model?: string | null } | null;
}

export interface RuntimeSetting {
  key: string;
  valueJson: string;
  parsed?: unknown;
}

export type RoutingGoal = 'balanced' | 'cheapest' | 'fastest' | 'highest-quality';

export interface RoutingObjectiveConfig {
  goal: RoutingGoal;
  costWeight?: number;
  qualityWeight?: number;
  throughputWeight?: number;
  missingPricePenalty?: number;
}

export interface ApiDoc {
  id?: string;
  title?: string;
  scope?: string;
  providerKind?: string;
  method?: string;
  path?: string;
  summary?: string;
  description?: string;
  [key: string]: unknown;
}
