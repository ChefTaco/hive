// Public timing evidence contains phase names and durations, never command output or secrets.
import { performance } from 'node:perf_hooks';

export function recoveryTiming({ now = () => performance.now(), emit = (row) => console.log('RECOVERY_PHASE ' + JSON.stringify(row)) } = {}) {
  const started = now(), phases = [];
  let active;
  const end = (result = 'passed') => {
    if (!active) return;
    const row = { name: active.name, seconds: Math.max(0, now() - active.started) / 1000, result };
    phases.push(row); active = undefined; emit(row);
  };
  return {
    phases,
    begin(name) { end(); active = { name, started: now() }; },
    end,
    elapsed() { return Math.max(0, now() - started) / 1000; },
  };
}
