import { spawn } from 'node:child_process';
import { config } from './config.js';
import { store } from './db.js';

/** One local deployment at a time. Output may contain credentials: retain only exit codes. */
export function startDeploymentWorker(): () => void {
  let busy = false;
  store.recoverDeployments();
  const timer = setInterval(() => {
    if (busy) return;
    const job = store.claimDeployment();
    if (!job) return;
    busy = true;
    const target = store.getTarget(job.target);
    if (!target) { store.finishDeployment(job.id, false, 'target_disabled'); busy = false; return; }
    try {
      const child = spawn(config.deployScript, ['--target', target.name], {
        stdio: 'ignore', timeout: 120_000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER,
          HIVE_SKILLS_PUBLIC_URL: config.publicUrl, HIVE_SKILLS_TARGET_HOST: target.host,
          HIVE_SKILLS_TARGET_USER: target.username, HIVE_SKILLS_KEY_ONLY: 'true' },
      });
      let finished = false;
      const finish = (ok: boolean, code: string) => { if (finished) return; finished = true; store.finishDeployment(job.id, ok, code); busy = false; };
      child.once('error', () => finish(false, 'launch_failed'));
      child.once('close', (code) => finish(code === 0, code === 0 ? 'timer_installed' : `exit_${code ?? 'signal'}`));
    } catch { store.finishDeployment(job.id, false, 'launch_failed'); busy = false; }
  }, 1000);
  timer.unref();
  return () => clearInterval(timer);
}
