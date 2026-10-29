import { MemoryWriteSchema, type MemoryWrite } from '@contracts/memory-operations.js';
import type {
  AdminUser,
  ApiDoc,
  AuditEvent,
  ClientKey,
  ClientKeyCreateRequest,
  ClientKeyUpdateRequest,
  ConfigImportRequest,
  CodexOAuthCheck,
  CodexOAuthStart,
  CodexOAuthStatus,
  CreateIamClientRequest,
  CreateIamRoleRequest,
  CreateIamServiceAccountRequest,
  CreateIamSystemUserRequest,
  CreateIamUserRequest,
  HeuristicRule,
  HeuristicWriteRequest,
  HiveStatus,
  HiveActor,
  HiveActorCreateRequest,
  HiveIncident,
  HiveActorLifecycleRequest,
  HiveActorLifecycleResponse,
  IamAuditEvent,
  IamAuditStats,
  IamClient,
  IamPasswordPolicy,
  IamRole,
  IamSession,
  IamServiceAccount,
  IamSystemUser,
  IamUser,
  MemoryConsoleData,
  MemorySearchResponse,
  ModelAlias,
  ModelAliasWriteRequest,
  Provider,
  ProviderWriteRequest,
  RoutingTestResult,
  RouteRule,
  RouteRuleWriteRequest,
  RoutingObjectiveConfig,
  RuntimeSetting,
  Telemetry,
  Trace,
  UpdateIamClientRequest,
  UpdateIamRoleRequest,
  UpdateIamServiceAccountRequest,
  UpdateIamSystemUserRequest,
  UpdateIamUserRequest,
} from './types';
import type { IamAssignRolesRequest, IamRotatePasswordRequest, JsonRequestBody } from '@contracts/ui-api.generated.js';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

interface RequestOptions<TBody extends JsonRequestBody = JsonRequestBody> {
  method?: string;
  body?: TBody;
  headers?: Record<string, string> | undefined;
}

