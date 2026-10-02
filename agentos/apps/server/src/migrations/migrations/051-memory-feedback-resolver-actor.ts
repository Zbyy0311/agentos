import { createHash } from 'node:crypto';
import type { Migration, MinimalDatabaseSync } from '../types.js';

const RESOLVER_ACTOR_051_COLUMN_DDL = Object.freeze([
  `ALTER TABLE memory_feedback_actions
    ADD COLUMN resolved_by_workspace_id TEXT
    CHECK (resolved_by_workspace_id IS NULL OR length(resolved_by_workspace_id) > 0)`,
  `ALTER TABLE memory_feedback_action_resolutions
    ADD COLUMN resolver_workspace_id TEXT
    CHECK (resolver_workspace_id IS NULL OR length(resolver_workspace_id) > 0)`,
  `ALTER TABLE memory_feedback_action_audit
    ADD COLUMN actor_workspace_id TEXT
    CHECK (actor_workspace_id IS NULL OR length(actor_workspace_id) > 0)`,
]);

export const MEMORY_FEEDBACK_RESOLVER_ACTOR_051_DDL = Object.freeze([
  ...RESOLVER_ACTOR_051_COLUMN_DDL,
  `DROP TRIGGER IF EXISTS memory_feedback_actions_insert_guard`,
  `CREATE TRIGGER memory_feedback_actions_insert_guard
    BEFORE INSERT ON memory_feedback_actions
    WHEN NOT (
      NEW.status = 'pending' AND NEW.version = 1 AND NEW.resolved_by_workspace_id IS NULL
      AND EXISTS (
        SELECT 1 FROM memory_version_feedback f
        INNER JOIN memory_entries e ON e.id = f.entry_id
        WHERE f.id = NEW.feedback_id AND f.workspace_id = NEW.workspace_id
          AND f.entry_id = NEW.entry_id AND f.entry_version = NEW.entry_version
          AND (e.scope = 'global' OR e.workspace_id = NEW.workspace_id)
      )
    ) BEGIN SELECT RAISE(ABORT,'MEMORY_FEEDBACK_ACTION_INSERT_INVALID'); END`,
  `DROP TRIGGER IF EXISTS memory_feedback_actions_transition_guard`,
  `CREATE TRIGGER memory_feedback_actions_transition_guard
    BEFORE UPDATE ON memory_feedback_actions
    WHEN NOT (
      OLD.status = 'pending' AND OLD.resolved_by_workspace_id IS NULL
      AND NEW.status IN ('resolved','rejected')
      AND NEW.version = OLD.version + 1
      AND NEW.id = OLD.id AND NEW.feedback_id = OLD.feedback_id
      AND NEW.workspace_id = OLD.workspace_id AND NEW.entry_id = OLD.entry_id
      AND NEW.entry_version = OLD.entry_version AND NEW.action = OLD.action
      AND NEW.created_at = OLD.created_at
      AND NEW.resolved_by_workspace_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM memory_entries e
        WHERE e.id = OLD.entry_id
          AND ((e.scope = 'global' AND e.workspace_id = NEW.resolved_by_workspace_id)
            OR (e.scope <> 'global' AND e.workspace_id = OLD.workspace_id
              AND NEW.resolved_by_workspace_id = OLD.workspace_id))
      )
      AND (NEW.status = 'rejected' OR EXISTS (
        SELECT 1 FROM memory_feedback_action_resolutions r
        WHERE r.action_id = OLD.id AND r.feedback_id = OLD.feedback_id
          AND r.workspace_id = OLD.workspace_id AND r.entry_id = OLD.entry_id
          AND r.reported_entry_version = OLD.entry_version
          AND r.expected_action_version = OLD.version
          AND r.resolver_workspace_id = NEW.resolved_by_workspace_id
      ))
    ) BEGIN SELECT RAISE(ABORT,'MEMORY_FEEDBACK_ACTION_TRANSITION_INVALID'); END`,
  `DROP TRIGGER IF EXISTS memory_feedback_action_resolutions_validate`,
  `CREATE TRIGGER memory_feedback_action_resolutions_validate
    BEFORE INSERT ON memory_feedback_action_resolutions
    WHEN NOT EXISTS (
      SELECT 1 FROM memory_feedback_actions a
      INNER JOIN memory_entries e ON e.id = a.entry_id
      WHERE a.id = NEW.action_id AND a.feedback_id = NEW.feedback_id
        AND a.workspace_id = NEW.workspace_id AND a.entry_id = NEW.entry_id
        AND a.entry_version = NEW.reported_entry_version
        AND a.status = 'pending' AND a.version = NEW.expected_action_version
        AND a.resolved_by_workspace_id IS NULL
        AND NEW.resolver_workspace_id IS NOT NULL
        AND ((e.scope = 'global' AND e.workspace_id = NEW.resolver_workspace_id)
          OR (e.scope <> 'global' AND e.workspace_id = a.workspace_id
            AND NEW.resolver_workspace_id = a.workspace_id))
        AND e.version = NEW.resolved_entry_version
        AND NEW.expected_entry_version + 1 = NEW.resolved_entry_version
        AND EXISTS (
          SELECT 1 FROM memory_lifecycle_actions l
          WHERE l.workspace_id = NEW.resolver_workspace_id AND l.entry_id = NEW.entry_id
            AND l.from_version = NEW.expected_entry_version
            AND l.to_version = NEW.resolved_entry_version
            AND l.action = CASE NEW.resolution
              WHEN 'corrected' THEN 'corrected'
              WHEN 'archived' THEN 'archive'
              WHEN 'revalidated' THEN 'revalidate'
            END
        )
    ) BEGIN SELECT RAISE(ABORT,'MEMORY_FEEDBACK_RESOLUTION_MISMATCH'); END`,
  `DROP TRIGGER IF EXISTS memory_feedback_action_audit_validate`,
  `CREATE TRIGGER memory_feedback_action_audit_validate
    BEFORE INSERT ON memory_feedback_action_audit
    WHEN NOT (
      EXISTS (
        SELECT 1 FROM memory_feedback_actions a
        INNER JOIN memory_entries e ON e.id = a.entry_id
        WHERE a.id = NEW.action_id AND a.feedback_id = NEW.feedback_id
          AND a.workspace_id = NEW.workspace_id AND a.entry_id = NEW.entry_id
          AND a.entry_version = NEW.entry_version AND a.action = NEW.action
          AND a.status = NEW.to_status AND a.version = NEW.version
          AND a.resolved_by_workspace_id = NEW.actor_workspace_id
          AND ((e.scope = 'global' AND e.workspace_id = NEW.actor_workspace_id)
            OR (e.scope <> 'global' AND e.workspace_id = a.workspace_id
              AND NEW.actor_workspace_id = a.workspace_id))
      )
      AND (NEW.to_status = 'rejected' OR EXISTS (
        SELECT 1 FROM memory_feedback_action_resolutions r
        WHERE r.action_id = NEW.action_id AND r.feedback_id = NEW.feedback_id
          AND r.workspace_id = NEW.workspace_id AND r.entry_id = NEW.entry_id
          AND r.reported_entry_version = NEW.entry_version
          AND r.expected_action_version = NEW.expected_version
          AND r.resolver_workspace_id = NEW.actor_workspace_id
      ))
    ) BEGIN SELECT RAISE(ABORT,'MEMORY_FEEDBACK_ACTION_AUDIT_MISMATCH'); END`,
  `DROP TRIGGER IF EXISTS memory_feedback_actions_record_audit`,
  `CREATE TRIGGER memory_feedback_actions_record_audit
    AFTER UPDATE OF status ON memory_feedback_actions
    WHEN OLD.status = 'pending' AND NEW.status IN ('resolved','rejected')
    BEGIN
      INSERT INTO memory_feedback_action_audit (
        id, action_id, feedback_id, workspace_id, entry_id, entry_version, action,
        from_status, to_status, expected_version, version, occurred_at, actor_workspace_id
      ) VALUES (
        lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-'
          || substr('89ab',abs(random()) % 4 + 1,1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))),
        NEW.id, NEW.feedback_id, NEW.workspace_id, NEW.entry_id, NEW.entry_version, NEW.action,
        OLD.status, NEW.status, OLD.version, NEW.version,
        strftime('%Y-%m-%dT%H:%M:%fZ','now'), NEW.resolved_by_workspace_id
      );
    END`,
]);

