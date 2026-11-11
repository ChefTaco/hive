// The reviewed service contracts of a suite release manifest: services, private networks,
// datastores, storage formats and initialization commands. Published releases
// (scripts/release/build-suite-manifest.mjs) and the disposable developer proofs build
// their manifests from here, so the contract a proof exercises is the one that ships.
// Callers supply only exact image references and the service owner.
import { hiveRegistryComponent } from './suite-catalog.mjs';

// Datastore images: the hardened builds in deployment/datastores (deployment/images.json),
// published from this repository and pinned to their multi-architecture index digests.
// Each is the upstream image at an exact digest with unused, vulnerable tooling removed.
export const DATASTORE_IMAGES = Object.freeze({
  redis: 'ghcr.io/cheftaco/hive-redis@sha256:91cbdfcaf13a1c9c06fc168ddf0a1fafc5d4a1efadfc9b613ca7a366407880f2', // 8.2.10-1
  qdrant: 'ghcr.io/cheftaco/hive-qdrant@sha256:9cc1a19b58d263decd071ac6017e3702cf1423a3d748065546026823481e0827', // 1.18.3-2
  postgres17: 'ghcr.io/cheftaco/hive-postgres@sha256:a09fd1d3ef969e21b532e8ea93537c8b9001eda56e709f5fad55d500c956d381', // 17.11-2
  postgres18: 'ghcr.io/cheftaco/hive-postgres@sha256:dcb12bad768145e678454580eece1204dc69c6d9d91bd5e2588f80b4085d8c2d', // 18.6-2
});
export const DATASTORE_VERSIONS = Object.freeze({ redis: '8.2.10', qdrant: '1.18.3', postgres17: '17.11', postgres18: '18.6' });

// Historical releases retain their original default pins. New releases explicitly select
// this reviewed tag set; the manifest builder resolves and verifies both architectures.
export const DATASTORE_RELEASE_PROFILES = Object.freeze({
  'runtime-2026-11': Object.freeze({
    redis: { image: 'ghcr.io/cheftaco/hive-redis:8.2.10-2', version: '8.2.10' },
    qdrant: { image: 'ghcr.io/cheftaco/hive-qdrant:1.18.3-3', version: '1.18.3' },
    postgres17: { image: 'ghcr.io/cheftaco/hive-postgres:17.11-3', version: '17.11' },
    postgres18: { image: 'ghcr.io/cheftaco/hive-postgres:18.6-3', version: '18.6' },
  }),
});
const DATASTORE_COMPONENTS = Object.freeze({
  redis: ['oathweave-redis', 'magnus-redis', 'cindertrace-redis'],
  qdrant: ['hivemem-qdrant'],
  postgres17: ['magnus-postgres', 'chattermost-postgres'],
  postgres18: ['cindertrace-postgres', 'embermend-postgres'],
});
export function datastoreProfileReferences(profile) {
  if (profile === undefined) return {};
  if (typeof profile !== 'string' || !Object.hasOwn(DATASTORE_RELEASE_PROFILES, profile)) {
    throw new Error('Unknown reviewed datastore profile');
  }
  return Object.fromEntries(Object.entries(DATASTORE_RELEASE_PROFILES[profile]).map(([name, spec]) => [
    'datastore:' + name, { ...spec, platforms: ['linux/amd64', 'linux/arm64'] },
  ]));
}
export function datastoreProfileComponent(reference) {
  const name = reference.replace(/^datastore:/, '');
  if (!reference.startsWith('datastore:') || !Object.hasOwn(DATASTORE_COMPONENTS, name)) {
    throw new Error('Unknown datastore reference');
  }
  return DATASTORE_COMPONENTS[name][0];
}
export function applyDatastoreProfile(manifest, profile, pinned) {
  for (const reference of Object.keys(datastoreProfileReferences(profile))) {
    const name = reference.slice('datastore:'.length);
    const image = pinned[reference];
    if (typeof image !== 'string' || !/^[a-z0-9./-]+@sha256:[a-f0-9]{64}$/.test(image)) {
      throw new Error('The reviewed datastore profile requires every exact image digest');
    }
    for (const component of DATASTORE_COMPONENTS[name]) {
      const target = manifest.components[component];
      if (!target) continue;
      target.image = image;
      if (name.startsWith('postgres')) {
        const from = target.storageFormat;
        target.storageFormat = from + '-runtime2';
        target.readableFormats = [target.storageFormat];
        target.migration = { from, command: ['hive-pg-reconcile'] };
      }
    }
  }
}

