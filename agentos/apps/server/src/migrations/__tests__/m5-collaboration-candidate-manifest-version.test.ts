import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { collaborationCandidateContentHash } from '../../services/CollaborationCandidateContentHash.js';
import { migration053 } from '../migrations/053-collaboration-candidate-content-hash.js';
import type { MigrationContext } from '../types.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { get(...params: unknown[]): unknown; run(...params: unknown[]): unknown };
    close(): void;
  };
};

test('053 preserves existing candidate manifests as v1 and hashes the explicit version', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE collaboration_candidates (
      id TEXT PRIMARY KEY, diff_hash TEXT NOT NULL, snapshot_version INTEGER NOT NULL, manifest_json TEXT NOT NULL
    )`);
    const diffHash = 'a'.repeat(64);
    const manifest = [{ path: 'assets/old.bin', sizeBytes: 9, gitObjectId: 'b'.repeat(40), binary: true }];
    db.prepare('INSERT INTO collaboration_candidates(id,diff_hash,snapshot_version,manifest_json) VALUES(?,?,?,?)')
      .run('legacy-candidate', diffHash, 2, JSON.stringify(manifest));

    migration053.apply({ db } as unknown as MigrationContext);

    const row = db.prepare('SELECT manifest_version,content_hash FROM collaboration_candidates WHERE id = ?')
      .get('legacy-candidate') as { manifest_version: number; content_hash: string };
    assert.equal(row.manifest_version, 1);
    assert.equal(row.content_hash, collaborationCandidateContentHash({
      diffHash, snapshotVersion: 2, manifestVersion: 1, manifest,
    }));
    assert.notEqual(row.content_hash, collaborationCandidateContentHash({
      diffHash, snapshotVersion: 2, manifestVersion: 2, manifest,
    }));

    assert.throws(() => db.prepare(`INSERT INTO collaboration_candidates(
      id,diff_hash,snapshot_version,manifest_json,manifest_version,content_hash
    ) VALUES(?,?,?,?,?,?)`).run('invalid-candidate', diffHash, 2, '[]', 3, 'c'.repeat(64)));
  } finally {
    db.close();
  }
});