async function request<T, TBody extends JsonRequestBody = JsonRequestBody>(path: string, options: RequestOptions<TBody> = {}): Promise<T> {
  const body = options.body !== undefined ? JSON.stringify(options.body) : null;
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(options.headers ?? {}) },
    credentials: 'include',
    ...(body ? { body } : {}),
  });

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    const text = await response.text();
    if (text) {
      try {
        const parsed = JSON.parse(text) as { error?: string; message?: string };
        message = parsed.error ?? parsed.message ?? text;
      } catch {
        message = text;
      }
    }
    throw new ApiError(message, response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

function iamPath(path: string): string {
  return `/api/iam/${path.replace(/^\/+/, '')}`;
}

export const adminApi = {
  // ---- auth ----
  login(username: string, password: string) {
    return request<{ ok: boolean; user: AdminUser }>('/api/auth/login', {
      method: 'POST',
      body: { username, password },
    });
  },
  logout() {
    return request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
  },
  me() {
    return request<{ user: AdminUser }>('/api/auth/me');
  },

  // ---- hive console ----
  hiveStatus() {
    return request<HiveStatus>('/api/hive/status');
  },
  hiveActors() {
    return request<{ data: HiveActor[] }>('/api/hive/actors');
  },
  createHiveActor(body: HiveActorCreateRequest) {
    return request<HiveActorLifecycleResponse, HiveActorCreateRequest>('/api/hive/actors', { method: 'POST', body });
  },
  disableHiveActor(id: string, body: HiveActorLifecycleRequest) {
    return request<HiveActorLifecycleResponse, HiveActorLifecycleRequest>(`/api/hive/actors/${encodeURIComponent(id)}/disable`, { method: 'POST', body });
  },
  rotateHiveActor(id: string, body: HiveActorLifecycleRequest) {
    return request<HiveActorLifecycleResponse, HiveActorLifecycleRequest>(`/api/hive/actors/${encodeURIComponent(id)}/rotate`, { method: 'POST', body });
  },
  hiveIncidents() {
    return request<{ data: HiveIncident[] }>('/api/hive/incidents');
  },
  memoryConsole() {
    return request<MemoryConsoleData>('/api/memory/dashboard-data');
  },
  searchMemory(params: { query?: string; workspaceId?: string; scope?: string; limit?: number; offset?: number }) {
    const search = new URLSearchParams();
    if (params.query) search.set('query', params.query);
    search.set('workspace_id', params.workspaceId ?? '*');
    if (params.scope) search.set('scope', params.scope);
    search.set('limit', String(params.limit ?? 25));
    search.set('offset', String(params.offset ?? 0));
    return request<MemorySearchResponse>(`/api/memory/search?${search.toString()}`);
  },
  createMemory(body: MemoryWrite) {
    return request<Record<string, unknown>>('/api/memory/memories', { method: 'POST', body: MemoryWriteSchema.parse(body) });
  },
  getMemory(id: string) {
    return request<Record<string, unknown>>(`/api/memory/memories/${encodeURIComponent(id)}`);
  },
  updateMemory(id: string, body: Record<string, unknown>) {
    return request<Record<string, unknown>>(`/api/memory/memories/${encodeURIComponent(id)}`, { method: 'PATCH', body });
  },
  deleteMemory(id: string) {
    return request<Record<string, unknown>>(`/api/memory/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  memoryGraph(id: string) {
    return request<Record<string, unknown>>(`/api/memory/memories/${encodeURIComponent(id)}/graph`);
  },
  memoryQueue(limit = 12) {
    return request<Record<string, unknown>>(`/api/memory/queue?limit=${limit}`);
  },
  runMemoryQueueJob(id: string) {
    return request<Record<string, unknown>>(`/api/memory/queue/${encodeURIComponent(id)}/run`, { method: 'POST' });
  },
  retryMemoryQueueJob(id: string) {
    return request<Record<string, unknown>>(`/api/memory/queue/${encodeURIComponent(id)}/retry`, { method: 'POST' });
  },
  cancelMemoryQueueJob(id: string) {
    return request<Record<string, unknown>>(`/api/memory/queue/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  memoryConflicts(body: Record<string, unknown>) {
    return request<Record<string, unknown>>('/api/memory/conflicts', { method: 'POST', body });
  },
  memoryWebhooks() {
    return request<Record<string, unknown>>('/api/memory/webhooks');
  },
  memoryWebhookDeliveries(limit = 10) {
    return request<Record<string, unknown>>(`/api/memory/webhook-deliveries?limit=${limit}`);
  },

  // ---- IAM operations ----
  iamHealth() {
    return request<Record<string, unknown>>(iamPath('health'));
  },
  iamUsers() {
    return request<{ users: IamUser[]; total: number; page: number; limit: number }>(iamPath('users?limit=100'));
  },
  createIamUser(body: CreateIamUserRequest) {
    return request<{ user: IamUser }>(iamPath('users'), { method: 'POST', body });
  },
  updateIamUser(id: string, body: UpdateIamUserRequest) {
    return request<{ user: IamUser }>(iamPath(`users/${id}`), { method: 'PATCH', body });
  },
  deleteIamUser(id: string) {
    return request<{ success: boolean }>(iamPath(`users/${id}`), { method: 'DELETE' });
  },
  assignIamUserRoles(id: string, roleIds: string[]) {
    const body: IamAssignRolesRequest = { roleIds };
    return request<{ success: boolean }, IamAssignRolesRequest>(iamPath(`users/${id}/roles`), { method: 'POST', body });
  },
  removeIamUserRole(id: string, roleId: string) {
    return request<{ success: boolean }>(iamPath(`users/${id}/roles/${roleId}`), { method: 'DELETE' });
  },
  lockIamUser(id: string) {
    return request<{ success: boolean }>(iamPath(`users/${id}/lock`), { method: 'POST' });
  },
  unlockIamUser(id: string) {
    return request<{ success: boolean }>(iamPath(`users/${id}/unlock`), { method: 'POST' });
  },
  rotateIamUserPassword(id: string, password: string) {
    const body: IamRotatePasswordRequest = { password };
    return request<{ success: boolean }, IamRotatePasswordRequest>(iamPath(`users/${id}/rotate-password`), { method: 'POST', body });
  },
  iamRoles() {
    return request<{ roles: IamRole[] }>(iamPath('roles'));
  },
  createIamRole(body: CreateIamRoleRequest) {
    return request<{ role: IamRole }>(iamPath('roles'), { method: 'POST', body });
  },
  updateIamRole(id: string, body: UpdateIamRoleRequest) {
    return request<{ role: IamRole }>(iamPath(`roles/${id}`), { method: 'PATCH', body });
  },
  deleteIamRole(id: string) {
    return request<{ success: boolean }>(iamPath(`roles/${id}`), { method: 'DELETE' });
  },
  iamServiceAccounts() {
    return request<{ serviceAccounts: IamServiceAccount[] }>(iamPath('service-accounts'));
  },
  createIamServiceAccount(body: CreateIamServiceAccountRequest) {
    return request<{ id: string; apiKey: string; warning: string }>(iamPath('service-accounts'), { method: 'POST', body });
  },
  updateIamServiceAccount(id: string, body: UpdateIamServiceAccountRequest) {
    return request<{ serviceAccount: IamServiceAccount }>(iamPath(`service-accounts/${id}`), { method: 'PATCH', body });
  },
  deleteIamServiceAccount(id: string) {
    return request<{ success: boolean }>(iamPath(`service-accounts/${id}`), { method: 'DELETE' });
  },
  rotateIamServiceAccount(id: string) {
    return request<{ apiKey: string; warning: string }>(iamPath(`service-accounts/${id}/rotate`), { method: 'POST' });
  },
  iamClients() {
    return request<{ clients: IamClient[] }>(iamPath('clients'));
  },
  createIamClient(body: CreateIamClientRequest) {
    return request<{ client: IamClient }>(iamPath('clients'), { method: 'POST', body });
  },
  updateIamClient(id: string, body: UpdateIamClientRequest) {
    return request<{ client: IamClient }>(iamPath(`clients/${id}`), { method: 'PATCH', body });
  },
  deleteIamClient(id: string) {
    return request<{ success: boolean }>(iamPath(`clients/${id}`), { method: 'DELETE' });
  },
  iamSystemUsers() {
    return request<{ systemUsers: IamSystemUser[] }>(iamPath('system-users'));
  },
  createIamSystemUser(body: CreateIamSystemUserRequest) {
    return request<{ systemUser: IamSystemUser }>(iamPath('system-users'), { method: 'POST', body });
  },
  updateIamSystemUser(id: string, body: UpdateIamSystemUserRequest) {
    return request<{ systemUser: IamSystemUser }>(iamPath(`system-users/${id}`), { method: 'PATCH', body });
  },
  deleteIamSystemUser(id: string) {
    return request<{ success: boolean }>(iamPath(`system-users/${id}`), { method: 'DELETE' });
  },
  iamSessions() {
    return request<{ sessions: IamSession[] }>(iamPath('sessions'));
  },
  revokeIamSession(id: string) {
    return request<{ success: boolean }>(iamPath(`sessions/${id}`), { method: 'DELETE' });
  },
  deduplicateIamSessions() {
    return request<{ success: boolean; revoked: number }>(iamPath('sessions/deduplicate'), { method: 'POST' });
  },
  iamAudit() {
    return request<{ events: IamAuditEvent[]; total: number; page: number; limit: number }>(iamPath('audit?limit=50'));
  },
  iamAuditStats() {
    return request<IamAuditStats>(iamPath('audit/stats'));
  },
  iamPasswordPolicy() {
    return request<{ policy: IamPasswordPolicy }>(iamPath('password-policy'));
  },
  updateIamPasswordPolicy(body: Partial<IamPasswordPolicy>) {
    return request<{ policy: IamPasswordPolicy }, Partial<IamPasswordPolicy>>(iamPath('password-policy'), { method: 'PATCH', body });
  },

  // ---- providers ----
  providers() {
    return request<{ data: Provider[] }>('/api/providers');
  },
  createProvider(body: ProviderWriteRequest) {
    return request<{ data: Provider }>('/api/providers', { method: 'POST', body });
  },
  updateProvider(id: string, body: ProviderWriteRequest) {
    return request<{ data: Provider }>(`/api/providers/${id}`, { method: 'PUT', body });
  },
  deleteProvider(id: string) {
    return request<{ ok: boolean }>(`/api/providers/${id}`, { method: 'DELETE' });
  },
  codexOAuthStatus() {
    return request<{ data: CodexOAuthStatus }>('/api/providers/codex-oauth/status');
  },
  startCodexOAuth() {
    return request<{ data: CodexOAuthStart }>('/api/providers/codex-oauth/start', { method: 'POST' });
  },
  checkCodexOAuth(loginId: string) {
    return request<{ data: CodexOAuthCheck }>('/api/providers/codex-oauth/check', { method: 'POST', body: { loginId } });
  },

  // ---- model aliases ----
  aliases() {
    return request<{ data: ModelAlias[] }>('/api/model-aliases');
  },
  createAlias(body: ModelAliasWriteRequest) {
    return request<{ data: ModelAlias }>('/api/model-aliases', { method: 'POST', body });
  },
  updateAlias(id: string, body: ModelAliasWriteRequest) {
    return request<{ data: ModelAlias }>(`/api/model-aliases/${id}`, { method: 'PUT', body });
  },
  deleteAlias(id: string) {
    return request<{ ok: boolean }>(`/api/model-aliases/${id}`, { method: 'DELETE' });
  },

  // ---- route rules ----
  routeRules() {
    return request<{ data: RouteRule[] }>('/api/route-rules');
  },
  runRoutingTest(body: { category?: string; modelAlias: string; prompt: string; maxResponseChars?: number }) {
    return request<{ data: RoutingTestResult }>('/api/testing/run', { method: 'POST', body });
  },
  createRouteRule(body: RouteRuleWriteRequest) {
    return request<{ data: RouteRule }>('/api/route-rules', { method: 'POST', body });
  },
  updateRouteRule(id: string, body: RouteRuleWriteRequest) {
    return request<{ data: RouteRule }>(`/api/route-rules/${id}`, { method: 'PUT', body });
  },
  deleteRouteRule(id: string) {
    return request<{ ok: boolean }>(`/api/route-rules/${id}`, { method: 'DELETE' });
  },

  // ---- heuristics ----
  heuristics() {
    return request<{ data: HeuristicRule[] }>('/api/heuristics');
  },
  createHeuristic(body: HeuristicWriteRequest) {
    return request<{ data: HeuristicRule }>('/api/heuristics', { method: 'POST', body });
  },
  updateHeuristic(id: string, body: HeuristicWriteRequest) {
    return request<{ data: HeuristicRule }>(`/api/heuristics/${id}`, { method: 'PUT', body });
  },
  deleteHeuristic(id: string) {
    return request<{ ok: boolean }>(`/api/heuristics/${id}`, { method: 'DELETE' });
  },

  // ---- client keys ----
  clientKeys() {
    return request<{ data: ClientKey[] }>('/api/client-keys');
  },
  createClientKey(body: ClientKeyCreateRequest) {
    return request<{ data: ClientKey & { apiKey: string } }>('/api/client-keys', { method: 'POST', body });
  },
  updateClientKey(id: string, body: ClientKeyUpdateRequest) {
    return request<{ data: ClientKey }>(`/api/client-keys/${id}`, { method: 'PUT', body });
  },
  rotateClientKey(id: string) {
    return request<{ data: ClientKey & { apiKey: string } }>(`/api/client-keys/${id}/rotate`, { method: 'POST' });
  },
  deleteClientKey(id: string) {
    return request<{ ok: boolean }>(`/api/client-keys/${id}`, { method: 'DELETE' });
  },

  // ---- observability ----
  telemetry() {
    return request<Telemetry>('/api/telemetry');
  },
  traces() {
    return request<{ data: Trace[] }>('/api/traces');
  },
  audit() {
    return request<{ data: AuditEvent[] }>('/api/audit');
  },

  // ---- settings / config ----
  runtimeSettings() {
    return request<{ data: RuntimeSetting[] }>('/api/runtime-settings');
  },
  routingObjective() {
    return request<{ data: { config: RoutingObjectiveConfig } }>('/api/routing/objective');
  },
  updateRoutingObjective(body: RoutingObjectiveConfig) {
    return request<{ data: { config: RoutingObjectiveConfig } }>('/api/routing/objective', { method: 'PUT', body });
  },
  exportConfig() {
    return request<Record<string, unknown>>('/api/config/export');
  },
  importConfig(body: ConfigImportRequest) {
    return request<{ ok: boolean }>('/api/config/import', { method: 'POST', body });
  },

  // ---- docs ----
  docsIndex() {
    return request<{ docs: ApiDoc[]; providers: Provider[] }>('/api-docs/index');
  },
};
