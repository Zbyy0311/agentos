import type { TransactionDatabase } from '../store/Transaction.js';
import { inTransaction } from '../store/Transaction.js';
import { conversationIdsForRun } from '../store/ConversationRunResolver.js';
import { ConversationEventRepository } from '../store/ConversationEventRepository.js';

/**
 * Conversation message search (SQLite FTS5) and per-user Read State.
 *
 * Lite 09-Conversation-Runtime §68/§69/§70/§71, §115/§116:
 *   - search is a join between messages_fts (full-text) and cr_messages
 *     (authoritative filters and sequence); the workspace boundary is always
 *     applied on cr_messages.workspace_id, never on the FTS row alone;
 *   - read state is server-authoritative: unread/mention/approval counts are
 *     computed from message sequence and content at read time, not trusted
 *     from the client.
 *
 * All SQL is parameterized; the FTS MATCH expression is rebuilt from the
 * caller's query by quoting every token, so user input never reaches SQL as
 * raw syntax.
 */

export const SEARCH_MAX_LIMIT = 100;
export const SEARCH_DEFAULT_LIMIT = 20;

export interface ConversationSearchFilters {
  readonly query: string;
  readonly sender?: 'user' | 'agent' | 'system';
  readonly agentId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly type?: string;
  readonly limit?: number;
  readonly conversationId?: string;
}

export interface ConversationSearchResult {
  readonly messageId: string;
  readonly conversationId: string;
  readonly sequence: number;
  readonly senderType: string;
  readonly senderDisplayName: string;
  readonly snippet: string;
  readonly matchedTerms: string[];
  readonly createdAt: string;
}

export interface ConversationReadStateSnapshot {
  readonly conversationId: string;
  readonly userId: string;
  readonly lastReadMessageSequence: number;
  readonly lastReadMessageId: string | null;
  readonly lastReadAt: string;
  readonly unreadCount: number;
  readonly mentionCount: number;
  readonly approvalCount: number;
}

const MENTION_PATTERN = /@\[?([^\]\s@]{1,64})/g;

/** Extract mention handles from message text (e.g. `@codex`, `@[kimi code]`). */
export function extractMentionTargets(content: string): string[] {
  const targets: string[] = [];
  for (const match of content.matchAll(MENTION_PATTERN)) targets.push(match[1]!);
  return targets;
}

/**
 * Build a safe FTS5 MATCH expression: every non-empty token becomes an
 * AND-quoted phrase so query syntax characters cannot inject FTS operators.
 */
