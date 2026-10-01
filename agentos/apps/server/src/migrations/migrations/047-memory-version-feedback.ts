import { createHash } from 'node:crypto';
import type { Migration } from '../types.js';

export const MEMORY_VERSION_FEEDBACK_047_DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS memory_version_feedback (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0),
    entry_id TEXT NOT NULL CHECK (length(entry_id) > 0),
    entry_version INTEGER NOT NULL CHECK (entry_version >= 1),
    current_entry_version INTEGER NOT NULL CHECK (current_entry_version >= 1),
    context_kind TEXT NOT NULL CHECK (context_kind IN ('run','stage','turn','legacy-execution')),
    context_id TEXT NOT NULL CHECK (length(context_id) > 0),
    context_hash TEXT NOT NULL CHECK (length(context_hash) = 64),
    kind TEXT NOT NULL CHECK (kind IN ('helpful','wrong','outdated')),
    comment TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    FOREIGN KEY (entry_id) REFERENCES memory_entries(id)
  )`,
  `CREATE INDEX IF NOT EXISTS memory_feedback_context
    ON memory_version_feedback(workspace_id,context_kind,context_id)`,
  `CREATE INDEX IF NOT EXISTS memory_feedback_entry
    ON memory_version_feedback(workspace_id,entry_id,created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS memory_feedback_actions (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    feedback_id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0),
    entry_id TEXT NOT NULL CHECK (length(entry_id) > 0),
    entry_version INTEGER NOT NULL CHECK (entry_version >= 1),
    action TEXT NOT NULL CHECK (action IN ('correction','revalidation')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','rejected')),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at TEXT NOT NULL,
    FOREIGN KEY (feedback_id) REFERENCES memory_version_feedback(id),
    FOREIGN KEY (entry_id) REFERENCES memory_entries(id)
  )`,
  `CREATE INDEX IF NOT EXISTS memory_feedback_actions_workspace
    ON memory_feedback_actions(workspace_id,status,created_at DESC)`,
  `CREATE TRIGGER IF NOT EXISTS memory_version_feedback_immutable
    BEFORE UPDATE ON memory_version_feedback BEGIN
    SELECT RAISE(ABORT,'MEMORY_FEEDBACK_IMMUTABLE'); END`,
  `CREATE TRIGGER IF NOT EXISTS memory_version_feedback_no_delete
    BEFORE DELETE ON memory_version_feedback BEGIN
    SELECT RAISE(ABORT,'MEMORY_FEEDBACK_IMMUTABLE'); END`,
  `CREATE TRIGGER IF NOT EXISTS memory_feedback_actions_transition_guard
    BEFORE UPDATE ON memory_feedback_actions
    WHEN NOT (
      OLD.status = 'pending' AND NEW.status IN ('resolved','rejected')
      AND NEW.version = OLD.version + 1
      AND NEW.id = OLD.id AND NEW.feedback_id = OLD.feedback_id
      AND NEW.workspace_id = OLD.workspace_id AND NEW.entry_id = OLD.entry_id
      AND NEW.entry_version = OLD.entry_version AND NEW.action = OLD.action
      AND NEW.created_at = OLD.created_at
    ) BEGIN SELECT RAISE(ABORT,'MEMORY_FEEDBACK_ACTION_TRANSITION_INVALID'); END`,
  `CREATE TRIGGER IF NOT EXISTS memory_feedback_actions_no_delete
    BEFORE DELETE ON memory_feedback_actions BEGIN
    SELECT RAISE(ABORT,'MEMORY_FEEDBACK_ACTION_IMMUTABLE'); END`,
  `CREATE TABLE IF NOT EXISTS memory_feedback_action_audit (
    id TEXT PRIMARY KEY CHECK (length(id) > 0),
    action_id TEXT NOT NULL,
    feedback_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0),
    entry_id TEXT NOT NULL CHECK (length(entry_id) > 0),
    entry_version INTEGER NOT NULL CHECK (entry_version >= 1),
    action TEXT NOT NULL CHECK (action IN ('correction','revalidation')),
    from_status TEXT NOT NULL CHECK (from_status = 'pending'),
    to_status TEXT NOT NULL CHECK (to_status IN ('resolved','rejected')),
    expected_version INTEGER NOT NULL CHECK (expected_version >= 1),
    version INTEGER NOT NULL CHECK (version = expected_version + 1),
    occurred_at TEXT NOT NULL,
    UNIQUE (action_id,version),
    FOREIGN KEY (action_id) REFERENCES memory_feedback_actions(id),
    FOREIGN KEY (feedback_id) REFERENCES memory_version_feedback(id)
  )`,
  `CREATE INDEX IF NOT EXISTS memory_feedback_action_audit_feedback
    ON memory_feedback_action_audit(workspace_id,feedback_id,version)`,
  `CREATE TRIGGER IF NOT EXISTS memory_feedback_action_audit_validate
    BEFORE INSERT ON memory_feedback_action_audit
    WHEN NOT EXISTS (
      SELECT 1 FROM memory_feedback_actions a
      WHERE a.id = NEW.action_id AND a.feedback_id = NEW.feedback_id
        AND a.workspace_id = NEW.workspace_id AND a.entry_id = NEW.entry_id
        AND a.entry_version = NEW.entry_version AND a.action = NEW.action
        AND a.status = NEW.to_status AND a.version = NEW.version
    ) BEGIN SELECT RAISE(ABORT,'MEMORY_FEEDBACK_ACTION_AUDIT_MISMATCH'); END`,
  `CREATE TRIGGER IF NOT EXISTS memory_feedback_action_audit_immutable
    BEFORE UPDATE ON memory_feedback_action_audit BEGIN
    SELECT RAISE(ABORT,'MEMORY_FEEDBACK_ACTION_AUDIT_IMMUTABLE'); END`,
  `CREATE TRIGGER IF NOT EXISTS memory_feedback_action_audit_no_delete
    BEFORE DELETE ON memory_feedback_action_audit BEGIN
    SELECT RAISE(ABORT,'MEMORY_FEEDBACK_ACTION_AUDIT_IMMUTABLE'); END`,
]);

export const migration047: Migration = {
  id: '047',
  name: 'memory-version-feedback',
  destructive: false,
  checksum: createHash('sha256').update(MEMORY_VERSION_FEEDBACK_047_DDL.join('\n')).digest('hex').slice(0, 16),
  apply({ db }) {
    for (const prerequisite of [
      'memory_entries',
      'memory_context_snapshots',
      'memory_execution_contexts',
      'cr_turn_context_snapshots',
      'cr_turn_memory_payloads',
    ]) {
      if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(prerequisite) === undefined) {
        throw new Error(`MIGRATION_PREREQUISITE_MISSING: 047 requires ${prerequisite}`);
      }
    }
    for (const sql of MEMORY_VERSION_FEEDBACK_047_DDL) db.prepare(sql).run();
  },
};
