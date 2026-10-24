import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
/** Kernel lock lives until this process exits; stale PIDs cannot steal it. */
export async function acquireWriterLock(path: string): Promise<() => void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) => {
    const child = spawn('flock', ['--exclusive', '--nonblock', path, 'sh', '-c', 'printf ready; cat >/dev/null'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let acquired = false;
    child.once('error', () => reject(new Error('HiveMem requires flock for single-writer protection')));
    child.once('exit', () => { if (!acquired) reject(new Error('Another HiveMem writer is already running')); else if (!child.killed) process.exit(1); });
    child.stdout.once('data', () => { acquired = true; resolve(() => { child.kill(); child.stdin.end(); }); });
  });
}
