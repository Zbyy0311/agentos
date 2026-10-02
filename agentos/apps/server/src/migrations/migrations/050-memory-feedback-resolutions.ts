import { createHash } from 'node:crypto';
import type { Migration } from '../types.js';

export const MEMORY_FEEDBACK_RESOLUTIONS_050_DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS memory_feedback_action_resolutions (
    action_id TEXT PRIMARY KEY,
    feedback_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0),
    entry_id TEXT NOT NULL CHECK (length(entry_id) > 0),
    reported_entry_version INTEGER NOT NULL CHECK (reported_entry_version >= 1),
    expected_action_version INTEGER NOT NULL CHECK (expected_action_version >= 1),
    expected_entry_version INTEGER NOT NULL CHECK (expected_entry_version >= 1),
    resolved_entry_version INTEGER NOT NULL CHECK (resolved_entry_version = expected_entry_version + 1),
    resolution TEXT NOT NULL CHECK (resolution IN ('corrected','archived','revalidated')),
    conclusion TEXT NOT NULL CHECK (length(trim(conclusion)) > 0),
    evidence TEXT NOT NULL CHECK (length(trim(evidence)) > 0),
    created_at TEXT NOT NULL,
    FOREIGN KEY (action_id) REFERENCES memory_feedback_actions(id),
    FOREIGN KEY (feedback_id) REFERENCES memory_version_feedback(id),
    FOREIGN KEY (entry_id) REFERENCES memory_entries(id)
  )`,
  `CREATE INDEX IF NOT EXISTS memory_feedback_actions_quarantine
    ON memory_feedback_actions(entry_id,entry_version,workspace_id)
    WHERE action = 'correction' AND status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS memory_feedback_action_resolutions_workspace
    ON memory_feedback_action_resolutions(workspace_id,entry_id,resolved_entry_version)`,
  `DROP TRIGGER IF EXISTS memory_feedback_actions_transition_guard`,
  `CREATE TRIGGER memory_feedback_actions_transition_guard
    BEFORE UPDATE ON memory_feedback_actions
    WHEN NOT (
      OLD.status = 'pending' AND NEW.status IN ('resolved','rejected')
      AND NEW.version = OLD.version + 1
      AND NEW.id = OLD.id AND NEW.feedback_id = OLD.feedback_id
      AND NEW.workspace_id = OLD.workspace_id AND NEW.entry_id = OLD.entry_id
      AND NEW.entry_version = OLD.entry_version AND NEW.action = OLD.action
      AND NEW.created_at = OLD.created_at
      AND (NEW.status = 'rejected' OR EXISTS (
        SELECT 1 FROM memory_feedback_action_resolutions r
        WHERE r.action_id = OLD.id AND r.feedback_id = OLD.feedback_id
          AND r.workspace_id = OLD.workspace_id AND r.entry_id = OLD.entry_id
          AND r.reported_entry_version = OLD.entry_version
          AND r.expected_action_version = OLD.version
      ))
    ) BEGIN SELECT RAISE(ABORT,'MEMORY_FEEDBACK_ACTION_TRANSITION_INVALID'); END`,
  `CREATE TRIGGER IF NOT EXISTS memory_feedback_action_resolutions_validate
    BEFORE INSERT ON memory_feedback_action_resolutions
    WHEN NOT EXISTS (
      SELECT 1 FROM memory_feedback_actions a
      INNER JOIN memory_entries e ON e.id = a.entry_id
      WHERE a.id = NEW.action_id AND a.feedback_id = NEW.feedback_id
        AND a.workspace_id = NEW.workspace_id AND a.entry_id = NEW.entry_id
        AND a.entry_version = NEW.reported_entry_version
        AND a.status = 'pending' AND a.version = NEW.expected_action_version
        AND e.workspace_id = NEW.workspace_id AND e.version = NEW.resolved_entry_version
        AND NEW.expected_entry_version + 1 = NEW.resolved_entry_version
        AND EXISTS (
          SELECT 1 FROM memory_lifecycle_actions l
          WHERE l.workspace_id = NEW.workspace_id AND l.entry_id = NEW.entry_id
            AND l.from_version = NEW.expected_entry_version
            AND l.to_version = NEW.resolved_entry_version
            AND l.action = CASE NEW.resolution
              WHEN 'corrected' THEN 'corrected'
              WHEN 'archived' THEN 'archive'
              WHEN 'revalidated' THEN 'revalidate'
            END
        )
    ) BEGIN SELECT RAISE(ABORT,'MEMORY_FEEDBACK_RESOLUTION_MISMATCH'); END`,
  `CREATE TRIGGER IF NOT EXISTS memory_feedback_action_resolutions_immutable
    BEFORE UPDATE ON memory_feedback_action_resolutions BEGIN
    SELECT RAISE(ABORT,'MEMORY_FEEDBACK_RESOLUTION_IMMUTABLE'); END`,
  `CREATE TRIGGER IF NOT EXISTS memory_feedback_action_resolutions_no_delete
    BEFORE DELETE ON memory_feedback_action_resolutions BEGIN
    SELECT RAISE(ABORT,'MEMORY_FEEDBACK_RESOLUTION_IMMUTABLE'); END`,
  `DROP TRIGGER IF EXISTS memory_feedback_action_audit_validate`,
  `CREATE TRIGGER memory_feedback_action_audit_validate
    BEFORE INSERT ON memory_feedback_action_audit
    WHEN NOT (
      EXISTS (
        SELECT 1 FROM memory_feedback_actions a
        WHERE a.id = NEW.action_id AND a.feedback_id = NEW.feedback_id
          AND a.workspace_id = NEW.workspace_id AND a.entry_id = NEW.entry_id
          AND a.entry_version = NEW.entry_version AND a.action = NEW.action
          AND a.status = NEW.to_status AND a.version = NEW.version
      )
      AND (NEW.to_status = 'rejected' OR EXISTS (
        SELECT 1 FROM memory_feedback_action_resolutions r
        WHERE r.action_id = NEW.action_id AND r.feedback_id = NEW.feedback_id
          AND r.workspace_id = NEW.workspace_id AND r.entry_id = NEW.entry_id
          AND r.reported_entry_version = NEW.entry_version
          AND r.expected_action_version = NEW.expected_version
      ))
    ) BEGIN SELECT RAISE(ABORT,'MEMORY_FEEDBACK_ACTION_AUDIT_MISMATCH'); END`,
]);

export const migration050: Migration = {
  id: '050',
  name: 'memory-feedback-resolutions',
  destructive: false,
  checksum: createHash('sha256').update(MEMORY_FEEDBACK_RESOLUTIONS_050_DDL.join('\n')).digest('hex').slice(0, 16),
  apply({ db }) {
    for (const prerequisite of [
      'memory_entries',
      'memory_version_feedback',
      'memory_feedback_actions',
      'memory_feedback_action_audit',
      'memory_lifecycle_actions',
    ]) {
      if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(prerequisite) === undefined) {
        throw new Error(`MIGRATION_PREREQUISITE_MISSING: 050 requires ${prerequisite}`);
      }
    }
    for (const sql of MEMORY_FEEDBACK_RESOLUTIONS_050_DDL) db.prepare(sql).run();
  },
};
