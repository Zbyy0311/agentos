import { randomUUID } from 'node:crypto';
import type { TransactionDatabase } from '../store/Transaction.js';

/**
 * Versioned Conversation Summary (09-Conversation-Runtime §64/§65).
 *
 * A Summary is a versioned, append-only artifact: creating one always INSERTs
 * a new row whose supersedes_summary_id points at the previous head, and old
 * rows are never updated (there is no update path in this service). The
 * version chain is the supersedes pointer; `version` is the 1-based depth.
 *
 * Generation is a deterministic rules extraction (§65 trigger -> extraction,
 * no LLM call): user messages contribute topics, and decisions/constraints are
 * lines matching fixed marker patterns. This is deliberately separate from
 * ConversationCompactionService: compaction rewrites runtime context for the
 * Turn driver, while this produces durable, user-visible Summary versions.
 */

export const SUMMARY_AUTO_TRIGGER_MESSAGE_THRESHOLD = 50;
export const SUMMARY_EXTRACT_MAX_ITEMS = 20;
export const SUMMARY_TEXT_MAX_CHARS = 2000;

const DECISION_PATTERN = /(决定|确认采用|结论是|我们采用|方案确定|decided|decision\s*:|agreed|conclusion)/iu;
const CONSTRAINT_PATTERN = /(必须|不得|禁止|不应该|约束条件|must not|must|never|required|forbidden)/iu;

export type ConversationSummaryTrigger = 'manual' | 'auto-message-threshold';

export interface ConversationSummaryRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly fromSequence: number;
  readonly toSequence: number;
  readonly summary: string;
  readonly decisions: string[];
  readonly constraints: string[];
  readonly supersedesSummaryId: string | null;
  readonly version: number;
  readonly createdAt: string;
}

export class ConversationSummaryError extends Error {
  constructor(readonly code: 'INPUT_INVALID' | 'CONVERSATION_NOT_FOUND' | 'SUMMARY_TABLE_UNAVAILABLE') {
    super('CONVERSATION_SUMMARY_' + code);
    this.name = 'ConversationSummaryError';
  }
}

interface SummaryRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly from_sequence: number;
  readonly to_sequence: number;
  readonly summary: string;
  readonly decisions_json: string;
  readonly constraints_json: string;
  readonly supersedes_summary_id: string | null;
  readonly version: number;
  readonly created_at: string;
}

export function extractSummaryItems(messages: ReadonlyArray<Pick<{ content: string }, 'content'>>): { decisions: string[]; constraints: string[] } {
  const decisions = new Set<string>();
  const constraints = new Set<string>();
  for (const message of messages) {
    for (const rawLine of message.content.split(/\r?\n/)) {
      const line = rawLine.replace(/^\s*[-*•>]\s*/, '').trim();
      if (line.length < 2 || line.length > 500) continue;
      if (DECISION_PATTERN.test(line) && decisions.size < SUMMARY_EXTRACT_MAX_ITEMS) decisions.add(line);
      else if (CONSTRAINT_PATTERN.test(line) && constraints.size < SUMMARY_EXTRACT_MAX_ITEMS) constraints.add(line);
    }
  }
  return { decisions: [...decisions], constraints: [...constraints] };
}

export class ConversationSummaryService {
  private tableAvailable: boolean | undefined;

  constructor(
    private readonly db: TransactionDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private hasTable(): boolean {
    if (this.tableAvailable === undefined) {
      this.tableAvailable = this.db.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'conversation_summaries'",
      ).get() !== undefined;
    }
    return this.tableAvailable;
  }

  private requireTable(): void {
    if (!this.hasTable()) throw new ConversationSummaryError('SUMMARY_TABLE_UNAVAILABLE');
  }

  list(workspaceId: string, conversationId: string): ConversationSummaryRecord[] {
    this.requireTable();
    this.assertConversation(workspaceId, conversationId);
    const rows = this.db.prepare(`
      SELECT * FROM conversation_summaries
      WHERE conversation_id = ?
      ORDER BY to_sequence DESC, created_at DESC, id DESC
    `).all(conversationId) as unknown as SummaryRow[];
    return rows.map(row => toRecord(row));
  }

  latest(workspaceId: string, conversationId: string): ConversationSummaryRecord | null {
    return this.list(workspaceId, conversationId)[0] ?? null;
  }

