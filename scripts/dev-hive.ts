import { createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

export interface DevHiveServicePlan {
  name: string;
  cwd: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
}

export interface DevHivePlan {
  rootDir: string;
  stateDir: string;
  composeFile: string;
  memoryToken: string;
  services: DevHiveServicePlan[];
}

function secret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signMemoryToken(jwtSecret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: 'HS256', typ: 'JWT' });
  const payload = base64UrlJson({
    sub: 'hive-router-dev',
    iss: 'hivemem',
    aud: 'hivemem-api',
    token_type: 'access',
    jti: randomBytes(16).toString('base64url'),
    role: 'admin',
    scope: ['admin:all'],
    iat: now,
    exp: now + 60 * 60 * 24 * 30,
  });
  const signature = createHmac('sha256', jwtSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function writeIfMissing(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, content, { mode });
  }
}

function ensureDevFiles(rootDir: string): {
  stateDir: string;
  composeFile: string;
  jwtPrivateKeyPath: string;
  jwtPublicKeyPath: string;
  memoryJwtSecret: string;
  memoryToken: string;
  cookieSecret: string;
  iamAgentSecret: string;
  passwordEncryptionKey: string;
  routerSecret: string;
} {
  const stateDir = resolve(rootDir, '.hive-dev');
  const secretsPath = resolve(stateDir, 'secrets.env');
  const jwtPrivateKeyPath = resolve(stateDir, 'iam/jwt-private.pem');
  const jwtPublicKeyPath = resolve(stateDir, 'iam/jwt-public.pem');
  const composeFile = resolve(stateDir, 'docker-compose.yml');

  mkdirSync(stateDir, { recursive: true });
  if (!existsSync(jwtPrivateKeyPath) || !existsSync(jwtPublicKeyPath)) {
    const pair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    writeIfMissing(jwtPrivateKeyPath, pair.privateKey, 0o600);
    writeIfMissing(jwtPublicKeyPath, pair.publicKey, 0o644);
  }

  if (!existsSync(secretsPath)) {
    const memoryJwtSecret = secret();
    writeIfMissing(secretsPath, [
      `HIVE_DEV_COOKIE_SECRET=${secret()}`,
      `HIVE_DEV_IAM_AGENT_SECRET=${secret(24)}`,
      `HIVE_DEV_PASSWORD_ENCRYPTION_KEY=${secret()}`,
      `HIVE_DEV_ROUTER_SECRET=${secret()}`,
      `HIVE_DEV_MEMORY_JWT_SECRET=${memoryJwtSecret}`,
      `HIVE_DEV_MEMORY_TOKEN=${signMemoryToken(memoryJwtSecret)}`,
      '',
    ].join('\n'), 0o600);
  }

  const secrets = Object.fromEntries(
    (existsSync(secretsPath) ? readFileSync(secretsPath, 'utf8') : '')
      .split(/\r?\n/)
      .map((line) => line.split('=', 2))
      .filter((entry): entry is [string, string] => entry.length === 2 && Boolean(entry[0])),
  );

  writeIfMissing(composeFile, [
    'services:',
    '  redis:',
    '    image: redis:7-alpine',
    '    ports:',
    '      - "6379:6379"',
    '  qdrant:',
    '    image: qdrant/qdrant:v1.15.5',
    '    ports:',
    '      - "6333:6333"',
    '    volumes:',
    '      - ./qdrant:/qdrant/storage',
    '',
  ].join('\n'));

  return {
    stateDir,
    composeFile,
    jwtPrivateKeyPath,
    jwtPublicKeyPath,
    memoryJwtSecret: secrets.HIVE_DEV_MEMORY_JWT_SECRET ?? secret(),
    memoryToken: secrets.HIVE_DEV_MEMORY_TOKEN ?? signMemoryToken(secrets.HIVE_DEV_MEMORY_JWT_SECRET ?? secret()),
    cookieSecret: secrets.HIVE_DEV_COOKIE_SECRET ?? secret(),
    iamAgentSecret: secrets.HIVE_DEV_IAM_AGENT_SECRET ?? secret(24),
    passwordEncryptionKey: secrets.HIVE_DEV_PASSWORD_ENCRYPTION_KEY ?? secret(),
    routerSecret: secrets.HIVE_DEV_ROUTER_SECRET ?? secret(),
  };
}

