import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Workspace } from '@agentos/shared';
import { DEFAULT_WORKSPACE_AGENTS } from '@agentos/agent-core';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceAdmissionRepository, type WorkspaceAdmissionRow } from '../store/WorkspaceAdmissionRepository.js';
import { isTransactionActive } from '../store/Transaction.js';
import { WorkspaceAdmissionAuthority, WorkspaceAdmissionAuthorityError } from './WorkspaceAdmissionAuthority.js';
import {
  WorkspaceAdmissionStartupReconciler,
  WorkspaceAdmissionStartupReconciliationError,
  STARTUP_ADMISSION_RECONCILIATION_FAILED,
} from './WorkspaceAdmissionStartupReconciler.js';

const APPLICATION_PATCH = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-base\n+candidate\n';
const APPLICATION_HASH = createHash('sha256').update(APPLICATION_PATCH).digest('hex');

function makeTempRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), 'agentos-l1e-' + label + '-'));
}

function makeWorkspace(id: string, root: string): Workspace {
  const now = '2026-07-25T00:00:00.000Z';
  return {
    id,
    name: id,
    rootPath: join(root, id),
    gitEnabled: false,
    memoryEnabled: false,
    agents: structuredClone(DEFAULT_WORKSPACE_AGENTS),
    lastOpenedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function seedWorkspace(store: SqliteStore, root: string, id: string): void {
  store.saveWorkspaces([makeWorkspace(id, root)]);
}

function insertRun(store: SqliteStore, workspaceId: string, runId: string, status: string, createdAt: string): void {
  const db = store.getDatabase();
  // runs has a composite FK (task_id, workspace_id) -> tasks(id, workspace_id).
  db.prepare(
    "INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at) VALUES (?, ?, 't', 'open', 'test', ?, ?)",
  ).run('task-' + runId, workspaceId, createdAt, createdAt);
  db.prepare(
    "INSERT INTO runs (id, workspace_id, task_id, parent_run_id, root_run_id, status, reason, origin, objective, failure_code, failure_message, cancellation_requested_at, next_event_sequence, started_at, completed_at, created_by, created_at, updated_at, version) VALUES (?, ?, ?, NULL, ?, ?, 'initial', 'v2_api', NULL, NULL, NULL, NULL, 1, NULL, NULL, 'test', ?, ?, 1)",
  ).run(runId, workspaceId, 'task-' + runId, runId, status, createdAt, createdAt);
}

function insertLegacyRun(store: SqliteStore, workspaceId: string, runId: string, status: string, createdAt: string): void {
  // agent_runs requires conversation/message parents; insert minimal graph.
  const db = store.getDatabase();
  db.prepare("INSERT INTO conversations (id, workspace_id, conversation_type, title, created_at, updated_at) VALUES (?, ?, 'direct', 'c', ?, ?)")
    .run('conv-' + runId, workspaceId, createdAt, createdAt);
  db.prepare("INSERT INTO messages (id, conversation_id, workspace_id, sender_type, content, created_at) VALUES (?, ?, ?, 'user', 'm', ?)")
    .run('msg-' + runId, 'conv-' + runId, workspaceId, createdAt);
  db.prepare("INSERT INTO agent_runs (id, workspace_id, conversation_id, source_message_id, objective, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'o', ?, ?, ?)")
    .run(runId, workspaceId, 'conv-' + runId, 'msg-' + runId, status, createdAt, createdAt);
}

function admissionsFor(store: SqliteStore, workspaceId: string): WorkspaceAdmissionRow[] {
  return new WorkspaceAdmissionRepository(store.getDatabase()).listByWorkspace(workspaceId);
}

function admissionCount(store: SqliteStore): number {
  const row = store.getDatabase().prepare('SELECT COUNT(*) AS c FROM workspace_admissions').get() as { c: number };
  return row.c;
}

async function reconcile(store: SqliteStore): Promise<void> {
  await new WorkspaceAdmissionStartupReconciler({ store }).reconcileOnStartup();
}

function insertApplyControl(
  store: SqliteStore,
  controlId: string,
  controlState: 'reserved' | 'running' | 'completed' | 'failed' | 'recovery_required',
  journalState: 'prepared' | 'written' | 'committed' | 'recovered' | 'recovery_required' | null,
): void {
  const db = store.getDatabase();
  const collaborationTaskId = `collab-${controlId}`;
  const runId = `application-run-${controlId}`;
  const candidateId = `candidate-${controlId}`;
  const committedPair = controlState === 'completed' && journalState === 'committed';
  insertRun(store, 'ws-a', runId, 'completed', '2026-09-30T00:00:00.000Z');
  db.prepare('UPDATE runs SET completed_at = ? WHERE id = ?').run('2026-09-30T00:00:00.000Z', runId);
  db.prepare(
    'INSERT INTO collaboration_tasks ('
      + 'id, workspace_id, title, objective, scope_json, acceptance_commands_json,'
      + 'planner_agent_id, implementer_agent_id, reviewer_agent_id, status, plan_hash,'
      + 'base_commit, control_epoch, version, canonical_task_id, canonical_run_id, current_candidate_id, apply_idempotency_key, created_at, updated_at'
      + ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)',
  ).run(collaborationTaskId, 'ws-a', 'Apply', 'Apply candidate', JSON.stringify(['README.md']), JSON.stringify(['node -e "process.exit(0)"']),
    'planner', 'implementer', 'reviewer', committedPair ? 'applied' : 'awaiting_application', 'plan-hash', 'base-sha',
    committedPair ? 2 : 1, `task-${runId}`, runId, candidateId, committedPair ? `key-${controlId}` : null,
    '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z');
  db.prepare(
    'INSERT INTO collaboration_candidates (id, collaboration_task_id, workspace_id, canonical_run_id, round,'
      + 'base_commit, head_commit, diff_hash, diff_text, manifest_json, test_status, test_command, test_exit_code,'
      + 'test_output, status, review_conclusion, review_agent_id, snapshot_version, created_at, updated_at)'
      + " VALUES (?, ?, 'ws-a', ?, 0, 'base-sha', 'base-sha', ?, ?, '[]', 'passed', 'node -e test', 0, 'exit 0', ?, 'approved', 'reviewer', 2, ?, ?)",
  ).run(candidateId, collaborationTaskId, runId, APPLICATION_HASH, APPLICATION_PATCH, committedPair ? 'applied' : 'reviewed',
    '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z');
  db.prepare(
    'INSERT INTO collaboration_controls ('
      + 'id, workspace_id, collaboration_task_id, action, idempotency_key, request_hash,'
      + 'expected_version, epoch, state, canonical_run_id, candidate_id, created_at, updated_at'
      + ") VALUES (?, 'ws-a', ?, 'apply', ?, ?, 1, 1, ?, ?, ?, ?, ?)",
  ).run(controlId, collaborationTaskId, `key-${controlId}`, `hash-${controlId}`, controlState,
    runId, candidateId,
    '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z');
  if (journalState !== null) {
    db.prepare(
      'INSERT INTO collaboration_apply_journals ('
        + 'control_id, workspace_id, collaboration_task_id, candidate_id, candidate_hash,'
        + 'base_commit, state, recovery_path, images_json, created_at, updated_at'
        + ') VALUES (?, \'ws-a\', ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(controlId, collaborationTaskId, candidateId, APPLICATION_HASH,
      'base-sha', journalState, `recovery/${controlId}`, '[]',
      '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z');
  }
}

function insertApplicationAdmission(
  store: SqliteStore,
  controlId: string,
  state: WorkspaceAdmissionRow['state'] = 'GRANTED',
): void {
  const db = store.getDatabase();
  const granted = state === 'GRANTED' || state === 'RELEASED';
  const terminal = state === 'RELEASED' || state === 'CANCELLED' || state === 'FAILED';
  new WorkspaceAdmissionRepository(db).insertAdmission({
    id: `admission-${controlId}`,
    workspaceId: 'ws-a',
    subjectKind: 'COLLABORATION_APPLICATION',
    canonicalRunId: null,
    legacyRunId: null,
    collaborationControlId: controlId,
    requestedMutationClass: 'MODIFYING',
    effectiveMutationClass: 'MODIFYING',
    enforcementEvidenceJson: null,
    requestOrder: 1,
    state,
    queueReason: state === 'QUEUED' ? 'WAITING_FOR_WORKSPACE_ADMISSION' : null,
    releaseReason: terminal ? 'TEST_TERMINAL' : null,
    requestedAt: '2026-09-30T00:00:00.000Z',
    grantedAt: granted ? '2026-09-30T00:00:00.000Z' : null,
    releasedAt: terminal ? '2026-09-30T00:00:00.000Z' : null,
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
    version: 1,
  });
}

for (let repetition = 1; repetition <= 3; repetition++) {
  for (const status of ['completed', 'failed', 'cancelled'] as const) {
    for (const conflict of ['two-modifying', 'modifying-with-reader', 'three-readers'] as const) {
      test(`F24 startup-original-granted ${status} ${conflict} fails before any repair and preserves the row hash (${repetition}/3)`, async () => {
        const root = makeTempRoot('terminal-conflict');
        const store = new SqliteStore(root);
        try {
          seedWorkspace(store, root, 'ws-a');
          const db = store.getDatabase();
          // Reproduce a pre-existing corrupt authority set, as the unchanged
          // spawned-server I07 does. Only this disposable fixture loses a fence.
          db.exec('DROP INDEX workspace_admissions_one_modifying_granted');
          const classes = conflict === 'two-modifying' ? ['MODIFYING', 'MODIFYING'] as const
            : conflict === 'modifying-with-reader' ? ['MODIFYING', 'READ_ONLY'] as const
              : ['READ_ONLY', 'READ_ONLY', 'READ_ONLY'] as const;
          for (const [index, mutationClass] of classes.entries()) {
            const runId = `terminal-conflict-${index}`;
            insertRun(store, 'ws-a', runId, status, '2026-09-30T00:00:00.000Z');
            db.prepare('UPDATE runs SET completed_at = ?, failure_code = ? WHERE id = ?')
              .run('2026-09-30T00:00:01.000Z', status === 'failed' ? 'FIXTURE_PROVEN_FAILURE' : null, runId);
            new WorkspaceAdmissionRepository(db).insertAdmission({
              id: `terminal-conflict-admission-${index}`, workspaceId: 'ws-a', subjectKind: 'CANONICAL_RUN', canonicalRunId: runId, legacyRunId: null,
              requestedMutationClass: mutationClass, effectiveMutationClass: mutationClass, enforcementEvidenceJson: null,
              requestOrder: index + 1, state: 'GRANTED', queueReason: null, releaseReason: null,
              requestedAt: '2026-09-30T00:00:00.000Z', grantedAt: '2026-09-30T00:00:01.000Z', releasedAt: null,
              createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:01.000Z', version: 1,
            });
          }
          const snapshot = () => ({
            admissions: db.prepare('SELECT * FROM workspace_admissions ORDER BY workspace_id, request_order, id').all(),
            runs: db.prepare('SELECT * FROM runs ORDER BY workspace_id, id').all(),
            tasks: db.prepare('SELECT * FROM tasks ORDER BY workspace_id, id').all(),
          });
          const rowHash = () => createHash('sha256').update(JSON.stringify(snapshot())).digest('hex');
          const original = snapshot(); const originalHash = rowHash();
          let repairWrites = 0;
          (db as typeof db & { function(name: string, callback: () => number): void }).function('f24_observe_repair', () => { repairWrites++; return 0; });
          db.exec('CREATE TRIGGER f24_observe_admission_repair BEFORE UPDATE ON workspace_admissions BEGIN SELECT f24_observe_repair(); END');
          for (let attempt = 1; attempt <= 2; attempt++) {
            let error: unknown;
            try { await reconcile(store); } catch (caught) { error = caught; }
            assert.equal(rowHash(), originalHash, JSON.stringify({ status, conflict, attempt, repairWrites, error: String(error) }));
            assert.equal(repairWrites, 0, 'invalid original holders must be rejected before even a rolled-back repair UPDATE');
            assert.ok(error instanceof WorkspaceAdmissionStartupReconciliationError, 'terminal Run facts cannot excuse a corrupt persisted GRANTED set');
            assert.equal(error.code, STARTUP_ADMISSION_RECONCILIATION_FAILED);
            assert.deepEqual(snapshot(), original);
            assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
          }
        } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
      });
    }
  }
}

for (let repetition = 1; repetition <= 3; repetition++) {
  for (const outcome of ['cancelled', 'completed', 'failed', 'unknown'] as const) {
    test(`F24 cancel-gap startup reconciles ${outcome} pending B before advancing C across two DB reopens (${repetition}/3)`, async () => {
      const root = makeTempRoot('cancel-gap');
      let store = new SqliteStore(root);
      const controlId = 'cancel-gap-startup-application';
      try {
        seedWorkspace(store, root, 'ws-a');
        insertApplyControl(store, controlId, 'running', null);
        const authority = new WorkspaceAdmissionAuthority({ store });
        assert.ok((await authority.requestCollaborationApplication({ workspaceId: 'ws-a', controlId })).grantedAdmission);
        for (const runId of ['cancel-gap-B', 'cancel-gap-C']) {
          insertRun(store, 'ws-a', runId, 'queued', '2026-09-30T00:00:00.000Z');
          assert.equal(await authority.requestCanonicalRun({ workspaceId: 'ws-a', runId }), false);
        }
        const original = admissionsFor(store, 'ws-a');
        const beforeB = original.find(row => row.canonicalRunId === 'cancel-gap-B')!;
        const beforeC = original.find(row => row.canonicalRunId === 'cancel-gap-C')!;
        assert.equal(beforeB.state, 'QUEUED'); assert.equal(beforeC.state, 'QUEUED');
        store.runInTransaction(() => {
          const db = store.getDatabase();
          if (outcome === 'unknown') db.prepare('UPDATE runs SET recovery_required = 1, version = version + 1 WHERE id = ?').run('cancel-gap-B');
          else db.prepare('UPDATE runs SET status = ?, completed_at = ?, failure_code = ?, version = version + 1 WHERE id = ?')
            .run(outcome, '2026-09-30T00:00:00.000Z', outcome === 'failed' ? 'FIXTURE_PROVEN_FAILURE' : null, 'cancel-gap-B');
          // A failed before preparing a journal: trusted terminal application.
          db.prepare("UPDATE collaboration_controls SET state = 'failed' WHERE id = ?").run(controlId);
        });
        const subjects = store.getDatabase().prepare('SELECT * FROM runs ORDER BY id').all();
        let stable: WorkspaceAdmissionRow[] | undefined;
        for (let reboot = 1; reboot <= 2; reboot++) {
          store.close(); store = new SqliteStore(root);
          if (reboot === 1) {
            assert.equal(admissionsFor(store, 'ws-a').find(row => row.canonicalRunId === 'cancel-gap-B')?.state, 'QUEUED', 'the pre-release cancellation gap is persisted');
            assert.equal(admissionsFor(store, 'ws-a').find(row => row.collaborationControlId === controlId)?.state, 'GRANTED');
          }
          await reconcile(store); await reconcile(store);
          const rows = admissionsFor(store, 'ws-a');
          const b = rows.find(row => row.canonicalRunId === 'cancel-gap-B')!;
          const c = rows.find(row => row.canonicalRunId === 'cancel-gap-C')!;
          assert.equal(b.id, beforeB.id); assert.equal(b.requestOrder, beforeB.requestOrder); assert.equal(b.grantedAt, null, 'startup must not grant B before discovering its terminal/unknown state');
          assert.equal(b.state, outcome === 'unknown' ? 'QUEUED' : outcome === 'cancelled' ? 'CANCELLED' : 'RELEASED');
          assert.equal(c.id, beforeC.id); assert.equal(c.requestOrder, beforeC.requestOrder);
          assert.equal(c.state, outcome === 'unknown' ? 'QUEUED' : 'GRANTED');
          assert.equal(rows.find(row => row.collaborationControlId === controlId)?.state, 'RELEASED');
          if (stable) assert.deepEqual(rows, stable); else stable = rows;
          assert.deepEqual(store.getDatabase().prepare('SELECT * FROM runs ORDER BY id').all(), subjects);
          assert.deepEqual(store.getDatabase().prepare('PRAGMA foreign_key_check').all(), []);
        }
      } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
    });
  }
}

for (let repetition = 1; repetition <= 3; repetition++) {
  for (const status of ['completed', 'failed', 'cancelled'] as const) {
    test(`F24 startup-original-granted valid single ${status} holder releases and advances its original follower across two DB reopens (${repetition}/3)`, async () => {
      const root = makeTempRoot('single-terminal-holder');
      let store = new SqliteStore(root);
      try {
        seedWorkspace(store, root, 'ws-a');
        const authority = new WorkspaceAdmissionAuthority({ store });
        for (const runId of ['single-terminal-A', 'single-terminal-C']) insertRun(store, 'ws-a', runId, 'queued', '2026-09-30T00:00:00.000Z');
        assert.equal(await authority.requestCanonicalRun({ workspaceId: 'ws-a', runId: 'single-terminal-A' }), true);
        assert.equal(await authority.requestCanonicalRun({ workspaceId: 'ws-a', runId: 'single-terminal-C' }), false);
        const before = admissionsFor(store, 'ws-a');
        store.getDatabase().prepare('UPDATE runs SET status = ?, completed_at = ?, failure_code = ?, version = version + 1 WHERE id = ?')
          .run(status, '2026-09-30T00:00:01.000Z', status === 'failed' ? 'FIXTURE_PROVEN_FAILURE' : null, 'single-terminal-A');
        const runFacts = store.getDatabase().prepare('SELECT * FROM runs ORDER BY id').all();
        let stable: WorkspaceAdmissionRow[] | undefined;
        for (let reboot = 1; reboot <= 2; reboot++) {
          store.close(); store = new SqliteStore(root);
          await reconcile(store); await reconcile(store);
          const rows = admissionsFor(store, 'ws-a');
          assert.equal(rows.length, 2);
          assert.deepEqual(rows.map(row => ({ id: row.id, order: row.requestOrder })), before.map(row => ({ id: row.id, order: row.requestOrder })));
          assert.equal(rows.find(row => row.canonicalRunId === 'single-terminal-A')?.state, 'RELEASED');
          assert.equal(rows.find(row => row.canonicalRunId === 'single-terminal-C')?.state, 'GRANTED');
          assert.deepEqual(store.getDatabase().prepare('SELECT * FROM runs ORDER BY id').all(), runFacts);
          assert.deepEqual(store.getDatabase().prepare('PRAGMA foreign_key_check').all(), []);
          if (stable) assert.deepEqual(rows, stable); else stable = rows;
        }
      } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
    });
  }
}

// L1E-U01 empty inventory is noop
test('L1E-U01 empty inventory is a no-op', async () => {
  const root = makeTempRoot('u01');
  const store = new SqliteStore(root);
  try {
    seedWorkspace(store, root, 'ws-a');
    await reconcile(store);
    assert.equal(admissionCount(store), 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('COLLAB-ADMISSION-STARTUP-01 recovery-required application holds the writer across two database reopens', async () => {
  const root = makeTempRoot('application-recovery-reopen');
  let store = new SqliteStore(root);
  try {
    seedWorkspace(store, root, 'ws-a');
    insertRun(store, 'ws-a', 'run_waiting_for_application', 'queued', '2026-09-30T00:00:01.000Z');
    insertApplyControl(store, 'control_unknown_startup', 'recovery_required', 'recovery_required');

    store.close();
    store = new SqliteStore(root);
    await reconcile(store);
    const firstRows = admissionsFor(store, 'ws-a');
    const firstApplication = new WorkspaceAdmissionRepository(store.getDatabase()).findBySubject('ws-a', {
      subjectKind: 'COLLABORATION_APPLICATION',
      controlId: 'control_unknown_startup',
    });
    assert.equal(firstApplication?.state, 'GRANTED');
    assert.equal(firstRows.filter(row => row.state === 'GRANTED').length, 1);
    assert.equal(firstRows.find(row => row.canonicalRunId === 'run_waiting_for_application')?.state, 'QUEUED');
    assert.equal(firstRows.length, 2);
    const stableAdmissionId = firstApplication?.id;

    store.close();
    store = new SqliteStore(root);
    await reconcile(store);
    const secondApplication = new WorkspaceAdmissionRepository(store.getDatabase()).findBySubject('ws-a', {
      subjectKind: 'COLLABORATION_APPLICATION',
      controlId: 'control_unknown_startup',
    });
    assert.equal(secondApplication?.id, stableAdmissionId);
    assert.equal(secondApplication?.state, 'GRANTED');
    assert.equal(admissionsFor(store, 'ws-a').filter(row => row.state === 'GRANTED').length, 1);
    assert.equal(admissionCount(store), 2);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('COLLAB-ADMISSION-STARTUP-02 stale apply control epoch fails closed before allocating a writer', async () => {
  const root = makeTempRoot('application-stale-epoch');
  let store = new SqliteStore(root);
  try {
    seedWorkspace(store, root, 'ws-a');
    insertApplyControl(store, 'control_stale_epoch', 'running', null);
    store.getDatabase().prepare('UPDATE collaboration_tasks SET control_epoch = 2 WHERE id = ?')
      .run('collab-control_stale_epoch');
    store.close();
    store = new SqliteStore(root);

    await assert.rejects(() => reconcile(store), WorkspaceAdmissionStartupReconciliationError);
    assert.equal(admissionCount(store), 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('COLLAB-ADMISSION-STARTUP-03 exactly paired committed/completed journal releases its existing startup writer hold', async () => {
  const root = makeTempRoot('application-committed-release');
  let store = new SqliteStore(root);
  try {
    seedWorkspace(store, root, 'ws-a');
    insertApplyControl(store, 'control_committed_startup', 'completed', 'committed');
    insertApplicationAdmission(store, 'control_committed_startup');
    store.close();
    store = new SqliteStore(root);

    await reconcile(store);
    const row = new WorkspaceAdmissionRepository(store.getDatabase()).findBySubject('ws-a', {
      subjectKind: 'COLLABORATION_APPLICATION',
      controlId: 'control_committed_startup',
    });
    assert.equal(row?.state, 'RELEASED');
    assert.equal(row?.releaseReason, 'APPLICATION_JOURNAL_COMMITTED');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (let repetition = 1; repetition <= 3; repetition++) {
  for (const journalState of ['committed', 'recovered'] as const) {
    test(`F25 startup exactly paired ${journalState} releases once and preserves its queued follower across two DB reopens (${repetition}/3)`, async () => {
      const root = makeTempRoot('paired-terminal-reopen');
      let store = new SqliteStore(root);
      try {
        seedWorkspace(store, root, 'ws-a');
        insertApplyControl(store, 'paired-startup-control', journalState === 'committed' ? 'completed' : 'failed', journalState);
        insertApplicationAdmission(store, 'paired-startup-control');
        insertRun(store, 'ws-a', 'paired-queued-follower', 'queued', '2026-09-30T00:00:01.000Z');
        let firstRows: WorkspaceAdmissionRow[] | undefined;
        for (let reboot = 1; reboot <= 2; reboot++) {
          store.close();
          store = new SqliteStore(root);
          await reconcile(store);
          const rows = admissionsFor(store, 'ws-a');
          const application = rows.find(row => row.collaborationControlId === 'paired-startup-control')!;
          assert.equal(application.state, 'RELEASED');
          assert.equal(application.releaseReason, journalState === 'committed' ? 'APPLICATION_JOURNAL_COMMITTED' : 'APPLICATION_JOURNAL_RECOVERED');
          assert.equal(rows.find(row => row.canonicalRunId === 'paired-queued-follower')?.state, 'GRANTED');
          assert.equal(rows.length, 2);
          assert.equal((store.getDatabase().prepare('SELECT COUNT(*) AS n FROM runs WHERE id = ?').get('paired-queued-follower') as { n: number }).n, 1);
          assert.deepEqual(store.getDatabase().prepare('PRAGMA foreign_key_check').all(), []);
          if (firstRows) assert.deepEqual(rows, firstRows, 'a repeated startup must not duplicate release or grant');
          else firstRows = rows;
        }
      } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
    });
    for (const scenario of ['pending-control', 'wrong-task', 'wrong-candidate', 'wrong-run', 'wrong-base', 'corrupt-hash', 'wrong-epoch', 'unknown'] as const) {
      test(`F25 startup ${journalState}/${scenario} retains the writer and queued follower across two DB reopens (${repetition}/3)`, async () => {
        const root = makeTempRoot('terminal-hold-reopen');
        let store = new SqliteStore(root);
        try {
          seedWorkspace(store, root, 'ws-a');
          const controlId = 'held-startup-control';
          const pending = scenario === 'pending-control' || scenario === 'wrong-epoch';
          insertApplyControl(store, controlId, scenario === 'unknown' ? 'recovery_required' : pending ? 'running' : journalState === 'committed' ? 'completed' : 'failed',
            scenario === 'unknown' ? 'recovery_required' : journalState);
          insertApplicationAdmission(store, controlId);
          insertApplyControl(store, 'other-startup-control', 'completed', 'committed');
          const db = store.getDatabase();
          if (scenario === 'wrong-task') db.prepare('UPDATE collaboration_apply_journals SET collaboration_task_id = ? WHERE control_id = ?')
            .run('collab-other-startup-control', controlId);
          if (scenario === 'wrong-candidate') db.prepare('UPDATE collaboration_controls SET candidate_id = ? WHERE id = ?')
            .run('candidate-other-startup-control', controlId);
          if (scenario === 'wrong-run') db.prepare('UPDATE collaboration_controls SET canonical_run_id = ? WHERE id = ?')
            .run('application-run-other-startup-control', controlId);
          if (scenario === 'wrong-base') db.prepare('UPDATE collaboration_apply_journals SET base_commit = ? WHERE control_id = ?').run('other-base', controlId);
          if (scenario === 'corrupt-hash') db.prepare('UPDATE collaboration_apply_journals SET candidate_hash = ? WHERE control_id = ?').run('0'.repeat(64), controlId);
          if (scenario === 'wrong-epoch') db.prepare('UPDATE collaboration_tasks SET control_epoch = 2 WHERE id = ?').run(`collab-${controlId}`);
          insertRun(store, 'ws-a', 'held-queued-follower', 'queued', '2026-09-30T00:00:01.000Z');
          let firstRows: WorkspaceAdmissionRow[] | undefined;
          for (let reboot = 1; reboot <= 2; reboot++) {
            store.close();
            store = new SqliteStore(root);
            await reconcile(store);
            const rows = admissionsFor(store, 'ws-a');
            assert.equal(rows.find(row => row.collaborationControlId === controlId)?.state, 'GRANTED', 'unproven journal/control association must retain its existing writer');
            assert.equal(rows.find(row => row.canonicalRunId === 'held-queued-follower')?.state, 'QUEUED');
            assert.equal(rows.filter(row => row.state === 'GRANTED').length, 1);
            assert.equal(rows.length, 2);
            assert.deepEqual(store.getDatabase().prepare('PRAGMA foreign_key_check').all(), []);
            if (firstRows) assert.deepEqual(rows, firstRows);
            else firstRows = rows;
          }
        } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
      });
    }
  }
}

for (let repetition = 1; repetition <= 3; repetition++) {
  for (const safe of [true, false]) {
    for (const pendingState of ['QUEUED', 'REQUESTED'] as const) {
      test(`F24 release-gap startup advances existing ${pendingState} only with ${safe ? 'RELEASED terminal A' : 'unknown GRANTED A'} across two real DB reopens (${repetition}/3)`, async () => {
        const root = makeTempRoot('release-gap');
        let store = new SqliteStore(root);
        let armed = false;
        let crashPoints = 0;
        const controlId = 'release-gap-startup-application';
        const runId = 'release-gap-startup-follower';
        try {
          seedWorkspace(store, root, 'ws-a');
          insertApplyControl(store, controlId, safe ? 'completed' : 'recovery_required', safe ? 'committed' : 'recovery_required');
          insertApplicationAdmission(store, controlId);
          insertRun(store, 'ws-a', runId, 'queued', '2026-09-30T00:00:01.000Z');
          const authority = new WorkspaceAdmissionAuthority({ store, testHooks: { afterEvidenceCollectionOutsideTransaction: () => {
            if (!armed) return;
            assert.equal(isTransactionActive(store.getDatabase()), false);
            assert.equal(admissionsFor(store, 'ws-a').find(row => row.collaborationControlId === controlId)?.state, 'RELEASED');
            assert.equal(admissionsFor(store, 'ws-a').find(row => row.canonicalRunId === runId)?.state, pendingState);
            crashPoints++;
            throw new Error('F24 durable release gap before startup');
          } } });
          assert.equal(await authority.requestCanonicalRun({ workspaceId: 'ws-a', runId }), false);
          if (pendingState === 'REQUESTED') store.runInTransaction(() => {
            // Persist an interrupted admission request, not a fabricated grant.
            store.getDatabase().prepare("UPDATE workspace_admissions SET state = 'REQUESTED', queue_reason = NULL, version = version + 1 WHERE canonical_run_id = ? AND state = 'QUEUED'").run(runId);
          });
          armed = true;
          await assert.rejects(authority.releaseCollaborationApplication({ workspaceId: 'ws-a', controlId }),
            (error: unknown) => error instanceof WorkspaceAdmissionAuthorityError && (safe || error.code === 'ADMISSION_NOT_RELEASABLE'));
          assert.equal(crashPoints, safe ? 1 : 0);
          const before = admissionsFor(store, 'ws-a');
          const application = before.find(row => row.collaborationControlId === controlId)!;
          const follower = before.find(row => row.canonicalRunId === runId)!;
          assert.equal(application.state, safe ? 'RELEASED' : 'GRANTED');
          assert.equal(follower.state, pendingState);
          const runs = store.getDatabase().prepare('SELECT * FROM runs ORDER BY id').all();
          const stages = store.getDatabase().prepare('SELECT * FROM run_stages ORDER BY id').all();
          let firstRows: WorkspaceAdmissionRow[] | undefined;
          for (let reboot = 1; reboot <= 2; reboot++) {
            store.close(); store = new SqliteStore(root);
            await reconcile(store); await reconcile(store);
            const rows = admissionsFor(store, 'ws-a');
            assert.deepEqual(rows.find(row => row.id === application.id), application, 'existing terminal/unknown A must not need a new inventory edit');
            const current = rows.find(row => row.id === follower.id)!;
            assert.equal(current.state, safe ? 'GRANTED' : 'QUEUED');
            assert.equal(current.requestOrder, follower.requestOrder);
            assert.equal(rows.length, 2);
            assert.deepEqual(store.getDatabase().prepare('SELECT * FROM runs ORDER BY id').all(), runs);
            assert.deepEqual(store.getDatabase().prepare('SELECT * FROM run_stages ORDER BY id').all(), stages);
            assert.deepEqual(store.getDatabase().prepare('PRAGMA foreign_key_check').all(), []);
            if (firstRows) assert.deepEqual(rows, firstRows); else firstRows = rows;
          }
        } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
      });
    }
  }
}

// L1E-U02 canonical queued missing Admission -> bootstrap MODIFYING QUEUED
test('L1E-U02 canonical queued subject bootstraps MODIFYING QUEUED', async () => {
  const root = makeTempRoot('u02');
  const store = new SqliteStore(root);
  try {
    seedWorkspace(store, root, 'ws-a');
    insertRun(store, 'ws-a', 'run-q1', 'queued', '2026-07-25T00:00:01.000Z');
    await reconcile(store);
    const rows = admissionsFor(store, 'ws-a');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].subjectKind, 'CANONICAL_RUN');
    assert.equal(rows[0].canonicalRunId, 'run-q1');
    assert.equal(rows[0].requestedMutationClass, 'MODIFYING');
    assert.equal(rows[0].effectiveMutationClass, 'MODIFYING');
    assert.equal(rows[0].enforcementEvidenceJson, null);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// L1E-U03 canonical running missing Admission -> bootstrap MODIFYING GRANTED
test('L1E-U03 canonical running subject bootstraps MODIFYING GRANTED holder', async () => {
  const root = makeTempRoot('u03');
  const store = new SqliteStore(root);
  try {
    seedWorkspace(store, root, 'ws-a');
    insertRun(store, 'ws-a', 'run-r1', 'running', '2026-07-25T00:00:01.000Z');
    await reconcile(store);
    const rows = admissionsFor(store, 'ws-a');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'GRANTED');
    assert.equal(rows[0].effectiveMutationClass, 'MODIFYING');
    assert.ok(rows[0].grantedAt !== null);
    assert.equal(rows[0].releasedAt, null);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// L1E-U04 waiting_approval -> GRANTED
test('L1E-U04 canonical waiting_approval subject bootstraps GRANTED', async () => {
  const root = makeTempRoot('u04');
  const store = new SqliteStore(root);
  try {
    seedWorkspace(store, root, 'ws-a');
    insertRun(store, 'ws-a', 'run-w1', 'waiting_approval', '2026-07-25T00:00:01.000Z');
    await reconcile(store);
    assert.equal(admissionsFor(store, 'ws-a')[0].state, 'GRANTED');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// L1E-U05 paused -> GRANTED
test('L1E-U05 canonical paused subject bootstraps GRANTED', async () => {
  const root = makeTempRoot('u05');
  const store = new SqliteStore(root);
  try {
    seedWorkspace(store, root, 'ws-a');
    insertRun(store, 'ws-a', 'run-p1', 'paused', '2026-07-25T00:00:01.000Z');
    await reconcile(store);
    assert.equal(admissionsFor(store, 'ws-a')[0].state, 'GRANTED');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// L1E-U06 legacy queued missing Admission -> QUEUED
test('L1E-U06 legacy queued subject bootstraps QUEUED', async () => {
  const root = makeTempRoot('u06');
  const store = new SqliteStore(root);
  try {
    seedWorkspace(store, root, 'ws-a');
    insertLegacyRun(store, 'ws-a', 'legacy-q1', 'queued', '2026-07-25T00:00:01.000Z');
    await reconcile(store);
    const rows = admissionsFor(store, 'ws-a');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].subjectKind, 'LEGACY_AGENT_RUN');
    assert.equal(rows[0].legacyRunId, 'legacy-q1');
    // Bootstrap mapping is QUEUED; the reused L1D winner algorithm then
    // advances the lone MODIFYING queued Admission to GRANTED (no competing
    // holder). The durable class stays fail-closed MODIFYING.
    assert.equal(rows[0].effectiveMutationClass, 'MODIFYING');
    assert.ok(rows[0].state === 'QUEUED' || rows[0].state === 'GRANTED');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// L1E-U07 legacy running missing Admission -> GRANTED
test('L1E-U07 legacy running subject bootstraps GRANTED holder', async () => {
  const root = makeTempRoot('u07');
  const store = new SqliteStore(root);
  try {
    seedWorkspace(store, root, 'ws-a');
    insertLegacyRun(store, 'ws-a', 'legacy-r1', 'running', '2026-07-25T00:00:01.000Z');
    await reconcile(store);
    const rows = admissionsFor(store, 'ws-a');
    assert.equal(rows[0].state, 'GRANTED');
    assert.equal(rows[0].effectiveMutationClass, 'MODIFYING');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// L1E-U08 bootstrap never creates READ_ONLY
test('L1E-U08 bootstrap never creates READ_ONLY', async () => {
  const root = makeTempRoot('u08');
  const store = new SqliteStore(root);
  try {
    seedWorkspace(store, root, 'ws-a');
    insertRun(store, 'ws-a', 'run-q1', 'queued', '2026-07-25T00:00:01.000Z');
    insertRun(store, 'ws-a', 'run-r1', 'running', '2026-07-25T00:00:02.000Z');
    insertLegacyRun(store, 'ws-a', 'legacy-r1', 'running', '2026-07-25T00:00:03.000Z');
    // Two executing holders in one Workspace must fail closed; assert no
    // READ_ONLY row can ever appear even on the failure path.
    await assert.rejects(() => reconcile(store), WorkspaceAdmissionStartupReconciliationError);
    for (const row of admissionsFor(store, 'ws-a')) {
      assert.notEqual(row.requestedMutationClass, 'READ_ONLY');
      assert.notEqual(row.effectiveMutationClass, 'READ_ONLY');
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// L1E-U09 terminal subjects ignored
test('L1E-U09 terminal subjects are ignored', async () => {
  const root = makeTempRoot('u09');
  const store = new SqliteStore(root);
  try {
    seedWorkspace(store, root, 'ws-a');
    insertRun(store, 'ws-a', 'run-c1', 'completed', '2026-07-25T00:00:01.000Z');
    insertRun(store, 'ws-a', 'run-f1', 'failed', '2026-07-25T00:00:02.000Z');
    insertLegacyRun(store, 'ws-a', 'legacy-x1', 'completed', '2026-07-25T00:00:03.000Z');
    await reconcile(store);
    assert.equal(admissionCount(store), 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// L1E-U10 existing Admission reused, no duplicate
test('L1E-U10 existing Admission is reused, never duplicated', async () => {
  const root = makeTempRoot('u10');
  const store = new SqliteStore(root);
  try {
    seedWorkspace(store, root, 'ws-a');
    insertRun(store, 'ws-a', 'run-q1', 'queued', '2026-07-25T00:00:01.000Z');
    await reconcile(store);
    const first = admissionsFor(store, 'ws-a');
    assert.equal(first.length, 1);
    await reconcile(store);
    const second = admissionsFor(store, 'ws-a');
    assert.equal(second.length, 1);
    assert.equal(second[0].id, first[0].id);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// L1E-U11 existing request_order immutable
test('L1E-U11 existing request_order is immutable across restarts', async () => {
  const root = makeTempRoot('u11');
  const store = new SqliteStore(root);
  try {
    seedWorkspace(store, root, 'ws-a');
    insertRun(store, 'ws-a', 'run-q1', 'queued', '2026-07-25T00:00:01.000Z');
    insertRun(store, 'ws-a', 'run-q2', 'queued', '2026-07-25T00:00:02.000Z');
    await reconcile(store);
    const before = admissionsFor(store, 'ws-a').map(r => ({ id: r.id, order: r.requestOrder, version: r.version }));
    await reconcile(store);
    const after = admissionsFor(store, 'ws-a').map(r => ({ id: r.id, order: r.requestOrder, version: r.version }));
    assert.deepEqual(after, before);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// L1E-U12 deterministic new request_order from MAX+1
test('L1E-U12 new request_order allocates from workspace MAX+1 deterministically', async () => {
  const root = makeTempRoot('u12');
  const store = new SqliteStore(root);
  try {
    seedWorkspace(store, root, 'ws-a');
    insertRun(store, 'ws-a', 'run-q2', 'queued', '2026-07-25T00:00:02.000Z');
    insertRun(store, 'ws-a', 'run-q1', 'queued', '2026-07-25T00:00:01.000Z');
    await reconcile(store);
    const rows = admissionsFor(store, 'ws-a');
    // created_at ASC ordering: run-q1 (older) gets the lower request_order.
    assert.equal(rows[0].canonicalRunId, 'run-q1');
    assert.equal(rows[0].requestOrder, 1);
    assert.equal(rows[1].canonicalRunId, 'run-q2');
    assert.equal(rows[1].requestOrder, 2);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// L1E-U13 executing subject + QUEUED Admission -> fail closed
test('L1E-U13 executing subject with QUEUED Admission fails closed', async () => {
  const root = makeTempRoot('u13');
  const store = new SqliteStore(root);
  try {
    seedWorkspace(store, root, 'ws-a');
    insertRun(store, 'ws-a', 'run-r1', 'running', '2026-07-25T00:00:01.000Z');
    const repo = new WorkspaceAdmissionRepository(store.getDatabase());
    repo.insertAdmission({
      id: 'grant_existing1', workspaceId: 'ws-a', subjectKind: 'CANONICAL_RUN',
      canonicalRunId: 'run-r1', legacyRunId: null,
      requestedMutationClass: 'MODIFYING', effectiveMutationClass: 'MODIFYING',
      enforcementEvidenceJson: null, requestOrder: 1, state: 'QUEUED',
      queueReason: 'WAITING_FOR_WORKSPACE_ADMISSION', releaseReason: null,
      requestedAt: '2026-07-25T00:00:01.000Z', grantedAt: null, releasedAt: null,
      createdAt: '2026-07-25T00:00:01.000Z', updatedAt: '2026-07-25T00:00:01.000Z', version: 1,
    });
    await assert.rejects(() => reconcile(store), WorkspaceAdmissionStartupReconciliationError);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// L1E-U14 active subject + terminal Admission -> fail closed
test('L1E-U14 active subject with terminal Admission fails closed', async () => {
  const root = makeTempRoot('u14');
  const store = new SqliteStore(root);
  try {
    seedWorkspace(store, root, 'ws-a');
    insertRun(store, 'ws-a', 'run-r1', 'running', '2026-07-25T00:00:01.000Z');
    const repo = new WorkspaceAdmissionRepository(store.getDatabase());
    repo.insertAdmission({
      id: 'grant_existing1', workspaceId: 'ws-a', subjectKind: 'CANONICAL_RUN',
      canonicalRunId: 'run-r1', legacyRunId: null,
      requestedMutationClass: 'MODIFYING', effectiveMutationClass: 'MODIFYING',
      enforcementEvidenceJson: null, requestOrder: 1, state: 'RELEASED',
      queueReason: null, releaseReason: 'RUN_TERMINAL',
      requestedAt: '2026-07-25T00:00:01.000Z', grantedAt: '2026-07-25T00:00:01.000Z', releasedAt: '2026-07-25T00:00:02.000Z',
      createdAt: '2026-07-25T00:00:01.000Z', updatedAt: '2026-07-25T00:00:02.000Z', version: 1,
    });
    await assert.rejects(() => reconcile(store), WorkspaceAdmissionStartupReconciliationError);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// L1E-U15 multiple executing holders -> fail closed
test('L1E-U15 multiple executing holders in one Workspace fail closed', async () => {
  const root = makeTempRoot('u15');
  const store = new SqliteStore(root);
  try {
    seedWorkspace(store, root, 'ws-a');
    insertRun(store, 'ws-a', 'run-r1', 'running', '2026-07-25T00:00:01.000Z');
    insertRun(store, 'ws-a', 'run-r2', 'running', '2026-07-25T00:00:02.000Z');
    await assert.rejects(() => reconcile(store), WorkspaceAdmissionStartupReconciliationError);
    // Rolled back: no partial bootstrap survives.
    assert.equal(admissionCount(store), 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// L1E-U16 errors are stable and data-free
test('L1E-U16 reconciliation error is a stable data-free code', async () => {
  const root = makeTempRoot('u16');
  const store = new SqliteStore(root);
  try {
    seedWorkspace(store, root, 'ws-a');
    insertRun(store, 'ws-a', 'run-r1', 'running', '2026-07-25T00:00:01.000Z');
    insertRun(store, 'ws-a', 'run-r2', 'running', '2026-07-25T00:00:02.000Z');
    const err = await reconcile(store).then(() => undefined, (e: unknown) => e);
    assert.ok(err instanceof WorkspaceAdmissionStartupReconciliationError);
    assert.equal((err as WorkspaceAdmissionStartupReconciliationError).code, STARTUP_ADMISSION_RECONCILIATION_FAILED);
    assert.equal((err as Error).message, STARTUP_ADMISSION_RECONCILIATION_FAILED);
    // No workspace id, run id, SQL, or path leaks through.
    assert.ok(!JSON.stringify(err).includes('ws-a'));
    assert.ok(!JSON.stringify(err).includes('run-r1'));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Repository / transaction (R-cases) ---

function insertAdmissionRow(store: SqliteStore, workspaceId: string, opts: {
  readonly admissionId: string; readonly runId: string; readonly requestOrder: number;
  readonly state: string; readonly effectiveClass?: string; readonly grantedAt?: string | null;
  readonly releaseReason?: string | null; readonly releasedAt?: string | null;
}): void {
  const now = '2026-07-25T00:00:00.000Z';
  new WorkspaceAdmissionRepository(store.getDatabase()).insertAdmission({
    id: opts.admissionId, workspaceId, subjectKind: 'CANONICAL_RUN',
    canonicalRunId: opts.runId, legacyRunId: null,
    requestedMutationClass: 'MODIFYING',
    effectiveMutationClass: (opts.effectiveClass ?? 'MODIFYING') as 'MODIFYING',
    enforcementEvidenceJson: null, requestOrder: opts.requestOrder,
    state: opts.state as 'GRANTED', queueReason: opts.state === 'QUEUED' ? 'WAITING_FOR_WORKSPACE_ADMISSION' : null,
    releaseReason: opts.releaseReason ?? null,
    requestedAt: now, grantedAt: opts.grantedAt ?? null, releasedAt: opts.releasedAt ?? null,
    createdAt: now, updatedAt: now, version: 1,
  });
}

// L1E-R03/R04: MAX request_order is Workspace-scoped and stays unique per Workspace
test('L1E-R03/R04 request_order allocation is workspace-scoped and unique', async () => {
  const root = makeTempRoot('r03');
  const store = new SqliteStore(root);
  try {
    seedWorkspace(store, root, 'ws-a');
    seedWorkspace(store, root, 'ws-b');
    insertRun(store, 'ws-a', 'run-a1', 'queued', '2026-07-25T00:00:01.000Z');
    insertRun(store, 'ws-a', 'run-a2', 'queued', '2026-07-25T00:00:02.000Z');
    insertRun(store, 'ws-b', 'run-b1', 'queued', '2026-07-25T00:00:01.000Z');
    await reconcile(store);
    assert.deepEqual(admissionsFor(store, 'ws-a').map(r => r.requestOrder), [1, 2]);
    assert.deepEqual(admissionsFor(store, 'ws-b').map(r => r.requestOrder), [1]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// L1E-R07: repeated reconciliation does not duplicate rows
test('L1E-R07 repeated reconciliation is idempotent', async () => {
  const root = makeTempRoot('r07');
  const store = new SqliteStore(root);
  try {
    seedWorkspace(store, root, 'ws-a');
    insertRun(store, 'ws-a', 'run-q1', 'queued', '2026-07-25T00:00:01.000Z');
    await reconcile(store);
    await reconcile(store);
    await reconcile(store);
    assert.equal(admissionsFor(store, 'ws-a').length, 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// L1E-R08: two Workspace inventories do not cross-bind
test('L1E-R08 two workspace inventories never cross-bind', async () => {
  const root = makeTempRoot('r08');
  const store = new SqliteStore(root);
  try {
    seedWorkspace(store, root, 'ws-a');
    seedWorkspace(store, root, 'ws-b');
    insertRun(store, 'ws-a', 'run-a1', 'running', '2026-07-25T00:00:01.000Z');
    insertRun(store, 'ws-b', 'run-b1', 'running', '2026-07-25T00:00:01.000Z');
    await reconcile(store);
    const a = admissionsFor(store, 'ws-a');
    const b = admissionsFor(store, 'ws-b');
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.equal(a[0].workspaceId, 'ws-a');
    assert.equal(a[0].canonicalRunId, 'run-a1');
    assert.equal(b[0].workspaceId, 'ws-b');
    assert.equal(b[0].canonicalRunId, 'run-b1');
    assert.equal(a[0].state, 'GRANTED');
    assert.equal(b[0].state, 'GRANTED');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// L1E existing-holder invariant: two GRANTED MODIFYING holders fail closed
test('L1E existing GRANTED MODIFYING holder conflict fails closed', async () => {
  const root = makeTempRoot('rg');
  const store = new SqliteStore(root);
  try {
    seedWorkspace(store, root, 'ws-a');
    insertRun(store, 'ws-a', 'run-a1', 'running', '2026-07-25T00:00:01.000Z');
    insertRun(store, 'ws-a', 'run-a2', 'running', '2026-07-25T00:00:02.000Z');
    store.getDatabase().exec('DROP INDEX workspace_admissions_one_modifying_granted');
    insertAdmissionRow(store, 'ws-a', { admissionId: 'grant-a1', runId: 'run-a1', requestOrder: 1, state: 'GRANTED', grantedAt: '2026-07-25T00:00:01.000Z' });
    insertAdmissionRow(store, 'ws-a', { admissionId: 'grant-a2', runId: 'run-a2', requestOrder: 2, state: 'GRANTED', grantedAt: '2026-07-25T00:00:02.000Z' });
    await assert.rejects(() => reconcile(store), WorkspaceAdmissionStartupReconciliationError);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// L1E-R05: one Admission per subject constraint retained
test('L1E-R05 one Admission per subject is enforced by the DB', async () => {
  const root = makeTempRoot('r05');
  const store = new SqliteStore(root);
  try {
    seedWorkspace(store, root, 'ws-a');
    insertRun(store, 'ws-a', 'run-a1', 'queued', '2026-07-25T00:00:01.000Z');
    insertAdmissionRow(store, 'ws-a', { admissionId: 'grant-a1', runId: 'run-a1', requestOrder: 1, state: 'QUEUED' });
    assert.throws(() => insertAdmissionRow(store, 'ws-a', { admissionId: 'grant-a2', runId: 'run-a1', requestOrder: 2, state: 'QUEUED' }));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
