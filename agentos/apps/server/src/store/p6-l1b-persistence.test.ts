import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteStore } from './SqliteStore.js';
import { WorkspaceAdmissionRepository } from './WorkspaceAdmissionRepository.js';
import { WorkspaceGitObservationRepository } from './WorkspaceGitObservationRepository.js';

/**
 * P6-L1B persistence-slice tests. They cover:
 *  - L1B-23 legacy artifact APIs still work after 016 (SqliteStore regression);
 *  - canonical Artifact round-trip via SqliteStore.createCanonicalRuntimeArtifact;
 *  - WorkspaceAdmissionRepository insert/find/list/CAS-update round-trips;
 *  - WorkspaceGitObservationRepository insert/find/list round-trips.
 *
 * Schema is the real migrated 016 schema (SqliteStore.runMigrations applies
 * DEFAULT_REGISTRY_MIGRATIONS, which ends in 016).
 */

const NOW = '2026-08-29T00:00:00.000Z';
const NOW2 = '2026-08-29T01:00:00.000Z';

interface Fixture {
  root: string;
  store: SqliteStore;
  admissionRepo: WorkspaceAdmissionRepository;
  gitRepo: WorkspaceGitObservationRepository;
  close(): void;
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agentos-l1b-store-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [{
    id: 'ws-a', name: 'WS A', rootPath: root, gitEnabled: true, memoryEnabled: true,
    agents: [{ id: 'agent-a', name: 'Agent', role: 'codex', enabled: true, cliCommand: 'agent', cliArgs: [] }],
    lastOpenedAt: NOW, createdAt: NOW, updatedAt: NOW,
  }] }), 'utf8');
  const store = new SqliteStore(root);
  // Legacy provenance parents: conversation -> message -> agent_run -> execution.
  store.createConversation({ id: 'conv-a', workspaceId: 'ws-a', type: 'direct', title: 'c', agentId: 'agent-a', createdAt: NOW, updatedAt: NOW });
  store.createMessage({ id: 'msg-a', conversationId: 'conv-a', workspaceId: 'ws-a', senderType: 'user', content: 'hi', createdAt: NOW });
  store.createRun({ id: 'agentrun-a', workspaceId: 'ws-a', conversationId: 'conv-a', sourceMessageId: 'msg-a', objective: 'obj', status: 'running', createdAt: NOW, updatedAt: NOW });
  store.createExecution({ id: 'exec-a', runId: 'agentrun-a', conversationId: 'conv-a', workspaceId: 'ws-a', sourceMessageId: 'msg-a', agentId: 'agent-a', status: 'running_cli', mode: 'real', createdAt: NOW, updatedAt: NOW });
  const db = store.getDatabase();
  return {
    root,
    store,
    admissionRepo: new WorkspaceAdmissionRepository(db),
    gitRepo: new WorkspaceGitObservationRepository(db),
    close() { try { store.close(); } finally { rmSync(root, { recursive: true, force: true }); } },
  };
}

