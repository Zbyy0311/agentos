import { createHash } from 'node:crypto';
import { isMemoryTextSafe } from './MemoryContentSafety.js';
import { inTransaction, type TransactionDatabase } from './Transaction.js';

export interface ExecutionMemorySelection {
  readonly memoryId: string;
  readonly memoryVersion: number | null;
  readonly store: 'canonical' | 'legacy';
  readonly rank: number;
  readonly reasons: readonly string[];
  readonly tokenCost: number;
}
export interface ExecutionMemoryContextInput {
  readonly workspaceId: string; readonly runId: string; readonly executionId: string;
  readonly conversationId: string; readonly agentId: string;
  readonly contextText: string; readonly queryHash: string;
  readonly selected: readonly ExecutionMemorySelection[];
  readonly exclusions: readonly { memoryId: string; reason: string }[];
  readonly retrievalDegraded: boolean; readonly truncated: boolean; readonly createdAt: string;
}
export interface ExecutionMemoryContextRecord extends ExecutionMemoryContextInput {
  readonly id: string; readonly totalTokens: number; readonly retrievalStrategyVersion: string;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export class MemoryExecutionContextRepository {
  constructor(private readonly db: TransactionDatabase) {}

  freeze(input: ExecutionMemoryContextInput): ExecutionMemoryContextRecord {
    return inTransaction(this.db, () => {
      const owner = this.db.prepare('SELECT run_id,workspace_id,conversation_id,agent_id FROM executions WHERE id=?').get(input.executionId) as { run_id: string; workspace_id: string; conversation_id: string; agent_id: string } | undefined;
      if (!owner || owner.workspace_id !== input.workspaceId || owner.run_id !== input.runId
        || owner.conversation_id !== input.conversationId || owner.agent_id !== input.agentId) {
        throw new Error('MEMORY_EXECUTION_CONTEXT_OWNER_INVALID');
      }
      const existing = this.findForExecution(input.workspaceId, input.executionId);
      if (existing) return existing;
      if (!/^[a-f0-9]{64}$/.test(input.queryHash) || input.contextText.length > 10000
        || !isMemoryTextSafe(input.contextText) || !isMemoryTextSafe(JSON.stringify([input.selected,input.exclusions]))) {
        throw new Error('MEMORY_EXECUTION_CONTEXT_INPUT_INVALID');
      }
      this.db.prepare(`INSERT INTO memory_execution_contexts
        (id,workspace_id,run_id,execution_id,conversation_id,agent_id,query_hash,strategy_version,
         context_text,content_sha256,selected_json,exclusions_json,total_tokens,truncated,retrieval_degraded,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        `mexec_${input.executionId}`,input.workspaceId,input.runId,input.executionId,input.conversationId,input.agentId,
        input.queryHash,'compat-memory.v2',input.contextText,hash(input.contextText),JSON.stringify(input.selected),
        JSON.stringify(input.exclusions),Math.ceil(input.contextText.length/4),input.truncated?1:0,input.retrievalDegraded?1:0,input.createdAt,
      );
      return this.findForExecution(input.workspaceId,input.executionId)!;
    });
  }

  findForExecution(workspaceId: string, executionId: string): ExecutionMemoryContextRecord | undefined {
    const row = this.db.prepare('SELECT * FROM memory_execution_contexts WHERE workspace_id=? AND execution_id=?').get(workspaceId,executionId) as Record<string,unknown> | undefined;
    if (!row) return undefined;
    const text = String(row.context_text);
    if (hash(text) !== row.content_sha256 || !isMemoryTextSafe(text)) throw new Error('MEMORY_EXECUTION_CONTEXT_CORRUPT');
    return { id:String(row.id), workspaceId:String(row.workspace_id), runId:String(row.run_id), executionId:String(row.execution_id),
      conversationId:String(row.conversation_id),agentId:String(row.agent_id),queryHash:String(row.query_hash),contextText:text,
      selected:JSON.parse(String(row.selected_json)),exclusions:JSON.parse(String(row.exclusions_json)),
      totalTokens:Number(row.total_tokens),truncated:row.truncated===1,retrievalDegraded:row.retrieval_degraded===1,
      retrievalStrategyVersion:String(row.strategy_version),createdAt:String(row.created_at) };
  }
}
