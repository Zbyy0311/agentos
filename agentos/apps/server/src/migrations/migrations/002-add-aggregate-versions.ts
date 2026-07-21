import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

const VERSION_TABLES = ['agent_profiles', 'conversations', 'agent_runs'];

const ALTER_STATEMENTS = VERSION_TABLES.map(
  (t) => `ALTER TABLE ${t} ADD COLUMN version INTEGER NOT NULL DEFAULT 1`,
);

const CANONICAL_SOURCE = ALTER_STATEMENTS.join('\n');

export const migration002Checksum = createHash('sha256')
  .update(CANONICAL_SOURCE)
  .digest('hex')
  .slice(0, 16);

export const migration002: Migration = {
  id: '002',
  name: 'add-aggregate-versions',
  checksum: migration002Checksum,
  apply(ctx: MigrationContext): void {
    for (const stmt of ALTER_STATEMENTS) {
      ctx.db.exec(stmt);
    }
  },
};
