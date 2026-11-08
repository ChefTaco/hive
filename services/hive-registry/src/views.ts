import type { Connection } from './schema.js';
import { emptyConnection, type HistoryRow, type InstallationRow, type InstalledRow, type ProductRow, type RegistryStore, type VersionRow } from './store.js';

// Field exposure lives here and only here. These are explicit allowlists: a new column
// reaches a response only by being named below. The public view carries no more than the
// kind of information the console's public runtime.json already holds: product names,
// same-origin paths and public links. Versions, digests, inventory hosts, internal
// endpoints and timestamps need a registry credential.
const connectionOf = (row: InstalledRow | undefined): Connection => (row ? (JSON.parse(row.connection_json) as Connection) : emptyConnection);
const dependenciesOf = (row: ProductRow): string[] => JSON.parse(row.dependencies_json) as string[];

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
  return { id: row.id, consolePath: connection.consolePath, browserPrefix: connection.browserPrefix, nativeApis: connection.nativeApis, documentation: row.documentation_url };
}

export function publicConnection(row: ProductRow, installed: InstalledRow | undefined) {
  return connectionDetails(row, connectionOf(installed));
}

export function privateConnection(row: ProductRow, installed: InstalledRow | undefined) {
  const connection = connectionOf(installed);
  return { ...connectionDetails(row, connection), inventoryHost: installed?.inventory_host ?? null, internalEndpoints: connection.internalEndpoints };
}

export function publicInstallation(installation: InstallationRow | undefined, configured: string, store: RegistryStore) {
  return {
    schema: 1,
    id: installation?.id ?? configured,
    products: store.installed().filter((row) => {
      const product = store.product(row.product_id);
      return product !== undefined && publicProductVisible(product) && row.status !== 'activating';
    }).map((row) => row.product_id),
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

export const historyView = (row: HistoryRow) => ({ sequence: row.sequence, recordedAt: row.recorded_at, actor: row.actor, operation: row.operation, subject: row.subject, change: JSON.parse(row.change_json) as unknown });
