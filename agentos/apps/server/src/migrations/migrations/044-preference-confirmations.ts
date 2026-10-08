import { createHash } from 'node:crypto';
import type { Migration } from '../types.js';

/** Sidecar lifecycle for preference suggestions and their canonical Memory Entries. */
export const PREFERENCE_CONFIRMATIONS_044_DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS preference_confirmations (
    id TEXT PRIMARY KEY,
    projection_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    projection_scope TEXT NOT NULL CHECK (projection_scope IN ('workspace','global')),
    projection_workspace_id TEXT,
    workspace_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending','confirmed','rejected','revoked')),
    version INTEGER NOT NULL CHECK (version >= 1),
    preferred_value TEXT NOT NULL,
    dimension TEXT NOT NULL,
    context_kind TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('workspace','global')),
    confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
    evidence_count INTEGER NOT NULL CHECK (evidence_count >= 0),
    evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
    entry_id TEXT,
    entry_workspace_id TEXT,
    entry_version INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (status = 'confirmed' AND entry_id IS NOT NULL AND entry_workspace_id IS NOT NULL AND entry_version IS NOT NULL)
      OR status <> 'confirmed'
    )
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS preference_confirmations_one_pending
    ON preference_confirmations (projection_id) WHERE status = 'pending'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS preference_confirmations_one_confirmed_projection
    ON preference_confirmations (projection_id) WHERE status = 'confirmed'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS preference_confirmations_one_active_binding
    ON preference_confirmations (
      profile_id, scope, CASE WHEN scope = 'global' THEN '' ELSE COALESCE(entry_workspace_id, '') END,
      dimension, context_kind
    )
    WHERE status = 'confirmed'`,
  `CREATE INDEX IF NOT EXISTS preference_confirmations_workspace_status
    ON preference_confirmations (workspace_id, status, updated_at DESC, projection_id)`,
  `CREATE INDEX IF NOT EXISTS preference_confirmations_profile_key
    ON preference_confirmations (profile_id, dimension, context_kind, status)`,
  `CREATE TABLE IF NOT EXISTS preference_confirmation_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    suggestion_id TEXT NOT NULL,
    projection_id TEXT NOT NULL,
    workspace_id TEXT,
    action TEXT NOT NULL CHECK (action IN ('backfilled','suggested','refreshed','confirmed','rejected','revoked','replaced')),
    actor TEXT NOT NULL CHECK (actor IN ('learner','user','migration')),
    expected_version INTEGER,
    version INTEGER NOT NULL CHECK (version >= 1),
    entry_id TEXT,
    details_json TEXT NOT NULL CHECK (json_valid(details_json)),
    occurred_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS preference_confirmation_audit_projection
    ON preference_confirmation_audit (projection_id, id)`,
  `CREATE TRIGGER IF NOT EXISTS preference_confirmation_audit_immutable_update
    BEFORE UPDATE ON preference_confirmation_audit BEGIN
    SELECT RAISE(ABORT, 'PREFERENCE_CONFIRMATION_AUDIT_IMMUTABLE'); END`,
  `CREATE TRIGGER IF NOT EXISTS preference_confirmation_audit_immutable_delete
    BEFORE DELETE ON preference_confirmation_audit BEGIN
    SELECT RAISE(ABORT, 'PREFERENCE_CONFIRMATION_AUDIT_IMMUTABLE'); END`,
]);

interface ProjectionRow {
  id: string; profile_id: string; scope: 'workspace' | 'global'; workspace_id: string | null;
  preferred_value: string; dimension: string; context_kind: string; confidence: number;
  evidence_count: number; created_at: string; updated_at: string;
}

interface EvidenceRow {
  id: string; profile_id: string; workspace_id: string | null; conversation_id: string; run_id: string;
  source_event_id: string; dimension: string; context_kind: string; candidate_value: string;
  signal_type: string; polarity: string; weight: number; summary: string; status: string;
  observed_at: string; created_at: string;
}

function serializeEvidence(row: EvidenceRow): Record<string, unknown> {
  return {
    evidenceId: row.id, profileId: row.profile_id, workspaceId: row.workspace_id,
    conversationId: row.conversation_id, runId: row.run_id, sourceEventId: row.source_event_id,
    dimension: row.dimension, contextKind: row.context_kind, candidateValue: row.candidate_value,
    signalType: row.signal_type, polarity: row.polarity, weight: row.weight, summary: row.summary,
    status: row.status, observedAt: row.observed_at, createdAt: row.created_at,
  };
}

export const migration044: Migration = {
  id: '044', name: 'preference-confirmations', destructive: false,
  checksum: createHash('sha256').update(PREFERENCE_CONFIRMATIONS_044_DDL.join('\n')).digest('hex').slice(0, 16),
  apply({ db }) {
    for (const prerequisite of ['preference_projections', 'preference_projection_evidence', 'preference_evidence', 'memory_entries']) {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(prerequisite) === undefined) {
        throw new Error(`MIGRATION_PREREQUISITE_MISSING: 044 requires ${prerequisite}`);
      }
    }
    for (const sql of PREFERENCE_CONFIRMATIONS_044_DDL) db.prepare(sql).run();

    const projections = db.prepare(`
      SELECT id, profile_id, scope, workspace_id, preferred_value, dimension, context_kind,
        confidence, evidence_count, created_at, updated_at
      FROM preference_projections WHERE status IN ('observed','provisional','stable') ORDER BY id
    `).all() as ProjectionRow[];
    const getEvidence = db.prepare(`
      SELECT e.id, e.profile_id, e.workspace_id, e.conversation_id, e.run_id, e.source_event_id,
        e.dimension, e.context_kind, e.candidate_value, e.signal_type, e.polarity, e.weight,
        e.summary, e.status, e.observed_at, e.created_at
      FROM preference_projection_evidence AS pe
      INNER JOIN preference_evidence AS e ON e.id = pe.evidence_id
      WHERE pe.projection_id = ? ORDER BY e.observed_at, e.id
    `);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO preference_confirmations (
        id, projection_id, profile_id, projection_scope, projection_workspace_id, workspace_id,
        status, version, preferred_value, dimension, context_kind, scope, confidence, evidence_count,
        evidence_json, entry_id, entry_workspace_id, entry_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
    `);
    const audit = db.prepare(`
      INSERT INTO preference_confirmation_audit (
        suggestion_id, projection_id, workspace_id, action, actor, expected_version, version,
        entry_id, details_json, occurred_at
      ) VALUES (?, ?, ?, 'backfilled', 'migration', NULL, 1, NULL, ?, ?)
    `);
    for (const projection of projections) {
      const evidence = (getEvidence.all(projection.id) as EvidenceRow[]).map(serializeEvidence);
      const evidenceJson = JSON.stringify(evidence);
      const suggestionId = `preference-suggestion:${projection.id}`;
      const inserted = insert.run(suggestionId, projection.id, projection.profile_id, projection.scope, projection.workspace_id,
        projection.workspace_id, projection.preferred_value, projection.dimension, projection.context_kind,
        projection.scope, projection.confidence, projection.evidence_count, evidenceJson,
        projection.created_at, projection.updated_at) as { changes?: number | bigint };
      if (Number(inserted.changes ?? 0) === 1) {
        audit.run(suggestionId, projection.id, projection.workspace_id, JSON.stringify({ evidence }), projection.updated_at);
      }
    }
  },
};

export const migration044Checksum = migration044.checksum;
