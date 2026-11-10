// Only for child processes created by disposable acceptance fixtures.
import { setTimeout as delay } from 'node:timers/promises';

export async function stopFixtureProcess(child, { timeoutMs = 10000, group = false } = {}) {
  if (!child?.pid) return;
  const signal = (name) => {
    try { group ? process.kill(-child.pid, name) : child.kill(name); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const stopped = () => {
    if (child.exitCode === null && child.signalCode === null) return false;
    if (!group) return true;
    try { process.kill(-child.pid, 0); return false; }
    catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  };
  if (stopped()) return;
  signal('SIGTERM');
  const until = Date.now() + timeoutMs;
  while (!stopped() && Date.now() < until) await delay(20);
  if (stopped()) return;
  signal('SIGKILL');
  // A forced stop is a failed fixture. It must never qualify a supervisor-absence check.
  const killedUntil = Date.now() + 2000;
  while (!stopped() && Date.now() < killedUntil) await delay(20);
  throw new Error('Synthetic fixture process did not stop gracefully before its deadline');
}
