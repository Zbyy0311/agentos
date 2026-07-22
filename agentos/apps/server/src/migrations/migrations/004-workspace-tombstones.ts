import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

const DDL = `CREATE TABLE _workspace_tombstones (
  workspace_id TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL
)`;

export const migration004Checksum = createHash('sha256')
  .update(DDL)
  .digest('hex')
  .slice(0, 16);

export const migration004: Migration = {
  id: '004',
  name: 'workspace-tombstones',
  checksum: migration004Checksum,
  apply(ctx: MigrationContext): void {
    ctx.db.exec(DDL);
  },
};