// Product images each profile needs. chat-migrator is ChatterMost's initialization image.
export const CORE_PRODUCTS = Object.freeze(['hive-registry', 'oathweave', 'emberpath', 'hivemem', 'hiveskills', 'hivexui', 'ingress']);
export const FULL_PRODUCTS = Object.freeze(['magnus', 'cindertrace', 'chattermost', 'chat-migrator', 'emberfold', 'magnus-gateway']);
// Offered only when the release inputs name an image, and never selected by a profile, so an
// installation without them, and the upgrade of one, is unchanged. Ardent Project Studio is
// published as ghcr.io/cheftaco/ardent-studio.
export const OPTIONAL_PRODUCTS = Object.freeze(['ardentstudio', 'embermend']);
// HiveXUI's nginx image runs as its own unprivileged account.
export const STATIC_UI_USER = '101:101';

const health = (command) => ({ test: ['CMD', ...command], interval: '2s', timeout: '5s', retries: 40, start_period: '5s' });
const need = (images, name) => images[name] ?? (() => { throw Error('Release contract needs an image for ' + name); })();

function redisComponent(image, user, network) {
  return {
    image,
    kind: 'datastore',
    storageFormat: 'redis-aof-v1',
    service: {
      user,
      command: ['redis-server', '/config/redis.conf'],
      networks: [network],
      healthcheck: {
        test: ['CMD-SHELL', 'REDISCLI_AUTH="$(sed -n "s/^requirepass //p" /config/redis.conf)" redis-cli --no-auth-warning ping | grep -q PONG'],
        interval: '2s',
        timeout: '3s',
        retries: 20,
      },
    },
  };
}

