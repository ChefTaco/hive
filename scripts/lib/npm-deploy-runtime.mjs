/** Runs only on the installation owner host, against a newly staged npm project. */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [operation, directory] = process.argv.slice(2);
const request = JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8'));
const inventory = JSON.parse(readFileSync(join(directory, 'inventory.json'), 'utf8'));
const runtime = `/opt/hive-npm/releases/${request.id}/runtime`;
const scope = join(runtime, 'node_modules/@hivemagnus');
const require = createRequire(join(runtime, 'package.json'));
const { canonicalJson, compareVersions, satisfies, releaseSchema, NATIVE_POLICY } = await import(join(scope, 'hive/dist/src/release/runtime.js'));
const Database = require('better-sqlite3');
const assert = (value, message) => { if (!value) throw Error(message); };

if (operation === 'validate') {
  const release = releaseSchema.parse(request.packages['@hivemagnus/hive'].hiveRelease);
  assert(release.engineProtocol === 1, 'Upgrade engine protocol requires a reviewed tooling update');
  assert(satisfies(process.versions.node, release.engines.node), 'Unsupported Node engine');
  for (const project of inventory.projects) {
    const staged = `${project.base}/releases/${request.id}/runtime`;
    const manifest = JSON.parse(readFileSync(join(staged, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(staged, 'package-lock.json'), 'utf8'));
    assert(canonicalJson(manifest.allowScripts) === canonicalJson(NATIVE_POLICY), 'Native script policy differs');
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (path) assert(entry.resolved?.startsWith('https://registry.npmjs.org/') && entry.integrity, 'Non-public or unverified dependency');
    }
    for (const [name, oldVersion] of Object.entries(project.versions)) {
      const info = JSON.parse(readFileSync(join(staged, 'node_modules', name, 'package.json'), 'utf8'));
      const expected = request.packages[name];
      assert(info.version === request.version && expected.version === request.version, 'Version mismatch');
      assert(lock.packages[`node_modules/${name}`].integrity === expected.dist.integrity, 'Registry integrity mismatch');
      assert(canonicalJson(info.hiveRelease) === canonicalJson(release), 'Mixed release manifests');
      assert(satisfies(process.versions.node, info.engines.node), 'Package Node engine mismatch');
      assert(release.components[name] === request.version, 'Bundle pin mismatch');
      assert(compareVersions(request.version, oldVersion) >= 0, 'Downgrades are unsupported');
      assert(Number(oldVersion.split('.')[0]) === Number(request.version.split('.')[0]), 'Major upgrades are unsupported');
      assert(!release.minUpgradeFrom[name] || satisfies(oldVersion, `>=${release.minUpgradeFrom[name]}`), 'Intermediate release required');
      const old = JSON.parse(readFileSync(join(project.base, 'current/runtime/node_modules', name, 'package.json'), 'utf8'));
      assert(old.hiveRelease, 'Legacy releases require separately reviewed adoption');
      assert(canonicalJson(old.hiveRelease.migrations) === canonicalJson(release.migrations), 'Migration inventory changed; use a reviewed migration procedure');
      assert(canonicalJson(old.hiveRelease.wireCompatibility) === canonicalJson(release.wireCompatibility) && canonicalJson(old.hiveRelease.testedSdks) === canonicalJson(release.testedSdks), 'Wire/consumer compatibility changed; review the consumer rollout separately');
      const service = ({'hive-iam-server':'iam','hive-router':'router','hivemem-server':'memory','hive-skills':'skills'})[name.split('/')[1]];
      if (service) assert(satisfies(oldVersion, release.dataCompatibility[service]), 'Old binary cannot read target data');
    }
  }
  assert(release.requiredIntermediates.length === 0, 'Required intermediate releases need operator review');
  assert(release.migrations.every(m => m.impact === 'fast'), 'Slow or one-way migration requires operator review');
  for (const item of release.newRequiredEnv) {
    const services = item.component === 'launcher' ? Object.values(inventory.services) : Object.values(inventory.services).filter(s => s.component === item.component);
    for (const service of services) assert(service.env[item.name]?.trim(), 'Required environment value is missing');
  }
  for (const item of release.removedEnv) assert(Object.values(inventory.services).every(s => !s.env[item.name]), 'Removed environment name is configured');
  const db = new Database(':memory:'); assert(db.prepare('SELECT 1 AS ok').get().ok === 1, 'Native SQLite failed'); db.close();
  const argon = require('argon2'); assert(await argon.verify(await argon.hash('synthetic-native-check'), 'synthetic-native-check'), 'Native Argon2 failed');
  console.log('Exact bundle, engines, compatibility, integrity and native modules verified');
} else if (operation === 'rehearse') {
  const snapshot = db => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name}) => [name,
    db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(row => createHash('sha256').update(JSON.stringify(row, (_, v) => Buffer.isBuffer(v) ? v.toString('hex') : v)).digest('hex')).sort()]));
  for (const service of Object.values(inventory.services).filter(s => s.database)) {
    const source = new Database(service.database, {readonly:true, fileMustExist:true});
    const dest = join(directory, `${service.component}-rehearsal.db`); await source.backup(dest); source.close();
    let db = new Database(dest); const before = snapshot(db); db.close();
    if (service.component === 'iam') {
      const {planMigrations} = await import(join(scope, 'hive-iam-server/dist/cli/migrate.js'));
      assert(planMigrations(dest, join(scope, 'hive-iam-server/prisma/migrations')).pending.length === 0, 'IAM migrations pending');
    } else if (service.component === 'router') {
      const {schemaStatements, columnMigrations} = await import(join(scope, 'hive-router/dist/src/storage/migrations/managed-format-1.js'));
      const {QuotaLedger} = await import(join(scope, 'hive-router/dist/src/security/quota-ledger.js'));
      db = new Database(dest); db.exec('PRAGMA foreign_keys=ON');
      for (const statement of schemaStatements) db.exec(statement);
      for (const m of columnMigrations) assert(db.prepare(`PRAGMA table_info("${m.table}")`).all().some(c => c.name === m.column), 'Router columns pending');
      new QuotaLedger(db).migrateRetainedHistory(); db.close();
    } else {
      const {initializeSchema} = await import(`/opt/hive-skills/npm/releases/${request.id}/runtime/node_modules/@hivemagnus/hive-skills/dist/schema.js`);
      const skills = new DatabaseSync(dest); initializeSchema(skills); skills.close();
    }
    db = new Database(dest); assert(canonicalJson(before) === canonicalJson(snapshot(db)), 'Rehearsal changed rows or tables');
    assert(db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok' && db.prepare('PRAGMA foreign_key_check').all().length === 0, 'Rehearsal integrity failed'); db.close();
  }
  writeFileSync(join(directory, 'rehearsal.json'), JSON.stringify({passed:true}), {mode:0o600});
  console.log('Isolated migration rehearsal preserved every existing SQLite row and table');
} else if (operation === 'documentation') {
  const {buildRouterOpenApiDocument} = await import('/opt/hive-npm/current/runtime/node_modules/@hivemagnus/hive-router/dist/src/openapi/spec.js');
  const router = inventory.services['hive-router']; const db = new Database(router.database, {readonly:true, fileMustExist:true});
  const actual = JSON.parse(db.prepare('SELECT valueJson FROM RuntimeSetting WHERE key=?').get('openapi.document').valueJson); db.close();
  assert(canonicalJson(actual) === canonicalJson(buildRouterOpenApiDocument(router.env.PUBLIC_ADMIN_URL)), 'Generated OpenAPI document differs');
} else throw Error('Unsupported runtime operation');
