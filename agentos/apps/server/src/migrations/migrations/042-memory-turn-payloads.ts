import { createHash } from 'node:crypto';
import type { Migration } from '../types.js';

/** Freeze Memory text and explanations for canonical Conversation Turns. */
export const MEMORY_042_DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS cr_turn_memory_payloads (
    snapshot_id TEXT NOT NULL PRIMARY KEY,
    context_text TEXT NOT NULL,
    context_sha256 TEXT NOT NULL CHECK (length(context_sha256) = 64),
    selection_json TEXT NOT NULL,
    exclusions_json TEXT NOT NULL,
    retrieval_degraded INTEGER NOT NULL DEFAULT 0 CHECK (retrieval_degraded IN (0,1)),
    FOREIGN KEY (snapshot_id) REFERENCES cr_turn_context_snapshots(id)
  )`,
  `CREATE TRIGGER IF NOT EXISTS cr_turn_memory_payloads_immutable
    BEFORE UPDATE ON cr_turn_memory_payloads BEGIN
    SELECT RAISE(ABORT, 'CR_TURN_MEMORY_PAYLOAD_IMMUTABLE'); END`,
  `CREATE TRIGGER IF NOT EXISTS cr_turn_memory_payloads_no_delete
    BEFORE DELETE ON cr_turn_memory_payloads BEGIN
    SELECT RAISE(ABORT, 'CR_TURN_MEMORY_PAYLOAD_IMMUTABLE'); END`,
]);

export const migration042: Migration = {
  id: '042', name: 'memory-turn-payloads', destructive: false,
  checksum: createHash('sha256').update(MEMORY_042_DDL.join('\n')).digest('hex').slice(0, 16),
  apply({ db }) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cr_turn_context_snapshots'").get() === undefined) {
      throw new Error('MIGRATION_PREREQUISITE_MISSING: 042 requires cr_turn_context_snapshots');
    }
    for (const sql of MEMORY_042_DDL) db.prepare(sql).run();
  },
};

/** The checksum the registry records, exported so a proof can re-derive it. */
export const migration042Checksum = migration042.checksum;
