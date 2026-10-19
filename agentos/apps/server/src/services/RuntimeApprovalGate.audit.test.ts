import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteStore } from '../store/SqliteStore.js';
import { RuntimeApprovalGate } from './RuntimeApprovalGate.js';

/**
 * §83 audit wiring: policy evaluations that land in policy_decisions also
 * append an immutable audit_records row (actor system / policy-engine).
 */
const NOW = '2026-10-20T00:00:00.000Z';

test('policy decision persistence appends an audit_records row', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentos-gate-audit-'));
  const store = new SqliteStore(projectRoot);
  try {
    const gate = new RuntimeApprovalGate(store, { now: () => NOW });
    const input = {
      workspaceId: 'ws_audit', taskId: 'task_audit', runId: 'run_audit',
      stageId: 'stage_audit', stageAttempt: 1, workflowStageKey: 'plan',
      operationId: 'op_audit',
    };
    // Drive the same caller-transaction helper the launch gate uses; the
    // shape beyond the ids is irrelevant for decision + audit persistence.
    (gate as unknown as {
      persistPolicyEvaluationWithinTransaction(
        input: unknown, policy: unknown, fingerprint: undefined, timestamp: string,
      ): void;
    }).persistPolicyEvaluationWithinTransaction(
      input,
      { decision: 'deny', evaluation: undefined, failure: undefined },
      undefined,
      NOW,
    );

    const audits = store.auditRecordRepository().query({ resourceType: 'policy_decision' });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.actorType, 'system');
    assert.equal(audits[0]!.actorId, 'policy-engine');
    assert.equal(audits[0]!.actionType, 'policy.evaluate');
    assert.equal(audits[0]!.result, 'deny');
    assert.equal(audits[0]!.workspaceId, 'ws_audit');
    assert.equal(audits[0]!.runId, 'run_audit');

    const decisions = store.getDatabase()
      .prepare('SELECT id FROM policy_decisions WHERE workspace_id = ?')
      .all('ws_audit') as Array<{ id: string }>;
    assert.equal(decisions.length, 1);
    assert.equal(audits[0]!.resourceId, decisions[0]!.id, 'audit row points at the policy_decision row');
  } finally {
    store.close();
    rmSync(projectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