/** Canonical-run parents (runs/run_stages) for admission + canonical artifact subjects. */
function seedCanonicalRun(fx: Fixture, runId = 'run-a', stageId = 'stage-a'): void {
  const db = fx.store.getDatabase();
  db.prepare('INSERT INTO tasks (id, workspace_id, title, status, priority, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('task-a', 'ws-a', 't', 'open', 'normal', 'test', NOW, NOW);
  db.prepare('INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(runId, 'ws-a', 'task-a', runId, 'queued', 'initial', 'v2_api', 'test', NOW, NOW);
  db.prepare('INSERT INTO run_snapshots (id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version, snapshot_json, content_hash, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('snap-a', 'ws-a', runId, 'workflow_00000000000000000000000002', 1, '{}', 'a'.repeat(64), NOW);
  db.prepare('INSERT INTO run_stages (id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name, sequence, attempt, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(stageId, 'ws-a', runId, 'snap-a', 'plan', 'Plan', 1, 1, 'pending', NOW, NOW, 1);
}

function admissionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'adm-1', workspaceId: 'ws-a', subjectKind: 'CANONICAL_RUN' as const, canonicalRunId: 'run-a',
    legacyRunId: null, requestedMutationClass: 'MODIFYING' as const, effectiveMutationClass: 'MODIFYING' as const,
    enforcementEvidenceJson: null, requestOrder: 1, state: 'REQUESTED' as const, queueReason: null,
    releaseReason: null, requestedAt: NOW, grantedAt: null, releasedAt: null,
    createdAt: NOW, updatedAt: NOW, version: 1, ...overrides,
  };
}

// L1B-23: legacy artifact APIs still work after 016.
test('L1B-23 legacy createRuntimeArtifact/list/get survive the 016 rebuild', () => {
  const fx = createFixture();
  try {
    fx.store.createRuntimeArtifact({
      id: 'artifact-legacy', workspaceId: 'ws-a', runId: 'agentrun-a', sourceExecutionId: 'exec-a', agentId: 'agent-a',
      type: 'log', title: 'legacy log', summary: 's', originalPath: '/x.log', mimeType: 'text/plain',
      sizeBytes: 7, sha256: 'b'.repeat(64), contentAvailable: true, createdAt: NOW,
    }, 'sink/legacy');
    const list = fx.store.listRuntimeArtifacts('ws-a', 'agentrun-a');
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'artifact-legacy');
    assert.equal(list[0].runId, 'agentrun-a');
    const rec = fx.store.getRuntimeArtifactRecord('ws-a', 'artifact-legacy');
    assert.ok(rec);
    assert.equal(rec.artifact.sourceExecutionId, 'exec-a');
    assert.equal(rec.storageKey, 'sink/legacy');
    // The row is persisted as LEGACY provenance with no canonical references.
    const raw = fx.store.getDatabase().prepare('SELECT * FROM runtime_artifacts WHERE id = ?').get('artifact-legacy') as Record<string, unknown>;
    assert.equal(raw.provenance_kind, 'LEGACY');
    assert.equal(raw.canonical_run_id, null);
  } finally { fx.close(); }
});

// Canonical artifact round-trip + optional provenance validation.
test('canonical artifact persists with run_id NULL and validates optional provenance', () => {
  const fx = createFixture();
  try {
    seedCanonicalRun(fx);
    fx.store.createCanonicalRuntimeArtifact({
      id: 'artifact-can', workspaceId: 'ws-a', type: 'diff', title: 'diff', summary: undefined,
      originalPath: undefined, mimeType: undefined, sizeBytes: 10, sha256: 'd'.repeat(64),
      contentAvailable: true, createdAt: NOW,
    }, { kind: 'CANONICAL', canonicalRunId: 'run-a', sourceStageId: 'stage-a' }, 'sink/diff');
    const raw = fx.store.getDatabase().prepare('SELECT * FROM runtime_artifacts WHERE id = ?').get('artifact-can') as Record<string, unknown>;
    assert.equal(raw.provenance_kind, 'CANONICAL');
    assert.equal(raw.run_id, null);
    assert.equal(raw.source_execution_id, null);
    assert.equal(raw.agent_id, null);
    assert.equal(raw.canonical_run_id, 'run-a');
    assert.equal(raw.source_stage_id, 'stage-a');
  } finally { fx.close(); }
});

test('canonical artifact rejects provenance outside the owning Workspace/Run', () => {
  const fx = createFixture();
  try {
    seedCanonicalRun(fx);
    const base = {
      id: 'artifact-x', workspaceId: 'ws-a', type: 'diff' as const, title: 'd', sizeBytes: 1,
      contentAvailable: true, createdAt: NOW,
    };
    // canonical Run does not belong to the Workspace.
    assert.throws(() => fx.store.createCanonicalRuntimeArtifact(base, { kind: 'CANONICAL', canonicalRunId: 'run-missing' }, null),
      /canonical Run does not belong to the Workspace/);
    // Stage outside the owning Run.
    assert.throws(() => fx.store.createCanonicalRuntimeArtifact(base, { kind: 'CANONICAL', canonicalRunId: 'run-a', sourceStageId: 'stage-missing' }, null),
      /source Stage is outside the owning Run/);
  } finally { fx.close(); }
});

// WorkspaceAdmissionRepository round-trips.
test('admission repository insert/findById/findBySubject/listByWorkspace', () => {
  const fx = createFixture();
  try {
    seedCanonicalRun(fx);
    fx.admissionRepo.insertAdmission(admissionRow());
    fx.admissionRepo.insertAdmission(admissionRow({
      id: 'adm-2', requestOrder: 2, subjectKind: 'LEGACY_AGENT_RUN', canonicalRunId: null, legacyRunId: 'agentrun-a',
      requestedMutationClass: 'READ_ONLY', effectiveMutationClass: 'READ_ONLY',
    }));
    const byId = fx.admissionRepo.findById('ws-a', 'adm-1');
    assert.ok(byId);
    assert.equal(byId.subjectKind, 'CANONICAL_RUN');
    assert.equal(byId.canonicalRunId, 'run-a');
    const bySubject = fx.admissionRepo.findBySubject('ws-a', { subjectKind: 'LEGACY_AGENT_RUN', legacyRunId: 'agentrun-a' });
    assert.ok(bySubject);
    assert.equal(bySubject.id, 'adm-2');
    const all = fx.admissionRepo.listByWorkspace('ws-a');
    assert.deepEqual(all.map(r => r.id), ['adm-1', 'adm-2']);
  } finally { fx.close(); }
});

test('admission repository CAS updateState succeeds on expected version and fails on stale version', () => {
  const fx = createFixture();
  try {
    seedCanonicalRun(fx);
    fx.admissionRepo.insertAdmission(admissionRow({ state: 'REQUESTED' }));
    const ok = fx.admissionRepo.updateState({
      workspaceId: 'ws-a', admissionId: 'adm-1', expectedVersion: 1, state: 'GRANTED',
      queueReason: null, releaseReason: null, grantedAt: NOW2, releasedAt: null,
      effectiveMutationClass: 'MODIFYING', enforcementEvidenceJson: '{"enforced":true}', updatedAt: NOW2,
    });
    assert.equal(ok, true);
    const after = fx.admissionRepo.findById('ws-a', 'adm-1');
    assert.equal(after?.state, 'GRANTED');
    assert.equal(after?.version, 2);
    assert.equal(after?.grantedAt, NOW2);
    // Stale version no longer matches.
    const stale = fx.admissionRepo.updateState({
      workspaceId: 'ws-a', admissionId: 'adm-1', expectedVersion: 1, state: 'RELEASED',
      queueReason: null, releaseReason: 'done', grantedAt: NOW2, releasedAt: NOW2,
      effectiveMutationClass: 'MODIFYING', enforcementEvidenceJson: null, updatedAt: NOW2,
    });
    assert.equal(stale, false);
  } finally { fx.close(); }
});

// WorkspaceGitObservationRepository round-trips.
test('git observation repository insert/findById/listByAdmission', () => {
  const fx = createFixture();
  try {
    seedCanonicalRun(fx);
    fx.admissionRepo.insertAdmission(admissionRow({ state: 'GRANTED', grantedAt: NOW }));
    fx.gitRepo.insertObservation({
      id: 'obs-1', workspaceId: 'ws-a', admissionId: 'adm-1', subjectKind: 'CANONICAL_RUN', canonicalRunId: 'run-a',
      legacyRunId: null, observationState: 'GIT', repositoryRoot: '/tmp/ws-a', baseCommitSha: 'c'.repeat(40),
      dirtyState: 'clean', statusSummaryJson: '{}', changedFilesJson: '[]', diffArtifactId: null,
      cwd: '/tmp/ws-a', errorCode: null, observedAt: NOW, createdAt: NOW,
    });
    const byId = fx.gitRepo.findById('ws-a', 'obs-1');
    assert.ok(byId);
    assert.equal(byId.observationState, 'GIT');
    assert.equal(byId.baseCommitSha, 'c'.repeat(40));
    const byAdmission = fx.gitRepo.listByAdmission('ws-a', 'adm-1');
    assert.equal(byAdmission.length, 1);
    assert.equal(byAdmission[0].id, 'obs-1');
  } finally { fx.close(); }
});