// The nine core components: the mandatory registry, identity, models, memory, skills,
// the console and ingress, and the private identity and memory stores.
export function coreRelease({ version, images, user, registryVersion }) {
  const app = (name, network, dependencies) => ({
    image: need(images, name),
    storageFormat: name + '-v1',
    kind: 'application',
    service: {
      user,
      healthcheck: { test: ['CMD', 'node', '/app/healthcheck.mjs'], interval: '2s', timeout: '4s', start_period: '2s', retries: 30 },
      networks: ['default', ...(network ? [network] : [])],
      ...(dependencies ? { depends_on: Object.fromEntries(dependencies.map((name) => [name, { condition: 'service_healthy' }])) } : {}),
    },
    ...(dependencies ? { requiresLocal: dependencies } : {}),
  });
  const components = {
    'hive-registry': hiveRegistryComponent(need(images, 'hive-registry'), user, ...(registryVersion ? [registryVersion] : [])),
    oathweave: app('oathweave', 'identity-data', ['oathweave-redis']),
    emberpath: app('emberpath'),
    hivemem: app('hivemem', 'memory-data', ['hivemem-qdrant']),
    hiveskills: app('hiveskills'),
    hivexui: {
      image: need(images, 'hivexui'),
      kind: 'static-ui',
      service: {
        user: STATIC_UI_USER,
        healthcheck: { test: ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8080/'], interval: '2s', timeout: '3s', retries: 20 },
      },
    },
    ingress: {
      image: need(images, 'ingress'),
      kind: 'ingress',
      requiresLocal: ['hivexui'],
      service: {
        user,
        command: ['caddy', 'run', '--config', '/config/Caddyfile', '--adapter', 'caddyfile'],
        healthcheck: { test: ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8081/ready'], interval: '2s', timeout: '3s', retries: 20 },
        depends_on: { hivexui: { condition: 'service_healthy' } },
      },
    },
    'oathweave-redis': redisComponent(images['oathweave-redis'] ?? DATASTORE_IMAGES.redis, user, 'identity-data'),
    'hivemem-qdrant': {
      image: images['hivemem-qdrant'] ?? DATASTORE_IMAGES.qdrant,
      kind: 'datastore',
      storageFormat: 'qdrant-v1.18.1',
      service: {
        user,
        working_dir: '/data',
        entrypoint: ['/qdrant/qdrant'],
        command: ['--config-path', '/config/qdrant.yaml'],
        networks: ['memory-data'],
        healthcheck: {
          test: ['CMD', 'bash', '-ec', 'exec 3<>/dev/tcp/127.0.0.1/6333; printf "GET /readyz HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n" >&3; IFS= read -r status <&3; [[ "$$status" == *" 200 "* ]]'],
          interval: '2s',
          timeout: '3s',
          retries: 20,
        },
      },
    },
  };
  const names = Object.keys(components).sort();
  return {
    schema: 1,
    version,
    profiles: { core: names, full: [...names] },
    networks: { 'identity-data': { driver: 'bridge', internal: true }, 'memory-data': { driver: 'bridge', internal: true } },
    components,
  };
}

// Adds Magnus, Cindertrace, ChatterMost (each with private PostgreSQL, and Redis for the
// first two), the Emberfold service and the optional Magnus fleet gateway, which is
// offered but never part of a profile, and the optional products the images name.
export function addFullComponents(manifest, { images, user }) {
  for (const [product, database, role, postgres, major] of [
    ['magnus', 'magnus', 'magnus', images['magnus-postgres'] ?? DATASTORE_IMAGES.postgres17, '17'],
    ['cindertrace', 'cindertrace', 'cindertrace', images['cindertrace-postgres'] ?? DATASTORE_IMAGES.postgres18, '18'],
    ['chattermost', 'chattermost', 'chattermost_app', images['chattermost-postgres'] ?? DATASTORE_IMAGES.postgres17, '17'],
  ]) {
    const network = product + '-data';
    manifest.networks[network] = { driver: 'bridge', internal: true };
    manifest.components[product + '-postgres'] = {
      image: postgres,
      kind: 'datastore',
      storageFormat: product + '-postgres-' + major,
      service: {
        user,
        tmpfs: ['/var/run/postgresql'],
        environment: { PGDATA: '/data/pgdata', POSTGRES_DB: database, POSTGRES_USER: role, POSTGRES_PASSWORD_FILE: '/config/password', POSTGRES_INITDB_ARGS: '--data-checksums' },
        // ChatterMost's container expects the database at the DNS name postgres.
        networks: product === 'chattermost' ? { [network]: { aliases: ['postgres'] } } : [network],
        healthcheck: health(['pg_isready', '-h', '127.0.0.1', '-U', role, '-d', database]),
      },
    };
    if (product !== 'chattermost') manifest.components[product + '-redis'] = redisComponent(images[product + '-redis'] ?? manifest.components['oathweave-redis'].image, user, network);
    const dependencies = { [product + '-postgres']: { condition: 'service_healthy' }, ...(product === 'chattermost' ? {} : { [product + '-redis']: { condition: 'service_healthy' } }) };
    const healthcheck = product === 'chattermost'
      ? health(['node', 'dist/scripts/container.js', 'health'])
      : health(['node', '-e', `fetch('https://localhost:${product === 'magnus' ? 4000 : 4101}/${product === 'cindertrace' ? 'ready' : ''}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`]);
    const initialization = product === 'magnus'
      ? { image: need(images, 'magnus'), command: ['migrate'], verificationCommand: ['verify-initialization'] }
      : product === 'cindertrace'
        ? { image: need(images, 'cindertrace'), command: ['node', 'scripts/apply-migrations.mjs'], verificationCommand: ['node', 'scripts/apply-migrations.mjs', '--verify-current'], workingDirectory: '/app/services/security-fusion' }
        : { image: need(images, 'chat-migrator'), command: ['migrate'], verificationCommand: ['validate-current'] };
    manifest.components[product] = {
      image: need(images, product),
      kind: 'application',
      storageFormat: product + '-v1',
      requiresLocal: Object.keys(dependencies),
      service: { user, networks: ['default', network], depends_on: dependencies, healthcheck },
      initialization,
    };
  }
  manifest.components.emberfold = {
    image: need(images, 'emberfold'),
    kind: 'application',
    storageFormat: 'emberfold-stateless-v1',
    service: { user, healthcheck: health(['node', '-e', "fetch('http://127.0.0.1:8096/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]) },
  };
  // Offered, but no profile selects it: the web terminal is an explicit opt-in.
  manifest.components['magnus-gateway'] = {
    image: need(images, 'magnus-gateway'),
    kind: 'application',
    storageFormat: 'magnus-gateway-known-hosts-v1',
    requiresLocal: ['magnus'],
    service: { user, depends_on: { magnus: { condition: 'service_healthy' } }, healthcheck: health(['magnus-fleet-gateway', 'healthcheck']) },
  };
  // Ardent Project Studio: SQLite and content-addressed files in /data, plain HTTP on the
  // console host's private network. It reaches Magnus, HiveMem and Oathweave over HTTPS.
  if (images.ardentstudio) {
    manifest.components.ardentstudio = {
      image: images.ardentstudio,
      kind: 'application',
      storageFormat: 'ardentstudio-v1',
      service: { user, healthcheck: health(['node', '/app/healthcheck.mjs']) },
    };
  }
  if (images.embermend) {
    const network = 'embermend-data';
    manifest.networks[network] = { driver: 'bridge', internal: true };
    manifest.components['embermend-postgres'] = {
      image: images['embermend-postgres'] ?? DATASTORE_IMAGES.postgres18, kind: 'datastore', storageFormat: 'embermend-postgres-18',
      service: { user, networks: [network], tmpfs: ['/var/run/postgresql'], environment: { PGDATA: '/data/pgdata', POSTGRES_DB: 'embermend', POSTGRES_USER: 'embermend', POSTGRES_PASSWORD_FILE: '/config/password', POSTGRES_INITDB_ARGS: '--data-checksums' }, healthcheck: health(['pg_isready', '-h', '127.0.0.1', '-U', 'embermend', '-d', 'embermend']) },
    };
    const service = { user, networks: ['default', network], depends_on: { 'embermend-postgres': { condition: 'service_healthy' } } };
    manifest.components['embermend-worker'] = { image: images.embermend, kind: 'application', storageFormat: 'embermend-worker-stateless-v1', requiresLocal: ['embermend-postgres'], service: { ...service, command: ['worker'], healthcheck: health(['node', '/app/healthcheck.mjs', 'worker']) } };
    manifest.components.embermend = { image: images.embermend, kind: 'application', storageFormat: 'embermend-v1', requiresLocal: ['magnus', 'oathweave', 'hivexui', 'embermend-postgres', 'embermend-worker'], service: { ...service, command: ['api'], healthcheck: health(['node', '/app/healthcheck.mjs']) }, initialization: { image: images.embermend, command: ['migrate'], verificationCommand: ['verify-initialization'] } };
  }
  manifest.profiles.full = Object.keys(manifest.components).filter((name) => name !== 'magnus-gateway' && !name.startsWith('embermend') && !OPTIONAL_PRODUCTS.includes(name)).sort();
  return manifest;
}
