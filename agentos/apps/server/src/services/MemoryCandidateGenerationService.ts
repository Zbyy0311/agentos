import { createHash } from 'node:crypto';

import type { RuntimeEventContextAuthoritySourceV1 } from '@agentos/shared';
import { inTransaction, type TransactionDatabase } from '../store/Transaction.js';
import { MemoryEntryRepository, type MemoryEntryDedupScope } from '../store/MemoryEntryRepository.js';
import {
  MemoryCandidateRepository,
  type CreateMemoryCandidateInput,
  type MemoryCandidateRecord,
} from '../store/MemoryCandidateRepository.js';
import type { RunRepository } from '../store/RunRepository.js';
import type { RunStageRepository } from '../store/RunStageRepository.js';
import type { TaskRepository } from '../store/TaskRepository.js';
import { toSafeFtsQuery } from './MemoryRetrievalService.js';
import type { MemoryRuntimeEventEmitter } from './MemoryRuntimeEventEmitter.js';

/**
 * MF-2R candidate generation trigger (07-Memory-Runtime.md section 7;
 * docs/implementation/milestones/MF2-remainder-audit.md).
 *
 * Bound to the canonical terminal-outcome seam: after a Run completes, build
 * a bounded Evidence Bundle from durable records only (task title, stage
 * outcomes/attempts, duration — never raw Provider output or hidden
 * reasoning) and create one forward Candidate through the MF-0 promotion
 * gate.
 *
 * Deduplication runs in spec order and never converges silently past step 1:
 *   1. exact content hash: converge, no new Candidate;
 *   2. normalized text hash: near-duplicate signal, duplicateResolved=false;
 *   4. FTS similarity: same signal (step 3 same-stable-source is N/A for
 *      generated candidates, whose source is new).
 * A near-duplicate signal forces the gate to review-required.
 *
 * Idempotent per (Run, trigger): the candidate id is deterministic
 * (mcand_terminal_<runId>) with a find-before-create guard, so a replay or
 * re-dispatch converges instead of duplicating.
 *
 * MF-5 production wiring: when an `emitter` is supplied the Candidate and its
 * canonical `memory.candidate_created` Event + Outbox row commit in ONE
 * transaction, bound to the caller's authorized causal context (the persisted
 * `run.start` Operation). Exact convergence preserves missing sources with an
 * Entry deduplication Event; a same-source replay emits nothing.
 */

export function normalizeMemoryText(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, ' ').trim();
}

export function hashMemoryText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export type MemoryCandidateGenerationErrorCode = 'INPUT_INVALID' | 'GENERATION_FAILED';

export class MemoryCandidateGenerationError extends Error {
  constructor(readonly code: MemoryCandidateGenerationErrorCode) {
    super(`MEMORY_CANDIDATE_GENERATION_${code}`);
    this.name = 'MemoryCandidateGenerationError';
  }
}

export type TerminalGenerationOutcome =
  | 'created'
  | 'existing'
  | 'converged'
  | 'run-not-found'
  | 'not-terminal';

/** LITE-07-102: every terminal Run outcome produces one bounded fact. */
const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled'] as const;

export interface GenerateForRunTerminalInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly createdAt: string;
  /**
   * Authorized causal context for the `memory.candidate_created` Event.
   * Required whenever the service is wired with an emitter; the origin is
   * proven against a durable Operation/Event row inside the same transaction.
   */
  readonly eventContext?: RuntimeEventContextAuthoritySourceV1;
}

export interface TerminalGenerationResult {
  readonly outcome: TerminalGenerationOutcome;
  readonly candidate?: MemoryCandidateRecord;
  /** Entry the Candidate converged on or was flagged against, when known. */
  readonly duplicateOfEntryId?: string;
}

export interface MemoryCandidateGenerationServiceDependencies {
  readonly store: { getDatabase(): TransactionDatabase };
  readonly runs: Pick<RunRepository, 'findById'>;
  readonly stages: Pick<RunStageRepository, 'listByRun'>;
  readonly tasks: Pick<TaskRepository, 'findById'>;
  readonly candidates?: MemoryCandidateRepository;
  /**
   * MF-5 seam. When supplied, the Candidate is created through
   * `emitCandidateCreated`, so the fact and the Event that records it share
   * one transaction and one rollback boundary.
   */
  readonly emitter?: MemoryRuntimeEventEmitter;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

export class MemoryCandidateGenerationService {
  private readonly db: TransactionDatabase;
  private readonly candidates: MemoryCandidateRepository;
  private readonly runs: MemoryCandidateGenerationServiceDependencies['runs'];
  private readonly stages: MemoryCandidateGenerationServiceDependencies['stages'];
  private readonly tasks: MemoryCandidateGenerationServiceDependencies['tasks'];
  private readonly emitter: MemoryRuntimeEventEmitter | undefined;

