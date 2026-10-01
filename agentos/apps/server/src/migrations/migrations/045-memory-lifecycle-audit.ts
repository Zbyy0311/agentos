import { createHash } from 'node:crypto';
import type { Migration } from '../types.js';
export const MEMORY_045_DDL = [
  `CREATE TABLE IF NOT EXISTS memory_lifecycle_actions (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, entry_id TEXT NOT NULL,
    action TEXT NOT NULL, from_version INTEGER NOT NULL, to_version INTEGER NOT NULL,
    before_json TEXT NOT NULL, after_json TEXT NOT NULL, created_at TEXT NOT NULL,
    FOREIGN KEY(entry_id) REFERENCES memory_entries(id), UNIQUE(entry_id,to_version))`,
  `CREATE INDEX IF NOT EXISTS memory_lifecycle_workspace ON memory_lifecycle_actions(workspace_id,created_at)`,
  `CREATE TRIGGER IF NOT EXISTS memory_lifecycle_immutable BEFORE UPDATE ON memory_lifecycle_actions
    BEGIN SELECT RAISE(ABORT,'MEMORY_LIFECYCLE_IMMUTABLE'); END`,
  `CREATE TRIGGER IF NOT EXISTS memory_lifecycle_no_delete BEFORE DELETE ON memory_lifecycle_actions
    BEGIN SELECT RAISE(ABORT,'MEMORY_LIFECYCLE_IMMUTABLE'); END`,
] as const;
export const migration045: Migration = {id:'045',name:'memory-lifecycle-audit',destructive:false,
  checksum:createHash('sha256').update(MEMORY_045_DDL.join('\n')).digest('hex').slice(0,16),
  apply({db}) {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE name='memory_entries'").get()) throw new Error('MIGRATION_PREREQUISITE_MISSING: 045 requires memory_entries');
    for(const ddl of MEMORY_045_DDL) db.prepare(ddl).run();
  }};
