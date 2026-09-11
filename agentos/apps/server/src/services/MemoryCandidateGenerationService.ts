import { createHash } from 'node:crypto';

import type { TransactionDatabase } from '../store/Transaction.js';
import {
  MemoryCandidateRepository,
  type MemoryCandidateRecord,
} from '../store/MemoryCandidateRepository.js';
import type { RunRepository } from '../store/RunRepository.js';
import type { RunStageRepository } from '../store/RunStageRepository.js';
import type { TaskRepository } from '../store/TaskRepository.js';
import { toSafeFtsQuery } from './MemoryRetrievalService.js';

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
 * No canonical Memory Event is emitted: production has no authorized
 * Run-scoped memory emission authority (deny-all precedent,
 * WorkspaceGitObservationService). Recorded in MF-progress.md.
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
  | 'not-completed';

export interface GenerateForRunTerminalInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly createdAt: string;
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

  constructor(dependencies: MemoryCandidateGenerationServiceDependencies) {
    this.db = dependencies.store.getDatabase();
    this.candidates = dependencies.candidates ?? new MemoryCandidateRepository(this.db);
    this.runs = dependencies.runs;
    this.stages = dependencies.stages;
    this.tasks = dependencies.tasks;
  }

  generateForRunTerminal(input: GenerateForRunTerminalInput): TerminalGenerationResult {
    if (typeof input !== 'object' || input === null || !nonBlank(input.workspaceId)
      || !nonBlank(input.runId) || !nonBlank(input.createdAt)) {
      throw new MemoryCandidateGenerationError('INPUT_INVALID');
    }
    const run = this.runs.findById(input.workspaceId, input.runId);
    if (run === undefined) return { outcome: 'run-not-found' };
    if (run.status !== 'completed') return { outcome: 'not-completed' };

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
    const title = truncate(`执行结果：${taskTitle}`, 200);
    const summary = truncate(`Run ${input.runId} 已完成，共 ${stageList.length} 个 Stage。`, 1000);
    const content = truncate([
      `任务：${taskTitle}`,
      `结果：Run ${input.runId} 完成（origin ${run.origin}，reason ${run.reason}）。`,
      stageLines.length > 0 ? `Stage 结果：${stageLines.join('; ')}` : '',
    ].filter(Boolean).join('\n'), 12000);

    const exactHash = hashMemoryText(content);
    const normalizedHash = hashMemoryText(normalizeMemoryText(content));
    const exactHit = this.candidates.findEntryByExactHash(input.workspaceId, exactHash);
    if (exactHit !== undefined) {
      // Dedup order step 1: exact duplicate converges; no new Candidate.
      return { outcome: 'converged', duplicateOfEntryId: exactHit };
    }
    const normalizedHit = this.candidates.findEntryByNormalizedHash(input.workspaceId, normalizedHash);
    const ftsHit = normalizedHit === undefined ? this.findFtsNearDuplicate(input.workspaceId, title, summary) : undefined;
    const duplicateOf = normalizedHit ?? ftsHit;

    try {
      const candidate = this.candidates.createCandidate({
        id: candidateId,
        workspaceId: input.workspaceId,
        scope: 'task',
        ownerTaskId: run.taskId,
        category: 'summary',
        authority: 'agent-derived',
        confidence: 0.6,
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
      });
      return duplicateOf === undefined
        ? { outcome: 'created', candidate }
        : { outcome: 'created', candidate, duplicateOfEntryId: duplicateOf };
    } catch (error) {
      if (error instanceof Error && /UNIQUE/i.test(error.message)) {
        // Lost a same-id race: converge on the existing row (idempotent).
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
  private findFtsNearDuplicate(workspaceId: string, title: string, _summary: string): string | undefined {
    const ftsQuery = toSafeFtsQuery(title);
    if (ftsQuery === null) return undefined;
    try {
      const row = this.db.prepare(
        'SELECT memory_entries_fts.memory_entry_id AS id'
          + ' FROM memory_entries_fts'
          + ' INNER JOIN memory_entries ON memory_entries.id = memory_entries_fts.memory_entry_id'
          + ' WHERE memory_entries.workspace_id = ?'
          + ' AND memory_entries_fts MATCH ?'
          + ' ORDER BY bm25(memory_entries_fts) ASC, id ASC LIMIT 1',
      ).get(workspaceId, ftsQuery) as { id: string } | undefined;
      return row?.id;
    } catch {
      return undefined;
    }
  }
}
