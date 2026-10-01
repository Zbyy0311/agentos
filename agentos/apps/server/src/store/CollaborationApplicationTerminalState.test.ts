import assert from 'node:assert/strict';
import test from 'node:test';
import { collaborationApplicationTerminalReason, type CollaborationApplicationFacts } from './CollaborationApplicationTerminalState.js';

function facts(overrides: Partial<CollaborationApplicationFacts> = {}): CollaborationApplicationFacts {
  return {
    workspace_id: 'workspace', control_id: 'control', collaboration_task_id: 'task', action: 'apply',
    control_state: 'completed', created_at: '2026-09-30T00:00:00Z', expected_version: 6, control_epoch: 4,
    control_candidate_id: 'candidate', control_run_id: 'run', idempotency_key: 'apply-key',
    task_id: 'task', task_version: 7, task_control_epoch: 4, task_status: 'applied',
    task_base_commit: 'base', apply_idempotency_key: 'apply-key',
    journal_state: 'committed', journal_workspace_id: 'workspace', journal_task_id: 'task',
    journal_candidate_id: 'candidate', journal_candidate_hash: 'hash', journal_base_commit: 'base',
    candidate_id: 'candidate', candidate_task_id: 'task', candidate_run_id: 'run',
    candidate_hash: 'hash', candidate_base_commit: 'base', candidate_status: 'applied', ...overrides,
  };
}

for (let repetition = 1; repetition <= 3; repetition++) {
  test(`F25 terminal application requires its own consistent durable pair (${repetition}/3)`, () => {
    assert.equal(collaborationApplicationTerminalReason(facts()), 'APPLICATION_JOURNAL_COMMITTED');
    assert.equal(collaborationApplicationTerminalReason(facts({ control_state: 'failed', journal_state: 'recovered',
      task_status: 'awaiting_application', candidate_status: 'reviewed', task_version: 6 })), 'APPLICATION_JOURNAL_RECOVERED');
    assert.equal(collaborationApplicationTerminalReason(facts({ control_state: 'failed', journal_state: null })), 'APPLICATION_FAILED_BEFORE_JOURNAL');
    for (const control_state of ['reserved', 'running', 'recovery_required']) {
      for (const journal_state of ['committed', 'recovered', 'prepared', 'written', 'recovery_required']) {
        assert.equal(collaborationApplicationTerminalReason(facts({ control_state, journal_state })), undefined,
          `${control_state} + ${journal_state} cannot release a writer`);
      }
    }
    assert.equal(collaborationApplicationTerminalReason(facts({ control_state: 'failed' })), undefined);
    assert.equal(collaborationApplicationTerminalReason(facts({ journal_state: 'recovered' })), undefined);
  });

  test(`F25 wrong application association cannot borrow terminal evidence (${repetition}/3)`, () => {
    const mismatches: Partial<CollaborationApplicationFacts>[] = [
      { action: 'cancel' }, { task_id: 'other-task' }, { journal_workspace_id: 'other-workspace' },
      { journal_task_id: 'other-task' }, { control_candidate_id: 'other-candidate' },
      { candidate_id: 'other-candidate' }, { candidate_task_id: 'other-task' },
      { control_run_id: 'other-run' }, { candidate_run_id: 'other-run' },
      { journal_candidate_hash: 'other-hash' }, { candidate_hash: 'other-hash' },
      { journal_base_commit: 'other-base' }, { candidate_base_commit: 'other-base' },
      { task_base_commit: 'other-base' }, { candidate_id: null },
    ];
    for (const mismatch of mismatches) {
      assert.equal(collaborationApplicationTerminalReason(facts(mismatch)), undefined, JSON.stringify(mismatch));
      assert.equal(collaborationApplicationTerminalReason(facts({ control_state: 'failed', journal_state: 'recovered', ...mismatch })),
        undefined, `recovered: ${JSON.stringify(mismatch)}`);
    }
    for (const mismatch of [{ task_version: 6 }, { task_control_epoch: 5 }, { task_status: 'awaiting_application' },
      { candidate_status: 'reviewed' }, { apply_idempotency_key: 'other-key' }]) {
      assert.equal(collaborationApplicationTerminalReason(facts(mismatch)), undefined, JSON.stringify(mismatch));
    }
  });

  test(`F25 a newer epoch cannot invalidate an old safe failed/recovered release (${repetition}/3)`, () => {
    assert.equal(collaborationApplicationTerminalReason(facts({ control_state: 'failed', journal_state: 'recovered',
      task_control_epoch: 5, task_version: 8, apply_idempotency_key: 'new-key' })), 'APPLICATION_JOURNAL_RECOVERED');
  });
}
