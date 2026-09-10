import {
  CONVERSATION_KINDS,
  CONVERSATION_REPLY_MODES,
  CONVERSATION_STATUSES,
  MEMBER_REPLY_MODES,
  MEMBER_ROLES,
  MEMBER_STATUSES,
  MEMBER_SUBJECT_TYPES,
  MESSAGE_KINDS,
  MESSAGE_STATUSES,
  canTransitionConversation,
  canTransitionMessage,
  type ConversationKind,
  type ConversationLifecycleAction,
  type ConversationReplyMode,
  type ConversationStatus,
  type MemberReplyMode,
  type MemberRole,
  type MemberStatus,
  type MemberSubjectType,
  type MessageKind,
  type MessageStatus,
} from '@agentos/shared';
import { inTransaction, type TransactionDatabase } from './Transaction.js';

/**
 * CR-1 forward Conversation persistence.
 *
 * This is a narrow persistence seam ONLY. It contains no streaming, Event
 * projection, Task/Run bridge, group orchestration, API, or UI; those belong to
 * later Conversation Runtime slices.
 *
 * Frozen design: `docs/implementation/milestones/CR1-schema-authorization.md`.
 */

export type ConversationRepositoryErrorCode =
  | 'INPUT_INVALID'
  | 'WORKSPACE_NOT_FOUND'
  | 'CONVERSATION_NOT_FOUND'
  | 'CONVERSATION_NOT_TRANSITIONABLE'
  | 'MEMBER_NOT_FOUND'
  | 'MESSAGE_NOT_FOUND'
  | 'MESSAGE_NOT_TRANSITIONABLE'
  | 'SEQUENCE_CONFLICT'
  | 'PERSISTENCE_FAILED';

export class ConversationRepositoryError extends Error {
  constructor(readonly code: ConversationRepositoryErrorCode) {
    super(`CONVERSATION_${code}`);
    this.name = 'ConversationRepositoryError';
  }
}

export interface CreateConversationInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: ConversationKind;
  readonly title: string;
  readonly replyMode?: ConversationReplyMode;
  readonly createdAt: string;
}

export interface ConversationRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: ConversationKind;
  readonly title: string;
  readonly status: ConversationStatus;
  readonly replyMode: ConversationReplyMode | null;
  readonly lastMessageId: string | null;
  readonly lastMessageAt: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface AddMemberInput {
  readonly id: string;
  readonly conversationId: string;
  readonly workspaceId: string;
  readonly subjectType: MemberSubjectType;
  readonly subjectId: string;
  readonly displayNameSnapshot: string;
  readonly role: MemberRole;
  readonly replyMode: MemberReplyMode;
  readonly joinedAt: string;
}

export interface MemberRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly workspaceId: string;
  readonly subjectType: MemberSubjectType;
  readonly subjectId: string;
  readonly displayNameSnapshot: string;
  readonly role: MemberRole;
  readonly replyMode: MemberReplyMode;
  readonly status: MemberStatus;
  readonly joinedAt: string;
  readonly removedAt: string | null;
  readonly version: number;
}

export interface AppendMessageInput {
  readonly id: string;
  readonly conversationId: string;
  readonly workspaceId: string;
  readonly senderType: 'user' | 'agent' | 'system';
  readonly senderAgentId?: string;
  readonly kind: MessageKind;
  readonly status: MessageStatus;
  readonly content: string;
  readonly clientMessageId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly sourceEventId?: string;
  readonly replyToMessageId?: string;
  readonly createdAt: string;
}

export interface MessageRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly workspaceId: string;
  readonly sequence: number;
  readonly senderType: 'user' | 'agent' | 'system';
  readonly senderAgentId: string | null;
  readonly kind: MessageKind;
  readonly status: MessageStatus;
  readonly content: string;
  readonly clientMessageId: string | null;
  readonly taskId: string | null;
  readonly runId: string | null;
  readonly sourceEventId: string | null;
  readonly replyToMessageId: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TransitionMessageStatusInput {
  readonly workspaceId: string;
  readonly messageId: string;
  readonly expectedVersion: number;
  readonly to: MessageStatus;
  readonly content?: string;
  readonly changedAt: string;
}

