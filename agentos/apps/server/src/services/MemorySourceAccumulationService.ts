import { createHash } from 'node:crypto';
import type { MemoryCategory, MemoryScope, MemorySourceKind, RunFileChange } from '@agentos/shared';
import { MemoryCandidateRepository, type MemoryCandidateRecord, type MemoryCandidateSourceInput } from '../store/MemoryCandidateRepository.js';
import type { TransactionDatabase } from '../store/Transaction.js';
import { inTransaction } from '../store/Transaction.js';
import type { SqliteStore } from '../store/SqliteStore.js';
import { areMemoryTextFieldsSafe } from '../store/MemoryContentSafety.js';
import { MemoryExtractor, type MemoryCandidateDraft, type MemoryExtractionInput } from './MemoryExtractor.js';

const MAX_VISIBLE_REPLIES = 32;
const MAX_REPLY_LENGTH = 4_000;
const MAX_FILE_CHANGES = 64;

export type MemorySourceAccumulationErrorCode =
  | 'INPUT_INVALID'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_MISMATCH'
  | 'SOURCE_NOT_TERMINAL'
  | 'GENERATION_FAILED';

export class MemorySourceAccumulationError extends Error {
  constructor(readonly code: MemorySourceAccumulationErrorCode) {
    super(`MEMORY_SOURCE_ACCUMULATION_${code}`);
    this.name = 'MemorySourceAccumulationError';
  }
}

export interface MemorySourceAccumulationResult {
  readonly outcome: 'created' | 'existing' | 'none';
  readonly candidates: readonly MemoryCandidateRecord[];
  readonly reason?: 'no_valuable_public_evidence';
}

interface PersistInput {
  readonly workspaceId: string;
  readonly triggerKind: 'direct-turn' | 'group-interaction' | 'legacy-run';
  readonly triggerId: string;
  readonly ownerConversationId: string;
  readonly objective: string;
  readonly resultSummary: string;
  readonly visibleReplies: readonly string[];
  readonly fileChanges: readonly RunFileChange[];
  readonly sources: readonly MemoryCandidateSourceInput[];
  readonly createdAt: string;
}

interface LegacyMessageRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly workspace_id: string;
  readonly sender_type: string;
  readonly content: string;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function categoryFor(type: MemoryCandidateDraft['type']): MemoryCategory {
  switch (type) {
    case 'overview': return 'architecture';
    case 'convention': return 'workflow';
    case 'decision': return 'decision';
    case 'experience': return 'knowledge';
  }
}

