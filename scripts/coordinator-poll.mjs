const transientSocketErrors = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOENT', 'EPIPE']);

/** Poll only the coordinator's read-only status operation. Never retry a mutation. */
export async function pollCoordinatorStatus(readStatus, accept, {
  attempts = 600, intervalMs = 500,
  delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
} = {}) {
  let lastStatus, lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { lastStatus = await readStatus(); lastError = undefined; }
    catch (error) {
      if (!transientSocketErrors.has(error?.code)) throw error;
      lastError = error;
    }
    // Keep acceptance assertions outside the transport catch: a wrong outcome is fatal.
    if (!lastError && accept(lastStatus)) return lastStatus;
    if (attempt + 1 < attempts) await delay(intervalMs);
  }
  throw new Error(`Coordinator status did not reach the expected outcome: ${JSON.stringify(lastStatus)}${lastError ? `; last read: ${lastError.code}` : ''}`, { cause: lastError });
}