export interface BindMessageReferencesInput {
  readonly workspaceId: string;
  readonly messageId: string;
  readonly expectedVersion: number;
  readonly taskId?: string;
  readonly runId?: string;
  readonly boundAt: string;
}

interface ConversationRow {
  id: string;
  workspace_id: string;
  kind: string;
  title: string;
  status: string;
  reply_mode: string | null;
  last_message_id: string | null;
  last_message_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface MemberRow {
  id: string;
  conversation_id: string;
  workspace_id: string;
  subject_type: string;
  subject_id: string;
  display_name_snapshot: string;
  role: string;
  reply_mode: string;
  status: string;
  joined_at: string;
  removed_at: string | null;
  version: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  workspace_id: string;
  sequence: number;
  sender_type: string;
  sender_agent_id: string | null;
  kind: string;
  status: string;
  content: string;
  client_message_id: string | null;
  task_id: string | null;
  run_id: string | null;
  source_event_id: string | null;
  reply_to_message_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function isKind(value: unknown): value is ConversationKind {
  return (CONVERSATION_KINDS as readonly unknown[]).includes(value);
}
function isStatus(value: unknown): value is ConversationStatus {
  return (CONVERSATION_STATUSES as readonly unknown[]).includes(value);
}
function isReplyMode(value: unknown): value is ConversationReplyMode {
  return (CONVERSATION_REPLY_MODES as readonly unknown[]).includes(value);
}
function isMemberSubject(value: unknown): value is MemberSubjectType {
  return (MEMBER_SUBJECT_TYPES as readonly unknown[]).includes(value);
}
function isMemberRole(value: unknown): value is MemberRole {
  return (MEMBER_ROLES as readonly unknown[]).includes(value);
}
function isMemberReplyMode(value: unknown): value is MemberReplyMode {
  return (MEMBER_REPLY_MODES as readonly unknown[]).includes(value);
}
function isMessageKind(value: unknown): value is MessageKind {
  return (MESSAGE_KINDS as readonly unknown[]).includes(value);
}
function isMessageStatus(value: unknown): value is MessageStatus {
  return (MESSAGE_STATUSES as readonly unknown[]).includes(value);
}

export class ConversationRepository {
  constructor(private readonly db: TransactionDatabase) {}

  createConversation(input: CreateConversationInput): ConversationRecord {
    if (!nonBlank(input.id) || !nonBlank(input.workspaceId) || !nonBlank(input.title)
      || !nonBlank(input.createdAt) || !isKind(input.kind)) {
      throw new ConversationRepositoryError('INPUT_INVALID');
    }
    if (input.replyMode !== undefined && !isReplyMode(input.replyMode)) {
      throw new ConversationRepositoryError('INPUT_INVALID');
    }
    // A direct Conversation has no reply mode.
    if (input.kind === 'direct' && input.replyMode !== undefined) {
      throw new ConversationRepositoryError('INPUT_INVALID');
    }
    try {
      return inTransaction(this.db, () => {
        this.assertWorkspaceExists(input.workspaceId);
        this.db.prepare(
          'INSERT INTO cr_conversations (id, workspace_id, kind, title, status, reply_mode, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
        ).run(
          input.id, input.workspaceId, input.kind, input.title, 'active',
          input.replyMode ?? null, input.createdAt, input.createdAt,
        );
        return this.requireConversation(input.workspaceId, input.id);
      });
    } catch (error) {
      throw this.publicError(error);
    }
  }

  findConversationById(workspaceId: string, conversationId: string): ConversationRecord | undefined {
    if (!nonBlank(workspaceId) || !nonBlank(conversationId)) return undefined;
    const row = this.db.prepare(
      'SELECT * FROM cr_conversations WHERE workspace_id = ? AND id = ?',
    ).get(workspaceId, conversationId) as ConversationRow | undefined;
    return row === undefined ? undefined : toConversationRecord(row);
  }

  /** Archive or restore under optimistic concurrency; never cascades. */
  transitionConversation(input: {
    readonly workspaceId: string;
    readonly conversationId: string;
    readonly expectedVersion: number;
    readonly action: ConversationLifecycleAction;
    readonly changedAt: string;
  }): ConversationRecord {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.conversationId)
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1
      || !nonBlank(input.changedAt)
      || (input.action !== 'archive' && input.action !== 'restore')) {
      throw new ConversationRepositoryError('INPUT_INVALID');
    }
    try {
      return inTransaction(this.db, () => {
        const current = this.db.prepare(
          'SELECT * FROM cr_conversations WHERE workspace_id = ? AND id = ?',
        ).get(input.workspaceId, input.conversationId) as ConversationRow | undefined;
        if (current === undefined) throw new ConversationRepositoryError('CONVERSATION_NOT_FOUND');
        if (current.version !== input.expectedVersion
          || !canTransitionConversation(current.status as ConversationStatus, input.action)) {
          throw new ConversationRepositoryError('CONVERSATION_NOT_TRANSITIONABLE');
        }
        const nextStatus: ConversationStatus = input.action === 'archive' ? 'archived' : 'active';
        this.db.prepare(
          'UPDATE cr_conversations SET status = ?, archived_at = ?, version = version + 1, updated_at = ? WHERE workspace_id = ? AND id = ? AND version = ?',
        ).run(nextStatus, input.action === 'archive' ? input.changedAt : null, input.changedAt, input.workspaceId, input.conversationId, input.expectedVersion);
        return this.requireConversation(input.workspaceId, input.conversationId);
      });
    } catch (error) {
      throw this.publicError(error);
    }
  }

