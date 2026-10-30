import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { adminApi, ApiError } from './api';
import type {
  ApiDoc,
  AuditEvent,
  ClientKey,
  HeuristicRule,
  HiveActor,
  HiveIncident,
  HiveStatus,
  ModelAlias,
  Provider,
  RouteRule,
  RuntimeSetting,
  Telemetry,
  Trace,
} from './types';

export interface RouterData {
  providers: Provider[];
  aliases: ModelAlias[];
  routeRules: RouteRule[];
  heuristics: HeuristicRule[];
  clientKeys: ClientKey[];
  telemetry: Telemetry | null;
  traces: Trace[];
  audit: AuditEvent[];
  actors: HiveActor[];
  incidents: HiveIncident[];
  runtimeSettings: RuntimeSetting[];
  docs: ApiDoc[];
  hiveStatus: HiveStatus | null;
}

const EMPTY: RouterData = {
  providers: [],
  aliases: [],
  routeRules: [],
  heuristics: [],
  clientKeys: [],
  telemetry: null,
  traces: [],
  audit: [],
  actors: [],
  incidents: [],
  runtimeSettings: [],
  docs: [],
  hiveStatus: null,
};

export interface ResourceFreshness { lastSuccess: string | null; error: string | null }
interface StoreApi {
  resourceFreshness: Partial<Record<keyof RouterData, ResourceFreshness>>;
  data: RouterData;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  loadIssues: string[];
  lastSync: Date | null;
  refresh: () => Promise<void>;
  onAuthExpired: () => void;
}

const StoreContext = createContext<StoreApi | null>(null);

export function useStore(): StoreApi {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used within StoreProvider');
  return ctx;
}

export function StoreProvider({ onAuthExpired, children }: { onAuthExpired: () => void; children: ReactNode }) {
  const [data, setData] = useState<RouterData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadIssues, setLoadIssues] = useState<string[]>([]);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [resourceFreshness, setResourceFreshness] = useState<Partial<Record<keyof RouterData, ResourceFreshness>>>({});
  const firstLoad = useRef(true);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const refreshId = ++generation.current;
    if (firstLoad.current) setLoading(true);
    else setRefreshing(true);
    setError(null);
    setLoadIssues([]);
    try {
      const requests = {
        providers: adminApi.providers(),
        aliases: adminApi.aliases(),
        routeRules: adminApi.routeRules(),
        heuristics: adminApi.heuristics(),
        clientKeys: adminApi.clientKeys(),
        telemetry: adminApi.telemetry(),
        traces: adminApi.traces(),
        audit: adminApi.audit(),
        actors: adminApi.hiveActors(),
        incidents: adminApi.hiveIncidents(),
        runtimeSettings: adminApi.runtimeSettings(),
        docs: adminApi.docsIndex(),
        hiveStatus: adminApi.hiveStatus(),
      };
      const keys = Object.keys(requests) as Array<keyof typeof requests>;
      const settled = await Promise.allSettled(keys.map((key) => requests[key]));
      if (refreshId !== generation.current) return;
      const values = new Map<string, unknown>();
      const issues: string[] = [];
      const timestamp = new Date().toISOString();
      setResourceFreshness((previous) => {
        const next = { ...previous };
        for (let index = 0; index < keys.length; index++) {
          const key = keys[index]!; const result = settled[index]!;
          if (result.status === 'fulfilled') next[key] = { lastSuccess: timestamp, error: null };
          else next[key] = { lastSuccess: previous[key]?.lastSuccess ?? null, error: result.reason instanceof Error ? result.reason.message : 'Request failed' };
        }
        return next;
      });
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index]!; const result = settled[index]!;
        if (result.status === 'fulfilled') values.set(key, result.value);
        else {
          if (result.reason instanceof ApiError && result.reason.status === 401) { onAuthExpired(); return; }
          issues.push(`${key}: ${result.reason instanceof Error ? result.reason.message : 'Unavailable'}`);
        }
      }
      setLoadIssues(issues);
      setError(issues.length ? `${issues.length} console sections failed to refresh; previous data remains visible` : null);
      setData((previous) => ({
        providers: (values.get('providers') as Awaited<ReturnType<typeof adminApi.providers>> | undefined)?.data ?? previous.providers,
        aliases: (values.get('aliases') as Awaited<ReturnType<typeof adminApi.aliases>> | undefined)?.data ?? previous.aliases,
        routeRules: (values.get('routeRules') as Awaited<ReturnType<typeof adminApi.routeRules>> | undefined)?.data ?? previous.routeRules,
        heuristics: (values.get('heuristics') as Awaited<ReturnType<typeof adminApi.heuristics>> | undefined)?.data ?? previous.heuristics,
        clientKeys: (values.get('clientKeys') as Awaited<ReturnType<typeof adminApi.clientKeys>> | undefined)?.data ?? previous.clientKeys,
        telemetry: (values.get('telemetry') as Awaited<ReturnType<typeof adminApi.telemetry>> | undefined) ?? previous.telemetry,
        traces: (values.get('traces') as Awaited<ReturnType<typeof adminApi.traces>> | undefined)?.data ?? previous.traces,
        audit: (values.get('audit') as Awaited<ReturnType<typeof adminApi.audit>> | undefined)?.data ?? previous.audit,
        actors: (values.get('actors') as Awaited<ReturnType<typeof adminApi.hiveActors>> | undefined)?.data ?? previous.actors,
        incidents: (values.get('incidents') as Awaited<ReturnType<typeof adminApi.hiveIncidents>> | undefined)?.data ?? previous.incidents,
        runtimeSettings: (values.get('runtimeSettings') as Awaited<ReturnType<typeof adminApi.runtimeSettings>> | undefined)?.data ?? previous.runtimeSettings,
        docs: (values.get('docs') as Awaited<ReturnType<typeof adminApi.docsIndex>> | undefined)?.docs ?? previous.docs,
        hiveStatus: (values.get('hiveStatus') as Awaited<ReturnType<typeof adminApi.hiveStatus>> | undefined) ?? previous.hiveStatus,
      }));
      setLastSync(new Date());
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        onAuthExpired();
        return;
      }
      setError(caught instanceof Error ? caught.message : 'Failed to load admin data');
    } finally {
      if (refreshId !== generation.current) return;
      firstLoad.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, [onAuthExpired]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <StoreContext.Provider value={{ data, loading, refreshing, error, loadIssues, lastSync, refresh, onAuthExpired, resourceFreshness }}>
      {children}
    </StoreContext.Provider>
  );
}
