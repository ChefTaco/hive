// A production-like host for the rehearsal drivers. Inside scripts/suite/sudo-host.sh
// (HIVE_SUDO_HOST), the controller reaches the host over SSH as the unprivileged deploy account
// and runs the host side as root through sudo -S, with the installation's sshConfig and
// sudoPasswordFile, exactly as on a production host. Services run as HIVE_SERVICE_USER.
// Outside it, the drivers keep their local target as the operator.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

export const sudoHost = process.env.HIVE_SUDO_HOST === '1';
/** uid:gid the suite's services run as. */
export const serviceUser = sudoHost ? process.env.HIVE_SERVICE_USER : `${process.getuid()}:${process.getgid()}`;
assert.match(serviceUser ?? '', /^[1-9][0-9]*:[1-9][0-9]*$/, 'A non-root service user is required');
export const [serviceUid, serviceGid] = serviceUser.split(':').map(Number);

async function freePort() {
  const socket = createServer().listen(0, '127.0.0.1');
  await new Promise((done) => socket.once('listening', done));
  const { port } = socket.address();
  await new Promise((done) => socket.close(done));
  return port;
}

/**
 * Starts an sshd for deploy and returns the host entry fields the installation needs:
 * {target, sshConfig, sudoPasswordFile}, plus stop(). `directory` holds the keys and the SSH
 * configuration; `path` is prepended to PATH for the session, as a host's own tools would be.
 */
export async function startSudoTarget(directory, { path = '' } = {}) {
  assert(sudoHost, 'A sudo target exists only inside scripts/suite/sudo-host.sh');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = (name) => join(directory, name);
  for (const name of ['host', 'client']) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file(name)]);
  const port = await freePort();
  // sshd reads it as deploy, so it lives in deploy's own home inside the container.
  const authorized = '/home/deploy/.ssh/authorized_keys';
  mkdirSync('/home/deploy/.ssh', { recursive: true, mode: 0o700 });
  writeFileSync(authorized, readFileSync(file('client.pub')), { mode: 0o600 });
  execFileSync('chown', ['-R', 'deploy:deploy', '/home/deploy/.ssh']);
  writeFileSync(file('sshd.conf'), [`Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${file('host')}`, `PidFile ${file('sshd.pid')}`, `AuthorizedKeysFile ${authorized}`,
    'AllowUsers deploy', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'AuthenticationMethods publickey', 'PermitRootLogin no', 'StrictModes no', 'UsePAM no',
    'AllowTcpForwarding no', 'X11Forwarding no', 'PermitTTY no', `SetEnv PATH=${path ? path + ':' : ''}${process.env.PATH}`, 'Subsystem sftp internal-sftp', ''].join('\n'));
  writeFileSync(file('known_hosts'), `[127.0.0.1]:${port} ${readFileSync(file('host.pub'), 'utf8')}`);
  writeFileSync(file('ssh.conf'), ['Host sudo-host.example.com', ' HostName 127.0.0.1', ` Port ${port}`, ` UserKnownHostsFile ${file('known_hosts')}`, ` IdentityFile ${file('client')}`,
    ' IdentityAgent none', ' IdentitiesOnly yes', ' StrictHostKeyChecking yes', ' BatchMode yes', ' ConnectTimeout 5', ' LogLevel ERROR', ''].join('\n'));
  for (const name of ['ssh.conf', 'known_hosts']) chmodSync(file(name), 0o600);
  const log = openSync(file('sshd.log'), 'a', 0o600);
  const daemon = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', file('sshd.conf')], { stdio: ['ignore', log, log] });
  closeSync(log);
  const sshConfig = file('ssh.conf');
  for (let attempt = 0; ; attempt++) {
    try { execFileSync('ssh', ['-F', sshConfig, 'deploy@sudo-host.example.com', 'true'], { stdio: 'ignore' }); break; } catch (error) { if (attempt > 50) throw error; await new Promise((done) => setTimeout(done, 100)); }
  }
  const sudoPasswordFile = process.env.HIVE_SUDO_PASSWORD_FILE;
  assert(sudoPasswordFile, 'The sudo host provides a password file');
  // The host side really is root through sudo, not the SSH account.
  const uid = execFileSync('ssh', ['-F', sshConfig, 'deploy@sudo-host.example.com', "sudo -k -S -p '' id -u"], { input: readFileSync(sudoPasswordFile), encoding: 'utf8' }).trim();
  assert.equal(uid, '0', 'sudo on the target runs as root');
  return { target: 'deploy@sudo-host.example.com', sshConfig, sudoPasswordFile, stop: () => daemon.kill() };
}
