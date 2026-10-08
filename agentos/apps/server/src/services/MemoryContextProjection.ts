import type { TransactionDatabase } from '../store/Transaction.js';
import { MemoryContextSnapshotRepository } from '../store/MemoryContextSnapshotRepository.js';
import { MemoryExecutionContextRepository } from '../store/MemoryExecutionContextRepository.js';
import { TurnContextSnapshotRepository } from '../store/TurnContextSnapshotRepository.js';

export const MEMORY_CONTEXT_KINDS = ['run','stage','turn','legacy-execution'] as const;
export type MemoryContextKind = typeof MEMORY_CONTEXT_KINDS[number];

/** Read-only projection; identities remain in their original aggregate stores. */
export function listMemoryContexts(db: TransactionDatabase, workspaceId: string, kind?: MemoryContextKind, ownerId?: string) {
  const runs = new MemoryContextSnapshotRepository(db);
  const executions = new MemoryExecutionContextRepository(db);
  const turns = new TurnContextSnapshotRepository(db);
  const result: Record<string, unknown>[] = [];
  if (!kind || kind === 'run' || kind === 'stage') {
    const rows = db.prepare(`SELECT id,run_id,stage_id FROM memory_context_snapshots WHERE workspace_id=?
      ${kind === 'run' ? 'AND stage_id IS NULL' : kind === 'stage' ? 'AND stage_id IS NOT NULL' : ''}
      ${ownerId ? 'AND (stage_id=? OR run_id=?)' : ''} ORDER BY created_at DESC,id LIMIT 100`)
      .all(workspaceId,...(ownerId ? [ownerId,ownerId] : [])) as { id:string; run_id:string; stage_id:string|null }[];
    for (const row of rows) {
      const rowKind = row.stage_id === null ? 'run' : 'stage';
      const rowOwner = row.stage_id ?? row.run_id;
      if ((kind && kind !== rowKind) || (ownerId && ownerId !== rowOwner && ownerId !== row.run_id)) continue;
      const record = runs.findById(workspaceId,row.id)!;
      const contextText = runs.readContextText(workspaceId,row.id);
      result.push({ ...record, kind:rowKind, ownerId:rowOwner, contextText:contextText??null,payloadAvailable:contextText!==undefined });
    }
  }
  if (!kind || kind === 'turn') {
    const rows = db.prepare(`SELECT id,turn_id FROM cr_turn_context_snapshots WHERE workspace_id=?
      ${ownerId ? 'AND turn_id=?' : ''} ORDER BY created_at DESC,id LIMIT 100`)
      .all(workspaceId,...(ownerId ? [ownerId] : [])) as { id:string; turn_id:string|null }[];
    for (const row of rows) {
      if (ownerId && ownerId !== row.turn_id) continue;
      const record = turns.findById(workspaceId,row.id)!;
      const payload = turns.readPayload(workspaceId,row.id);
      result.push({ ...record, ...payload,kind:'turn', ownerId:row.turn_id,payloadAvailable:payload!==undefined,contextText:payload?.contextText??null });
    }
  }
  if (!kind || kind === 'legacy-execution') {
    const rows = db.prepare(`SELECT execution_id FROM memory_execution_contexts WHERE workspace_id=?
      ${ownerId ? 'AND execution_id=?' : ''} ORDER BY created_at DESC,id LIMIT 100`)
      .all(workspaceId,...(ownerId ? [ownerId] : [])) as { execution_id:string }[];
    for (const row of rows) {
      if (ownerId && ownerId !== row.execution_id) continue;
      result.push({ ...executions.findForExecution(workspaceId,row.execution_id)!,kind:'legacy-execution',ownerId:row.execution_id,payloadAvailable:true });
    }
  }
  return result.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))||String(a.id).localeCompare(String(b.id))).slice(0,100);
}