  addMember(input: AddMemberInput): MemberRecord {
    if (!nonBlank(input.id) || !nonBlank(input.conversationId) || !nonBlank(input.workspaceId)
      || !nonBlank(input.subjectId) || !nonBlank(input.displayNameSnapshot) || !nonBlank(input.joinedAt)
      || !isMemberSubject(input.subjectType) || !isMemberRole(input.role)
      || !isMemberReplyMode(input.replyMode)) {
      throw new ConversationRepositoryError('INPUT_INVALID');
    }
    try {
      return inTransaction(this.db, () => {
        this.assertConversation(input.workspaceId, input.conversationId);
        this.db.prepare(
          'INSERT INTO cr_conversation_members (id, conversation_id, workspace_id, subject_type, subject_id, display_name_snapshot, role, reply_mode, status, joined_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
        ).run(
          input.id, input.conversationId, input.workspaceId, input.subjectType,
          input.subjectId, input.displayNameSnapshot, input.role, input.replyMode,
          'active', input.joinedAt,
        );
        return this.requireMember(input.workspaceId, input.conversationId, input.id);
      });
    } catch (error) {
      throw this.publicError(error);
    }
  }

  listMembers(workspaceId: string, conversationId: string): MemberRecord[] {
    if (!nonBlank(workspaceId) || !nonBlank(conversationId)) return [];
    const rows = this.db.prepare(
      'SELECT * FROM cr_conversation_members WHERE workspace_id = ? AND conversation_id = ? ORDER BY id ASC',
    ).all(workspaceId, conversationId) as MemberRow[];
    return rows.map(toMemberRecord);
  }

  /**
   * Append a Message with a transactional per-Conversation sequence. A repeated
   * `clientMessageId` converges on the existing Message instead of creating a
   * second row.
   */
  appendMessage(input: AppendMessageInput): MessageRecord {
    try {
      return inTransaction(this.db, () => this.appendMessageWithinTransaction(input));
    } catch (error) {
      throw this.publicError(error);
    }
  }

