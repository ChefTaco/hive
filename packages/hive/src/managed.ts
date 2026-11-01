import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  adopt,
  atomic,
  configureCompose,
  projectFile,
  run,
  type Project,
} from './release/runtime.js';
import { ensurePrivateDir } from './envfile.js';
import type { HivePaths } from './paths.js';

function unitQuote(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('Invalid service path');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
}
export async function enroll(paths: HivePaths, manager: Project['manager']): Promise<void> {
  if (existsSync(projectFile(paths.home))) return;
  await adopt(paths.home, true, manager);
  atomic(
    join(paths.config, 'upgrade.env'),
    'HIVE_UPDATE_CHECK=true\nHIVE_AUTO_UPGRADE=false\nHIVE_UI_UPGRADE=false\nHIVE_COMPOSE_UPGRADE_SUPERVISOR=false\n',
  );
  if (manager === 'compose') {
    for (const service of ['iam', 'router', 'memory', 'skills'])
      ensurePrivateDir(join(paths.home, service));
    configureCompose(paths.home);
    atomic(
      join(paths.config, 'upgrade.env'),
      'HIVE_UPDATE_CHECK=true\nHIVE_AUTO_UPGRADE=false\nHIVE_UI_UPGRADE=false\nHIVE_COMPOSE_UPGRADE_SUPERVISOR=true\n',
    );
  }
  if (manager === 'systemd') {
    if (process.platform !== 'linux') throw new Error('Systemd management requires Linux');
    const units = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd/user');
    const bin = join(paths.home, 'current/node_modules/@hivemagnus/hive/dist/src/cli.js');
    const common = `\n[Service]\nType=simple\nWorkingDirectory=${unitQuote(paths.home)}\nEnvironment=${unitQuote(`HIVE_HOME=${paths.home}`)}\nEnvironmentFile=${unitQuote(join(paths.config, 'upgrade.env'))}\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\n`;
    atomic(
      join(units, 'hive.service'),
      `[Unit]\nDescription=Hive managed stack\nAfter=network-online.target\n${common}ExecStart=${unitQuote(process.execPath)} ${unitQuote(bin)} start\nTimeoutStopSec=660\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`,
    );
    atomic(
      join(units, 'hive-coordinator.service'),
      `[Unit]\nDescription=Hive upgrade coordinator\nAfter=network-online.target\n${common}ExecStart=${unitQuote(process.execPath)} ${unitQuote(bin)} coordinator\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`,
    );
    await run('systemctl', ['--user', 'daemon-reload']);
    await run('systemctl', ['--user', 'enable', 'hive.service', 'hive-coordinator.service']);
  }
}
