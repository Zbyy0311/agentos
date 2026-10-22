import { createEntityId } from './Identity.js';
import type { TransactionDatabase } from './Transaction.js';
import { M3_013_LEGACY_WORKFLOW_V2_ID } from '../migrations/migrations/013-workflow-creation-metadata-v2.js';

/** Canonical Run/Stage/Operation evidence used by productization acceptance tests. */
export function seedApprovalRun(db: TransactionDatabase, workspaceId: string, now: string, sourceConversationId?: string) {
  const taskId = createEntityId('task');
  const runId = createEntityId('run');
  const snapshotId = `snapshot_${runId}`;
  const stageId = `stage_${runId}`;
  const operationId = createEntityId('operation');
  db.prepare(`INSERT INTO tasks (id,workspace_id,title,status,priority,created_by,source_conversation_id,created_at,updated_at)
    VALUES (?,?,'approval test','open','normal','test',?,?,?)`).run(taskId, workspaceId, sourceConversationId ?? null, now, now);
  db.prepare(`INSERT INTO runs (id,workspace_id,task_id,root_run_id,status,reason,origin,created_by,created_at,updated_at)
    VALUES (?,?,?,?,'running','initial','v2_api','test',?,?)`).run(runId, workspaceId, taskId, runId, now, now);
  db.prepare(`INSERT INTO run_snapshots (id,workspace_id,run_id,workflow_definition_id,snapshot_schema_version,snapshot_json,content_hash,captured_at)
    VALUES (?,?,?,?,2,'{}',?,?)`).run(snapshotId, workspaceId, runId, M3_013_LEGACY_WORKFLOW_V2_ID, 'a'.repeat(64), now);
  db.prepare(`INSERT INTO run_stages (id,workspace_id,run_id,run_snapshot_id,workflow_stage_key,name,sequence,attempt,status,created_at,updated_at)
    VALUES (?,?,?,?,'execute','Execute',1,1,'running',?,?)`).run(stageId, workspaceId, runId, snapshotId, now, now);
  db.prepare(`INSERT INTO operations (id,type,status,workspace_id,aggregate_type,aggregate_id,run_id,correlation_id,created_at,updated_at)
    VALUES (?,'run.start','completed',?,'run',?,?,?,?,?)`).run(operationId, workspaceId, runId, runId, operationId, now, now);
  return {
    id: createEntityId('approval'), workspaceId, taskId, runId, runSnapshotId: snapshotId, stageId, stageAttempt: 1,
    operationId, sourceKey: `source:${runId}`, requestRound: 1, category: 'command', riskLevel: 'high' as const,
    title: 'Approve provider execution', description: 'Canonical approval fixture',
    actionFingerprint: 'a'.repeat(64), agentSnapshotHash: 'c'.repeat(64), providerSnapshotHash: 'd'.repeat(64),
    launchPlanHash: 'e'.repeat(64), requestSnapshotJson: '{}', snapshotHash: 'b'.repeat(64), policyVersion: 'lite-v1',
    requestedAt: now, expiresAt: new Date(Date.parse(now) + 300000).toISOString(), createdAt: now, updatedAt: now,
  };
}
