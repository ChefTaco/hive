import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrations.js';
import type { CatalogEntry, Connection, ExternalProduct, InstalledEntry, SyncRequest } from './schema.js';

export class Conflict extends Error {}

export type InstallationRow = { id: string; origin: string; profile: string; release_version: string; manifest_digest: string; plan_digest: string; phase: 'activating' | 'complete'; revision: number; updated_at: string };
export type ProductRow = { id: string; source: 'release' | 'external'; kind: string; display_name: string; description: string; repository_url: string | null; documentation_url: string | null; license_url: string | null; license_spdx: string | null; console_section: string | null; required: number; dependencies_json: string; public: number; offered: number; updated_at: string };
export type InstalledRow = { product_id: string; inventory_host: string | null; version: string | null; image: string | null; image_digest: string | null; status: 'activating' | 'installed' | 'external'; installed_at: string | null; updated_at: string; release_version: string | null; connection_json: string };
export type VersionRow = { product_id: string; version: string; image: string; image_digest: string; storage_format: string | null; release_version: string; recorded_at: string };
export type HistoryRow = { sequence: number; recorded_at: string; actor: string; operation: string; subject: string; change_json: string };
export type WriteResult = { changes: number; revision: number };

const databaseFile = 'registry.sqlite';
const emptyConnection: Connection = { consolePath: null, browserPrefix: null, nativeApis: {}, internalEndpoints: {} };

export type OpenOptions = { dataDirectory: string; autoMigrate: boolean; readOnly: boolean; now?: () => string };