export function buildDevHivePlan(rootDir = process.cwd()): DevHivePlan {
  const files = ensureDevFiles(rootDir);
  const routerDir = resolve(rootDir, 'services/hive-router');
  const iamDir = resolve(rootDir, 'services/hive-iam/apps/iam-core');
  const memoryDir = resolve(rootDir, 'services/hive-mem/ts-core');

  const services: DevHiveServicePlan[] = [
    {
      name: 'memory',
      cwd: memoryDir,
      command: 'npm',
      args: ['run', 'dev'],
      env: {
        NODE_ENV: 'development',
        HIVEMEM_JWT_SECRET: files.memoryJwtSecret,
        HIVEMEM_TOKEN: files.memoryToken,
        HIVEMEM_TS_CORE_HOST: '127.0.0.1',
        HIVEMEM_TS_CORE_PORT: '18790',
        HIVEMEM_TS_PERSISTENCE: 'qdrant',
        QDRANT_URL: 'http://127.0.0.1:6333',
      },
      url: 'http://127.0.0.1:18790/v1/health/ready',
    },
    {
      name: 'iam',
      cwd: iamDir,
      command: 'npm',
      args: ['run', 'dev'],
      env: {
        NODE_ENV: 'development',
        HOST: '127.0.0.1',
        PORT: '4200',
        DATABASE_URL: `file:${resolve(files.stateDir, 'iam/iam.db')}`,
        REDIS_URL: 'redis://127.0.0.1:6379',
        JWT_PRIVATE_KEY_PATH: files.jwtPrivateKeyPath,
        JWT_PUBLIC_KEY_PATH: files.jwtPublicKeyPath,
        JWT_ISSUER: 'http://127.0.0.1:4200',
        COOKIE_SECRET: files.cookieSecret,
        IAM_AGENT_SECRET: files.iamAgentSecret,
        PASSWORD_ENCRYPTION_KEY: files.passwordEncryptionKey,
        CORS_ORIGIN: 'http://127.0.0.1:9443,http://127.0.0.1:5173',
      },
      url: 'http://127.0.0.1:4200/api/v1/health/ready',
    },
    {
      name: 'router',
      cwd: routerDir,
      command: 'npm',
      args: ['run', 'dev'],
      env: {
        NODE_ENV: 'development',
        API_HOST: '127.0.0.1',
        ADMIN_HOST: '127.0.0.1',
        API_PORT: '8080',
        ADMIN_PORT: '9443',
        PUBLIC_API_URL: 'http://127.0.0.1:8080',
        PUBLIC_ADMIN_URL: 'http://127.0.0.1:9443',
        HIVE_UI_PUBLIC_URL: 'http://127.0.0.1:5173',
        DATABASE_URL: `file:${resolve(files.stateDir, 'router/router.db')}`,
        DATA_DIR: resolve(files.stateDir, 'router/data'),
        TRACE_DIR: resolve(files.stateDir, 'router/traces'),
        HIVE_ROUTER_SECRET: files.routerSecret,
        HIVE_ROUTER_AUTH_MODE: 'os',
        HIVE_ROUTER_ADMIN_USERS: process.env.USER ?? 'admin',
        HIVEMEM_INTERNAL_URL: 'http://127.0.0.1:18790',
        HIVEMEM_PUBLIC_URL: 'http://127.0.0.1:18790',
        HIVE_ROUTER_MEMORY_PROXY_TOKEN: files.memoryToken,
        HIVE_IAM_INTERNAL_URL: 'http://127.0.0.1:4200',
        HIVE_IAM_PUBLIC_URL: 'http://127.0.0.1:4200',
        HIVE_STATUS_ALLOW_INSECURE_TLS: 'true',
      },
      url: 'http://127.0.0.1:9443',
    },
    {
      name: 'ui',
      cwd: routerDir,
      command: 'npm',
      args: ['run', 'dev:ui', '--', '--host', '127.0.0.1', '--port', '5173'],
      env: {},
      url: 'http://127.0.0.1:5173',
    },
  ];

  return { rootDir, stateDir: files.stateDir, composeFile: files.composeFile, memoryToken: files.memoryToken, services };
}

function hasDockerCompose(): boolean {
  const docker = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' });
  return docker.status === 0;
}

function startService(service: DevHiveServicePlan): ChildProcess {
  const child = spawn(service.command, service.args, {
    cwd: service.cwd,
    env: { ...process.env, ...service.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = `[${service.name}]`;
  child.stdout?.on('data', (chunk) => process.stdout.write(`${prefix} ${chunk}`));
  child.stderr?.on('data', (chunk) => process.stderr.write(`${prefix} ${chunk}`));
  child.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT') {
      process.stderr.write(`${prefix} exited with code ${code ?? signal}\n`);
    }
  });
  return child;
}

function runPreflight(service: DevHiveServicePlan, args: string[]): void {
  const result = spawnSync('npm', args, {
    cwd: service.cwd,
    env: { ...process.env, ...service.env },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`${service.name} preflight failed: npm ${args.join(' ')}`);
  }
}

async function main(): Promise<void> {
  const rootDir = resolve(process.cwd());
  const plan = buildDevHivePlan(rootDir);
  if (process.argv.includes('--print-plan') || process.argv.includes('--dry-run')) {
    console.log(JSON.stringify({
      ...plan,
      memoryToken: '<redacted>',
      services: plan.services.map((service) => ({
        ...service,
        env: Object.fromEntries(Object.entries(service.env).map(([key, value]) => [key, /SECRET|TOKEN|KEY/.test(key) ? '<redacted>' : value])),
      })),
    }, null, 2));
    return;
  }

  if (!process.argv.includes('--no-deps') && hasDockerCompose()) {
    spawnSync('docker', ['compose', '-f', plan.composeFile, 'up', '-d'], { cwd: plan.stateDir, stdio: 'inherit' });
  } else if (!process.argv.includes('--no-deps')) {
    console.warn('docker compose is not available; starting services without Redis/Qdrant containers. Pass --no-deps to silence this warning.');
  }

  console.log('Hive local dev stack');
  console.log(`State: ${plan.stateDir}`);
  for (const service of plan.services) {
    console.log(`- ${service.name}: ${service.url ?? service.cwd}`);
  }

  const iam = plan.services.find((service) => service.name === 'iam');
  if (iam && !process.argv.includes('--skip-iam-db')) {
    runPreflight(iam, ['run', 'db:migrate:deploy']);
    runPreflight(iam, ['run', 'db:seed']);
  }

  const children = plan.services.map(startService);
  const shutdown = () => {
    for (const child of children) child.kill('SIGTERM');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
