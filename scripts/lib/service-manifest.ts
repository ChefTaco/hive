export type HiveServiceKey = 'router' | 'iam' | 'memory' | 'skills';
export type HiveSystemdServiceName = 'hive-router' | 'hive-iam' | 'hivemem' | 'hive-skills';

export interface HiveHostTarget {
  host: string;
  fqdn: string;
  optionalServices?: readonly HiveServiceKey[];
}

export type HiveEnv = Readonly<Record<string, string | undefined>>;

export interface HiveServiceEndpoint {
  name: string;
  urlTemplate: string;
  requiresAuth?: boolean;
}

export interface HiveServiceManifestEntry {
  key: HiveServiceKey;
  displayName: string;
  systemdService: HiveSystemdServiceName;
  deployScript: string;
  remoteRoot: string;
  envPath: string;
  envFallbackPaths: string[];
  requiredEnvKeys: string[];
  requiredPorts: number[];
  healthEndpoints: HiveServiceEndpoint[];
  requiredSystemd: Record<string, string>;
  backupPaths: string[];
  localEnvExamples: string[];
}

/**
 * Example topology used when `HIVE_HOSTS` is not configured: a primary host that
 * runs the Router, IAM and optional Skills, plus a memory host for HiveMem/Qdrant.
 */
export const HIVE_DEFAULT_HOSTS: readonly HiveHostTarget[] = [
  { host: 'hive', fqdn: 'hive.example.com', optionalServices: ['skills'] },
  { host: 'memory-host', fqdn: 'memory.example.com' },
] as const;

export const HIVE_SERVICES: readonly HiveServiceManifestEntry[] = [
  {
    key: 'router',
    displayName: 'Hive Router',
    systemdService: 'hive-router',
    deployScript: 'services/hive-router/scripts/deploy-hive-router.sh',
    remoteRoot: '/opt/hive-router',
    envPath: '/opt/hive-router/shared/.env',
    envFallbackPaths: ['/opt/hive-router/.env'],
    requiredEnvKeys: [
      'NODE_ENV',
      'PUBLIC_ADMIN_URL',
      'HIVE_IAM_INTERNAL_URL',
      'HIVEMEM_INTERNAL_URL',
      'HIVE_ROUTER_IAM_CLIENT_SECRET',
      'HIVE_ROUTER_MEMORY_PROXY_TOKEN',
      'HIVE_ROUTER_AUTH_MODE',
      'HIVE_ROUTER_SECRET',
      'TLS_CERT_PATH',
      'TLS_KEY_PATH',
    ],
    requiredPorts: [443, 4020],
    healthEndpoints: [
      { name: 'admin readiness', urlTemplate: 'https://{fqdn}/health/ready' },
      { name: 'api readiness', urlTemplate: 'https://{host}:4020/health/ready' },
      { name: 'authenticated status', urlTemplate: 'https://{fqdn}/api/hive/status', requiresAuth: true },
    ],
    requiredSystemd: {
      ProtectSystem: 'strict',
      PrivateTmp: 'yes',
      PrivateDevices: 'yes',
      NoNewPrivileges: 'no',
      RestrictSUIDSGID: 'no',
    },
    backupPaths: [
      '/opt/hive-router/shared',
      '/opt/hive-router/current',
      '/opt/hive-router/releases',
      '/etc/systemd/system/hive-router.service',
    ],
    localEnvExamples: ['services/hive-router/.env.example'],
  },
  {
    key: 'iam',
    displayName: 'Hive IAM',
    systemdService: 'hive-iam',
    deployScript: 'services/hive-iam/scripts/deploy-iam-core.sh',
    remoteRoot: '/opt/hive-iam',
    envPath: '/opt/hive-iam/.env',
    envFallbackPaths: [],
    requiredEnvKeys: [
      'NODE_ENV',
      'DATABASE_URL',
      'REDIS_URL',
      'JWT_PRIVATE_KEY_PATH',
      'JWT_PUBLIC_KEY_PATH',
      'COOKIE_SECRET',
      'IAM_AGENT_SECRET',
      'TLS_CERT_PATH',
      'TLS_KEY_PATH',
    ],
    requiredPorts: [4200],
    healthEndpoints: [
      { name: 'readiness', urlTemplate: 'https://{host}:4200/api/v1/health/ready' },
      { name: 'dependencies', urlTemplate: 'https://{host}:4200/api/v1/health/dependencies' },
    ],
    requiredSystemd: {
      User: 'hive-iam',
      Group: 'hive-iam',
      ProtectSystem: 'strict',
      PrivateTmp: 'yes',
      PrivateDevices: 'yes',
      NoNewPrivileges: 'yes',
    },
    backupPaths: [
      '/opt/hive-iam/.env',
      '/opt/hive-iam/data',
      '/opt/hive-iam/certs',
      '/var/lib/hive-iam-pki',
      '/var/lib/hive-iam-keyring/current',
      '/opt/hive-iam/audit-logs',
      '/opt/hive-iam/prisma',
      '/etc/systemd/system/hive-iam.service',
    ],
    localEnvExamples: ['services/hive-iam/apps/iam-core/.env.example'],
  },
  {
    key: 'memory',
    displayName: 'HiveMem',
    systemdService: 'hivemem',
    deployScript: 'services/hive-mem/scripts/deploy_server.sh',
    remoteRoot: '/opt/hivemem',
    envPath: '/opt/hivemem/.env',
    envFallbackPaths: [],
    requiredEnvKeys: [
      'HIVEMEM_JWT_SECRET',
      'HIVEMEM_HOST',
      'HIVEMEM_PORT',
    ],
    requiredPorts: [18443],
    healthEndpoints: [
      { name: 'readiness', urlTemplate: 'https://{fqdn}/v1/health/ready' },
      { name: 'dependencies', urlTemplate: 'https://{host}:18443/v1/health/dependencies' },
    ],
    requiredSystemd: {},
    backupPaths: [
      '/opt/hivemem/.env',
      '/opt/hivemem/certs',
      '/var/opt/hivemem',
      '/etc/systemd/system/hivemem.service',
    ],
    localEnvExamples: ['services/hive-mem/.env.example'],
  },
] as const;

