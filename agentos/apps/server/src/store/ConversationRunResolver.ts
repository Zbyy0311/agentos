import type { TransactionDatabase } from './Transaction.js';

/** Read durable forward-runtime associations only, always inside the Workspace. */
export function conversationIdsForRun(db: TransactionDatabase, workspaceId: string, runId: string): string[] {
  const hasTable = (name: string) => db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name) !== undefined;
  if (!hasTable('cr_conversations')) return [];
  const queries: string[] = [];
  if (hasTable('cr_messages')) queries.push(`
    SELECT conversation_id FROM cr_messages WHERE workspace_id = ? AND run_id = ?
  `);
  if (hasTable('cr_agent_turns')) queries.push(`
    SELECT conversation_id FROM cr_agent_turns WHERE workspace_id = ? AND run_id = ?
  `);
  if (hasTable('runtime_events')) queries.push(`
    SELECT conversation_id FROM runtime_events WHERE workspace_id = ? AND run_id = ? AND conversation_id IS NOT NULL
  `);
  if (hasTable('runs') && hasTable('tasks')) {
    queries.push(`
      SELECT task.source_conversation_id AS conversation_id FROM runs run
      JOIN tasks task ON task.id = run.task_id AND task.workspace_id = run.workspace_id
      WHERE run.workspace_id = ? AND run.id = ?
    `);
    if (hasTable('cr_messages')) queries.push(`
      SELECT message.conversation_id FROM runs run
      JOIN cr_messages message ON message.task_id = run.task_id AND message.workspace_id = run.workspace_id
      WHERE run.workspace_id = ? AND run.id = ?
    `);
  }
  if (queries.length === 0) return [];
  return (db.prepare(`
    SELECT DISTINCT conversation.id FROM cr_conversations conversation
    JOIN (${queries.join(' UNION ')}) binding ON binding.conversation_id = conversation.id
    WHERE conversation.workspace_id = ? ORDER BY conversation.id
  `).all(...queries.flatMap(() => [workspaceId, runId]), workspaceId) as Array<{ id: string }>).map(row => row.id);
}
