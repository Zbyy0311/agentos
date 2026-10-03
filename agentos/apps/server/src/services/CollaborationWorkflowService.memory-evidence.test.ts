import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOW, fixture, applyVerifiedMemoryFacts046, captureServerAcceptanceCandidate } from './CollaborationWorkflowService.test-fixture.js';


test('M3 runner receipt binds the persisted server acceptance output, exit code and frozen HEAD in one transaction', async () => {
  const fx = fixture({}, {
    memoryEnabled: true,
    acceptanceCommands: ['node -e "process.stdout.write(\'server-acceptance-proof\')"'],
  });
  try {
    applyVerifiedMemoryFacts046(fx);
    const active = fx.runningWithCompletedStart();
    const working = join(fx.root, 'implementation');
    execFileSync('git', ['worktree', 'add', '--detach', working, fx.plan.baseCommit], { cwd: fx.repositoryRoot, windowsHide: true, stdio: 'pipe' });
    writeFileSync(join(working, 'README.md'), 'candidate\n');

    const candidate = await captureServerAcceptanceCandidate(fx, active.run.id, working);
    const persistedOutput = fx.store.getDatabase().prepare('SELECT test_output FROM collaboration_candidates WHERE id=?')
      .get(candidate.id) as { test_output: string };
    const receipt = fx.store.getDatabase().prepare(`SELECT candidate_id,workspace_id,run_id,commit_id,result,exit_code,
      output_sha256,runner_version FROM memory_test_runner_receipts WHERE candidate_id=?`).get(candidate.id) as {
      candidate_id: string; workspace_id: string; run_id: string; commit_id: string; result: string; exit_code: number;
      output_sha256: string; runner_version: string;
    };
    assert.equal(candidate.testStatus, 'passed');
    assert.equal(candidate.testExitCode, 0);
    assert.match(persistedOutput.test_output, /server-acceptance-proof/u);
    assert.deepEqual({ ...receipt }, {
      candidate_id: candidate.id, workspace_id: 'workspace-a', run_id: active.run.id,
      commit_id: candidate.headCommit, result: 'passed', exit_code: 0,
      output_sha256: createHash('sha256').update(persistedOutput.test_output).digest('hex'),
      runner_version: 'collaboration-acceptance.v1',
    });
    assert.throws(() => fx.store.getDatabase().prepare('UPDATE memory_test_runner_receipts SET result=? WHERE candidate_id=?')
      .run('failed', candidate.id), /MEMORY_TEST_RUNNER_RECEIPT_IMMUTABLE/u);
  } finally { await fx.close(); }
});

test('M3 runner receipt records the acceptance process actual nonzero exit code', async () => {
  const fx = fixture({}, {
    memoryEnabled: true,
    acceptanceCommands: ['node -e "process.stdout.write(\'server-runner-failure\');process.exit(7)"'],
  });
  try {
    applyVerifiedMemoryFacts046(fx);
    const active = fx.runningWithCompletedStart();
    const working = join(fx.root, 'implementation');
    execFileSync('git', ['worktree', 'add', '--detach', working, fx.plan.baseCommit], { cwd: fx.repositoryRoot, windowsHide: true, stdio: 'pipe' });
    writeFileSync(join(working, 'README.md'), 'candidate\n');

    const candidate = await captureServerAcceptanceCandidate(fx, active.run.id, working);
    const persisted = fx.store.getDatabase().prepare(`SELECT c.head_commit,c.test_status,c.test_exit_code,c.test_output,
      rr.commit_id,rr.result,rr.exit_code,rr.output_sha256 FROM collaboration_candidates c
      JOIN memory_test_runner_receipts rr ON rr.candidate_id=c.id WHERE c.id=?`).get(candidate.id) as {
      head_commit: string; test_status: string; test_exit_code: number; test_output: string;
      commit_id: string; result: string; exit_code: number; output_sha256: string;
    };
    assert.equal(persisted.test_status, 'failed');
    assert.equal(persisted.test_exit_code, 7);
    assert.equal(persisted.result, persisted.test_status);
    assert.equal(persisted.exit_code, persisted.test_exit_code);
    assert.equal(persisted.commit_id, persisted.head_commit);
    assert.match(persisted.test_output, /server-runner-failure/u);
    assert.equal(persisted.output_sha256, createHash('sha256').update(persisted.test_output).digest('hex'));
  } finally { await fx.close(); }
});

