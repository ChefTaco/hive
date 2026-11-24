import type { Capabilities, Connection } from './schema.js';
import { capabilityVersion } from './schema.js';
import { canonicalSetupItem, emptyConnection, type HistoryRow, type InstallationRow, type InstalledRow, type ProductRow, type RegistryStore, type VersionRow } from './store.js';

// Field exposure lives here and only here. These are explicit allowlists: a new column
// reaches a response only by being named below. The public view carries no more than the
// kind of information the console's public runtime.json already holds: product names,
// same-origin paths and public links. Versions, digests, inventory hosts, internal
// endpoints and timestamps need a registry credential.
const connectionOf = (row: InstalledRow | undefined): Connection => (row ? (JSON.parse(row.connection_json) as Connection) : emptyConnection);
const dependenciesOf = (row: ProductRow): string[] => JSON.parse(row.dependencies_json) as string[];
// Products that offer no capability omit the field. A connection stored before capabilities
// existed has none.
const capabilitiesOf = (connection: Connection): { capabilities?: Capabilities } =>
  connection.capabilities && Object.keys(connection.capabilities).length
    ? { capabilities: Object.fromEntries(Object.entries(connection.capabilities).map(([name, capability]) => [name, { path: capability.path }])) }
    : {};

// Dotted numeric versions, compared part by part; a missing part counts as 0.
function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

export type ServiceCapabilityView = { name: string; since: string; confirmed: boolean };

/**
 * The service capabilities a product's connection offers. With a recorded numeric version, only
 * those whose `since` it reaches. They are `confirmed: true` only once the controller recorded the
 * product as running that version: `installed` (a sync's completion, after hive.sh observed the
 * signed image running and healthy) or `external` (an externally managed product, whose version
 * the operator records). While it is `activating` (an install, upgrade or rollback that has not
 * completed, or one that failed and is held) the product may still run its previous version, so
 * they are `confirmed: false`. Without a comparable version (an external product, an externally
 * managed product without a version, or a version such as 3.3.0-rc.1), every declared one,
 * `confirmed: false`. Unconfirmed, the reader compares `since` with the version the product
 * reports. `name` narrows the list to that capability; an unconfirmed entry is still offered.
 */
export function serviceCapabilitiesOf(installed: InstalledRow | undefined, name?: string): ServiceCapabilityView[] {
  const declared = connectionOf(installed).serviceCapabilities ?? [];
  const version = installed?.version && capabilityVersion.safeParse(installed.version).success ? installed.version : null;
  const running = version !== null && (installed?.status === 'installed' || installed?.status === 'external');
  return declared
    .filter((capability) => (version === null || compareVersions(version, capability.since) >= 0) && (name === undefined || capability.name === name))
    .map((capability) => ({ name: capability.name, since: capability.since, confirmed: running }));
}

export function publicProductVisible(row: ProductRow): boolean {
  return row.public === 1;
}

function productDetails(row: ProductRow, installed: InstalledRow | undefined) {
  return {
    id: row.id,
    displayName: row.display_name,
    description: row.description,
    links: { repository: row.repository_url, documentation: row.documentation_url, license: row.license_url, licenseSpdx: row.license_spdx },
    consoleSection: row.console_section,
    required: row.required === 1,
    installed: installed?.status === 'installed' || installed?.status === 'external',
    ...capabilitiesOf(connectionOf(installed)),
  };
}

export function publicProduct(row: ProductRow, installed: InstalledRow | undefined, store: RegistryStore) {
  return {
    ...productDetails(row, installed),
    dependencies: dependenciesOf(row).filter((name) => {
      const dependency = store.product(name);
      return dependency ? publicProductVisible(dependency) : false;
    }),
  };
}

const versionView = (row: VersionRow) => ({ version: row.version, image: row.image, imageDigest: row.image_digest, storageFormat: row.storage_format, release: row.release_version, recordedAt: row.recorded_at });

export function privateProduct(row: ProductRow, installed: InstalledRow | undefined, store: RegistryStore) {
  return {
    ...productDetails(row, installed),
    dependencies: dependenciesOf(row),
    kind: row.kind,
    source: row.source,
    public: row.public === 1,
    offered: row.offered === 1,
    versions: store.versions(row.id).map(versionView),
    installation: installed
      ? { inventoryHost: installed.inventory_host, version: installed.version, image: installed.image, imageDigest: installed.image_digest, status: installed.status, installedAt: installed.installed_at, updatedAt: installed.updated_at, release: installed.release_version }
      : null,
  };
}

function connectionDetails(row: ProductRow, connection: Connection) {
  return { id: row.id, consolePath: connection.consolePath, browserPrefix: connection.browserPrefix, nativeApis: connection.nativeApis, documentation: row.documentation_url, ...capabilitiesOf(connection) };
}