export function openDatabase(options: OpenOptions): DatabaseSync {
  const now = options.now ?? ((): string => new Date().toISOString());
  if (options.readOnly) {
    // Rehearsal: the restored data is never opened for writing. A private copy of the
    // whole SQLite family, including any WAL, may be migrated in memory-backed /tmp;
    // the service then refuses all writes, so nothing can reach the restored files.
    const scratch = mkdtempSync(join(tmpdir(), 'hive-registry-'));
    const copy = join(scratch, databaseFile);
    const source = join(options.dataDirectory, databaseFile);
    if (existsSync(source)) {
      copyFileSync(source, copy);
      if (existsSync(`${source}-wal`)) copyFileSync(`${source}-wal`, `${copy}-wal`);
    }
    const db = new DatabaseSync(copy, { enableForeignKeyConstraints: true });
    migrate(db, true, now);
    return db;
  }
  const db = new DatabaseSync(join(options.dataDirectory, databaseFile), { enableForeignKeyConstraints: true });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
  try {
    migrate(db, options.autoMigrate, now);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

export class RegistryStore {
  private readonly now: () => string;

  constructor(private readonly db: DatabaseSync, private readonly installationId: string, now?: () => string) {
    this.now = now ?? ((): string => new Date().toISOString());
  }

  ready(): boolean {
    this.db.prepare('SELECT 1').get();
    return true;
  }

  close(): void {
    this.db.close();
  }

  installation(): InstallationRow | undefined {
    return this.db.prepare('SELECT * FROM installation WHERE singleton = 1').get() as InstallationRow | undefined;
  }

  products(): ProductRow[] {
    return this.db.prepare('SELECT * FROM catalog_products ORDER BY id').all() as ProductRow[];
  }

  product(id: string): ProductRow | undefined {
    return this.db.prepare('SELECT * FROM catalog_products WHERE id = ?').get(id) as ProductRow | undefined;
  }

  installed(): InstalledRow[] {
    return this.db.prepare('SELECT * FROM installed_products ORDER BY product_id').all() as InstalledRow[];
  }

  installedProduct(id: string): InstalledRow | undefined {
    return this.db.prepare('SELECT * FROM installed_products WHERE product_id = ?').get(id) as InstalledRow | undefined;
  }

  versions(id: string): VersionRow[] {
    return this.db.prepare('SELECT * FROM catalog_versions WHERE product_id = ? ORDER BY recorded_at, version').all(id) as VersionRow[];
  }

  history(after: number, limit: number): HistoryRow[] {
    return this.db.prepare('SELECT * FROM history WHERE sequence > ? ORDER BY sequence LIMIT ?').all(after, limit) as HistoryRow[];
  }

  /**
   * Reconciles the release's catalog and this installation's observed state in one
   * transaction. It writes only differences, so a retried or repeated install adds no
   * rows and no history. Externally managed products are never touched.
   */
  sync(request: SyncRequest): WriteResult {
    if (request.installation.id !== this.installationId) throw new Conflict('This registry belongs to another installation');
    return this.transaction(request.actor, request.operation, (record, timestamp) => {
      const current = this.installation();
      const samePlan = current?.plan_digest === request.release.planDigest && current.release_version === request.release.version && current.manifest_digest === request.release.manifestDigest;
      const phase = request.phase === 'complete' || (samePlan && current.phase === 'complete') ? 'complete' : 'activating';
      const next = { id: request.installation.id, origin: request.installation.origin, profile: request.installation.profile, release_version: request.release.version, manifest_digest: request.release.manifestDigest, plan_digest: request.release.planDigest, phase };
      if (!current || (Object.keys(next) as Array<keyof typeof next>).some((key) => current[key] !== next[key])) {
        record('installation', { before: current ? this.publicInstallationFields(current) : null, after: next });
        this.db.prepare(`INSERT INTO installation (singleton, id, origin, profile, release_version, manifest_digest, plan_digest, phase, revision, updated_at)
          VALUES (1, ?, ?, ?, ?, ?, ?, ?, 0, ?)
          ON CONFLICT (singleton) DO UPDATE SET id = excluded.id, origin = excluded.origin, profile = excluded.profile, release_version = excluded.release_version,
            manifest_digest = excluded.manifest_digest, plan_digest = excluded.plan_digest, phase = excluded.phase, updated_at = excluded.updated_at`)
          .run(next.id, next.origin, next.profile, next.release_version, next.manifest_digest, next.plan_digest, next.phase, timestamp);
      }
      for (const entry of request.catalog) this.upsertCatalog(entry, request.release.version, timestamp, record);
      const offered = new Set(request.catalog.map((entry) => entry.id));
      for (const product of this.products()) {
        if (product.source === 'release' && product.offered === 1 && !offered.has(product.id)) {
          this.db.prepare('UPDATE catalog_products SET offered = 0, updated_at = ? WHERE id = ?').run(timestamp, product.id);
          record(`catalog:${product.id}`, { offered: [true, false] });
        }
      }
      for (const entry of request.installed) this.upsertInstalled(entry, request.release.version, timestamp, record);
      if (request.phase === 'complete') {
        const present = new Set(request.installed.map((entry) => entry.id));
        for (const row of this.installed()) {
          const product = this.product(row.product_id);
          if (product?.source === 'release' && !present.has(row.product_id)) {
            this.db.prepare('DELETE FROM installed_products WHERE product_id = ?').run(row.product_id);
            record(`installed:${row.product_id}`, { removed: { inventoryHost: row.inventory_host, version: row.version, imageDigest: row.image_digest } });
          }
        }
      }
    });
  }

  /** Adds or updates an externally managed product. Release-owned products are refused. */
  putExternal(id: string, product: ExternalProduct, actor: string): WriteResult {
    return this.transaction(actor, 'external', (record, timestamp) => {
      const existing = this.product(id);
      if (existing?.source === 'release') throw new Conflict('This product is owned by the release manifest; the installer records it');
      const links = product.links;
      const row = {
        display_name: product.displayName, description: product.description, repository_url: links.repository, documentation_url: links.documentation,
        license_url: links.license, license_spdx: links.licenseSpdx, console_section: product.consoleSection, dependencies_json: JSON.stringify(product.dependencies), public: product.public ? 1 : 0,
      };
      if (!existing || (Object.keys(row) as Array<keyof typeof row>).some((key) => existing[key] !== row[key])) {
        record(`catalog:${id}`, { externallyManaged: true, displayName: product.displayName, public: product.public });
        this.db.prepare(`INSERT INTO catalog_products (id, source, kind, display_name, description, repository_url, documentation_url, license_url, license_spdx, console_section, required, dependencies_json, public, offered, updated_at)
          VALUES (?, 'external', 'external', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, ?)
          ON CONFLICT (id) DO UPDATE SET display_name = excluded.display_name, description = excluded.description, repository_url = excluded.repository_url, documentation_url = excluded.documentation_url,
            license_url = excluded.license_url, license_spdx = excluded.license_spdx, console_section = excluded.console_section, dependencies_json = excluded.dependencies_json, public = excluded.public, updated_at = excluded.updated_at`)
          .run(id, row.display_name, row.description, row.repository_url, row.documentation_url, row.license_url, row.license_spdx, row.console_section, row.dependencies_json, row.public, timestamp);
      }
      const current = this.installedProduct(id);
      const connection = JSON.stringify(product.connection);
      if (!current || current.inventory_host !== product.inventoryHost || current.version !== product.version || current.image_digest !== product.imageDigest || current.connection_json !== connection) {
        record(`installed:${id}`, { inventoryHost: product.inventoryHost, version: product.version, imageDigest: product.imageDigest });
        this.db.prepare(`INSERT INTO installed_products (product_id, inventory_host, version, image, image_digest, status, installed_at, updated_at, release_version, connection_json)
          VALUES (?, ?, ?, NULL, ?, 'external', ?, ?, NULL, ?)
          ON CONFLICT (product_id) DO UPDATE SET inventory_host = excluded.inventory_host, version = excluded.version, image_digest = excluded.image_digest, updated_at = excluded.updated_at, connection_json = excluded.connection_json`)
          .run(id, product.inventoryHost, product.version, product.imageDigest, timestamp, timestamp, connection);
      }
    });
  }

  deleteExternal(id: string, actor: string): WriteResult {
    return this.transaction(actor, 'external', (record) => {
      const existing = this.product(id);
      if (!existing) return;
      if (existing.source === 'release') throw new Conflict('This product is owned by the release manifest; the installer records it');
      this.db.prepare('DELETE FROM catalog_products WHERE id = ?').run(id);
      record(`catalog:${id}`, { removed: true });
    });
  }

  private publicInstallationFields(row: InstallationRow) {
    return { id: row.id, release_version: row.release_version, manifest_digest: row.manifest_digest, plan_digest: row.plan_digest, phase: row.phase };
  }

  private upsertCatalog(entry: CatalogEntry, release: string, timestamp: string, record: (subject: string, change: unknown) => void): void {
    const existing = this.product(entry.id);
    if (existing?.source === 'external') throw new Conflict(`Product ${entry.id} is externally managed; remove it before a release can own that name`);
    const row = {
      kind: entry.kind, display_name: entry.displayName, description: entry.description, repository_url: entry.links.repository, documentation_url: entry.links.documentation,
      license_url: entry.links.license, license_spdx: entry.links.licenseSpdx, console_section: entry.consoleSection, required: entry.required ? 1 : 0,
      dependencies_json: JSON.stringify(entry.dependencies), public: entry.kind === 'datastore' ? 0 : 1, offered: 1,
    };
    if (!existing || (Object.keys(row) as Array<keyof typeof row>).some((key) => existing[key] !== row[key])) {
      record(`catalog:${entry.id}`, { displayName: entry.displayName, kind: entry.kind, required: entry.required, offered: true });
      this.db.prepare(`INSERT INTO catalog_products (id, source, kind, display_name, description, repository_url, documentation_url, license_url, license_spdx, console_section, required, dependencies_json, public, offered, updated_at)
        VALUES (?, 'release', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, display_name = excluded.display_name, description = excluded.description, repository_url = excluded.repository_url, documentation_url = excluded.documentation_url,
          license_url = excluded.license_url, license_spdx = excluded.license_spdx, console_section = excluded.console_section, required = excluded.required, dependencies_json = excluded.dependencies_json, public = excluded.public, offered = 1, updated_at = excluded.updated_at`)
        .run(entry.id, row.kind, row.display_name, row.description, row.repository_url, row.documentation_url, row.license_url, row.license_spdx, row.console_section, row.required, row.dependencies_json, row.public, timestamp);
    }
    const version = entry.version;
    const inserted = this.db.prepare('INSERT OR IGNORE INTO catalog_versions VALUES (?, ?, ?, ?, ?, ?, ?)').run(entry.id, version.version, version.image, version.imageDigest, version.storageFormat, release, timestamp);
    if (inserted.changes) record(`catalog:${entry.id}`, { versionAdded: version.version, imageDigest: version.imageDigest, storageFormat: version.storageFormat, release });
  }

  private upsertInstalled(entry: InstalledEntry, release: string, timestamp: string, record: (subject: string, change: unknown) => void): void {
    const current = this.installedProduct(entry.id);
    const sameDeployment = current?.inventory_host === entry.inventoryHost && current.version === entry.version && current.image_digest === entry.imageDigest;
    // An interrupted retry of an already installed product must not look like new work.
    const status = entry.status === 'activating' && sameDeployment && current.status === 'installed' ? 'installed' : entry.status;
    const installedAt = status === 'installed' ? (sameDeployment && current.status === 'installed' ? current.installed_at : timestamp) : (sameDeployment ? (current.installed_at ?? null) : null);
    const connection = JSON.stringify(entry.connection);
    if (current && sameDeployment && current.status === status && current.connection_json === connection && current.release_version === release) return;
    record(`installed:${entry.id}`, {
      before: current ? { inventoryHost: current.inventory_host, version: current.version, imageDigest: current.image_digest, status: current.status } : null,
      after: { inventoryHost: entry.inventoryHost, version: entry.version, imageDigest: entry.imageDigest, status },
      release,
    });
    this.db.prepare(`INSERT INTO installed_products (product_id, inventory_host, version, image, image_digest, status, installed_at, updated_at, release_version, connection_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (product_id) DO UPDATE SET inventory_host = excluded.inventory_host, version = excluded.version, image = excluded.image, image_digest = excluded.image_digest, status = excluded.status,
        installed_at = excluded.installed_at, updated_at = excluded.updated_at, release_version = excluded.release_version, connection_json = excluded.connection_json`)
      .run(entry.id, entry.inventoryHost, entry.version, entry.image, entry.imageDigest, status, installedAt, timestamp, release, connection);
  }

  private transaction(actor: string, operation: string, work: (record: (subject: string, change: unknown) => void, timestamp: string) => void): WriteResult {
    const timestamp = this.now();
    let changes = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      work((subject, change) => {
        changes += 1;
        this.db.prepare('INSERT INTO history (recorded_at, actor, operation, subject, change_json) VALUES (?, ?, ?, ?, ?)').run(timestamp, actor, operation, subject, JSON.stringify(change));
      }, timestamp);
      if (changes) this.db.prepare('UPDATE installation SET revision = revision + 1, updated_at = ?').run(timestamp);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { changes, revision: this.installation()?.revision ?? 0 };
  }
}

export { emptyConnection };
