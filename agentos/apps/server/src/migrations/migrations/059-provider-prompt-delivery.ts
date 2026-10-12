import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

export const PROVIDER_PROMPT_DELIVERY_059_DDL_STATEMENTS = Object.freeze([
  `ALTER TABLE provider_configurations ADD COLUMN prompt_delivery TEXT
    CHECK (prompt_delivery IS NULL OR prompt_delivery IN ('argument','stdin','file'))`,
]);

export const migration059Checksum = createHash('sha256')
  .update(PROVIDER_PROMPT_DELIVERY_059_DDL_STATEMENTS.join('\n'))
  .digest('hex')
  .slice(0, 16);

export const migration059: Migration = {
  id: '059',
  name: 'provider-prompt-delivery',
  checksum: migration059Checksum,
  destructive: false,
  apply(ctx: MigrationContext): void {
    for (const statement of PROVIDER_PROMPT_DELIVERY_059_DDL_STATEMENTS) ctx.db.exec(statement);
  },
};
