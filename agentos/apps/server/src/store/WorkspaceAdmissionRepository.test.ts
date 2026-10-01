import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { MigrationRegistry } from '../migrations/registry.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import { WorkspaceAdmissionRepository } from './WorkspaceAdmissionRepository.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => MinimalDatabaseSync & { close(): void };
};

const NOW = '2026-09-30T00:00:00.000Z';

function insertWorkspace(db: MinimalDatabaseSync, id: string): void {
  db.prepare('INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, id, `C:/${id}`, `C:/${id}`, NOW, NOW, NOW);
}

function insertApplyControl(db: MinimalDatabaseSync, workspaceId: string, controlId: string): void {
  const taskId = `collab_${controlId}`;
  db.prepare('INSERT INTO collaboration_tasks (id, workspace_id, title, objective, scope_json, acceptance_commands_json, planner_agent_id, implementer_agent_id, reviewer_agent_id, status, plan_hash, base_commit, control_epoch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
    .run(taskId, workspaceId, 'Apply', 'Apply candidate', '[]', '[]', 'planner', 'implementer', 'reviewer', 'awaiting_application', 'plan-hash', 'base-sha', NOW, NOW);
  db.prepare("INSERT INTO collaboration_controls (id, workspace_id, collaboration_task_id, action, idempotency_key, request_hash, expected_version, epoch, state, created_at, updated_at) VALUES (?, ?, ?, 'apply', ?, ?, 1, 1, 'reserved', ?, ?)")
    .run(controlId, workspaceId, taskId, `key_${controlId}`, `hash_${controlId}`, NOW, NOW);
}

test('WorkspaceAdmissionRepository round-trips a workspace-scoped application subject', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
    insertWorkspace(db, 'ws_repo_admission');
    insertWorkspace(db, 'ws_repo_other');
    insertApplyControl(db, 'ws_repo_admission', 'control_repo_apply');

    const repository = new WorkspaceAdmissionRepository(db);
    const row = {
      id: 'admission_repo_apply',
      workspaceId: 'ws_repo_admission',
      subjectKind: 'COLLABORATION_APPLICATION' as const,
      canonicalRunId: null,
      legacyRunId: null,
      collaborationControlId: 'control_repo_apply',
      requestedMutationClass: 'MODIFYING' as const,
      effectiveMutationClass: 'MODIFYING' as const,
      enforcementEvidenceJson: null,
      requestOrder: 1,
      state: 'REQUESTED' as const,
      queueReason: null,
      releaseReason: null,
      requestedAt: NOW,
      grantedAt: null,
      releasedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
    };
    repository.insertAdmission(row);

    assert.deepEqual(repository.findById(row.workspaceId, row.id), row);
    assert.deepEqual(repository.findBySubject(row.workspaceId, {
      subjectKind: 'COLLABORATION_APPLICATION',
      controlId: 'control_repo_apply',
    }), row);
    assert.equal(repository.findBySubject('ws_repo_other', {
      subjectKind: 'COLLABORATION_APPLICATION',
      controlId: 'control_repo_apply',
    }), undefined);
    assert.deepEqual(repository.listByWorkspace(row.workspaceId), [row]);
    assert.throws(() => repository.insertAdmission({ ...row, id: 'admission_repo_apply_duplicate', requestOrder: 2 }));
    assert.throws(() => db.prepare('UPDATE workspace_admissions SET collaboration_control_id = ? WHERE id = ?')
      .run('another_control', row.id));
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});