function hasColumn(db: MinimalDatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some(row => row.name === column);
}

export const migration051: Migration = {
  id: '051',
  name: 'memory-feedback-resolver-actor',
  destructive: false,
  checksum: createHash('sha256').update(MEMORY_FEEDBACK_RESOLVER_ACTOR_051_DDL.join('\n')).digest('hex').slice(0, 16),
  apply({ db }) {
    for (const prerequisite of [
      'memory_entries',
      'memory_feedback_actions',
      'memory_feedback_action_audit',
      'memory_feedback_action_resolutions',
      'memory_lifecycle_actions',
    ]) {
      if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(prerequisite) === undefined) {
        throw new Error(`MIGRATION_PREREQUISITE_MISSING: 051 requires ${prerequisite}`);
      }
    }

    const columns: readonly [string, string][] = [
      ['memory_feedback_actions', 'resolved_by_workspace_id'],
      ['memory_feedback_action_resolutions', 'resolver_workspace_id'],
      ['memory_feedback_action_audit', 'actor_workspace_id'],
    ];
    for (let index = 0; index < columns.length; index += 1) {
      const [table, column] = columns[index]!;
      if (!hasColumn(db, table, column)) db.prepare(RESOLVER_ACTOR_051_COLUMN_DDL[index]!).run();
    }

    for (const sql of MEMORY_FEEDBACK_RESOLVER_ACTOR_051_DDL.slice(RESOLVER_ACTOR_051_COLUMN_DDL.length)) {
      db.prepare(sql).run();
    }
  },
};
