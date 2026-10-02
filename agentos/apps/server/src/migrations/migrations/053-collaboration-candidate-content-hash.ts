import { createHash } from 'node:crypto';
import { collaborationCandidateContentHash } from '../../services/CollaborationCandidateContentHash.js';
import type { Migration, MigrationContext } from '../types.js';

const DDL_CONTENT_HASH = `ALTER TABLE collaboration_candidates ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''`;
const DDL_MANIFEST_VERSION = `ALTER TABLE collaboration_candidates ADD COLUMN manifest_version INTEGER NOT NULL DEFAULT 1 CHECK (manifest_version IN (1, 2))`;

export const migration053Checksum = createHash('sha256')
  .update(`${DDL_CONTENT_HASH}\n${DDL_MANIFEST_VERSION}`)
  .digest('hex')
  .slice(0, 16);

export const migration053: Migration = {
  id: '053',
  name: 'collaboration-candidate-content-hash',
  checksum: migration053Checksum,
  apply(ctx: MigrationContext): void {
    ctx.db.exec(DDL_CONTENT_HASH);
    ctx.db.exec(DDL_MANIFEST_VERSION);
    const rows = ctx.db.prepare(`SELECT id,diff_hash,snapshot_version,manifest_json,manifest_version FROM collaboration_candidates`).all() as Array<{
      id: string; diff_hash: string; snapshot_version: number; manifest_json: string; manifest_version: number;
    }>;
    const update = ctx.db.prepare('UPDATE collaboration_candidates SET content_hash = ? WHERE id = ?');
    for (const row of rows) {
      let manifest: unknown;
      try { manifest = JSON.parse(row.manifest_json); } catch { throw new Error('MIGRATION_053: candidate manifest is not valid JSON'); }
      if (!Array.isArray(manifest)) throw new Error('MIGRATION_053: candidate manifest is not an array');
      const contentHash = collaborationCandidateContentHash({
        diffHash: row.diff_hash,
        snapshotVersion: row.snapshot_version,
        manifestVersion: row.manifest_version,
        manifest: manifest as Parameters<typeof collaborationCandidateContentHash>[0]['manifest'],
      });
      update.run(contentHash, row.id);
    }
  },
};
