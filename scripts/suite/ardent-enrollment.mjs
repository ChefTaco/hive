// Runs inside the pinned Magnus image. Only a reviewed, empty fresh installation can
// obtain this narrow scope. Existing histories use Magnus's independent review workflow.
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

export function assertServiceProcesses(processes) {
  assert.equal(processes.length, 2, 'API or gateway descendants need independent review');
  const init = processes.find(p => p.name === 'docker-init');
  // Node's /proc name changed across runtime releases. Both exact main-thread
  // names describe the one application child; no other process is approved.
  const main = processes.find(p => p.name === 'MainThread' || p.name === 'node-MainThread');
  assert(init && main, 'API or gateway must contain only its init and Node main thread');
  assert(processes.every(p => Number.isSafeInteger(p.pid) && p.pid > 0 && Number.isSafeInteger(p.ppid))
    && init.pid !== main.pid, 'API or gateway process identities need independent review');
  assert.equal(main.ppid, init.pid, 'API or gateway Node process must be a direct child of its init');
}
export async function stableServiceProcesses(read, wait = () => new Promise(resolve => setTimeout(resolve, 250))) {
  let previous = null;
  for (let attempt = 0; attempt < 24; attempt++) {
    const processes = await read();
    try { assertServiceProcesses(processes); }
    catch {
      previous = null;
      if (attempt === 23) throw new Error('API processes did not settle; pause unrelated work and retry the enrollment review');
      await wait(); continue;
    }
    if (JSON.stringify(processes) === JSON.stringify(previous)) return processes;
    previous = processes;
    if (attempt < 23) await wait();
  }
  throw new Error('API processes keep changing; pause unrelated work and retry the enrollment review');
}

export function assertFreshArdentReview(review) {
  assert.equal(review.freshInstallation, true, 'A completed fresh installation is required');
  assert.match(review.initializerSHA256, /^[a-f0-9]{64}$/, 'Fresh initializer evidence is required');
  assert(Number.isSafeInteger(review.owner.uid) && review.owner.uid > 0, 'A non-root native owner is required');
  assert.match(review.owner.username, /^[a-z_][a-z0-9_-]*$/);
  assert.equal(review.owner.profileCount, 0, 'Existing native profiles require independent review');
  assert(review.owner.processes.every((name) => ['systemd', '(sd-pam)', 'dbus-daemon'].includes(name)), 'Native owner has running work');
  assert(['commands', 'leases', 'participantWork', 'schedulerDefinitions'].every((key) => review.counts[key] === 0), 'Existing command, participant or scheduler history requires independent review');
  for (const processes of [review.apiProcesses, review.gatewayProcesses]) {
    if (processes === null) continue; // The product verifies its declared-absent gateway itself.
    assertServiceProcesses(processes);
  }
}

async function apiProcesses() {
  const processes = [];
  for (const pid of (await readdir('/proc')).filter((value) => /^\d+$/.test(value) && Number(value) !== process.pid)) {
    try {
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      processes.push({ pid: Number(pid), ppid: Number(status.match(/^PPid:\s+(\d+)$/m)?.[1]), name: status.match(/^Name:\s+(.+)$/m)?.[1] });
    } catch { /* A process that exited cannot be approved as a continuing descendant. */ }
  }
  return processes.sort((a, b) => a.pid - b.pid);
}