  constructor(dependencies: MemoryCandidateGenerationServiceDependencies) {
    this.db = dependencies.store.getDatabase();
    this.candidates = dependencies.candidates ?? new MemoryCandidateRepository(this.db);
    this.runs = dependencies.runs;
    this.stages = dependencies.stages;
    this.tasks = dependencies.tasks;
    this.emitter = dependencies.emitter;
  }

  generateForRunTerminal(input: GenerateForRunTerminalInput): TerminalGenerationResult {
    if (typeof input !== 'object' || input === null || !nonBlank(input.workspaceId)
      || !nonBlank(input.runId) || !nonBlank(input.createdAt)) {
      throw new MemoryCandidateGenerationError('INPUT_INVALID');
    }
    const run = this.runs.findById(input.workspaceId, input.runId);
    if (run === undefined) return { outcome: 'run-not-found' };
    // LITE-07-102: a failed or cancelled Run is a terminal outcome too, and its
    // bounded fact is the memory that prevents repeating the same failure.
    if (!(TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)) {
      return { outcome: 'not-terminal' };
    }
    const completed = run.status === 'completed';
    // Fail closed: an emitter-wired generator must never create a Candidate
    // whose canonical Event cannot be authorized.
    if (this.emitter !== undefined && input.eventContext === undefined) {
      throw new MemoryCandidateGenerationError('INPUT_INVALID');
    }

    const candidateId = `mcand_terminal_${input.runId}`;
    const existing = this.candidates.findCandidateById(input.workspaceId, candidateId);
    if (existing !== undefined) return { outcome: 'existing', candidate: existing };

    const task = this.tasks.findById(input.workspaceId, run.taskId);
    const stageList = this.stages.listByRun(input.workspaceId, input.runId);
    const stageLines = stageList.map(stage => {
      const duration = stage.startedAt !== undefined && stage.completedAt !== undefined
        ? `${Date.parse(stage.completedAt) - Date.parse(stage.startedAt)}ms`
        : 'unknown';
      return `${stage.workflowStageKey}: ${stage.status} (attempt ${stage.attempt}, duration ${duration})`;
    });
    const taskTitle = task?.title ?? run.taskId;
    // Bounded, record-only facts: status, failure code/message and stage
    // outcomes. Never raw Provider output or hidden reasoning.
    const statusLabel = completed ? '完成' : run.status === 'cancelled' ? '已取消' : '失败';
    // The completed title stays byte-identical to the pre-LITE-07-102 shape: its
    // exact text feeds the FTS near-duplicate signal (MF2R-G4b), so only a
    // non-success outcome adds the status marker that distinguishes it.
    const title = truncate(completed ? `执行结果：${taskTitle}` : `执行结果：${taskTitle}（${statusLabel}）`, 200);
    const summary = truncate(
      completed
        ? `Run ${input.runId} 已完成，共 ${stageList.length} 个 Stage。`
        : `Run ${input.runId} ${statusLabel}，共 ${stageList.length} 个 Stage。`,
      1000,
    );
    const content = truncate([
      `任务：${taskTitle}`,
      completed
        ? `结果：Run ${input.runId} 完成（origin ${run.origin}，reason ${run.reason}）。`
        : `结果：Run ${input.runId} ${statusLabel}（origin ${run.origin}，reason ${run.reason}，status ${run.status}）。`,
      completed || run.failureCode === undefined || run.failureCode === null
        ? ''
        : `失败代码：${truncate(String(run.failureCode), 120)}`,
      completed || !run.failureMessage
        ? ''
        : `失败说明：${truncate(String(run.failureMessage), 400)}`,
      stageLines.length > 0 ? `Stage 结果：${stageLines.join('; ')}` : '',
    ].filter(Boolean).join('\n'), 12000);

    const exactHash = hashMemoryText(content);
    const normalizedHash = hashMemoryText(normalizeMemoryText(content));
    // A non-success outcome is Failure Experience, not a success summary, so it
    // deduplicates inside its own category instead of colliding with the
    // completion summary of the same Task.
    const category = completed ? 'summary' : 'failure';
    const boundary: MemoryEntryDedupScope = { scope: 'task', ownerTaskId: run.taskId, category };
    const exactHit = this.candidates.findEntryByExactHash(input.workspaceId, exactHash, boundary);
    if (exactHit !== undefined) {
      // LITE-07-107: preserve actual provenance without creating another Entry.
      const merge = { ...boundary, workspaceId: input.workspaceId, entryId: exactHit,
        exactContentHash: exactHash, sources: [{ kind: 'run' as const, id: input.runId }], updatedAt: input.createdAt };
      try {
        const result = this.emitter === undefined
          ? inTransaction(this.db, () => new MemoryEntryRepository(this.db).mergeExactSourcesWithinTransaction(merge))
          : this.emitter.emitEntryDeduplicated({ ...merge, runId: input.runId,
            eventContext: input.eventContext as RuntimeEventContextAuthoritySourceV1, timestamp: input.createdAt });
        if (result !== undefined) return { outcome: 'converged', duplicateOfEntryId: exactHit };
      } catch {
        throw new MemoryCandidateGenerationError('GENERATION_FAILED');
      }
      // A concurrent archive/removal invalidated the match. Continue with a
      // review Candidate instead of losing this meaningful transition.
    }
    const normalizedHit = this.candidates.findEntryByNormalizedHash(input.workspaceId, normalizedHash, boundary);
    const ftsHit = normalizedHit === undefined ? this.findFtsNearDuplicate(input.workspaceId, run.taskId, title) : undefined;
    const duplicateOf = normalizedHit ?? ftsHit;

    const candidateInput: CreateMemoryCandidateInput = {
        id: candidateId,
        workspaceId: input.workspaceId,
        scope: 'task',
        ownerTaskId: run.taskId,
        category,
        authority: 'agent-derived',
        confidence: completed ? 0.6 : 0.5,
        importance: 0.5,
        title,
        summary,
        content,
        exactContentHash: exactHash,
        normalizedTextHash: normalizedHash,
        tokenEstimate: Math.max(1, Math.ceil(content.length / 4)),
        duplicateResolved: duplicateOf === undefined,
        sources: [{ kind: 'run', id: input.runId }],
        createdAt: input.createdAt,
        // Conservative gate inputs: automatic promotion is never requested
        // here; the reviewer decides through the MF-5 queue.
        minConfidence: 0.9,
        maxTokenEstimate: 4000,
    };
    try {
      const candidate = this.emitter === undefined
        ? this.candidates.createCandidate(candidateInput)
        : this.emitter.emitCandidateCreated({
          ...candidateInput,
          runId: input.runId,
          eventContext: input.eventContext as RuntimeEventContextAuthoritySourceV1,
          timestamp: input.createdAt,
        }).record;
      return duplicateOf === undefined
        ? { outcome: 'created', candidate }
        : { outcome: 'created', candidate, duplicateOfEntryId: duplicateOf };
    } catch (error) {
      // Lost same-id race: the failed write rolled back, so any surviving row
      // can only have been written by the concurrent winner — converge on it.
      // The emitter path is included because it wraps the underlying UNIQUE
      // violation, and converging is still the truthful outcome.
      if ((error instanceof Error && /UNIQUE/i.test(error.message)) || this.emitter !== undefined) {
        const won = this.candidates.findCandidateById(input.workspaceId, candidateId);
        if (won !== undefined) return { outcome: 'existing', candidate: won };
      }
      throw new MemoryCandidateGenerationError('GENERATION_FAILED');
    }
  }

