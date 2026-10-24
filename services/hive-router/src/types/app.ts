import type { AdminUser, ClientApiKey } from '@prisma/client';

export interface TraceRuntimeContext {
  traceId: string;
  requestId: string;
}

export interface AppVariables {
  requestId: string;
  adminUser?: AdminUser;
  adminRoles?: string[];
  adminPermissions?: string[];
  clientApiKey?: ClientApiKey;
  traceContext?: TraceRuntimeContext;
}
