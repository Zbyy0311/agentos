import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

/** Stores image attachments for canonical Conversation Messages. */
const DDL = [
  `CREATE TABLE IF NOT EXISTS cr_message_attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size >= 1),
    relative_path TEXT NOT NULL,
    FOREIGN KEY (message_id) REFERENCES cr_messages(id) ON DELETE CASCADE,
    FOREIGN KEY (conversation_id) REFERENCES cr_conversations(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS cr_message_attachments_message
    ON cr_message_attachments (workspace_id, conversation_id, message_id, id)`,
];

export const migration037Checksum = createHash('sha256')
  .update(DDL.join('\n'))
  .digest('hex')
  .slice(0, 16);

export const migration037: Migration = {
  id: '037',
  name: 'canonical-message-attachments',
  checksum: migration037Checksum,
  apply(ctx: MigrationContext): void {
    for (const statement of DDL) ctx.db.exec(statement);
  },
};
