// Ownership boundary for a disposable real systemd user-service rehearsal.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
  rmdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
export function syntheticUnitName(installation, agent) {
  assert(
    /^native-proof-[a-f0-9]{10}$/.test(installation),
    'Only uniquely generated native proof installations are supported',
  );
  assert.equal(agent, 'native-magnus');
  return `hive-${installation}-${agent}.service`;
}
const missing = (path) => {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function prepareUserService({
  installation,
  agent = 'native-magnus',
  home = process.env.HOME,
}) {
  const unit = syntheticUnitName(installation, agent),
    uid = process.getuid();
  assert(uid > 0 && home?.startsWith('/'));
  const runtime = '/run/user/' + uid,
    runtimeInfo = lstatSync(runtime);
  assert(
    runtimeInfo.isDirectory() &&
      !runtimeInfo.isSymbolicLink() &&
      runtimeInfo.uid === uid &&
      (runtimeInfo.mode & 0o077) === 0,
  );
  assert(
    lstatSync(join(runtime, 'bus')).isSocket(),
    'Existing user bus is required; no manager is provisioned',
  );
  const env = { PATH: process.env.PATH, HOME: home, XDG_RUNTIME_DIR: runtime };
  const control = (...args) =>
    execFileSync('systemctl', ['--user', ...args], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    }).trim();
  const managerVersion = control('show', '--property=Version', '--value');
  assert(managerVersion);
  const config = join(home, '.config'),
    systemd = join(config, 'systemd'),
    units = join(systemd, 'user'),
    wants = join(units, 'default.target.wants');
  assert(
    control('show', '--property=UnitPath', '--value').split(/\s+/).includes(units),
    'The existing user manager must search its standard user unit directory',
  );
  const path = join(units, unit),
    link = join(wants, unit);
  assert(missing(path) && missing(link), 'Refuse an existing unit path, including links');
  assert.equal(control('show', unit, '--property=LoadState', '--value'), 'not-found');
  const created = [config, systemd, units, wants].filter(missing);
  for (const directory of [config, systemd, units, wants].filter((path) => !missing(path))) {
    const info = lstatSync(directory);
    assert(info.isDirectory() && !info.isSymbolicLink() && info.uid === uid);
    if (directory === units)
      assert.equal(
        info.mode & 0o777,
        0o700,
        'An existing unit directory must already be private; this proof does not change its permissions',
      );
  }
  const snapshot = () =>
    missing(units)
      ? []
      : readdirSync(units)
          .filter((name) => name !== unit && name !== 'default.target.wants')
          .sort()
          .map((name) => {
            const file = join(units, name),
              info = lstatSync(file);
            return [
              name,
              info.ino,
              info.mode,
              info.isFile()
                ? sha(readFileSync(file))
                : info.isSymbolicLink()
                  ? readlinkSync(file)
                  : 'directory',
            ];
          });
  const baseline = snapshot();
  const baselineWants = missing(wants) ? [] : readdirSync(wants).sort();
  let unitSHA;
  const capture = (expectedLauncher) => {
    const info = lstatSync(path);
    assert(info.isFile() && !info.isSymbolicLink() && info.uid === uid);
    const bytes = readFileSync(path);
    assert(bytes.includes(Buffer.from('ExecStart=' + expectedLauncher + '\n')));
    assert.equal(control('show', unit, '--property=FragmentPath', '--value'), path);
    assert.equal(readlinkSync(link), path);
    unitSHA = sha(bytes);
    return unitSHA;
  };
  const state = () => {
    const values = Object.fromEntries(
      control(
        'show',
        unit,
        '--property=ActiveState',
        '--property=SubState',
        '--property=MainPID',
        '--property=InvocationID',
      )
        .split('\n')
        .map((row) => {
          const at = row.indexOf('=');
          return [row.slice(0, at), row.slice(at + 1)];
        }),
    );
    return {
      active: values.ActiveState === 'active',
      substate: values.SubState,
      pid: Number(values.MainPID),
      invocation: values.InvocationID,
    };
  };
  const cleanup = () => {
    if (!missing(path)) {
      assert(
        unitSHA && sha(readFileSync(path)) === unitSHA,
        'Synthetic unit changed; retain it for explicit ownership review',
      );
      control('stop', unit);
      if (!missing(link)) assert.equal(readlinkSync(link), path);
      control('disable', unit);
      assert(missing(link));
      unlinkSync(path);
      control('daemon-reload');
      try {
        control('reset-failed', unit);
      } catch {
        /* Removed units need no failure reset. */
      }
    }
    assert.deepEqual(snapshot(), baseline, 'Existing unit files must remain unchanged');
    if (!missing(wants))
      assert.deepEqual(
        readdirSync(wants).sort(),
        baselineWants,
        'Existing enablement links must remain unchanged',
      );
    for (const directory of [...created].reverse()) if (!missing(directory)) rmdirSync(directory);
    assert.equal(control('show', unit, '--property=LoadState', '--value'), 'not-found');
    return {
      unitRemoved: true,
      ownedEnablementRemoved: true,
      priorUnitsUnchanged: true,
      newDirectoriesRemoved: true,
      managerVersion,
    };
  };
  return { unit, path, env, control, capture, state, cleanup };
}
