import { createHash } from 'node:crypto';
import type { Migration } from '../types.js';

/** Additive correction: freeze injected text without reinterpreting old snapshots. */
export const MEMORY_024_DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS memory_context_snapshot_payloads (
    snapshot_id TEXT NOT NULL PRIMARY KEY,
    context_text TEXT NOT NULL,
    content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
    FOREIGN KEY (snapshot_id) REFERENCES memory_context_snapshots(id)
  )`,
  `CREATE TRIGGER IF NOT EXISTS memory_context_snapshot_payloads_immutable
    BEFORE UPDATE ON memory_context_snapshot_payloads BEGIN
    SELECT RAISE(ABORT, 'MEMORY_SNAPSHOT_PAYLOAD_IMMUTABLE'); END`,
  `CREATE TRIGGER IF NOT EXISTS memory_context_snapshot_payloads_no_delete
    BEFORE DELETE ON memory_context_snapshot_payloads BEGIN
    SELECT RAISE(ABORT, 'MEMORY_SNAPSHOT_PAYLOAD_IMMUTABLE'); END`,
]);

export const migration024: Migration = {
  id: '024', name: 'memory-snapshot-payloads', destructive: false,
  checksum: createHash('sha256').update(MEMORY_024_DDL.join('\n')).digest('hex').slice(0, 16),
  apply({ db }) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_context_snapshots'").get() === undefined) {
      throw new Error('MIGRATION_PREREQUISITE_MISSING: 024 requires memory_context_snapshots');
    }
    for (const sql of MEMORY_024_DDL) db.prepare(sql).run();
  },
};
