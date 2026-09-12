import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from './SqliteStore.js';
import { inTransaction } from './Transaction.js';
import { RuntimeApprovalRepository, RuntimeApprovalRepositoryError } from './RuntimeApprovalRepository.js';
import { ApprovalDecisionRepository } from './ApprovalDecisionRepository.js';
import { M3_013_LEGACY_WORKFLOW_V2_ID } from '../migrations/migrations/013-workflow-creation-metadata-v2.js';

const NOW = '2026-09-12T10:30:00.000Z';
const LATER = '2026-09-12T10:31:00.000Z';
const WS = 'ws_approval_028';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-runtime-approval-'));
  const store = new SqliteStore(root);
  const db = store.getDatabase();
  db.prepare("INSERT INTO workspaces (id,name,root_path,canonical_root_path,last_opened_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(WS, WS, root, root, NOW, NOW, NOW);
  db.prepare("INSERT INTO tasks (id,workspace_id,title,status,priority,created_by,created_at,updated_at) VALUES ('task',?,'approval','open','normal','test',?,?)")
    .run(WS, NOW, NOW);
  db.prepare("INSERT INTO runs (id,workspace_id,task_id,root_run_id,status,reason,origin,created_by,created_at,updated_at) VALUES ('run',?,'task','run','running','initial','v2_api','test',?,?)")
    .run(WS, NOW, NOW);
  db.prepare("INSERT INTO run_snapshots (id,workspace_id,run_id,workflow_definition_id,snapshot_schema_version,snapshot_json,content_hash,captured_at) VALUES ('snapshot',?,'run',?,2,'{}',?,?)")
    .run(WS, M3_013_LEGACY_WORKFLOW_V2_ID, 'a'.repeat(64), NOW);
  db.prepare("INSERT INTO run_stages (id,workspace_id,run_id,run_snapshot_id,workflow_stage_key,name,sequence,attempt,status,created_at,updated_at) VALUES ('stage',?,'run','snapshot','execute','Execute',1,1,'running',?,?)")
    .run(WS, NOW, NOW);
  db.prepare("INSERT INTO operations (id,type,status,workspace_id,aggregate_type,aggregate_id,run_id,correlation_id,created_at,updated_at) VALUES ('operation','run.start','completed',?,'run','run','run','operation',?,?)")
    .run(WS, NOW, NOW);
  const approvals = new RuntimeApprovalRepository(db);
  return { root, store, db, approvals, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

function input(round = 1) {
  return {
    id: `approval_${round}`, workspaceId: WS, runId: 'run', runSnapshotId: 'snapshot', stageId: 'stage', stageAttempt: 1,
    operationId: 'operation', sourceKey: 'source', requestRound: round, category: 'command', riskLevel: 'high' as const,
    title: 'Approve provider execution', description: 'Provider may modify the Workspace',
    actionFingerprint: 'a'.repeat(64), agentSnapshotHash: 'c'.repeat(64), providerSnapshotHash: 'd'.repeat(64),
    launchPlanHash: 'e'.repeat(64), requestSnapshotJson: JSON.stringify({ schemaVersion: 1, executable: 'kimi.exe' }),
    snapshotHash: 'b'.repeat(64), policyVersion: 'lite-v1', requestedAt: NOW,
    expiresAt: '2026-09-12T10:35:00.000Z', createdAt: NOW, updatedAt: NOW,
  };
}

test('LITE-08-005/006: request creation, source proof, replay uniqueness and decision CAS', () => {
  const fx = fixture();
  try {
    const created = inTransaction(fx.db, () => fx.approvals.createWithinTransaction(input()));
    assert.equal(created.status, 'pending');
    assert.equal(created.version, 1);
    assert.throws(() => inTransaction(fx.db, () => fx.approvals.createWithinTransaction(input())), /RUNTIME_APPROVAL_CONFLICT/);
    assert.throws(() => inTransaction(fx.db, () => fx.approvals.createWithinTransaction({ ...input(2), id: 'approval_bad', operationId: 'missing' })), /RUNTIME_APPROVAL_SOURCE_INVALID/);
    const decisions = new ApprovalDecisionRepository(fx.db);
    const decision = decisions.recordDecision({
      id: 'decision', workspaceId: WS, runId: 'run', approvalRequestId: created.id, agentId: 'agent', provider: 'kimicode',
      toolName: 'provider.stage', actionFingerprint: created.actionFingerprint, riskLevel: 'high', decision: 'allow_once',
      decidedBy: 'user', decidedAt: LATER, createdAt: LATER,
    });
    const approved = inTransaction(fx.db, () => fx.approvals.markDecisionWithinTransaction({
      workspaceId: WS, id: created.id, expectedVersion: 1, now: LATER, status: 'approved', resolution: 'approve_once',
      decisionRecordId: decision.id, decidedBy: 'user', decidedAt: LATER,
    }));
    assert.equal(approved.status, 'approved');
    assert.equal(approved.version, 2);
    assert.throws(() => inTransaction(fx.db, () => fx.approvals.markDecisionWithinTransaction({
      workspaceId: WS, id: created.id, expectedVersion: 1, now: LATER, status: 'rejected', resolution: 'reject',
      decisionRecordId: decision.id, decidedBy: 'other', decidedAt: LATER,
    })), /RUNTIME_APPROVAL_CONFLICT/);
    const consumed = inTransaction(fx.db, () => fx.approvals.markConsumedWithinTransaction({
      workspaceId: WS, id: created.id, expectedVersion: 2, consumedAt: '2026-09-12T10:32:00.000Z',
    }));
    assert.equal(consumed.consumedAt, '2026-09-12T10:32:00.000Z');
    assert.throws(() => fx.db.prepare("UPDATE runtime_approval_requests SET snapshot_hash = ? WHERE id = ?").run('c'.repeat(64), created.id), /RUNTIME_APPROVAL_IDENTITY_IMMUTABLE/);
  } finally { fx.close(); }
});

test('LITE-08-007: expiry is durable and a consumed/expired action requires the next round', () => {
  const fx = fixture();
  try {
    const first = inTransaction(fx.db, () => fx.approvals.createWithinTransaction(input()));
    const expired = inTransaction(fx.db, () => fx.approvals.markExpiredWithinTransaction({
      workspaceId: WS, id: first.id, expectedVersion: 1, now: '2026-09-12T10:36:00.000Z',
    }));
    assert.equal(expired.status, 'expired');
    assert.throws(() => inTransaction(fx.db, () => fx.approvals.markExpiredWithinTransaction({
      workspaceId: WS, id: first.id, expectedVersion: 2, now: '2026-09-12T10:37:00.000Z',
    })), /RUNTIME_APPROVAL_CONFLICT/);
    const second = inTransaction(fx.db, () => fx.approvals.createWithinTransaction({ ...input(2), id: 'approval_2' }));
    assert.equal(second.requestRound, 2);
    assert.equal(fx.approvals.findLatestBySourceKey(WS, 'source')?.id, second.id);
  } finally { fx.close(); }
});
