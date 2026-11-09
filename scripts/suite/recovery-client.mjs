// Observe actual client traffic rather than sleeping and hoping the client started.
export function observeRecoveryClient(child, { timeoutMs = 10000 } = {}) {
  const samples = [], waiters = new Set();
  let partial = '', failure;
  const fail = (error) => { failure = error; for (const waiter of waiters) waiter(); };
  child.on('error', fail);
  child.on('exit', () => fail(new Error('Acceptance client exited')));
  child.stdout.on('data', (chunk) => {
    partial += chunk;
    let end;
    while ((end = partial.indexOf('\n')) >= 0) {
      const line = partial.slice(0, end); partial = partial.slice(end + 1);
      if (!line.startsWith('{')) continue;
      try {
        const sample = JSON.parse(line);
        if (!Number.isFinite(sample.at) || !Number.isFinite(sample.ms) || typeof sample.ok !== 'boolean') throw Error('Invalid acceptance client sample');
        samples.push(sample);
      } catch { fail(new Error('Invalid acceptance client sample')); }
    }
    for (const waiter of waiters) waiter();
  });
  return {
    samples,
    observed(after = 0) {
      return new Promise((done, reject) => {
        let settled = false;
        const finish = (error) => { if (settled) return; settled = true; clearTimeout(timeout); waiters.delete(check); error ? reject(error) : done(); };
        const check = () => {
          if (failure) finish(failure);
          else if (samples.some((row) => row.ok && row.at >= after)) finish();
          else if (child.exitCode !== null) finish(new Error('Acceptance client exited'));
        };
        const timeout = setTimeout(() => finish(new Error('Acceptance client observation timed out')), timeoutMs);
        waiters.add(check); check();
      });
    },
  };
}
