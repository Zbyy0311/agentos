import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

/** Binds one canonical group interaction to the user message that started it. */
const DDL = [
  `ALTER TABLE cr_group_interactions ADD COLUMN source_message_id TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cr_group_interactions_source_message
    ON cr_group_interactions (workspace_id, conversation_id, source_message_id)
    WHERE source_message_id IS NOT NULL`,
];

export const migration036Checksum = createHash('sha256')
  .update(DDL.join('\n'))
  .digest('hex')
  .slice(0, 16);

export const migration036: Migration = {
  id: '036',
  name: 'group-discussion-idempotency',
  checksum: migration036Checksum,
  apply(ctx: MigrationContext): void {
    const columns = new Set((ctx.db.prepare('PRAGMA table_info(cr_group_interactions)').all() as Array<{ name?: unknown }>)
      .flatMap(row => typeof row.name === 'string' ? [row.name] : []));
    if (!columns.has('source_message_id')) ctx.db.prepare(DDL[0]!).run();
    ctx.db.prepare(DDL[1]!).run();
  },
};