  /**
   * Transaction-free variant: callers already inside `inTransaction` compose a
   * Message append with other durable writes (for example the CR-3 streaming
   * reservation and finalization).
   */
  appendMessageWithinTransaction(input: AppendMessageInput): MessageRecord {
    this.validateMessageInput(input);
    this.assertConversation(input.workspaceId, input.conversationId);
    if (input.clientMessageId !== undefined) {
      const existing = this.db.prepare(
        'SELECT * FROM cr_messages WHERE conversation_id = ? AND client_message_id = ?',
      ).get(input.conversationId, input.clientMessageId) as MessageRow | undefined;
      if (existing !== undefined) return toMessageRecord(existing);
    }
    const next = (this.db.prepare(
      'SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM cr_messages WHERE conversation_id = ?',
    ).get(input.conversationId) as { next: number }).next;
    this.db.prepare(
      'INSERT INTO cr_messages (id, conversation_id, workspace_id, sequence, sender_type, sender_agent_id, kind, status, content, client_message_id, task_id, run_id, source_event_id, reply_to_message_id, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
    ).run(
      input.id, input.conversationId, input.workspaceId, next, input.senderType,
      input.senderAgentId ?? null, input.kind, input.status, input.content,
      input.clientMessageId ?? null, input.taskId ?? null, input.runId ?? null,
      input.sourceEventId ?? null, input.replyToMessageId ?? null,
      input.createdAt, input.createdAt,
    );
    this.db.prepare(
      'UPDATE cr_conversations SET last_message_id = ?, last_message_at = ?, version = version + 1, updated_at = ? WHERE workspace_id = ? AND id = ?',
    ).run(input.id, input.createdAt, input.createdAt, input.workspaceId, input.conversationId);
    return this.requireMessage(input.workspaceId, input.id);
  }