  /**
   * Create the next Summary version covering messages after the current head.
   * Returns { created: false } when nothing new exists since the latest
   * version — Summary versions never overlap and never re-cover old ranges.
   */
  createVersion(input: {
    readonly workspaceId: string;
    readonly conversationId: string;
    readonly trigger: ConversationSummaryTrigger;
  }): { readonly created: boolean; readonly summary: ConversationSummaryRecord | null } {
    this.requireTable();
    this.assertConversation(input.workspaceId, input.conversationId);
    const head = this.latest(input.workspaceId, input.conversationId);
    const maxSequence = (this.db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS max FROM cr_messages
      WHERE workspace_id = ? AND conversation_id = ? AND status != 'deleted'
    `).get(input.workspaceId, input.conversationId) as { max: number }).max;
    if (maxSequence === 0 || (head !== null && maxSequence <= head.toSequence)) {
      return { created: false, summary: head };
    }
    const fromSequence = head !== null ? head.toSequence + 1 : 1;
    const messages = this.db.prepare(`
      SELECT id, sender_type AS senderType, content FROM cr_messages
      WHERE workspace_id = ? AND conversation_id = ? AND sequence >= ? AND status != 'deleted'
      ORDER BY sequence ASC
    `).all(input.workspaceId, input.conversationId, fromSequence) as Array<{ id: string; senderType: string; content: string }>;
    const { decisions, constraints } = extractSummaryItems(messages);
    const version = (head?.version ?? 0) + 1;
    const summaryText = buildSummaryText(version, fromSequence, maxSequence, messages);
    const id = randomUUID();
    const createdAt = this.now();
    this.db.prepare(`
      INSERT INTO conversation_summaries (
        id, conversation_id, from_sequence, to_sequence, summary,
        decisions_json, constraints_json, supersedes_summary_id, version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.conversationId, fromSequence, maxSequence, summaryText,
      JSON.stringify(decisions), JSON.stringify(constraints),
      head !== null ? head.id : null, version, createdAt,
    );
    return {
      created: true,
      summary: {
        id, conversationId: input.conversationId, fromSequence, toSequence: maxSequence,
        summary: summaryText, decisions, constraints,
        supersedesSummaryId: head !== null ? head.id : null, version, createdAt,
      },
    };
  }

  /**
   * §65 automatic trigger: fire when the Conversation has grown past the
   * frozen head of the version chain by at least the message threshold.
   */
  maybeAutoSummarize(workspaceId: string, conversationId: string): { readonly created: boolean; readonly summary: ConversationSummaryRecord | null } {
    this.requireTable();
    const head = this.latest(workspaceId, conversationId);
    const messageCount = (this.db.prepare(`
      SELECT COUNT(*) AS count FROM cr_messages
      WHERE workspace_id = ? AND conversation_id = ? AND status != 'deleted'
    `).get(workspaceId, conversationId) as { count: number }).count;
    const covered = head?.toSequence ?? 0;
    if (messageCount - covered < SUMMARY_AUTO_TRIGGER_MESSAGE_THRESHOLD) return { created: false, summary: head };
    return this.createVersion({ workspaceId, conversationId, trigger: 'auto-message-threshold' });
  }

  private assertConversation(workspaceId: string, conversationId: string): void {
    const row = this.db.prepare('SELECT id FROM cr_conversations WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, conversationId);
    if (row === undefined) throw new ConversationSummaryError('CONVERSATION_NOT_FOUND');
  }
}

function buildSummaryText(
  version: number,
  fromSequence: number,
  toSequence: number,
  messages: ReadonlyArray<{ senderType: string; content: string }>,
): string {
  const userTopics = messages
    .filter(message => message.senderType === 'user')
    .map(message => message.content.replace(/\s+/gu, ' ').trim())
    .filter(content => content.length > 0)
    .map(content => content.length > 120 ? content.slice(0, 120) + '…' : content);
  const body = userTopics.length > 0
    ? userTopics.join('\n')
    : messages.map(message => message.content.replace(/\s+/gu, ' ').trim()).filter(content => content.length > 0).join('\n');
  const header = `Conversation summary v${version} (messages ${fromSequence}–${toSequence}, ${messages.length} messages)`;
  const text = `${header}\n${body}`.trim();
  return text.length > SUMMARY_TEXT_MAX_CHARS ? text.slice(0, SUMMARY_TEXT_MAX_CHARS) + '…' : text;
}

function toRecord(row: SummaryRow): ConversationSummaryRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    fromSequence: row.from_sequence,
    toSequence: row.to_sequence,
    summary: row.summary,
    decisions: JSON.parse(row.decisions_json) as string[],
    constraints: JSON.parse(row.constraints_json) as string[],
    supersedesSummaryId: row.supersedes_summary_id,
    version: row.version,
    createdAt: row.created_at,
  };
}
