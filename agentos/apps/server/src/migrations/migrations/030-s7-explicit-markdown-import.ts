import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

/**
 * S7 explicit Markdown import persistence (authorization:
 * S7-import-authorization.md). Additive only: one immutable record table that
 * makes re-import idempotent and proves the memory.import Workspace origin.
 * 001-029 stay unchanged.
 */
export const S7_IMPORT_030_DDL_STATEMENTS = Object.freeze([
  `CREATE TABLE memory_import_records (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
    workspace_id TEXT NOT NULL,
    source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
    fragment_index INTEGER NOT NULL CHECK (fragment_index >= 0),
    fragment_hash TEXT NOT NULL CHECK (length(fragment_hash) = 64),
    parser_version TEXT NOT NULL CHECK (length(parser_version) > 0),
    title TEXT NOT NULL CHECK (length(title) > 0),
    fragment_count INTEGER NOT NULL CHECK (fragment_count >= 1),
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    candidate_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    UNIQUE (workspace_id, source_hash, fragment_index, parser_version),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (candidate_id) REFERENCES memory_candidate_entries(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX memory_import_records_workspace_source
    ON memory_import_records (workspace_id, source_hash, created_at, id)`,
  `CREATE TRIGGER memory_import_records_immutable
    BEFORE UPDATE ON memory_import_records
    BEGIN SELECT RAISE(ABORT, 'MEMORY_IMPORT_IMMUTABLE'); END`,
]);

export const migration030Checksum = createHash('sha256')
  .update(S7_IMPORT_030_DDL_STATEMENTS.join('\n')).digest('hex').slice(0, 16);

export const migration030: Migration = {
  id: '030',
  name: 's7-explicit-markdown-import',
  checksum: migration030Checksum,
  destructive: false,
  apply(ctx: MigrationContext): void {
    for (const table of ['workspaces', 'memory_candidate_entries']) {
      if (ctx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) === undefined) {
        throw new Error('MIGRATION_PREREQUISITE_MISSING: 030 requires ' + table);
      }
    }
    for (const sql of S7_IMPORT_030_DDL_STATEMENTS) ctx.db.exec(sql);
  },
};

