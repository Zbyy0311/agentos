import { createHash } from 'node:crypto';
import type { Migration } from '../types.js';

export const MEMORY_EXECUTION_043_DDL = [
  `CREATE TABLE IF NOT EXISTS memory_execution_contexts (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, run_id TEXT NOT NULL,
    execution_id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    query_hash TEXT NOT NULL, strategy_version TEXT NOT NULL,
    context_text TEXT NOT NULL, content_sha256 TEXT NOT NULL,
    selected_json TEXT NOT NULL CHECK(json_valid(selected_json)),
    exclusions_json TEXT NOT NULL CHECK(json_valid(exclusions_json)),
    total_tokens INTEGER NOT NULL CHECK(total_tokens >= 0),
    truncated INTEGER NOT NULL CHECK(truncated IN (0,1)),
    retrieval_degraded INTEGER NOT NULL CHECK(retrieval_degraded IN (0,1)), created_at TEXT NOT NULL,
    FOREIGN KEY(execution_id) REFERENCES executions(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS memory_execution_contexts_workspace_run ON memory_execution_contexts(workspace_id,run_id,created_at,id)`,
  `CREATE TRIGGER IF NOT EXISTS memory_execution_contexts_immutable BEFORE UPDATE ON memory_execution_contexts BEGIN
    SELECT RAISE(ABORT,'MEMORY_EXECUTION_CONTEXT_IMMUTABLE'); END`,
  // Workspace deletion owns execution deletion. Ordinary writes never remove contexts.
  `CREATE TRIGGER IF NOT EXISTS memory_execution_contexts_no_delete BEFORE DELETE ON memory_execution_contexts
    WHEN EXISTS(SELECT 1 FROM executions WHERE id=OLD.execution_id) BEGIN
    SELECT RAISE(ABORT,'MEMORY_EXECUTION_CONTEXT_IMMUTABLE'); END`,
];
export const migration043: Migration = {
  id: '043', name: 'memory-execution-contexts', destructive: false,
  checksum: createHash('sha256').update(MEMORY_EXECUTION_043_DDL.join('\n')).digest('hex').slice(0,16),
  apply({ db }) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='executions' AND type='table'").get()) {
      throw new Error('MIGRATION_PREREQUISITE_MISSING: 043 requires executions');
    }
    for (const ddl of MEMORY_EXECUTION_043_DDL) db.prepare(ddl).run();
  },
};
