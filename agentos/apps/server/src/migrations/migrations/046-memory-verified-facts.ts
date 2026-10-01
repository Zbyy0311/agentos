import { createHash } from 'node:crypto';
import type { Migration } from '../types.js';

export const MEMORY_VERIFIED_FACTS_046_DDL = [
  `CREATE TABLE IF NOT EXISTS memory_auto_accept_policy (
    workspace_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    updated_at TEXT NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS memory_test_runner_receipts (
    candidate_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    commit_id TEXT NOT NULL CHECK (length(commit_id) IN (40,64) AND commit_id NOT GLOB '*[^0-9a-f]*'),
    result TEXT NOT NULL CHECK (result IN ('passed','failed')),
    exit_code INTEGER NOT NULL,
    output_sha256 TEXT NOT NULL CHECK (length(output_sha256)=64 AND output_sha256 NOT GLOB '*[^0-9a-f]*'),
    runner_version TEXT NOT NULL CHECK (runner_version='collaboration-acceptance.v1'),
    created_at TEXT NOT NULL,
    CHECK ((result='passed' AND exit_code=0) OR (result='failed' AND exit_code<>0)),
    FOREIGN KEY (candidate_id,workspace_id) REFERENCES collaboration_candidates(id,workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  )`,
  `CREATE TRIGGER IF NOT EXISTS memory_test_runner_receipts_validate_insert
    BEFORE INSERT ON memory_test_runner_receipts
    WHEN NOT EXISTS (
      SELECT 1 FROM collaboration_candidates c
      WHERE c.id=NEW.candidate_id AND c.workspace_id=NEW.workspace_id
        AND c.canonical_run_id=NEW.run_id AND c.head_commit=NEW.commit_id
        AND c.test_status=NEW.result AND c.test_exit_code=NEW.exit_code
    )
    BEGIN SELECT RAISE(ABORT,'MEMORY_TEST_RUNNER_RECEIPT_INVALID'); END`,
  `CREATE TRIGGER IF NOT EXISTS memory_test_runner_receipts_immutable_update
    BEFORE UPDATE ON memory_test_runner_receipts
    BEGIN SELECT RAISE(ABORT,'MEMORY_TEST_RUNNER_RECEIPT_IMMUTABLE'); END`,
  `CREATE TRIGGER IF NOT EXISTS memory_test_runner_receipts_immutable_delete
    BEFORE DELETE ON memory_test_runner_receipts
    WHEN EXISTS (SELECT 1 FROM workspaces WHERE id=OLD.workspace_id)
    BEGIN SELECT RAISE(ABORT,'MEMORY_TEST_RUNNER_RECEIPT_IMMUTABLE'); END`,
  `CREATE TABLE IF NOT EXISTS memory_verified_facts (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('failure-code','environment','test-result')),
    source_id TEXT NOT NULL CHECK (length(source_id) > 0),
    evidence_hash TEXT NOT NULL CHECK (length(evidence_hash) = 64),
    outcome_hash TEXT NOT NULL CHECK (length(outcome_hash) = 64),
    environment_id TEXT NOT NULL CHECK (length(environment_id) > 0),
    commit_id TEXT,
    fact_key TEXT NOT NULL CHECK (length(fact_key) > 0),
    candidate_id TEXT NOT NULL,
    entry_id TEXT,
    decision TEXT NOT NULL CHECK (decision IN ('auto-accept','review-required')),
    created_at TEXT NOT NULL,
    CHECK (decision <> 'auto-accept' OR entry_id IS NOT NULL),
    UNIQUE (workspace_id,source_kind,source_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (candidate_id) REFERENCES memory_candidate_entries(id),
    FOREIGN KEY (entry_id) REFERENCES memory_entries(id)
  )`,
  `CREATE INDEX IF NOT EXISTS memory_verified_facts_dedup
    ON memory_verified_facts(workspace_id,fact_key,environment_id,commit_id,evidence_hash)`,
  `CREATE INDEX IF NOT EXISTS memory_verified_facts_source
    ON memory_verified_facts(workspace_id,source_kind,source_id)`,
  `CREATE TRIGGER IF NOT EXISTS memory_verified_facts_validate_insert
    BEFORE INSERT ON memory_verified_facts
    WHEN NOT EXISTS (
      SELECT 1 FROM memory_candidate_entries c
      WHERE c.id=NEW.candidate_id AND c.workspace_id=NEW.workspace_id AND c.scope='task'
        AND (NEW.entry_id IS NULL OR (c.merged_into_entry_id=NEW.entry_id AND EXISTS (
          SELECT 1 FROM memory_entries e WHERE e.id=NEW.entry_id AND e.workspace_id=NEW.workspace_id
            AND e.scope='task' AND e.owner_task_id=c.owner_task_id
        )))
    )
    BEGIN SELECT RAISE(ABORT,'MEMORY_FACT_CANDIDATE_INVALID'); END`,
  `CREATE TRIGGER IF NOT EXISTS memory_verified_facts_immutable
    BEFORE UPDATE ON memory_verified_facts BEGIN SELECT RAISE(ABORT,'MEMORY_FACT_IMMUTABLE'); END`,
  `CREATE TRIGGER IF NOT EXISTS memory_verified_facts_no_delete
    BEFORE DELETE ON memory_verified_facts
    WHEN EXISTS (SELECT 1 FROM workspaces WHERE id=OLD.workspace_id)
    BEGIN SELECT RAISE(ABORT,'MEMORY_FACT_IMMUTABLE'); END`,
] as const;

export const migration046: Migration = {
  id: '046', name: 'memory-verified-facts', destructive: false,
  checksum: createHash('sha256').update(MEMORY_VERIFIED_FACTS_046_DDL.join('\n')).digest('hex').slice(0, 16),
  apply({ db }) {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_candidate_entries'").get()) {
      throw new Error('MIGRATION_PREREQUISITE_MISSING: 046 requires memory candidates');
    }
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='collaboration_candidates'").get()) {
      throw new Error('MIGRATION_PREREQUISITE_MISSING: 046 requires collaboration candidates');
    }
    for (const ddl of MEMORY_VERIFIED_FACTS_046_DDL) db.prepare(ddl).run();
  },
};
