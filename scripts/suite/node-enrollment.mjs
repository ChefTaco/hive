// Runs inside the signed Magnus image. Only installer-owned fresh nodes or their
// reviewed Ardent-only continuation qualify. All existing records remain intact.
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

const OS_SOURCES = new Set(['SYSTEM_ANACRON', 'SYSTEM_CRONTAB', 'SYSTEM_CRON_SOURCE',
  'SYSTEM_TIMER_DEFINITION', 'USER_TIMER_DEFINITION', 'USER_TIMER_OFFLINE_ENABLED']);
export function assertFullNodeReview(review) {
  assert.equal(review.freshInstallation, true, 'Completed installer provenance is required');
  assert.match(review.initializerSHA256, /^[a-f0-9]{64}$/);
  assert(Number.isSafeInteger(review.owner.uid) && review.owner.uid > 0, 'Non-root installer-owned native account required');
  assert(review.owner.processes.every(name => ['systemd', '(sd-pam)', 'dbus-daemon'].includes(name)), 'Native work must be paused for review');
  assert(review.history.every(row => row.commandStatus === 'COMPLETED' && row.state === 'released'
    && row.completionClass === 'native-http' && row.completionDescriptorId === 'ardent-action'
    && row.settlement === 'signed-command-result'), 'Other or uncertain history needs independent review');
  assert(review.ardentScopeActive || (review.owner.profileCount === 0 && review.history.length === 0), 'Existing work needs a prior reviewed Ardent scope');
  assert.equal(review.unsettled, 0, 'Unsettled commands, participant work or scheduler definitions require independent review');
  assert.deepEqual(review.scheduler.issues, [], 'Scheduler inventory must be complete');
  assert.equal(review.scheduler.activeCount, 0); assert.equal(review.scheduler.unknownCount, 0);
  assert.equal(review.scheduler.managedJobs.length, 0, 'Existing managed schedules need independent review');
  assert(review.scheduler.blockers.every(source => source.identityVersion === 2 && OS_SOURCES.has(source.kind)),
    'Foreign cron, native schedules or unknown sources require independent review');
  for (const processes of [review.apiProcesses, review.gatewayProcesses]) {
    if (processes === null) continue;
    assert.equal(processes.length, 2, 'API or gateway descendants need independent review');
    assert.deepEqual(processes.map(p => p.name).sort(), ['MainThread', 'docker-init']);
    assert.equal(processes.find(p => p.name === 'MainThread').ppid, processes.find(p => p.name === 'docker-init').pid);
  }
}
async function apiProcesses() {
  const rows = [];
  for (const pid of (await readdir('/proc')).filter(value => /^\d+$/.test(value) && Number(value) !== process.pid)) {
    try { const raw = await readFile('/proc/' + pid + '/status', 'utf8');
      rows.push({ pid: Number(pid), ppid: Number(raw.match(/^PPid:\s+(\d+)$/m)?.[1]), name: raw.match(/^Name:\s+(.+)$/m)?.[1] });
    } catch { /* An exited process cannot be approved as a continuing descendant. */ }
  }
  return rows.sort((a, b) => a.pid - b.pid);
}
export async function enrollFullNode(input) {
  const base = '/opt/magnus-server/node_modules/@hivemagnus/magnus-server/dist';
  const { getDb, disconnectDb } = await import(base + '/db/index.js');
  const service = await import(base + '/services/resource-enrollment.js');
  const scope = await import(base + '/services/ardent-scope-enrollment.js');
  const { reconciliationSecret } = await import(base + '/services/resource-participant-work.js');
  const { getNodeBaseUrl } = await import(base + '/utils/node-url.js');
  const { getNodeManagerSecret } = await import(base + '/utils/env.js');
  const fence = await import(base + '/services/admission-fence.js');
  const { logAuditEvent } = await import(base + '/services/audit-service.js');
  const db = getDb(); const sha = value => createHash('sha256').update(service.canonical(value)).digest('hex');
  try {
    const nodes = await db.node.findMany({ where: { hostname: input.hostFqdn }, take: 2 });
    assert.equal(nodes.length, 1, 'An unambiguous canonical node is required');
    const node = nodes[0];
    const enrollment = await service.inspectEnrollment(node.id);
    if (input.mode === 'release') {
      const current = await fence.inspectNodeAdmission(node.id);
      if (!current.closed) return { nodeId: node.id, closed: false, changed: false };
      assert.equal(current.releaseId, input.maintenanceId, 'A different maintenance operation owns admission');
      const actor = JSON.parse(process.env.MAGNUS_OATHWEAVE_IDENTITIES_JSON ?? '[]').find(link => link.role === 'ADMIN');
      assert(actor?.localUserId, 'Installer administrator identity link required');
      const result = await fence.releaseNodeAdmission(node.id, node.hostname, input.maintenanceId);
      await logAuditEvent({ action: 'resource.admission.release', actorId: actor.localUserId, targetType: 'node', targetId: node.id,
        details: { releaseId: input.maintenanceId, source: 'installer-full-node-review' } });
      return result;
    }
    if (enrollment.state === 'enrolled' || input.mode === 'status') return { nodeId: node.id, state: enrollment.state, changed: false, agentRuntime: input.agentRuntime };
    assert(['inspect', 'apply'].includes(input.mode));
    const key = reconciliationSecret(); // Fail before installing any drain.
    assert.match(input.maintenanceId, /^[a-f0-9-]{36}$/, 'Durable installer maintenance identity required');
    const actor = JSON.parse(process.env.MAGNUS_OATHWEAVE_IDENTITIES_JSON ?? '[]').find(link => link.role === 'ADMIN');
    assert(actor?.localUserId, 'Installer administrator identity link required');
    const priorFence = await fence.inspectNodeAdmission(node.id);
    await fence.closeNodeAdmission(node.id, node.hostname, input.maintenanceId);
    if (!priorFence.closed) await logAuditEvent({ action: 'resource.admission.close', actorId: actor.localUserId,
      targetType: 'node', targetId: node.id, details: { releaseId: input.maintenanceId, source: 'installer-full-node-review' } });
    const sign = (value, payload) => ({ ...value, signature: createHmac('sha256', key).update(payload(value)).digest('hex') });
    const url = getNodeBaseUrl(node.ipAddress, node.port).replace(/\/$/, '');
    assert.equal(new URL(url).protocol, 'https:');
    if (input.gatewayProcesses !== null) {
      const ping = await fetch(url + '/api/v1/ping', { redirect: 'error', signal: AbortSignal.timeout(5000) });
      assert.equal((await ping.json()).data?.features?.managedTerminal, 1, 'Configure the released agent managed terminal capability before full enrollment');
    }
    const inventory = async () => {
      const response = await fetch(url + '/api/v1/cron/managed-inventory', { redirect: 'error', signal: AbortSignal.timeout(25000),
        headers: { 'x-node-token': getNodeManagerSecret() } });
      const envelope = await service.readParticipantReceipt(response, 256 * 1024);
      assert.equal(envelope.success, true); const value = envelope.data;
      return { sources: value.sources, blockers: value.blockers, issues: value.issues,
        activeCount: value.activeCount, unknownCount: value.unknownCount, managedJobs: value.managedJobs };
    };
    const previousScope = await scope.inspectArdentScope(node.id);
    const leases = await db.commandResourceLease.findMany({ where: { nodeId: node.id }, orderBy: { id: 'asc' }, take: 1001,
      select: { id: true, commandId: true, state: true, settlement: true, completionClass: true, completionDescriptorId: true,
        requestSha256: true, evidenceSha256: true } });
    assert(leases.length <= 1000, 'History exceeds the bounded installer review');
    const commands = await db.remoteCommand.findMany({ where: { nodeId: node.id }, select: { id: true, status: true }, take: 1001 });
    assert.equal(commands.length, leases.length, 'Unowned commands require independent review');
    const history = leases.map(row => ({ ...row, commandStatus: commands.find(command => command.id === row.commandId)?.status }));
    let scheduler = await inventory(); let stable = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const next = await inventory(); stable = sha(next) === sha(scheduler); scheduler = next; if (stable) break;
    }
    assert(stable, 'Scheduler sources keep changing; review again');
    const review = { nodeId: node.id, nodeFqdn: node.hostname, freshInstallation: input.freshInstallation,
      initializerSHA256: input.initializerSHA256, agentRuntime: input.agentRuntime, maintenanceId: input.maintenanceId, owner: input.owner, ardentScopeActive: previousScope.scope.state === 'active',
      history, scheduler, apiProcesses: await apiProcesses(), gatewayProcesses: input.gatewayProcesses,
      unsettled: enrollment.commandOwners + enrollment.api.activeCount + enrollment.api.unknownCount
        + enrollment.dashboard.activeCount + enrollment.dashboard.unknownCount + enrollment.schedulerUnsettled
        + await db.managedCronDefinition.count({ where: { nodeId: node.id } }) };
    assertFullNodeReview(review); const reviewSHA256 = sha(review);
    if (input.mode === 'inspect') return { state: 'review', reviewSHA256, evidence: review,
      capabilities: ['managed Ardent actions', 'node-wide commands', 'managed cron', 'restricted web terminals'],
      boundary: 'Observed OS maintenance schedules stay outside Magnus management and are left unchanged.' };
    assert.equal(input.reviewSHA256, reviewSHA256, 'Evidence changed; inspect and approve again');
    const approvalRef = 'hive:full-node:' + reviewSHA256.slice(0, 24);
    const drain = await service.beginEnrollmentDrain(node.id, actor.localUserId);
    const prepared = await service.refreshEnrollmentParticipant(node.id, 'api');
    const hashes = { preinstrumentationSha256: sha({ initializerSHA256: review.initializerSHA256, history }),
      localDescendantsSha256: sha(review.apiProcesses), sshDescendantsSha256: sha(review.gatewayProcesses) };
    const api = { ...prepared.descriptor, status: 'drained', activeCount: 0, unknownCount: 0, ...hashes,
      evidenceSha256: sha({ nodeId: node.id, nodeFqdn: node.hostname, epoch: drain.epoch, barrierId: drain.barrierId, ...hashes }),
      observedAt: Date.now(), approvalRef };
    await service.acceptApiDrainAttestation(node.id, sign(api, service.apiDrainAttestationSigningPayload));
    for (const participant of ['agent', 'dashboard']) {
      const proof = await service.refreshEnrollmentParticipant(node.id, participant);
      assert.equal(proof.status, 'verified', `Live ${participant} proof is incomplete: ${JSON.stringify(proof)}`);
    }
    const result = await service.refreshEnrollmentParticipant(node.id, 'scheduler');
    assert.equal(result.reason, 'reviewed-boundary-required', `Scheduler evidence is incomplete: ${JSON.stringify(result)}`);
    const ack = await db.resourceDrainParticipant.findUniqueOrThrow({ where: { nodeId_participant: { nodeId: node.id, participant: 'scheduler' } } });
    const receipt = JSON.parse(ack.receiptJson);
    assert.equal(sha(receipt.externalBlockers), sha(review.scheduler.blockers), 'Observed scheduler boundary changed');
    assert.equal(sha(await inventory()), sha(review.scheduler), 'Scheduler sources changed after draining');
    const boundary = { version: 1, scope: 'magnus-managed-scheduler-only', nodeId: node.id, nodeFqdn: node.hostname,
      epoch: drain.epoch, barrierId: drain.barrierId, challengeId: ack.challengeId,
      receiptSha256: createHash('sha256').update(ack.receiptJson).digest('hex'),
      externalBlockersSha256: sha(receipt.externalBlockers), reviewSha256: reviewSHA256, observedAt: Date.now(), approvalRef };
    await service.acceptSchedulerBoundaryAttestation(node.id, sign(boundary, service.schedulerBoundaryAttestationSigningPayload));
    // Refresh the short-lived live proofs after potentially slow scheduler inventory collection.
    for (const participant of ['agent', 'dashboard']) assert.equal((await service.refreshEnrollmentParticipant(node.id, participant)).status, 'verified');
    // Keep the narrow Ardent claim for its existing native action client, and then finish the whole-node protocol.
    if (previousScope.scope.state !== 'active') {
      const evidence = await scope.ardentScopeActivationEvidence(node.id);
      assert(evidence.ready && evidence.receiptSha256, 'Ardent participant evidence is incomplete');
      const claim = { version: 1, scope: 'managed-ardent-actions-only', excludedParticipant: 'scheduler', nodeId: node.id,
        nodeFqdn: node.hostname, epoch: evidence.epoch, barrierId: evidence.barrierId, decisionId: randomUUID(), approvalRef,
        reviewSha256: reviewSHA256, schedulerSnapshotSha256: evidence.schedulerSnapshotSha256,
        receiptSha256: evidence.receiptSha256, expiresAt: Date.now() + 60000 };
      await scope.activateArdentScope(node.id, sign(claim, scope.ardentScopeSigningPayload));
    }
    const completed = await service.completeEnrollment(node.id);
    await logAuditEvent({ action: 'resource.enrollment.complete', actorId: actor.localUserId, targetType: 'node', targetId: node.id,
      details: { epoch: completed.epoch, approvalRef, reviewSHA256, source: 'installer-full-node-review' } });
    return { ...completed, changed: true, reviewSHA256 };
  } finally { await disconnectDb(); }
}
if (process.env.HIVE_ARDENT_REVIEW) {
  try { console.log(JSON.stringify(await enrollFullNode(JSON.parse(process.env.HIVE_ARDENT_REVIEW)))); }
  catch (error) { console.error('Full-node enrollment held: ' + error.message); process.exitCode = 1; }
}
