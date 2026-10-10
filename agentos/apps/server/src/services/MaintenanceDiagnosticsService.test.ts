import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { getAgentOsBuildIdentity } from './BuildIdentity.js';
import { MaintenanceDiagnosticsService } from './MaintenanceDiagnosticsService.js';
import { inTransaction } from '../store/Transaction.js';
import { CompactionPolicyRepository, CompactionRepository } from '../store/CompactionRepository.js';
import { createHash } from 'node:crypto';
import { MaintenanceBarrier } from './MaintenanceBarrier.js';

test('readiness separates database, migration, recovery, Provider state and maintenance without exposing probe secrets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-readiness-test-'));
  mkdirSync(join(root, 'workspace-root'), { recursive: true });
  const store = new SqliteStore(root);
  let maintenanceActive = false;
  let providerCalls = 0;
  let providerAuthentication: unknown = 'unauthenticated';
  try {
    const workspaces = new WorkspaceManager(store);
    await workspaces.create('Readiness fixture', join(root, 'workspace-root'), { git: false, memory: false, docs: false, readme: false });
    const diagnostics = new MaintenanceDiagnosticsService(store, workspaces, {
      providerValidator: {
        async validate(configuration) {
          providerCalls += 1;
          return {
            valid: false,
            executableResolved: 'C:\\private\\secret-cli.exe',
            cliVersion: '1.2.3',
            authentication: providerAuthentication as any,
            capabilities: configuration.capabilities,
            outputMode: configuration.outputMode,
            warnings: [{ code: 'PROBE_WARNING', message: 'credential sk-test-secret' }],
            errors: [{ code: 'PROVIDER_AUTH_REQUIRED', phase: 'authentication', message: 'token=sk-test-secret', retryable: false }],
            checkedAt: new Date().toISOString(),
          };
        },
      },
      readMaintenanceStatus: () => ({ active: maintenanceActive, quiescing: maintenanceActive, recoveredAfterRestart: false }),
    });

    const report = await diagnostics.readiness();
    assert.equal(report.ok, true, 'degraded Provider auth remains distinct from database readiness');
    assert.equal(report.database.status, 'ok');
    assert.equal(report.database.integrity, 'ok');
    assert.equal(report.database.foreignKeys, 'ok');
    assert.equal(report.migrations.status, 'current');
    assert.equal(report.recovery.status, 'clear');
    assert.equal(report.providers.status, 'degraded');
    assert.equal(report.providers.entries[0]?.authentication, 'unauthenticated');
    assert.equal(report.providers.entries[0]?.cliVersion, '1.2.3');
    assert.deepEqual(report.providers.entries[0]?.errorCodes, ['PROVIDER_AUTH_REQUIRED']);
    assert.equal(report.build.version.length > 0, true);
    assert.equal(report.build.commit.length > 0, true);
    assert.equal(report.build.id.length > 0, true);
    assert.equal(report.build.source, 'source-checkout');
    assert.equal(report.build.verified, false, 'tsx source mode is explicitly distinguished from a stamped release build');
    assert.equal(JSON.stringify(report).includes('sk-test-secret'), false);
    assert.equal(JSON.stringify(report).includes('private\\secret-cli.exe'), false);

    const exported = JSON.stringify(await diagnostics.exportSanitized());
    assert.equal(exported.includes('sk-test-secret'), false);
    assert.equal(exported.includes('private\\secret-cli.exe'), false);
    assert.equal(exported.includes(root), false);
    assert.equal(exported.includes('"token"'), false);
    assert.equal(exported.includes(getAgentOsBuildIdentity().id), true);
    assert.equal(providerCalls > 0, true, 'Provider validation is exercised through the injected mock');

    providerAuthentication = 'token=sk-test-auth-secret';
    const malformedAuth = await diagnostics.readiness();
    assert.equal(malformedAuth.providers.entries[0]?.authentication, undefined);
    assert.equal(JSON.stringify(malformedAuth).includes('sk-test-auth-secret'), false,
      'an unexpected Provider auth value cannot leak through the readiness response');

    maintenanceActive = true;
    const fenced = await diagnostics.readiness();
    assert.equal(fenced.maintenance.active, true);
    assert.equal(fenced.ok, false, 'an active maintenance lease is not reported ready');

    const db = store.getDatabase();
    const now = new Date().toISOString();
    const conversationId = 'conv_' + 'd'.repeat(26);
    const workspaceId = workspaces.list()[0]!.id;
    const conversations = store.conversationRepository();
    conversations.createConversation({ id: conversationId, workspaceId, kind: 'group', title: 'active group work', createdAt: now });
    const source = conversations.appendMessage({
      id: 'msg_' + 'd'.repeat(26), conversationId, workspaceId, senderType: 'user',
      kind: 'text', status: 'final', content: 'maintenance source', createdAt: now,
    });
    const groups = store.groupInteractionRepository();
    const interaction = groups.createInteraction({
      id: 'group_maintenance_owner', conversationId, workspaceId, sourceMessageId: source.id, createdAt: now,
      budget: { maxAgentsPerTurn: 2, maxRepliesPerAgent: 1, maxTotalReplies: 2, maxAgentHops: 1 },
    });
    const owner = groups.claimExecution({
      workspaceId, conversationId, interactionId: interaction.id, sourceMessageId: source.id,
      participantAgentIds: ['agent_maintenance_fixture'], ownerId: 'owner_fixture', createdAt: now,
    });
    inTransaction(db, () => groups.transitionExecutionWithinTransaction({
      workspaceId, interactionId: interaction.id, ownerId: owner.ownerId, ownerEpoch: owner.ownerEpoch,
      status: 'running', eventType: 'group.turn.start', updatedAt: now,
    }));
    const activityWithGroup = diagnostics.inspectActivity();
    assert.equal(activityWithGroup.counts.cr_group_interaction_executions, 1,
      'an active group provider owner remains visible after its HTTP request ends');

    const policies = new CompactionPolicyRepository(db);
    const compactions = new CompactionRepository(db);
    const policy = inTransaction(db, () => policies.createWithinTransaction({
      id: 'policy_maintenance_fixture', policyVersion: 'maintenance-fixture', triggerRatio: 0.7, targetRatio: 0.5,
      minRecentMessages: 1, summaryMaxTokens: 20, timeoutMs: 1000, maxAutomaticRetries: 1,
      fallbackApplicationBudgetTokens: 100, parametersJson: '{}',
      checksum: createHash('sha256').update('maintenance-policy').digest('hex'), createdAt: now,
    }));
    const compaction = inTransaction(db, () => compactions.createTaskWithinTransaction({
      id: 'compaction_maintenance_fixture', workspaceId: workspaces.list()[0]!.id, conversationId,
      policyId: policy.id, sourceStartMessageId: null, sourceEndMessageId: null,
      sourceMessageCount: 0, sourceHash: createHash('sha256').update('empty-source').digest('hex'),
      priorSummaryId: null, budgetJson: '{}', providerConfigId: null, providerType: null,
      adapterId: null, adapterVersion: null, model: null, estimatorVersion: 'maintenance-test', createdAt: now,
    }));
    inTransaction(db, () => compactions.claimRunningWithinTransaction({
      workspaceId: workspaces.list()[0]!.id, id: compaction.id, expectedVersion: compaction.version,
      leaseOwner: 'summarizer-fixture', leaseExpiresAt: new Date(Date.parse(now) + 60_000).toISOString(), now,
    }));
    const activityWithSummarizer = diagnostics.inspectActivity();
    assert.equal(activityWithSummarizer.counts.conversation_compactions, 1,
      'active provider summarization is included in maintenance drain status');

    const barrier = new MaintenanceBarrier();
    assert.equal(barrier.begin(), true);
    let drainFinished = false;
    const drain = barrier.waitForDrain(() => diagnostics.inspectActivity(), 1_000, 5)
      .then(snapshot => { drainFinished = true; return snapshot; });
    await new Promise(resolvePromise => setTimeout(resolvePromise, 30));
    assert.equal(drainFinished, false, 'active group and summarizer Provider work must hold maintenance drain');

    inTransaction(db, () => compactions.reconcileInterruptedOnStartupWithinTransaction(new Date().toISOString()));
    const afterRestart = diagnostics.inspectActivity();
    assert.equal(afterRestart.counts.conversation_compactions, 0,
      'a durable lease proven interrupted by restart no longer blocks maintenance indefinitely');
    assert.equal(afterRestart.counts.cr_group_interaction_executions, 1,
      'unresolved group owners still hold maintenance until the startup reconciler marks them interrupted');
    assert.equal(groups.reconcileInterruptedOnStartup(new Date().toISOString()), 1);
    const drained = await drain;
    assert.equal(drained.activity.counts.cr_group_interaction_executions, 0);
    assert.equal(drained.activity.counts.conversation_compactions, 0);
    assert.equal(diagnostics.inspectActivity().counts.cr_group_interaction_executions, 0,
      'startup-reconciled group owner no longer blocks a new maintenance operation');
    barrier.end();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10 });
  }
});
