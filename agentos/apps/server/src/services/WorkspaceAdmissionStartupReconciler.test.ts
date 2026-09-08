import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Workspace } from '@agentos/shared';
import { DEFAULT_WORKSPACE_AGENTS } from '@agentos/agent-core';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceAdmissionRepository, type WorkspaceAdmissionRow } from '../store/WorkspaceAdmissionRepository.js';
import {
  WorkspaceAdmissionStartupReconciler,
  WorkspaceAdmissionStartupReconciliationError,
  STARTUP_ADMISSION_RECONCILIATION_FAILED,
} from './WorkspaceAdmissionStartupReconciler.js';

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
