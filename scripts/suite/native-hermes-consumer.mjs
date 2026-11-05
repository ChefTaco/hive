// Optional actual public Hermes Skills-loader proof; no existing profile selected.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import {
  validateHermesConsumerArtifact,
  requireHermesMessaging,
} from './native-consumer-contract.mjs';
const execute = promisify(execFile);
export async function rehearseHermesSkills({
  output,
  artifactFile,
  skillsOrigin,
  targetToken,
  syncRunner,
  certificate,
  architecture,
  chat,
}) {
  const directory = join(output, 'hermes-proof');
  mkdirSync(directory, { mode: 0o700 });
  const put = (name, value) => {
    const path = join(directory, name);
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  };
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const descriptor = validateHermesConsumerArtifact(
    JSON.parse(readFileSync(artifactFile, 'utf8')),
    architecture,
  );
  if (chat) requireHermesMessaging(descriptor);
  const archive = join(dirname(artifactFile), descriptor.archive);
  assert.equal(digest(readFileSync(archive)), descriptor.sha256);
  const command = async (program, args, env = minimal) =>
    (
      await execute(program, args, {
        env,
        cwd: directory,
        timeout: 60000,
        maxBuffer: 32 * 1024 * 1024,
      })
    ).stdout.trim();
  const home = join(directory, 'home'),
    profile = join(directory, 'profile'),
    unpack = join(directory, 'artifact');
  for (const path of [home, profile, unpack]) mkdirSync(path, { mode: 0o700 });
  const minimal = Object.fromEntries(
    ['PATH', 'LANG', 'LC_ALL', 'TZ']
      .filter((name) => process.env[name])
      .map((name) => [name, process.env[name]]),
  );
  minimal.HOME = home;
  const names = (await command('tar', ['-tzf', archive])).split('\n');
  assert(
    names.every(
      (name) =>
        !name.startsWith('/') &&
        !name.includes('\\') &&
        !name.split('/').includes('..') &&
        !/\.(gguf|ggml|safetensors)$/i.test(name),
    ),
  );
  assert(
    (await command('tar', ['-tvzf', archive]))
      .split('\n')
      .every((line) => ['-', 'd'].includes(line[0])),
  );
  await command('tar', ['-xzf', archive, '-C', unpack, '--no-same-owner', '--no-same-permissions']);
  const envFile = put(
    'native.env',
    'RETAINED_PROFILE_CREDENTIAL=obviously-fake-synthetic-retained\n',
  );
  const config = 'skills:\n  auto_load: false\ntelemetry:\n  enabled: false\n';
  writeFileSync(join(profile, 'config.yaml'), config, { mode: 0o600 });
  const originalEnvironment = readFileSync(envFile),
    originalConfig = readFileSync(join(profile, 'config.yaml'));
  const cli = join(unpack, descriptor.executable),
    args = ['--env-file', envFile, '--profile-path', profile];
  assert.equal(
    await command(cli, [...args, '--native-preflight']),
    'hermes-agent ' + descriptor.version,
  );
  assert.equal(JSON.parse(await command(cli, [...args, '--native-init-profile'])).ok, true);
  const syncInput = put('sync-input.json', {
    registry: skillsOrigin,
    hermesHome: profile,
    target: 'hermes-consumer-fixture',
    token: targetToken,
    hermesVersion: descriptor.version,
  });
  const nativeNode = join(unpack, 'runtime/node');
  const syncEnv = { ...minimal, NODE_EXTRA_CA_CERTS: certificate };
  await command(nativeNode, [syncRunner, syncInput], syncEnv);
  const skillPath = join(profile, 'skills/registry/consumer-fixture/SKILL.md'),
    beforeSkill = digest(readFileSync(skillPath));
  await command(nativeNode, [syncRunner, syncInput], syncEnv);
  const cliOutput = await command(cli, [...args, 'skills', 'list']);
  put('native-cli-list.log', cliOutput);
  assert(cliOutput.includes('consumer-fixture'));
  const runtimes = readdirSync(join(unpack, 'app/python')).filter((name) =>
    /^cpython-3\.13\.13-linux-(x86_64|aarch64)-gnu$/.test(name),
  );
  assert.equal(runtimes.length, 1);
  const python = join(unpack, 'app/python', runtimes[0], 'bin/python3.13');
  const workerOutput = await command(
    python,
    [
      '-I',
      '-B',
      join(import.meta.dirname, 'native-hermes-consumer.py'),
      join(unpack, 'app'),
      profile,
      skillPath,
    ],
    {
      ...minimal,
      HERMES_HOME: profile,
      HERMES_MANAGED: 'magnus',
      HERMES_DISABLE_LAZY_INSTALLS: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONNOUSERSITE: '1',
    },
  );
  put('native-tools.log', workerOutput);
  const result = JSON.parse(workerOutput.split('\n').at(-1));
  assert.equal(result.passed, true);
  assert.equal(result.skillSHA256, beforeSkill);
  assert.equal(digest(readFileSync(skillPath)), beforeSkill);
  assert.deepEqual(readFileSync(envFile), originalEnvironment);
  assert.deepEqual(readFileSync(join(profile, 'config.yaml')), originalConfig);
  const mattermostFiles = names.filter(
    (name) => name.startsWith('./app/source/plugins/platforms/mattermost/') && !name.endsWith('/'),
  );
  assert(
    mattermostFiles.some((name) => name.endsWith('/adapter.py')),
    'Record actual bundled Chat adapter availability',
  );
  let chatResult;
  if (chat) {
    const ready = join(directory, 'chat-ready');
    const input = put('chat-input.json', {
      profile,
      origin: chat.origin,
      token: chat.token,
      botId: chat.botId,
      allowedUser: chat.allowedUser,
      forbiddenUser: chat.forbiddenUser,
      skillMarker: 'SYNTHETIC-IMMUTABLE-CONSUMER-SKILL',
      ready,
    });
    const environment = {
      ...minimal,
      HERMES_HOME: profile,
      HERMES_MANAGED: 'magnus',
      HERMES_DISABLE_LAZY_INSTALLS: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONNOUSERSITE: '1',
      SSL_CERT_FILE: certificate,
      MATTERMOST_ALLOWED_USERS: chat.allowedUser,
    };
    const pending = command(
      python,
      ['-I', '-B', join(import.meta.dirname, 'native-hermes-chat.py'), join(unpack, 'app'), input],
      environment,
    );
    // Install a rejection observer immediately while the protected readiness gate runs.
    let failure;
    pending.catch((error) => {
      failure = error;
    });
    await chat.waitReady(ready, () => failure);
    await chat.sendEvents();
    const stdout = await pending;
    put('native-chat.log', stdout);
    chatResult = JSON.parse(stdout.split('\n').at(-1));
    assert.equal(chatResult.passed, true);
  }
  assert.deepEqual(readFileSync(envFile), originalEnvironment);
  assert.deepEqual(readFileSync(join(profile, 'config.yaml')), originalConfig);
  const evidence = {
    ...result,
    artifactSHA256: descriptor.sha256,
    version: descriptor.version,
    provenance: descriptor.provenance,
    originalProfileEnvironmentUnchanged: true,
    originalProfileConfigurationUnchanged: true,
    repeatedSyncUnchanged: true,
    mattermost: chatResult
      ? {
          bundledAdapterPresent: true,
          accepted: true,
          ...chatResult,
          persistentGateway: 'not exercised; native adapter and owning authorization only',
        }
      : {
          bundledAdapterPresent: true,
          accepted: false,
          reason: 'Skills loader-only rehearsal; no gateway activated',
        },
  };
  put('result.json', evidence);
  return evidence;
}