test('M3 runner receipt is omitted when acceptance changes the frozen candidate', async () => {
  const fx = fixture({}, {
    memoryEnabled: true,
    acceptanceCommands: ['node -e "require(\'fs\').writeFileSync(\'README.md\', \'mutated\\n\')"'],
  });
  try {
    applyVerifiedMemoryFacts046(fx);
    const active = fx.runningWithCompletedStart();
    const working = join(fx.root, 'implementation');
    execFileSync('git', ['worktree', 'add', '--detach', working, fx.plan.baseCommit], { cwd: fx.repositoryRoot, windowsHide: true, stdio: 'pipe' });
    writeFileSync(join(working, 'README.md'), 'candidate\n');

    const candidate = await captureServerAcceptanceCandidate(fx, active.run.id, working);
    assert.equal(candidate.testStatus, 'failed');
    assert.match(candidate.testOutput ?? '', /COLLABORATION_TEST_MUTATED_CANDIDATE/u);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM memory_test_runner_receipts WHERE candidate_id=?')
      .get(candidate.id) as { count: number }).count, 0);
  } finally { await fx.close(); }
});

test('M3 keeps candidate capture compatible without runner receipt schema and atomically rolls back a failed receipt insert', async () => {
  const legacy = fixture({}, { memoryEnabled: true });
  try {
    // SqliteStore always applies the current registry. Explicitly remove this
    // capability from the isolated fixture to exercise the legacy fallback.
    legacy.store.getDatabase().exec('DROP TABLE memory_test_runner_receipts');
    const active = legacy.runningWithCompletedStart();
    const working = join(legacy.root, 'implementation');
    execFileSync('git', ['worktree', 'add', '--detach', working, legacy.plan.baseCommit], { cwd: legacy.repositoryRoot, windowsHide: true, stdio: 'pipe' });
    writeFileSync(join(working, 'README.md'), 'candidate\n');
    const candidate = await captureServerAcceptanceCandidate(legacy, active.run.id, working);
    assert.equal(candidate.testStatus, 'passed');
    assert.equal((legacy.store.getDatabase().prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='memory_test_runner_receipts'")
      .get() as { count: number }).count, 0);
  } finally { await legacy.close(); }

  const fx = fixture({}, { memoryEnabled: true });
  try {
    applyVerifiedMemoryFacts046(fx);
    fx.store.getDatabase().exec(`CREATE TRIGGER reject_memory_test_receipt BEFORE INSERT ON memory_test_runner_receipts
      BEGIN SELECT RAISE(ABORT,'receipt insert rejected'); END`);
    const active = fx.runningWithCompletedStart();
    const working = join(fx.root, 'implementation');
    execFileSync('git', ['worktree', 'add', '--detach', working, fx.plan.baseCommit], { cwd: fx.repositoryRoot, windowsHide: true, stdio: 'pipe' });
    writeFileSync(join(working, 'README.md'), 'candidate\n');
    await assert.rejects(captureServerAcceptanceCandidate(fx, active.run.id, working), /receipt insert rejected/u);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM collaboration_candidates WHERE canonical_run_id=?')
      .get(active.run.id) as { count: number }).count, 0);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM memory_test_runner_receipts').get() as { count: number }).count, 0);
  } finally { await fx.close(); }
});

test('M3 terminal hook derives its eventContext from the canonical durable terminal event', async () => {
  const observed: Array<{ workspaceId: string; runId: string; createdAt: string; eventContext?: unknown }> = [];
  const fx = fixture({
    verifiedMemoryFacts: () => ({ accumulateTerminal(input) { observed.push(input); return []; } }),
  }, { memoryEnabled: true });
  try {
    applyVerifiedMemoryFacts046(fx);
    const active = fx.runningWithCompletedStart();
    const db = fx.store.getDatabase();
    db.prepare("UPDATE runs SET status='completed',updated_at=?,version=version+1 WHERE workspace_id=? AND id=?")
      .run(NOW, 'workspace-a', active.run.id);
    const sequence = (db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM runtime_events WHERE run_id=?')
      .get(active.run.id) as { sequence: number }).sequence;
    db.prepare(`INSERT INTO runtime_events
      (id,schema_version,type,workspace_id,task_id,run_id,sequence,timestamp,source,correlation_id,severity,visibility,durability,payload_json,created_at)
      VALUES(?,1,'run.completed',?,?,?,?,?,'test',?,'info','workspace','durable','{}',?)`)
      .run('evt_terminal_hook', 'workspace-a', active.run.taskId, active.run.id, sequence, NOW, 'corr-terminal-hook', NOW);

    assert.deepEqual(fx.service.accumulateTerminal({ workspaceId: 'workspace-a', runId: active.run.id }), []);
    assert.equal(observed.length, 1);
    assert.deepEqual(observed[0], {
      workspaceId: 'workspace-a', runId: active.run.id, createdAt: NOW,
      eventContext: { origin: 'persisted_event', eventId: 'evt_terminal_hook', context: {
        correlationId: 'corr-terminal-hook', causationId: 'evt_terminal_hook',
      } },
    });
  } finally { await fx.close(); }
});
