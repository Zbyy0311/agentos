import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteStore } from './SqliteStore.js';
import { WorkspaceAdmissionRepository } from './WorkspaceAdmissionRepository.js';
import { WorkspaceGitObservationRepository } from './WorkspaceGitObservationRepository.js';

const NOW = '2026-08-30T00:00:00.000Z';

interface Fixture {
  root: string;
  store: SqliteStore;
  admissions: WorkspaceAdmissionRepository;
  observations: WorkspaceGitObservationRepository;
  close(): void;
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agentos-l1b-delete-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({
    workspaces: [
      {
        id: 'ws-a', name: 'Workspace A', rootPath: join(root, 'ws-a'),
        gitEnabled: true, memoryEnabled: true,
        agents: [{ id: 'agent-a', name: 'Agent A', role: 'codex', enabled: true, cliCommand: 'agent-a', cliArgs: [] }],
        lastOpenedAt: NOW, createdAt: NOW, updatedAt: NOW,
      },
      {
        id: 'ws-b', name: 'Workspace B', rootPath: join(root, 'ws-b'),
        gitEnabled: true, memoryEnabled: true,
        agents: [{ id: 'agent-b', name: 'Agent B', role: 'kimi', enabled: true, cliCommand: 'agent-b', cliArgs: [] }],
        lastOpenedAt: NOW, createdAt: NOW, updatedAt: NOW,
      },
    ],
  }), 'utf8');
  const store = new SqliteStore(root);
  const db = store.getDatabase();
  assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
  return {
    root,
    store,
    admissions: new WorkspaceAdmissionRepository(db),
    observations: new WorkspaceGitObservationRepository(db),
    close() {
      try {
        store.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

function seedCanonicalRun(fx: Fixture, workspaceId: string, suffix: string): string {
  const db = fx.store.getDatabase();
  const taskId = 'task-' + suffix;
  const runId = 'canonical-run-' + suffix;
  const snapshotId = 'snapshot-' + suffix;
  const stageId = 'stage-' + suffix;
  db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, status, priority, created_by, created_at, updated_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(taskId, workspaceId, 'Task ' + suffix, 'open', 'normal', 'test', NOW, NOW);
  db.prepare(
    'INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, created_by, created_at, updated_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(runId, workspaceId, taskId, runId, 'queued', 'initial', 'v2_api', 'test', NOW, NOW);
  db.prepare(
    'INSERT INTO run_snapshots (id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version,'
      + ' snapshot_json, content_hash, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    snapshotId, workspaceId, runId, 'workflow_00000000000000000000000002',
    1, '{}', 'a'.repeat(64), NOW,
  );
  db.prepare(
    'INSERT INTO run_stages (id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name, sequence,'
      + ' attempt, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(stageId, workspaceId, runId, snapshotId, 'plan', 'Plan', 1, 1, 'pending', NOW, NOW, 1);
  return runId;
}

function seedConversation(fx: Fixture, workspaceId: string, conversationId: string, agentId: string): void {
  fx.store.createConversation({
    id: conversationId,
    workspaceId,
    type: 'direct',
    title: conversationId,
    agentId,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function seedLegacyRun(
  fx: Fixture,
  workspaceId: string,
  conversationId: string,
  runId: string,
  agentId: string,
): void {
  const messageId = 'message-' + runId;
  fx.store.createMessage({
    id: messageId,
    conversationId,
    workspaceId,
    senderType: 'user',
    content: runId,
    createdAt: NOW,
  });
  fx.store.createRun({
    id: runId,
    workspaceId,
    conversationId,
    sourceMessageId: messageId,
    objective: runId,
    status: 'completed',
    createdAt: NOW,
    updatedAt: NOW,
  });
  fx.store.createExecution({
    id: 'execution-' + runId,
    runId,
    conversationId,
    workspaceId,
    sourceMessageId: messageId,
    agentId,
    status: 'completed',
    mode: 'real',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function insertAdmission(
  fx: Fixture,
  input: {
    id: string;
    workspaceId: string;
    requestOrder: number;
    subjectKind: 'CANONICAL_RUN' | 'LEGACY_AGENT_RUN';
    subjectId: string;
  },
): void {
  fx.admissions.insertAdmission({
    id: input.id,
    workspaceId: input.workspaceId,
    subjectKind: input.subjectKind,
    canonicalRunId: input.subjectKind === 'CANONICAL_RUN' ? input.subjectId : null,
    legacyRunId: input.subjectKind === 'LEGACY_AGENT_RUN' ? input.subjectId : null,
    requestedMutationClass: 'MODIFYING',
    effectiveMutationClass: 'MODIFYING',
    enforcementEvidenceJson: null,
    requestOrder: input.requestOrder,
    state: 'REQUESTED',
    queueReason: null,
    releaseReason: null,
    requestedAt: NOW,
    grantedAt: null,
    releasedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
  });
}

function insertObservation(
  fx: Fixture,
  input: {
    id: string;
    workspaceId: string;
    admissionId?: string;
    subjectKind?: 'CANONICAL_RUN' | 'LEGACY_AGENT_RUN';
    subjectId?: string;
    diffArtifactId?: string;
  },
): void {
  const canonical = input.subjectKind === 'CANONICAL_RUN';
  const legacy = input.subjectKind === 'LEGACY_AGENT_RUN';
  fx.observations.insertObservation({
    id: input.id,
    workspaceId: input.workspaceId,
    admissionId: input.admissionId ?? null,
    subjectKind: input.subjectKind ?? null,
    canonicalRunId: canonical ? input.subjectId ?? null : null,
    legacyRunId: legacy ? input.subjectId ?? null : null,
    observationState: 'GIT',
    repositoryRoot: '/repo/' + input.workspaceId,
    baseCommitSha: 'c'.repeat(40),
    dirtyState: 'clean',
    statusSummaryJson: '{}',
    changedFilesJson: '[]',
    diffArtifactId: input.diffArtifactId ?? null,
    cwd: '/repo/' + input.workspaceId,
    errorCode: null,
    observedAt: NOW,
    createdAt: NOW,
  });
}

function insertCanonicalArtifact(
  fx: Fixture,
  workspaceId: string,
  runId: string,
  artifactId: string,
): void {
  fx.store.createCanonicalRuntimeArtifact({
    id: artifactId,
    workspaceId,
    type: 'diff',
    title: artifactId,
    sizeBytes: 1,
    sha256: 'd'.repeat(64),
    contentAvailable: true,
    createdAt: NOW,
  }, { kind: 'CANONICAL', canonicalRunId: runId }, 'sink/' + artifactId);
}

function count(fx: Fixture, table: string, column: string, value: string): number {
  const row = fx.store.getDatabase()
    .prepare('SELECT COUNT(*) AS count FROM ' + table + ' WHERE ' + column + ' = ?')
    .get(value) as { count: number };
  return row.count;
}

function assertDatabaseHealthy(fx: Fixture): void {
  const db = fx.store.getDatabase();
  assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(
    (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check,
    'ok',
  );
}

test('deleteWorkspace removes a canonical Artifact and workspace-only Git Observation before the Workspace', () => {
  const fx = createFixture();
  try {
    const runId = seedCanonicalRun(fx, 'ws-a', 'ws-a-artifact');
    insertCanonicalArtifact(fx, 'ws-a', runId, 'diff-ws-a');
    insertObservation(fx, {
      id: 'obs-workspace-only-a',
      workspaceId: 'ws-a',
      diffArtifactId: 'diff-ws-a',
    });

    fx.store.deleteWorkspace('ws-a');

    assert.equal(count(fx, 'runtime_artifacts', 'workspace_id', 'ws-a'), 0);
    assert.equal(count(fx, 'workspace_git_observations', 'workspace_id', 'ws-a'), 0);
    assert.equal(count(fx, 'workspaces', 'id', 'ws-a'), 0);
    assert.equal(count(fx, '_workspace_tombstones', 'workspace_id', 'ws-a'), 1);
    assertDatabaseHealthy(fx);
  } finally {
    fx.close();
  }
});

test('deleteWorkspace removes canonical and legacy Admissions after their bound Observations', () => {
  const fx = createFixture();
  try {
    const canonicalRunId = seedCanonicalRun(fx, 'ws-a', 'ws-a-admission');
    insertCanonicalArtifact(fx, 'ws-a', canonicalRunId, 'diff-complete-ws-a');
    seedConversation(fx, 'ws-a', 'conversation-ws-a', 'agent-a');
    seedLegacyRun(fx, 'ws-a', 'conversation-ws-a', 'legacy-run-ws-a', 'agent-a');
    insertAdmission(fx, {
      id: 'admission-canonical-a',
      workspaceId: 'ws-a',
      requestOrder: 1,
      subjectKind: 'CANONICAL_RUN',
      subjectId: canonicalRunId,
    });
    insertAdmission(fx, {
      id: 'admission-legacy-a',
      workspaceId: 'ws-a',
      requestOrder: 2,
      subjectKind: 'LEGACY_AGENT_RUN',
      subjectId: 'legacy-run-ws-a',
    });
    insertObservation(fx, {
      id: 'obs-workspace-complete-a',
      workspaceId: 'ws-a',
      diffArtifactId: 'diff-complete-ws-a',
    });
    insertObservation(fx, {
      id: 'obs-canonical-a',
      workspaceId: 'ws-a',
      admissionId: 'admission-canonical-a',
      subjectKind: 'CANONICAL_RUN',
      subjectId: canonicalRunId,
    });
    insertObservation(fx, {
      id: 'obs-legacy-a',
      workspaceId: 'ws-a',
      admissionId: 'admission-legacy-a',
      subjectKind: 'LEGACY_AGENT_RUN',
      subjectId: 'legacy-run-ws-a',
    });

    fx.store.deleteWorkspace('ws-a');

    assert.equal(count(fx, 'workspace_git_observations', 'workspace_id', 'ws-a'), 0);
    assert.equal(count(fx, 'workspace_admissions', 'workspace_id', 'ws-a'), 0);
    assert.equal(count(fx, 'runtime_artifacts', 'workspace_id', 'ws-a'), 0);
    assert.equal(count(fx, 'workspaces', 'id', 'ws-a'), 0);
    assert.equal(count(fx, '_workspace_tombstones', 'workspace_id', 'ws-a'), 1);
    assertDatabaseHealthy(fx);
  } finally {
    fx.close();
  }
});

test('deleteWorkspace preserves another Workspace L1B data', () => {
  const fx = createFixture();
  try {
    const runA = seedCanonicalRun(fx, 'ws-a', 'isolation-a');
    const runB = seedCanonicalRun(fx, 'ws-b', 'isolation-b');
    insertAdmission(fx, {
      id: 'admission-isolation-a',
      workspaceId: 'ws-a',
      requestOrder: 1,
      subjectKind: 'CANONICAL_RUN',
      subjectId: runA,
    });
    insertAdmission(fx, {
      id: 'admission-isolation-b',
      workspaceId: 'ws-b',
      requestOrder: 1,
      subjectKind: 'CANONICAL_RUN',
      subjectId: runB,
    });
    insertObservation(fx, {
      id: 'obs-isolation-a',
      workspaceId: 'ws-a',
      admissionId: 'admission-isolation-a',
      subjectKind: 'CANONICAL_RUN',
      subjectId: runA,
    });
    insertObservation(fx, {
      id: 'obs-isolation-b',
      workspaceId: 'ws-b',
      admissionId: 'admission-isolation-b',
      subjectKind: 'CANONICAL_RUN',
      subjectId: runB,
    });

    fx.store.deleteWorkspace('ws-a');

    assert.equal(count(fx, 'workspace_admissions', 'workspace_id', 'ws-a'), 0);
    assert.equal(count(fx, 'workspace_git_observations', 'workspace_id', 'ws-a'), 0);
    assert.equal(count(fx, 'workspace_admissions', 'workspace_id', 'ws-b'), 1);
    assert.equal(count(fx, 'workspace_git_observations', 'workspace_id', 'ws-b'), 1);
    assert.equal(count(fx, 'workspaces', 'id', 'ws-b'), 1);
    assertDatabaseHealthy(fx);
  } finally {
    fx.close();
  }
});

test('deleteConversation removes only that Conversation legacy Admissions and bound Observations', () => {
  const fx = createFixture();
  try {
    seedConversation(fx, 'ws-a', 'conversation-delete', 'agent-a');
    seedConversation(fx, 'ws-a', 'conversation-keep', 'agent-a');
    seedLegacyRun(fx, 'ws-a', 'conversation-delete', 'legacy-run-delete', 'agent-a');
    seedLegacyRun(fx, 'ws-a', 'conversation-keep', 'legacy-run-keep', 'agent-a');
    insertAdmission(fx, {
      id: 'admission-delete',
      workspaceId: 'ws-a',
      requestOrder: 1,
      subjectKind: 'LEGACY_AGENT_RUN',
      subjectId: 'legacy-run-delete',
    });
    insertAdmission(fx, {
      id: 'admission-keep',
      workspaceId: 'ws-a',
      requestOrder: 2,
      subjectKind: 'LEGACY_AGENT_RUN',
      subjectId: 'legacy-run-keep',
    });
    insertObservation(fx, {
      id: 'obs-delete',
      workspaceId: 'ws-a',
      admissionId: 'admission-delete',
      subjectKind: 'LEGACY_AGENT_RUN',
      subjectId: 'legacy-run-delete',
    });
    insertObservation(fx, {
      id: 'obs-keep',
      workspaceId: 'ws-a',
      admissionId: 'admission-keep',
      subjectKind: 'LEGACY_AGENT_RUN',
      subjectId: 'legacy-run-keep',
    });

    fx.store.deleteConversation('ws-a', 'conversation-delete');

    assert.equal(fx.store.getRun('ws-a', 'legacy-run-delete'), undefined);
    assert.equal(fx.admissions.findById('ws-a', 'admission-delete'), undefined);
    assert.equal(fx.observations.findById('ws-a', 'obs-delete'), undefined);
    assert.ok(fx.store.getRun('ws-a', 'legacy-run-keep'));
    assert.ok(fx.admissions.findById('ws-a', 'admission-keep'));
    assert.ok(fx.observations.findById('ws-a', 'obs-keep'));
    assert.ok(fx.store.listConversations('ws-a').some(row => row.id === 'conversation-keep'));
    assertDatabaseHealthy(fx);
  } finally {
    fx.close();
  }
});

test('deleteRunData removes only the target legacy Run Admission and bound Observation', () => {
  const fx = createFixture();
  try {
    seedConversation(fx, 'ws-a', 'conversation-runs', 'agent-a');
    seedLegacyRun(fx, 'ws-a', 'conversation-runs', 'legacy-run-delete', 'agent-a');
    seedLegacyRun(fx, 'ws-a', 'conversation-runs', 'legacy-run-keep', 'agent-a');
    insertAdmission(fx, {
      id: 'admission-run-delete',
      workspaceId: 'ws-a',
      requestOrder: 1,
      subjectKind: 'LEGACY_AGENT_RUN',
      subjectId: 'legacy-run-delete',
    });
    insertAdmission(fx, {
      id: 'admission-run-keep',
      workspaceId: 'ws-a',
      requestOrder: 2,
      subjectKind: 'LEGACY_AGENT_RUN',
      subjectId: 'legacy-run-keep',
    });
    insertObservation(fx, {
      id: 'obs-run-delete',
      workspaceId: 'ws-a',
      admissionId: 'admission-run-delete',
      subjectKind: 'LEGACY_AGENT_RUN',
      subjectId: 'legacy-run-delete',
    });
    insertObservation(fx, {
      id: 'obs-run-keep',
      workspaceId: 'ws-a',
      admissionId: 'admission-run-keep',
      subjectKind: 'LEGACY_AGENT_RUN',
      subjectId: 'legacy-run-keep',
    });

    fx.store.deleteRunData('ws-a', 'legacy-run-delete');

    assert.equal(fx.store.getRun('ws-a', 'legacy-run-delete'), undefined);
    assert.equal(fx.admissions.findById('ws-a', 'admission-run-delete'), undefined);
    assert.equal(fx.observations.findById('ws-a', 'obs-run-delete'), undefined);
    assert.ok(fx.store.getRun('ws-a', 'legacy-run-keep'));
    assert.ok(fx.admissions.findById('ws-a', 'admission-run-keep'));
    assert.ok(fx.observations.findById('ws-a', 'obs-run-keep'));
    assertDatabaseHealthy(fx);
  } finally {
    fx.close();
  }
});