export async function prepareArdentScope(input) {
  const base = '/opt/magnus-server/node_modules/@hivemagnus/magnus-server/dist';
  const { getDb, disconnectDb } = await import(`${base}/db/index.js`);
  const service = await import(`${base}/services/resource-enrollment.js`);
  const scope = await import(`${base}/services/ardent-scope-enrollment.js`);
  const { reconciliationSecret } = await import(`${base}/services/resource-participant-work.js`);
  const { logAuditEvent } = await import(`${base}/services/audit-service.js`);
  const db = getDb();
  const sha = (value) => createHash('sha256').update(service.canonical(value)).digest('hex');
  try {
    assert(['inspect', 'apply'].includes(input.mode));
    const node = await db.node.findFirstOrThrow({ where: { hostname: input.hostFqdn } });
    const current = await scope.inspectArdentScope(node.id);
    if (current.scope.state === 'active') return { state: 'active', nodeId: node.id, changed: false };
    // Check the separate authority before starting any irreversible drain.
    const key = reconciliationSecret();
    const counts = {
      commands: await db.remoteCommand.count({ where: { nodeId: node.id } }),
      leases: await db.commandResourceLease.count({ where: { nodeId: node.id } }),
      participantWork: await db.resourceParticipantWork.count({ where: { nodeId: node.id } }),
      schedulerDefinitions: await db.managedCronDefinition.count({ where: { nodeId: node.id } }),
    };
    const review = { nodeId: node.id, nodeFqdn: node.hostname, createdAt: node.createdAt,
      freshInstallation: input.freshInstallation, initializerSHA256: input.initializerSHA256,
      owner: input.owner, counts, apiProcesses: await stableServiceProcesses(apiProcesses), gatewayProcesses: input.gatewayProcesses };
    assertFreshArdentReview(review);
    const reviewSHA256 = sha(review);
    if (input.mode === 'inspect') return { state: 'review', reviewSHA256, evidence: review,
      consequence: 'Only managed Ardent actions are enabled. Node-wide commands, the managed scheduler and web terminals remain unavailable on this node.' };
    assert.equal(input.reviewSHA256, reviewSHA256, 'Review evidence changed; inspect and approve it again');
    const actor = JSON.parse(process.env.MAGNUS_OATHWEAVE_IDENTITIES_JSON ?? '[]').find((link) => link.role === 'ADMIN');
    assert(actor?.localUserId, 'The fresh administrator link is required');
    const approvalRef = 'hive:fresh-ardent:' + reviewSHA256.slice(0, 24);
    const sign = (value, payload) => ({ ...value, signature: createHmac('sha256', key).update(payload(value)).digest('hex') });
    const drain = await service.beginEnrollmentDrain(node.id, actor.localUserId);
    const prepared = await service.refreshEnrollmentParticipant(node.id, 'api');
    const hashes = { preinstrumentationSha256: sha({ createdAt: node.createdAt, counts, initializerSHA256: review.initializerSHA256 }),
      localDescendantsSha256: sha(review.apiProcesses), sshDescendantsSha256: sha(review.gatewayProcesses) };
    const api = { ...prepared.descriptor, status: 'drained', activeCount: 0, unknownCount: 0, ...hashes,
      evidenceSha256: sha({ nodeId: node.id, nodeFqdn: node.hostname, epoch: drain.epoch, barrierId: drain.barrierId, ...hashes }),
      observedAt: Date.now(), approvalRef };
    await service.acceptApiDrainAttestation(node.id, sign(api, service.apiDrainAttestationSigningPayload));
    for (const participant of ['agent', 'dashboard']) {
      const proof = await service.refreshEnrollmentParticipant(node.id, participant);
      assert.equal(proof.status, 'verified', `Live ${participant} drain proof is incomplete: ${JSON.stringify(proof)}`);
    }
    const evidence = await scope.ardentScopeActivationEvidence(node.id);
    assert(evidence.ready && evidence.receiptSha256, `Scope evidence is incomplete: ${JSON.stringify(evidence.blockers)}`);
    const assertion = { version: 1, scope: 'managed-ardent-actions-only', excludedParticipant: 'scheduler',
      nodeId: node.id, nodeFqdn: node.hostname, epoch: evidence.epoch, barrierId: evidence.barrierId,
      decisionId: randomUUID(), approvalRef, reviewSha256: reviewSHA256,
      schedulerSnapshotSha256: evidence.schedulerSnapshotSha256, receiptSha256: evidence.receiptSha256, expiresAt: Date.now() + 60_000 };
    const result = await scope.activateArdentScope(node.id, sign(assertion, scope.ardentScopeSigningPayload));
    await logAuditEvent({ action: 'resource.enrollment.ardent-scope.activate', actorId: actor.localUserId,
      targetType: 'node', targetId: node.id, details: { decisionId: assertion.decisionId, approvalRef, reviewSHA256,
        scope: assertion.scope, source: 'fresh-install-review' } });
    return { ...result, changed: true, reviewSHA256 };
  } finally { await disconnectDb(); }
}

if (process.env.HIVE_ARDENT_REVIEW) {
  try { console.log(JSON.stringify(await prepareArdentScope(JSON.parse(process.env.HIVE_ARDENT_REVIEW)))); }
  catch (error) { console.error(`Fresh Ardent enrollment refused: ${error.message}`); process.exitCode = 1; }
}
