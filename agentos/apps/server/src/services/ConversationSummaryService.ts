import { createEntityId } from '../store/Identity.js';
import { inTransaction, isTransactionActive, type TransactionDatabase } from '../store/Transaction.js';
import { eventRedactionServiceForDatabase } from './EventRedactionService.js';
import { ConversationEventRepository } from '../store/ConversationEventRepository.js';

/** §65 automatic Summary trigger, measured from the currently active chain head. */
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
  readonly openQuestions: string[];
  readonly taskReferences: string[];
  readonly runReferences: string[];
  readonly sourceMessageIds: string[];
  readonly generatedAt: string;
  readonly supersedesSummaryId: string | null;
  readonly version: number;
  readonly createdAt: string;
}

export class ConversationSummaryError extends Error {
  constructor(readonly code: 'INPUT_INVALID' | 'CONVERSATION_NOT_FOUND' | 'SUMMARY_TABLE_UNAVAILABLE' | 'ACTIVE_STREAM') {
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
  readonly open_questions_json: string;
  readonly task_references_json: string;
  readonly run_references_json: string;
  readonly source_message_ids_json: string;
  readonly generated_at: string;
  readonly supersedes_summary_id: string | null;
  readonly version: number;
  readonly created_at: string;
}

export function extractSummaryItems(messages: ReadonlyArray<{
  readonly senderType?: string;
  readonly status?: string;
  readonly content: string;
}>): { decisions: string[]; constraints: string[] } {
  const decisions = new Set<string>();
  const constraints = new Set<string>();
  for (const message of messages) {
    const source = summarySourceLabel(message.senderType ?? 'user', message.status);
    for (const rawLine of message.content.split(/\r?\n/)) {
      const line = rawLine.replace(/^\s*[-*•>]\s*/, '').trim();
      if (line.length < 2 || line.length > 500) continue;
      if (DECISION_PATTERN.test(line) && decisions.size < SUMMARY_EXTRACT_MAX_ITEMS) decisions.add(`${source}: ${line}`);
      else if (CONSTRAINT_PATTERN.test(line) && constraints.size < SUMMARY_EXTRACT_MAX_ITEMS) constraints.add(`${source}: ${line}`);
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
      ORDER BY version DESC, created_at DESC, id DESC
    `).all(conversationId) as unknown as SummaryRow[];
    return rows.map(toRecord);
  }

  /** The chain head is the sole active Summary; prior versions remain readable. */
  latest(workspaceId: string, conversationId: string): ConversationSummaryRecord | null {
    this.requireTable();
    this.assertConversation(workspaceId, conversationId);
    const row = this.db.prepare(`
      SELECT current.* FROM conversation_summaries current
      WHERE current.conversation_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM conversation_summaries successor
          WHERE successor.supersedes_summary_id = current.id
        )
      ORDER BY current.version DESC
      LIMIT 1
    `).get(conversationId) as SummaryRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  /** Append a new version for uncovered messages; the active head is never overwritten. */
  createVersion(input: {
    readonly workspaceId: string;
    readonly conversationId: string;
    readonly trigger: ConversationSummaryTrigger;
  }): { readonly created: boolean; readonly summary: ConversationSummaryRecord | null } {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.conversationId)
      || (input.trigger !== 'manual' && input.trigger !== 'auto-message-threshold')) {
      throw new ConversationSummaryError('INPUT_INVALID');
    }
    this.requireTable();
    return this.atomic(() => this.createVersionWithinTransaction(input));
  }

  /** Auto trigger called after each committed final message append. */
  maybeAutoSummarize(workspaceId: string, conversationId: string): { readonly created: boolean; readonly summary: ConversationSummaryRecord | null } {
    if (!this.hasTable()) return { created: false, summary: null };
    if (!nonBlank(workspaceId) || !nonBlank(conversationId)) throw new ConversationSummaryError('INPUT_INVALID');
    return this.atomic(() => {
      this.assertConversation(workspaceId, conversationId);
      const head = this.latest(workspaceId, conversationId);
      const afterSequence = head?.toSequence ?? 0;
      const pending = this.db.prepare(`
        SELECT 1 AS present FROM cr_messages
        WHERE workspace_id = ? AND conversation_id = ? AND sequence > ? AND status = 'streaming'
        LIMIT 1
      `).get(workspaceId, conversationId, afterSequence);
      if (pending !== undefined) return { created: false, summary: head };
      const count = (this.db.prepare(`
        SELECT COUNT(*) AS count FROM cr_messages
        WHERE workspace_id = ? AND conversation_id = ? AND sequence > ? AND status <> 'deleted'
      `).get(workspaceId, conversationId, afterSequence) as { count: number }).count;
      if (count < SUMMARY_AUTO_TRIGGER_MESSAGE_THRESHOLD) return { created: false, summary: head };
      return this.createVersionWithinTransaction({
        workspaceId, conversationId, trigger: 'auto-message-threshold',
      });
    });
  }

  private createVersionWithinTransaction(input: {
    readonly workspaceId: string;
    readonly conversationId: string;
    readonly trigger: ConversationSummaryTrigger;
  }): { readonly created: boolean; readonly summary: ConversationSummaryRecord | null } {
    this.assertConversation(input.workspaceId, input.conversationId);
    const head = this.latest(input.workspaceId, input.conversationId);
    const afterSequence = head?.toSequence ?? 0;
    const pending = this.db.prepare(`
      SELECT 1 AS present FROM cr_messages
      WHERE workspace_id = ? AND conversation_id = ? AND sequence > ? AND status = 'streaming'
      LIMIT 1
    `).get(input.workspaceId, input.conversationId, afterSequence);
    if (pending !== undefined) {
      if (input.trigger === 'manual') throw new ConversationSummaryError('ACTIVE_STREAM');
      return { created: false, summary: head };
    }
    const maxSequence = (this.db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS max FROM cr_messages
      WHERE workspace_id = ? AND conversation_id = ? AND status <> 'deleted'
    `).get(input.workspaceId, input.conversationId) as { max: number }).max;
    if (maxSequence <= afterSequence) return { created: false, summary: head };
    const fromSequence = head === null ? 1 : head.toSequence + 1;
    const rows = this.db.prepare(`
        SELECT id, sender_type AS senderType, status, content, task_id AS taskId, run_id AS runId FROM cr_messages
      WHERE workspace_id = ? AND conversation_id = ? AND sequence >= ? AND sequence <= ? AND status <> 'deleted'
      ORDER BY sequence ASC
    `).all(input.workspaceId, input.conversationId, fromSequence, maxSequence) as Array<{
      id: string;
      senderType: string;
      status: string;
      content: string;
      taskId: string | null;
      runId: string | null;
    }>;
    const redactor = eventRedactionServiceForDatabase(this.db);
    const messages = rows.map(row => ({
      ...row,
      content: redactText(redactor.redactPayload(input.workspaceId, row.content).value),
    }));
    const { decisions, constraints } = extractSummaryItems(messages);
    const openQuestions = [...new Set(messages.flatMap(message => message.content.split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => /[?？]$/u.test(line) && line.length <= 500)
      .map(line => `${summarySourceLabel(message.senderType, message.status)}: ${line}`)))].slice(0, SUMMARY_EXTRACT_MAX_ITEMS);
    const taskReferences = [...new Set(rows.flatMap(row => row.taskId ? [row.taskId] : []))];
    const runReferences = [...new Set(rows.flatMap(row => row.runId ? [row.runId] : []))];
    const sourceMessageIds = rows.map(row => row.id);
    const version = (head?.version ?? 0) + 1;
    const summaryText = buildSummaryText(version, fromSequence, maxSequence, messages);
    const id = createEntityId('conversationSummary');
    const createdAt = this.now();
    this.db.prepare(`
      INSERT INTO conversation_summaries (
        id, conversation_id, from_sequence, to_sequence, summary,
        decisions_json, constraints_json, open_questions_json, task_references_json, run_references_json,
        source_message_ids_json, generated_at, supersedes_summary_id, version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.conversationId, fromSequence, maxSequence, summaryText,
      JSON.stringify(decisions), JSON.stringify(constraints), JSON.stringify(openQuestions), JSON.stringify(taskReferences),
      JSON.stringify(runReferences), JSON.stringify(sourceMessageIds), createdAt, head?.id ?? null, version, createdAt,
    );
    const events = new ConversationEventRepository(this.db);
    events.appendWithinTransaction({
      workspaceId: input.workspaceId, conversationId: input.conversationId,
      type: 'conversation.summary_created', dedupeKey: `summary-created:${id}`, timestamp: createdAt,
      payload: { summaryId: id, fromSequence, toSequence: maxSequence, sourceMessageCount: messages.length,
        generatedBy: 'deterministic-extraction-v1', trigger: input.trigger, version },
    });
    if (head !== null) events.appendWithinTransaction({
      workspaceId: input.workspaceId, conversationId: input.conversationId,
      type: 'conversation.summary_superseded', dedupeKey: `summary-superseded:${head.id}`, timestamp: createdAt,
      payload: { summaryId: head.id, supersededBySummaryId: id, activeSummaryId: id },
    });
    return {
      created: true,
      summary: {
        id, conversationId: input.conversationId, fromSequence, toSequence: maxSequence,
        summary: summaryText, decisions, constraints,
        openQuestions, taskReferences, runReferences, sourceMessageIds, generatedAt: createdAt,
        supersedesSummaryId: head?.id ?? null, version, createdAt,
      },
    };
  }

  private atomic<T>(run: () => T): T {
    return isTransactionActive(this.db) ? run() : inTransaction(this.db, run);
  }

  private assertConversation(workspaceId: string, conversationId: string): void {
    const row = this.db.prepare('SELECT id FROM cr_conversations WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, conversationId);
    if (row === undefined) throw new ConversationSummaryError('CONVERSATION_NOT_FOUND');
  }
}

function nonBlank(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function redactText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function buildSummaryText(
  version: number,
  fromSequence: number,
  toSequence: number,
  messages: ReadonlyArray<{ senderType: string; status: string; content: string }>,
): string {
  const body = messages.map(message => {
    const content = message.content.replace(/\s+/gu, ' ').trim();
    if (content.length === 0) return '';
    const excerpt = content.length > 120 ? content.slice(0, 120) + '…' : content;
    return `${summarySourceLabel(message.senderType, message.status)}: ${excerpt}`;
  }).filter(line => line.length > 0).join('\n');
  const header = `Conversation summary v${version} (messages ${fromSequence}–${toSequence}, ${messages.length} messages)`;
  const text = `${header}\n${body}`.trim();
  return text.length > SUMMARY_TEXT_MAX_CHARS ? text.slice(0, SUMMARY_TEXT_MAX_CHARS) + '…' : text;
}

function summarySourceLabel(senderType: string, status?: string): string {
  const role = senderType === 'agent' ? 'Agent' : senderType === 'system' ? 'System' : 'User';
  return status !== undefined && status !== 'final' ? `${role} (${status})` : role;
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
    openQuestions: JSON.parse(row.open_questions_json) as string[],
    taskReferences: JSON.parse(row.task_references_json) as string[],
    runReferences: JSON.parse(row.run_references_json) as string[],
    sourceMessageIds: JSON.parse(row.source_message_ids_json) as string[],
    generatedAt: row.generated_at,
    supersedesSummaryId: row.supersedes_summary_id,
    version: row.version,
    createdAt: row.created_at,
  };
}