function uniqueSources(sources: readonly MemoryCandidateSourceInput[]): MemoryCandidateSourceInput[] {
  const seen = new Set<string>();
  return sources.filter(source => {
    const key = `${source.kind}\0${source.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function candidateId(input: PersistInput, index: number, content: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([input.workspaceId, input.triggerKind, input.triggerId, index, content]))
    .digest('hex')
    .slice(0, 32);
  return `mcand_acc_${digest}`;
}

/**
 * Accumulates bounded, visible evidence from concrete conversation and legacy
 * execution records into the canonical Candidate/review tables. Every source
 * bundle is assembled from a persisted Turn, Group Interaction, or legacy Run
 * and its exact linked Messages; wall-clock ranges are never used.
 */
export class MemorySourceAccumulationService {
  private readonly db: TransactionDatabase;
  private readonly candidates: MemoryCandidateRepository;
  private readonly extractor: MemoryExtractor;

  constructor(
    private readonly store: SqliteStore,
    dependencies: {
      readonly candidates?: MemoryCandidateRepository;
      readonly extractor?: MemoryExtractor;
    } = {},
  ) {
    this.db = store.getDatabase();
    this.candidates = dependencies.candidates ?? new MemoryCandidateRepository(this.db);
    this.extractor = dependencies.extractor ?? new MemoryExtractor();
  }

  generateForDirectTurn(input: {
    readonly workspaceId: string;
    readonly conversationId: string;
    readonly turnId: string;
    readonly sourceMessageId: string;
    readonly responseMessageId: string;
    readonly createdAt: string;
  }): MemorySourceAccumulationResult {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.conversationId) || !nonBlank(input.turnId)
      || !nonBlank(input.sourceMessageId) || !nonBlank(input.responseMessageId) || !nonBlank(input.createdAt)) {
      throw new MemorySourceAccumulationError('INPUT_INVALID');
    }
    const conversations = this.store.conversationRepository();
    const turn = this.store.agentTurnRepository().findTurnById(input.workspaceId, input.turnId);
    const source = conversations.findMessageById(input.workspaceId, input.sourceMessageId);
    const reply = conversations.findMessageById(input.workspaceId, input.responseMessageId);
    if (!turn || !source || !reply) throw new MemorySourceAccumulationError('SOURCE_NOT_FOUND');
    if (turn.conversationId !== input.conversationId || turn.sourceMessageId !== reply.id
      || source.conversationId !== input.conversationId || source.senderType !== 'user' || source.status !== 'final'
      || reply.conversationId !== input.conversationId || reply.senderType !== 'agent'
      || reply.replyToMessageId !== source.id) {
      throw new MemorySourceAccumulationError('SOURCE_MISMATCH');
    }
    if (turn.status !== 'final' || reply.status !== 'final') {
      throw new MemorySourceAccumulationError('SOURCE_NOT_TERMINAL');
    }
    const conversation = conversations.findConversationById(input.workspaceId, input.conversationId);
    if (!conversation || conversation.kind !== 'direct') throw new MemorySourceAccumulationError('SOURCE_MISMATCH');

    return this.persistDrafts({
      workspaceId: input.workspaceId,
      triggerKind: 'direct-turn',
      triggerId: turn.id,
      ownerConversationId: conversation.id,
      objective: source.content,
      resultSummary: '',
      visibleReplies: [reply.content],
      fileChanges: [],
      sources: [
        { kind: 'conversation', id: conversation.id },
        { kind: 'message', id: source.id },
        { kind: 'message', id: reply.id },
      ],
      createdAt: input.createdAt,
    });
  }

  generateForGroupInteraction(input: {
    readonly workspaceId: string;
    readonly conversationId: string;
    readonly interactionId: string;
    readonly sourceMessageId: string;
    readonly createdAt: string;
  }): MemorySourceAccumulationResult {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.conversationId) || !nonBlank(input.interactionId)
      || !nonBlank(input.sourceMessageId) || !nonBlank(input.createdAt)) {
      throw new MemorySourceAccumulationError('INPUT_INVALID');
    }
    const conversations = this.store.conversationRepository();
    const groups = this.store.groupInteractionRepository();
    const interaction = groups.findInteractionById(input.workspaceId, input.interactionId);
    const conversation = conversations.findConversationById(input.workspaceId, input.conversationId);
    const source = conversations.findMessageById(input.workspaceId, input.sourceMessageId);
    if (!interaction || !conversation || !source) throw new MemorySourceAccumulationError('SOURCE_NOT_FOUND');
    if (conversation.kind !== 'group' || interaction.conversationId !== conversation.id
      || interaction.sourceMessageId !== source.id || source.conversationId !== conversation.id
      || source.senderType !== 'user' || source.status !== 'final') {
      throw new MemorySourceAccumulationError('SOURCE_MISMATCH');
    }
    if (interaction.integrityStatus !== 'valid') throw new MemorySourceAccumulationError('SOURCE_MISMATCH');
    if (interaction.status === 'active') throw new MemorySourceAccumulationError('SOURCE_NOT_TERMINAL');

    const replies = groups.listReplies(interaction.id).slice(0, MAX_VISIBLE_REPLIES);
    const replyMessages = replies.map(reply => {
      const message = conversations.findMessageById(input.workspaceId, reply.messageId);
      const turn = reply.turnId === null ? undefined : this.store.agentTurnRepository().findTurnById(input.workspaceId, reply.turnId);
      if (reply.integrityStatus !== 'valid' || !message || !turn
        || message.conversationId !== conversation.id || message.senderType !== 'agent'
        || message.replyToMessageId !== source.id || message.status !== 'final'
        || turn.status !== 'final' || turn.sourceMessageId !== message.id) {
        throw new MemorySourceAccumulationError('SOURCE_MISMATCH');
      }
      return { reply, message };
    });

    const ended = interaction.stopReason ?? interaction.status;
    return this.persistDrafts({
      workspaceId: input.workspaceId,
      triggerKind: 'group-interaction',
      triggerId: interaction.id,
      ownerConversationId: conversation.id,
      objective: source.content,
      resultSummary: `Group interaction ${interaction.id} ended: ${ended}.`,
      visibleReplies: replyMessages.map(({ message }) => truncate(message.content, MAX_REPLY_LENGTH)),
      fileChanges: [],
      sources: [
        { kind: 'conversation', id: conversation.id },
        { kind: 'message', id: source.id },
        ...replyMessages.map(({ message }) => ({ kind: 'message' as const, id: message.id })),
      ],
      createdAt: input.createdAt,
    });
  }

  generateForLegacyRun(input: {
    readonly workspaceId: string;
    readonly runId: string;
    readonly createdAt: string;
  }): MemorySourceAccumulationResult {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.runId) || !nonBlank(input.createdAt)) {
      throw new MemorySourceAccumulationError('INPUT_INVALID');
    }
    const run = this.store.getRun(input.workspaceId, input.runId);
    if (!run) throw new MemorySourceAccumulationError('SOURCE_NOT_FOUND');
    if (!['completed', 'failed', 'cancelled'].includes(run.status)) {
      throw new MemorySourceAccumulationError('SOURCE_NOT_TERMINAL');
    }
    const source = this.db.prepare(
      'SELECT id, conversation_id, workspace_id, sender_type, content FROM messages WHERE workspace_id = ? AND id = ?',
    ).get(input.workspaceId, run.sourceMessageId) as LegacyMessageRow | undefined;
    if (!source) throw new MemorySourceAccumulationError('SOURCE_NOT_FOUND');
    if (source.conversation_id !== run.conversationId || source.sender_type !== 'user') {
      throw new MemorySourceAccumulationError('SOURCE_MISMATCH');
    }
    const replyRows = this.db.prepare(
      'SELECT id, conversation_id, workspace_id, sender_type, content FROM messages'
        + ' WHERE workspace_id = ? AND conversation_id = ? AND run_id = ? AND sender_type <> ?'
        + ' ORDER BY created_at ASC, rowid ASC LIMIT ?',
    ).all(input.workspaceId, run.conversationId, run.id, 'user', MAX_VISIBLE_REPLIES) as LegacyMessageRow[];
    if (replyRows.some(row => row.workspace_id !== input.workspaceId || row.conversation_id !== run.conversationId)) {
      throw new MemorySourceAccumulationError('SOURCE_MISMATCH');
    }
    const fileChanges = this.store.listRunFileChanges(input.workspaceId, run.id).slice(0, MAX_FILE_CHANGES);
    const resultSummary = run.resultSummary ?? run.failureReason ?? '';
    return this.persistDrafts({
      workspaceId: input.workspaceId,
      triggerKind: 'legacy-run',
      triggerId: run.id,
      ownerConversationId: run.conversationId,
      objective: run.objective || source.content,
      resultSummary,
      visibleReplies: replyRows.map(row => truncate(row.content, MAX_REPLY_LENGTH)),
      fileChanges,
      sources: [
        { kind: 'conversation', id: run.conversationId },
        { kind: 'message', id: source.id },
        { kind: 'run', id: run.id },
        ...replyRows.map(row => ({ kind: 'message' as const, id: row.id })),
      ],
      createdAt: input.createdAt,
    });
  }

  private persistDrafts(input: PersistInput): MemorySourceAccumulationResult {
    const extractionInput: MemoryExtractionInput = {
      objective: truncate(input.objective, MAX_REPLY_LENGTH),
      resultSummary: truncate(input.resultSummary, MAX_REPLY_LENGTH),
      fileChanges: input.fileChanges.map(change => ({ ...change })),
      visibleReplies: [...input.visibleReplies],
    };
    const extraction = this.extractor.extract(extractionInput);
    const drafts = extraction.drafts.slice(0, 3).filter(draft => draft.operation !== 'ignore'
      && areMemoryTextFieldsSafe([draft.title, draft.summary, draft.content]));
    if (drafts.length === 0) {
      return extraction.reason === 'no_valuable_public_evidence'
        ? { outcome: 'none', candidates: [], reason: 'no_valuable_public_evidence' }
        : { outcome: 'none', candidates: [] };
    }

    try {
      const saved = inTransaction(this.db, () => {
        const records: MemoryCandidateRecord[] = [];
        let createdCount = 0;
        for (const [index, draft] of drafts.entries()) {
          const sources = uniqueSources(input.sources);
          const exactContentHash = createHash('sha256').update(draft.content, 'utf8').digest('hex');
          const normalized = draft.content.toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
          const normalizedTextHash = createHash('sha256').update(normalized, 'utf8').digest('hex');
          const id = candidateId(input, index, draft.content);
          const existing = this.candidates.findCandidateById(input.workspaceId, id);
          if (existing) {
            records.push(existing);
            continue;
          }
          records.push(this.candidates.createCandidateWithinTransaction({
            id,
            workspaceId: input.workspaceId,
            scope: 'conversation' satisfies MemoryScope,
            ownerConversationId: input.ownerConversationId,
            category: categoryFor(draft.type),
            authority: 'agent-derived',
            confidence: draft.confidence / 100,
            importance: 0.5,
            title: draft.title,
            summary: draft.summary,
            content: draft.content,
            exactContentHash,
            normalizedTextHash,
            tokenEstimate: Math.max(1, Math.ceil(draft.content.length / 4)),
            inferredPreference: false,
            scopePromotion: false,
            containsSecret: false,
            duplicateResolved: draft.operation === 'create',
            sources: sources.map(source => ({ kind: source.kind as MemorySourceKind, id: source.id })),
            createdAt: input.createdAt,
            minConfidence: 0.9,
            maxTokenEstimate: 4_000,
          }));
          createdCount += 1;
        }
        return { records, createdCount };
      });
      return {
        outcome: saved.createdCount > 0 ? 'created' : 'existing',
        candidates: saved.records,
      };
    } catch {
      throw new MemorySourceAccumulationError('GENERATION_FAILED');
    }
  }
}