/** Optional capabilities are installation-specific; content never replicates between hosts. */
export const HIVE_OPTIONAL_SERVICES: readonly HiveServiceManifestEntry[] = [{
  key: 'skills', displayName: 'Hive Skills', systemdService: 'hive-skills',
  deployScript: 'services/hive-skills/scripts/deploy-hive-skills.sh', remoteRoot: '/opt/hive-skills',
  envPath: '/opt/hive-skills/shared/.env', envFallbackPaths: [],
  requiredEnvKeys: ['HIVE_SKILLS_PUBLIC_URL', 'HIVE_SKILLS_DATA_DIR', 'HIVE_SKILLS_SESSION_SECRET', 'HIVE_SKILLS_TLS_CERT_FILE', 'HIVE_SKILLS_TLS_KEY_FILE'],
  requiredPorts: [4030], healthEndpoints: [{ name: 'readiness', urlTemplate: 'https://{fqdn}:4030/healthz' }],
  requiredSystemd: { ProtectSystem: 'strict', PrivateTmp: 'yes' },
  backupPaths: ['/opt/hive-skills/shared', '/etc/systemd/system/hive-skills.service'],
  localEnvExamples: ['services/hive-skills/.env.example'],
}];
const HIVE_HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HIVE_OPTIONAL_SERVICE_KEYS = new Set<string>(HIVE_OPTIONAL_SERVICES.map((service) => service.key));

/**
 * Parses `host[:fqdn[:service+service]]`, for example `hive:hive.example.com:skills`.
 * When the FQDN is omitted the host value is used as the FQDN.
 */
export function parseHiveHostTarget(value: string): HiveHostTarget {
  const [host = '', fqdn = host, services = ''] = value.trim().split(':');
  if (!HIVE_HOST_PATTERN.test(host) || !HIVE_HOST_PATTERN.test(fqdn)) {
    throw new Error(`Invalid Hive host target "${value}"; expected host[:fqdn[:services]]`);
  }
  const optionalServices = services.split('+').map((entry) => entry.trim()).filter(Boolean);
  const unknown = optionalServices.filter((entry) => !HIVE_OPTIONAL_SERVICE_KEYS.has(entry));
  if (unknown.length > 0) throw new Error(`Unknown optional Hive service(s) for ${host}: ${unknown.join(', ')}`);
  return optionalServices.length > 0
    ? { host, fqdn, optionalServices: optionalServices as HiveServiceKey[] }
    : { host, fqdn };
}

/** Resolves deployment hosts from `HIVE_HOSTS` (comma-separated targets), falling back to the example topology. */
export function resolveHiveHosts(env: HiveEnv = {}): HiveHostTarget[] {
  const configured = env['HIVE_HOSTS']?.split(',').map((entry) => entry.trim()).filter(Boolean) ?? [];
  if (configured.length === 0) return HIVE_DEFAULT_HOSTS.map((target) => ({ ...target }));
  return configured.map(parseHiveHostTarget);
}

export function hiveHostCapabilities(targets: readonly HiveHostTarget[]): Record<string, readonly HiveServiceKey[]> {
  return Object.fromEntries(targets.map((target) => [target.host.toLowerCase(), [...(target.optionalServices ?? [])]]));
}

export const HIVE_HOST_CAPABILITIES: Readonly<Record<string, readonly HiveServiceKey[]>> = hiveHostCapabilities(HIVE_DEFAULT_HOSTS);

export function hiveServicesForHost(
  target: string | HiveHostTarget,
  capabilities: Readonly<Record<string, readonly HiveServiceKey[]>> = HIVE_HOST_CAPABILITIES,
): readonly HiveServiceManifestEntry[] {
  const optional = typeof target === 'string'
    ? capabilities[target.toLowerCase()] ?? []
    : target.optionalServices ?? capabilities[target.host.toLowerCase()] ?? [];
  return [...HIVE_SERVICES, ...HIVE_OPTIONAL_SERVICES.filter((service) => optional.includes(service.key))];
}

export const HIVE_REQUIRED_PORTS: readonly number[] = [...new Set(HIVE_SERVICES.flatMap((service) => service.requiredPorts))].sort((left, right) => left - right);

export function getHiveServiceBySystemdName(name: HiveSystemdServiceName): HiveServiceManifestEntry {
  const service = [...HIVE_SERVICES, ...HIVE_OPTIONAL_SERVICES].find((entry) => entry.systemdService === name);
  if (!service) throw new Error(`Unknown Hive systemd service: ${name}`);
  return service;
}

export function getHiveServiceByKey(key: HiveServiceKey): HiveServiceManifestEntry {
  const service = [...HIVE_SERVICES, ...HIVE_OPTIONAL_SERVICES].find((entry) => entry.key === key);
  if (!service) throw new Error(`Unknown Hive service key: ${key}`);
  return service;
}

export function renderHiveEndpoint(template: string, target: HiveHostTarget): string {
  return template.replaceAll('{host}', target.host).replaceAll('{fqdn}', target.fqdn);
}