export function publicConnection(row: ProductRow, installed: InstalledRow | undefined) {
  return connectionDetails(row, connectionOf(installed));
}

// Service capabilities are private like internal endpoints and versions: their `since` and
// `confirmed` tell the product version apart. A product that offers none omits the field.
export function privateConnection(row: ProductRow, installed: InstalledRow | undefined, capability?: string) {
  const connection = connectionOf(installed);
  const offered = serviceCapabilitiesOf(installed, capability);
  return {
    ...connectionDetails(row, connection), inventoryHost: installed?.inventory_host ?? null, internalEndpoints: connection.internalEndpoints,
    ...(offered.length ? { serviceCapabilities: offered } : {}),
  };
}

// The setup checklist is public: HiveXUI shows it to administrators. Its items carry titles,
// hive.sh command lines and repository doc anchors only, which the schema enforces, and its
// `updatedAt` is the one timestamp the public view carries. A registry that never received a
// checklist omits the field.
function setupOf(store: RegistryStore) {
  const setup = store.setup();
  return setup ? { setup: { items: setup.items.map(canonicalSetupItem), updatedAt: setup.updatedAt } } : {};
}

export function publicInstallation(installation: InstallationRow | undefined, configured: string, store: RegistryStore) {
  return {
    schema: 1,
    id: installation?.id ?? configured,
    products: store.installed().filter((row) => {
      const product = store.product(row.product_id);
      return product !== undefined && publicProductVisible(product) && row.status !== 'activating';
    }).map((row) => row.product_id),
    ...setupOf(store),
  };
}

export function privateInstallation(installation: InstallationRow | undefined, configured: string, store: RegistryStore) {
  const hosts = [...new Set(store.installed().flatMap((row) => (row.inventory_host ? [row.inventory_host] : [])))].sort();
  return {
    ...publicInstallation(installation, configured, store),
    origin: installation?.origin ?? null,
    profile: installation?.profile ?? null,
    release: installation ? { version: installation.release_version, manifestDigest: installation.manifest_digest, planDigest: installation.plan_digest } : null,
    phase: installation?.phase ?? null,
    revision: installation?.revision ?? 0,
    updatedAt: installation?.updated_at ?? null,
    hosts,
  };
}

const digestOf = (image: string): string => image.slice(image.indexOf('@') + 1);

/**
 * GET /v1/inventory: the signed release's pins beside what each host reports (see
 * inventory-contract.ts). Its own allowlist: internal endpoints, origins and plan digests stay out.
 */
export function inventoryView(installation: InstallationRow | undefined, configured: string, store: RegistryStore) {
  const observed = store.observations();
  const hosts = observed?.hosts ?? [];
  // Pins from the manifest the hosts keep, for products the installation does not run itself.
  const manifestPin = (id: string) => {
    for (const host of hosts) {
      const pin = host.catalog?.find((entry) => entry.id === id);
      if (pin) return { version: pin.version, image: pin.image, imageDigest: digestOf(pin.image) };
    }
    return null;
  };
  const components = store.products().filter((row) => row.source === 'external' || row.offered === 1).map((row) => {
    const installed = store.installedProduct(row.id);
    const deployed = row.source === 'release' && installed && installed.status !== 'external' && installed.image && installed.image_digest;
    return {
      id: row.id,
      displayName: row.display_name,
      kind: row.kind,
      source: row.source,
      status: installed ? installed.status : 'not-installed',
      inventoryHost: installed?.inventory_host ?? null,
      pinned: row.source === 'external' ? null : deployed ? { version: installed.version, image: installed.image!, imageDigest: installed.image_digest! } : manifestPin(row.id),
      recorded: row.source === 'external' ? { version: installed?.version ?? null, imageDigest: installed?.image_digest ?? null } : null,
    };
  });
  return {
    schema: 1,
    installationId: installation?.id ?? configured,
    release: installation ? { version: installation.release_version, manifestDigest: installation.manifest_digest } : null,
    phase: installation?.phase ?? null,
    observedAt: observed?.observedAt ?? null,
    components,
    hosts: hosts.map((host) => ({
      host: host.host, active: host.active, unreachable: host.unreachable, receipt: host.receipt, transactionPhase: host.transactionPhase, catalog: host.catalog,
      services: host.services.map((service) => ({ service: service.service, image: service.image, runningImage: service.runningImage, imageId: service.imageId, imageMatches: service.imageMatches, state: service.state, health: service.health })),
    })),
  };
}

export const historyView =(row: HistoryRow) => ({ sequence: row.sequence, recordedAt: row.recorded_at, actor: row.actor, operation: row.operation, subject: row.subject, change: JSON.parse(row.change_json) as unknown });