  /**
   * Edit Message content: appends a revision and updates the Message under
   * optimistic concurrency. History is never lost.
   */
  editMessage(input: {
    readonly workspaceId: string;
    readonly messageId: string;
    readonly expectedVersion: number;
    readonly content: string;
    readonly revisionId: string;
    readonly editedAt: string;
  }): MessageRecord {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.messageId)
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1
      || typeof input.content !== 'string' || !nonBlank(input.revisionId) || !nonBlank(input.editedAt)) {
      throw new ConversationRepositoryError('INPUT_INVALID');
    }
    try {
      return inTransaction(this.db, () => {
        const current = this.db.prepare(
          'SELECT * FROM cr_messages WHERE workspace_id = ? AND id = ?',
        ).get(input.workspaceId, input.messageId) as MessageRow | undefined;
        if (current === undefined) throw new ConversationRepositoryError('MESSAGE_NOT_FOUND');
        if (current.version !== input.expectedVersion) {
          throw new ConversationRepositoryError('PERSISTENCE_FAILED');
        }
        const nextRevision = (this.db.prepare(
          'SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM cr_message_revisions WHERE message_id = ?',
        ).get(input.messageId) as { next: number }).next;
        this.db.prepare(
          'INSERT INTO cr_message_revisions (id, message_id, revision, content, edited_at) VALUES (?, ?, ?, ?, ?)',
        ).run(input.revisionId, input.messageId, nextRevision, input.content, input.editedAt);
        this.db.prepare(
          'UPDATE cr_messages SET content = ?, status = ?, version = version + 1, updated_at = ? WHERE workspace_id = ? AND id = ? AND version = ?',
        ).run(input.content, 'edited', input.editedAt, input.workspaceId, input.messageId, input.expectedVersion);
        return this.requireMessage(input.workspaceId, input.messageId);
      });
    } catch (error) {
      throw this.publicError(error);
    }
  }

  listMessages(workspaceId: string, conversationId: string, afterSequence = 0): MessageRecord[] {
    if (!nonBlank(workspaceId) || !nonBlank(conversationId)) return [];
    const rows = this.db.prepare(
      'SELECT * FROM cr_messages WHERE workspace_id = ? AND conversation_id = ? AND sequence > ? ORDER BY sequence ASC',
    ).all(workspaceId, conversationId, afterSequence) as MessageRow[];
    return rows.map(toMessageRecord);
  }

  findMessageBySourceEvent(workspaceId: string, sourceEventId: string): MessageRecord | undefined {
    if (!nonBlank(workspaceId) || !nonBlank(sourceEventId)) return undefined;
    const row = this.db.prepare(
      'SELECT * FROM cr_messages WHERE workspace_id = ? AND source_event_id = ? ORDER BY sequence ASC LIMIT 1',
    ).get(workspaceId, sourceEventId) as MessageRow | undefined;
    return row === undefined ? undefined : toMessageRecord(row);
  }

  /**
   * CR-4 bridge seam: bind durable Task/Run references onto a Message under
   * optimistic concurrency. Message identity, sequence, and content are
   * untouched; a reference is only ever added, never cleared.
   */
  bindMessageReferences(input: BindMessageReferencesInput): MessageRecord {
    try {
      return inTransaction(this.db, () => this.bindMessageReferencesWithinTransaction(input));
    } catch (error) {
      throw this.publicError(error);
    }
  }

  /** Transaction-free variant for callers already inside `inTransaction`. */
  bindMessageReferencesWithinTransaction(input: BindMessageReferencesInput): MessageRecord {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.messageId)
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1
      || !nonBlank(input.boundAt)
      || (input.taskId === undefined && input.runId === undefined)) {
      throw new ConversationRepositoryError('INPUT_INVALID');
    }
    const current = this.db.prepare(
      'SELECT * FROM cr_messages WHERE workspace_id = ? AND id = ?',
    ).get(input.workspaceId, input.messageId) as MessageRow | undefined;
    if (current === undefined) throw new ConversationRepositoryError('MESSAGE_NOT_FOUND');
    if (current.version !== input.expectedVersion) {
      throw new ConversationRepositoryError('MESSAGE_NOT_TRANSITIONABLE');
    }
    this.db.prepare(
      'UPDATE cr_messages SET task_id = COALESCE(?, task_id), run_id = COALESCE(?, run_id), version = version + 1, updated_at = ? WHERE workspace_id = ? AND id = ? AND version = ?',
    ).run(
      input.taskId ?? null, input.runId ?? null, input.boundAt,
      input.workspaceId, input.messageId, input.expectedVersion,
    );
    return this.requireMessage(input.workspaceId, input.messageId);
  }

  findMessageById(workspaceId: string, messageId: string): MessageRecord | undefined {
    if (!nonBlank(workspaceId) || !nonBlank(messageId)) return undefined;
    const row = this.db.prepare(
      'SELECT * FROM cr_messages WHERE workspace_id = ? AND id = ?',
    ).get(workspaceId, messageId) as MessageRow | undefined;
    return row === undefined ? undefined : toMessageRecord(row);
  }

  /**
   * CR-3 finalization primitive: move a Message to a frozen next status under
   * optimistic concurrency. Identity fields stay immutable and the allowed
   * transition set is frozen by the shared contracts.
   */
  transitionMessageStatus(input: TransitionMessageStatusInput): MessageRecord {
    try {
      return inTransaction(this.db, () => this.transitionMessageStatusWithinTransaction(input));
    } catch (error) {
      throw this.publicError(error);
    }
  }

  /** Transaction-free variant of `transitionMessageStatus`. */
  transitionMessageStatusWithinTransaction(input: TransitionMessageStatusInput): MessageRecord {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.messageId)
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1
      || !nonBlank(input.changedAt) || !isMessageStatus(input.to)) {
      throw new ConversationRepositoryError('INPUT_INVALID');
    }
    const current = this.db.prepare(
      'SELECT * FROM cr_messages WHERE workspace_id = ? AND id = ?',
    ).get(input.workspaceId, input.messageId) as MessageRow | undefined;
    if (current === undefined) throw new ConversationRepositoryError('MESSAGE_NOT_FOUND');
    if (current.version !== input.expectedVersion
      || !canTransitionMessage(current.status as MessageStatus, input.to)) {
      throw new ConversationRepositoryError('MESSAGE_NOT_TRANSITIONABLE');
    }
    this.db.prepare(
      'UPDATE cr_messages SET status = ?, content = COALESCE(?, content), version = version + 1, updated_at = ? WHERE workspace_id = ? AND id = ? AND version = ?',
    ).run(
      input.to, input.content ?? null, input.changedAt,
      input.workspaceId, input.messageId, input.expectedVersion,
    );
    return this.requireMessage(input.workspaceId, input.messageId);
  }

  private validateMessageInput(input: AppendMessageInput): void {
    if (!nonBlank(input.id) || !nonBlank(input.conversationId) || !nonBlank(input.workspaceId)
      || !nonBlank(input.createdAt) || !isMessageKind(input.kind) || !isMessageStatus(input.status)
      || typeof input.content !== 'string') {
      throw new ConversationRepositoryError('INPUT_INVALID');
    }
    if (input.senderType !== 'user' && input.senderType !== 'agent' && input.senderType !== 'system') {
      throw new ConversationRepositoryError('INPUT_INVALID');
    }
    // Agent Messages bind a durable Agent Profile.
    if (input.senderType === 'agent' && !nonBlank(input.senderAgentId)) {
      throw new ConversationRepositoryError('INPUT_INVALID');
    }
  }

  private assertWorkspaceExists(workspaceId: string): void {
    const row = this.db.prepare('SELECT 1 AS present FROM workspaces WHERE id = ?').get(workspaceId);
    if (row === undefined) throw new ConversationRepositoryError('WORKSPACE_NOT_FOUND');
  }

  private assertConversation(workspaceId: string, conversationId: string): void {
    const row = this.db.prepare(
      'SELECT 1 AS present FROM cr_conversations WHERE workspace_id = ? AND id = ?',
    ).get(workspaceId, conversationId);
    if (row === undefined) throw new ConversationRepositoryError('CONVERSATION_NOT_FOUND');
  }

  private requireConversation(workspaceId: string, conversationId: string): ConversationRecord {
    const conversation = this.findConversationById(workspaceId, conversationId);
    if (conversation === undefined) throw new ConversationRepositoryError('CONVERSATION_NOT_FOUND');
    return conversation;
  }

  private requireMember(workspaceId: string, conversationId: string, memberId: string): MemberRecord {
    const row = this.db.prepare(
      'SELECT * FROM cr_conversation_members WHERE workspace_id = ? AND conversation_id = ? AND id = ?',
    ).get(workspaceId, conversationId, memberId) as MemberRow | undefined;
    if (row === undefined) throw new ConversationRepositoryError('MEMBER_NOT_FOUND');
    return toMemberRecord(row);
  }

  private requireMessage(workspaceId: string, messageId: string): MessageRecord {
    const row = this.db.prepare(
      'SELECT * FROM cr_messages WHERE workspace_id = ? AND id = ?',
    ).get(workspaceId, messageId) as MessageRow | undefined;
    if (row === undefined) throw new ConversationRepositoryError('MESSAGE_NOT_FOUND');
    return toMessageRecord(row);
  }

  private publicError(error: unknown): ConversationRepositoryError {
    if (error instanceof ConversationRepositoryError) return error;
    return new ConversationRepositoryError('PERSISTENCE_FAILED');
  }
}

function toConversationRecord(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind as ConversationKind,
    title: row.title,
    status: row.status as ConversationStatus,
    replyMode: row.reply_mode as ConversationReplyMode | null,
    lastMessageId: row.last_message_id,
    lastMessageAt: row.last_message_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function toMemberRecord(row: MemberRow): MemberRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    workspaceId: row.workspace_id,
    subjectType: row.subject_type as MemberSubjectType,
    subjectId: row.subject_id,
    displayNameSnapshot: row.display_name_snapshot,
    role: row.role as MemberRole,
    replyMode: row.reply_mode as MemberReplyMode,
    status: row.status as MemberStatus,
    joinedAt: row.joined_at,
    removedAt: row.removed_at,
    version: row.version,
  };
}

function toMessageRecord(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    workspaceId: row.workspace_id,
    sequence: row.sequence,
    senderType: row.sender_type as 'user' | 'agent' | 'system',
    senderAgentId: row.sender_agent_id,
    kind: row.kind as MessageKind,
    status: row.status as MessageStatus,
    content: row.content,
    clientMessageId: row.client_message_id,
    taskId: row.task_id,
    runId: row.run_id,
    sourceEventId: row.source_event_id,
    replyToMessageId: row.reply_to_message_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
