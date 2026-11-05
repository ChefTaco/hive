// Reviewed product CLI/layout contracts for a disposable developer full-suite
// proof. The caller supplies a private ephemeral registry and exact local images.
import assert from 'node:assert/strict';
export function extendFullFixture({ manifest, registry, id, tags, docker, user }) {
  const push = (product, local) => {
    const tag = registry + '/' + id + '/' + product + ':candidate'; tags.push(tag);
    docker('tag', local, tag); docker('push', tag);
    const image = JSON.parse(docker('image', 'inspect', tag, '--format', '{{json .RepoDigests}}')).find(value => value.startsWith(registry + '/' + id + '/' + product + '@sha256:'));
    assert(image); return image;
  };
  const images = Object.fromEntries([['magnus', 'magnus-server:candidate'], ['cindertrace', 'cindertrace:candidate'], ['chattermost', 'chattermost:candidate'], ['chat-migrator', 'chattermost-migrator:candidate'], ['emberfold', 'emberfold:candidate'], ['magnus-gateway', 'magnus-gateway:candidate']].map(([product, local]) => [product, push(product, local)]));
  const postgres17 = JSON.parse(docker('image', 'inspect', 'postgres:17', '--format', '{{json .RepoDigests}}')).find(image => image.startsWith('postgres@sha256:'));
  const postgres18 = JSON.parse(docker('image', 'inspect', 'postgres:18', '--format', '{{json .RepoDigests}}')).find(image => image.startsWith('postgres@sha256:'));
  assert(postgres17 && postgres18);
  const health = command => ({ test: ['CMD', ...command], interval: '2s', timeout: '5s', retries: 40, start_period: '5s' });
  const redisImage = manifest.components['oathweave-redis'].image;
  for (const [product, database, role, pgImage] of [['magnus', 'magnus', 'magnus', postgres17], ['cindertrace', 'cindertrace', 'cindertrace', postgres18], ['chattermost', 'chattermost', 'chattermost_app', postgres17]]) {
    const network = product + '-data'; manifest.networks[network] = { driver: 'bridge', internal: true };
    manifest.components[product + '-postgres'] = { image: pgImage, kind: 'datastore', storageFormat: product + '-postgres-' + (product === 'cindertrace' ? '18' : '17'), service: { user, tmpfs: ['/var/run/postgresql'], environment: { PGDATA: '/data/pgdata', POSTGRES_DB: database, POSTGRES_USER: role, POSTGRES_PASSWORD_FILE: '/config/password', POSTGRES_INITDB_ARGS: '--data-checksums' }, networks: product === 'chattermost' ? {[network]:{aliases:['postgres']}} : [network], healthcheck: health(['pg_isready', '-h', '127.0.0.1', '-U', role, '-d', database]) } };
    if (product !== 'chattermost') manifest.components[product + '-redis'] = { ...structuredClone(manifest.components['oathweave-redis']), image: redisImage, storageFormat: 'redis-aof-v1', service: { ...structuredClone(manifest.components['oathweave-redis'].service), networks: [network] } };
    const dependencies = { [product + '-postgres']: { condition: 'service_healthy' }, ...(product === 'chattermost' ? {} : { [product + '-redis']: { condition: 'service_healthy' } }) };
    manifest.components[product] = { image: images[product], kind: 'application', storageFormat: product + '-candidate-v1', requiresLocal: Object.keys(dependencies), service: { user, networks: ['default', network], depends_on: dependencies, healthcheck: product === 'chattermost' ? health(['node', 'dist/scripts/container.js', 'health']) : health(['node', '-e', `fetch('https://localhost:${product === 'magnus' ? 4000 : 4101}/${product === 'cindertrace' ? 'ready' : ''}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`]) }, initialization: product === 'magnus' ? { image: images.magnus, command: ['migrate'], verificationCommand: ['verify-initialization'] } : product === 'cindertrace' ? { image: images.cindertrace, command: ['node', 'scripts/apply-migrations.mjs'], verificationCommand: ['node', 'scripts/apply-migrations.mjs', '--verify-current'], workingDirectory: '/app/services/security-fusion' } : { image: images['chat-migrator'], command: ['migrate'], verificationCommand: ['validate-current'] } };
  }
  manifest.components.emberfold = { image: images.emberfold, kind: 'application', storageFormat: 'emberfold-stateless-v1', service: { user, healthcheck: health(['node', '-e', "fetch('http://127.0.0.1:8096/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]) } };
  // Offered, but no profile selects it: the web terminal is an explicit opt-in.
  manifest.components['magnus-gateway'] = { image: images['magnus-gateway'], kind: 'application', storageFormat: 'magnus-gateway-known-hosts-v1', requiresLocal: ['magnus'], service: { user, depends_on: { magnus: { condition: 'service_healthy' } }, healthcheck: health(['magnus-fleet-gateway', 'healthcheck']) } };
  manifest.profiles.full = Object.keys(manifest.components).filter(name => name !== 'magnus-gateway').sort();
}