  /**
   * Dedup order step 4: FTS similarity over the Entry title — the densest
   * near-duplicate signal. All title tokens must match (AND semantics via
   * the neutralized query); summary/content tokens are too body-specific and
   * would miss partial overlaps. Any hit is a near-duplicate SIGNAL (never a
   * silent merge). Degraded FTS (unavailable/error) yields no signal;
   * structured hashes remain authoritative.
   */
  private findFtsNearDuplicate(workspaceId: string, taskId: string, title: string): string | undefined {
    const ftsQuery = toSafeFtsQuery(title);
    if (ftsQuery === null) return undefined;
    try {
      const row = this.db.prepare(
        'SELECT memory_entries_fts.memory_entry_id AS id'
          + ' FROM memory_entries_fts'
          + ' INNER JOIN memory_entries ON memory_entries.id = memory_entries_fts.memory_entry_id'
          + ' WHERE memory_entries.workspace_id = ?'
          + " AND memory_entries.status = 'active' AND memory_entries.scope = 'task' AND memory_entries.category = 'summary'"
          + ' AND memory_entries.owner_task_id = ? AND memory_entries.owner_agent_id IS NULL'
          + ' AND memory_entries.owner_conversation_id IS NULL AND memory_entries.owner_run_id IS NULL'
          + ' AND memory_entries_fts MATCH ?'
          + ' ORDER BY bm25(memory_entries_fts) ASC, id ASC LIMIT 1',
      ).get(workspaceId, taskId, ftsQuery) as { id: string } | undefined;
      return row?.id;
    } catch {
      return undefined;
    }
  }
}