export function buildMatchExpression(query: string): string | null {
  const tokens = query.split(/\s+/u).map(token => token.replace(/["']/gu, '')).filter(token => token.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map(token => `"${token}"`).join(' AND ');
}

export class ConversationSearchReadStateError extends Error {
  constructor(readonly code: 'INPUT_INVALID' | 'CONVERSATION_NOT_FOUND') {
    super(`CONVERSATION_${code}`);
    this.name = 'ConversationSearchReadStateError';
  }
}

export class ConversationSearchReadStateService {
  private approvalConversationColumnAvailable: boolean | undefined;

  constructor(private readonly db: TransactionDatabase) {}

  private hasFts(): boolean {
    return this.db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'").get() !== undefined;
  }

  search(workspaceId: string, filters: ConversationSearchFilters): ConversationSearchResult[] {
    const query = filters.query.trim();
    const match = buildMatchExpression(query);
    if (match === null) throw new ConversationSearchReadStateError('INPUT_INVALID');
    const limit = filters.limit === undefined
      ? SEARCH_DEFAULT_LIMIT
      : Math.min(Math.max(1, filters.limit), SEARCH_MAX_LIMIT);
    if (filters.limit !== undefined && (!Number.isSafeInteger(filters.limit) || filters.limit < 1)) {
      throw new ConversationSearchReadStateError('INPUT_INVALID');
    }
    if (filters.sender !== undefined && !['user', 'agent', 'system'].includes(filters.sender)) {
      throw new ConversationSearchReadStateError('INPUT_INVALID');
    }
    if (filters.from !== undefined && Number.isNaN(Date.parse(filters.from))) {
      throw new ConversationSearchReadStateError('INPUT_INVALID');
    }
    if (filters.to !== undefined && Number.isNaN(Date.parse(filters.to))) {
      throw new ConversationSearchReadStateError('INPUT_INVALID');
    }
    // The workspace always converges on cr_messages; workspace scoping on the
    // FTS row alone could leak messages across workspaces with the same text.
    const conditions: string[] = ['m.workspace_id = ?', "m.status <> 'deleted'"];
    const params: unknown[] = [workspaceId];
    if (filters.conversationId !== undefined) {
      conditions.push('m.conversation_id = ?');
      params.push(filters.conversationId);
    }
    if (filters.sender !== undefined) {
      conditions.push('m.sender_type = ?');
      params.push(filters.sender);
    }
    if (filters.agentId !== undefined) {
      conditions.push('m.sender_agent_id = ?');
      params.push(filters.agentId);
    }
    if (filters.type !== undefined) {
      conditions.push('m.kind = ?');
      params.push(filters.type);
    }
    if (filters.from !== undefined) {
      conditions.push('m.created_at >= ?');
      params.push(new Date(filters.from).toISOString());
    }
    if (filters.to !== undefined) {
      conditions.push('m.created_at <= ?');
      params.push(new Date(filters.to).toISOString());
    }
    const where = conditions.join(' AND ');
    if (!this.hasFts()) return [];
    const rows = this.db.prepare(`
      SELECT m.id AS messageId, m.conversation_id AS conversationId, m.sequence AS sequence,
        m.sender_type AS senderType, f.sender_display_name AS senderDisplayName,
        m.created_at AS createdAt,
        snippet(messages_fts, 3, '<mark>', '</mark>', '…', 16) AS snippet
      FROM messages_fts AS f
      JOIN cr_messages m ON m.id = f.message_id
      WHERE f.messages_fts MATCH ? AND ${where}
      ORDER BY m.sequence DESC
      LIMIT ?
    `).all(match, ...params, limit) as Array<Omit<ConversationSearchResult, 'matchedTerms'>>;
    const matchedTerms = query.split(/\s+/u).map(token => token.trim()).filter(token => token.length > 0);
    return rows.map(row => ({ ...row, matchedTerms }));
  }

  /**
   * Advance the read position. The position is monotone: a lower sequence
   * than the stored one is a no-op (the stored row is returned unchanged).
   * The whole advance is one IMMEDIATE transaction, so two concurrent writers
   * cannot interleave a read-back.
   */
  markRead(input: {
    readonly workspaceId: string;
    readonly conversationId: string;
    readonly userId: string;
    readonly lastReadMessageSequence?: number;
    readonly latest?: boolean;
    readonly now: string;
  }): ConversationReadStateSnapshot {
    if (input.lastReadMessageSequence === undefined && input.latest !== true) {
      throw new ConversationSearchReadStateError('INPUT_INVALID');
    }
    if (input.lastReadMessageSequence !== undefined
      && (!Number.isSafeInteger(input.lastReadMessageSequence) || input.lastReadMessageSequence < 0)) {
      throw new ConversationSearchReadStateError('INPUT_INVALID');
    }
    return inTransaction(this.db, () => {
      const conversation = this.db.prepare(
        'SELECT id FROM cr_conversations WHERE workspace_id = ? AND id = ?',
      ).get(input.workspaceId, input.conversationId);
      if (conversation === undefined) throw new ConversationSearchReadStateError('CONVERSATION_NOT_FOUND');
      const maxSequence = (this.db.prepare(
        'SELECT COALESCE(MAX(sequence), 0) AS max FROM cr_messages WHERE workspace_id = ? AND conversation_id = ?',
      ).get(input.workspaceId, input.conversationId) as { max: number }).max;
      const target = input.latest === true ? maxSequence : input.lastReadMessageSequence!;
      if (target > maxSequence) throw new ConversationSearchReadStateError('INPUT_INVALID');
      const previous = this.db.prepare(`SELECT last_read_message_sequence FROM conversation_read_states
        WHERE conversation_id = ? AND user_id = ?`).get(input.conversationId, input.userId) as { last_read_message_sequence: number } | undefined;
      // Atomic monotone advance: only rows whose stored position is behind the
      // target move. A conflicting writer either wins the lock or re-reads.
      this.db.prepare(`
        INSERT INTO conversation_read_states (
          conversation_id, user_id, last_read_message_sequence, last_read_message_id,
          last_read_at, unread_count, mention_count, approval_count, updated_at
        ) VALUES (?, ?, ?, NULL, ?, 0, 0, 0, ?)
        ON CONFLICT(conversation_id, user_id) DO UPDATE SET
          last_read_message_sequence = excluded.last_read_message_sequence,
          last_read_message_id = excluded.last_read_message_id,
          last_read_at = excluded.last_read_at,
          updated_at = excluded.updated_at
        WHERE conversation_read_states.last_read_message_sequence <= excluded.last_read_message_sequence
      `).run(input.conversationId, input.userId, target, input.now, input.now);
      const row = this.db.prepare(
        'SELECT * FROM conversation_read_states WHERE conversation_id = ? AND user_id = ?',
      ).get(input.conversationId, input.userId) as ReadStateRow;
      const snapshot = this.snapshot(input.workspaceId, input.userId, row, input.now);
      if (previous === undefined || previous.last_read_message_sequence < target) {
        new ConversationEventRepository(this.db).appendWithinTransaction({
          workspaceId: input.workspaceId, conversationId: input.conversationId, userId: input.userId,
          type: 'conversation.read_state_updated', dedupeKey: `read:${input.userId}:${target}`, timestamp: input.now,
          payload: { readState: snapshot },
        });
      }
      return snapshot;
    });
  }

  readState(workspaceId: string, conversationId: string, userId: string, now: string): ConversationReadStateSnapshot | null {
    const conversation = this.db.prepare(
      'SELECT id FROM cr_conversations WHERE workspace_id = ? AND id = ?',
    ).get(workspaceId, conversationId);
    if (conversation === undefined) return null;
    const row = this.db.prepare(
      'SELECT * FROM conversation_read_states WHERE conversation_id = ? AND user_id = ?',
    ).get(conversationId, userId) as ReadStateRow | undefined;
    if (row === undefined) {
      const counts = this.countUnread(workspaceId, conversationId, 0);
      return {
        conversationId, userId, lastReadMessageSequence: 0, lastReadMessageId: null, lastReadAt: now,
        unreadCount: counts.unreadCount,
        mentionCount: counts.mentionCount,
        approvalCount: this.countPendingApprovals(workspaceId, conversationId, now),
      };
    }
    return this.snapshot(workspaceId, userId, row, now);
  }

  /** Batch read state for the Conversation list page: one row per Conversation. */
  listReadStates(workspaceId: string, userId: string, now: string): ConversationReadStateSnapshot[] {
    const conversations = this.db.prepare(
      'SELECT id FROM cr_conversations WHERE workspace_id = ? ORDER BY updated_at DESC',
    ).all(workspaceId) as Array<{ id: string }>;
    return conversations.map(row => this.readState(workspaceId, row.id, userId, now)!);
  }

  private countUnread(workspaceId: string, conversationId: string, afterSequence: number): { unreadCount: number; mentionCount: number } {
    const rows = this.db.prepare(`
      SELECT content FROM cr_messages
      WHERE workspace_id = ? AND conversation_id = ? AND sequence > ? AND status != 'deleted'
    `).all(workspaceId, conversationId, afterSequence) as Array<{ content: string }>;
    let mentionCount = 0;
    for (const row of rows) {
      if (extractMentionTargets(row.content).length > 0) mentionCount += 1;
    }
    return { unreadCount: rows.length, mentionCount };
  }

  private countPendingApprovals(workspaceId: string, conversationId: string, now: string): number {
    if (this.approvalConversationColumnAvailable === undefined) {
      const table = this.db.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'runtime_approval_requests'",
      ).get();
      const columns = table === undefined
        ? []
        : this.db.prepare('PRAGMA table_info(runtime_approval_requests)').all() as Array<{ name: string }>;
      this.approvalConversationColumnAvailable = columns.some(column => column.name === 'conversation_id');
    }
    const hasApprovals = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runtime_approval_requests'").get();
    if (hasApprovals === undefined) return 0;
    const binding = this.approvalConversationColumnAvailable ? 'conversation_id' : 'NULL';
    const pending = this.db.prepare(`
      SELECT ${binding} AS conversationId, run_id AS runId FROM runtime_approval_requests
      WHERE workspace_id = ? AND status = 'pending' AND expires_at > ?
    `).all(workspaceId, now) as Array<{ conversationId: string | null; runId: string }>;
    return pending.filter(approval => approval.conversationId === conversationId
      || conversationIdsForRun(this.db, workspaceId, approval.runId).includes(conversationId)).length;
  }

  private snapshot(workspaceId: string, userId: string, row: ReadStateRow, now: string): ConversationReadStateSnapshot {
    const counts = this.countUnread(workspaceId, row.conversation_id, row.last_read_message_sequence);
    const approvalCount = this.countPendingApprovals(workspaceId, row.conversation_id, now);
    const lastReadMessage = row.last_read_message_sequence > 0
      ? (this.db.prepare(
        'SELECT id FROM cr_messages WHERE workspace_id = ? AND conversation_id = ? AND sequence = ?',
      ).get(workspaceId, row.conversation_id, row.last_read_message_sequence) as { id: string } | undefined)
      : undefined;
    // Persist the frozen counts so the row stays a faithful §71 snapshot; the
    // live values are still recomputed above on every read (server authority).
    this.db.prepare(`
      UPDATE conversation_read_states
      SET unread_count = ?, mention_count = ?, approval_count = ?, updated_at = ?,
        last_read_message_id = COALESCE(?, last_read_message_id)
      WHERE conversation_id = ? AND user_id = ?
    `).run(counts.unreadCount, counts.mentionCount, approvalCount, now, lastReadMessage?.id ?? null, row.conversation_id, userId);
    return {
      conversationId: row.conversation_id,
      userId: row.user_id,
      lastReadMessageSequence: row.last_read_message_sequence,
      lastReadMessageId: lastReadMessage?.id ?? row.last_read_message_id,
      lastReadAt: row.last_read_at,
      unreadCount: counts.unreadCount,
      mentionCount: counts.mentionCount,
      approvalCount,
    };
  }
}

interface ReadStateRow {
  readonly conversation_id: string;
  readonly user_id: string;
  readonly last_read_message_sequence: number;
  readonly last_read_message_id: string | null;
  readonly last_read_at: string;
}
