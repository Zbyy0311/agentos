import { createHash } from 'node:crypto';

import { isRunCompletedPayload, type RuntimeEventContextAuthoritySourceV1 } from '@agentos/shared';
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
import { MemoryExtractor, type MemoryCandidateDraft } from './MemoryExtractor.js';
import { areMemoryTextFieldsSafe } from '../store/MemoryContentSafety.js';
import type { MergeExactMemorySourcesInput } from '../store/MemoryEntryRepository.js';

/**
 * MF-2R candidate generation trigger (07-Memory-Runtime.md section 7;
 * docs/implementation/milestones/MF2-remainder-audit.md).
 *
 * Bound to the canonical terminal-outcome seam: after a Run completes, build
 * a bounded Evidence Bundle from the exact Task, Run, linked Stage records,
 * and public result summaries explicitly referenced by the terminal Event;
 * pass it through MemoryExtractor, then persist up to three review-gated
 * Candidates through the canonical MF-0/MF-5 path.
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
 * MF-5 production wiring: when an `emitter` is supplied the bounded Candidate
 * batch, canonical Events, and Outbox rows commit in ONE transaction, bound to
 * the caller's authorized causal context (the persisted `run.start` Operation).
 * Exact convergence preserves missing sources with an Entry deduplication
 * Event; a same-source replay emits nothing.
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
  | 'none'
  | 'run-not-found'
  | 'not-terminal';

/** LITE-07-102: every terminal Run outcome may yield up to three bounded facts. */
const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled'] as const;
const GENERATE_INPUT_KEYS = new Set(['workspaceId', 'runId', 'createdAt', 'eventContext']);

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
  readonly candidates?: readonly MemoryCandidateRecord[];
  /** Entry the Candidate converged on or was flagged against, when known. */
  readonly duplicateOfEntryId?: string;
}

export interface MemoryCandidateGenerationServiceDependencies {
  readonly store: { getDatabase(): TransactionDatabase };
  readonly runs: Pick<RunRepository, 'findById'>;
  readonly stages: Pick<RunStageRepository, 'listByRun'>;
  readonly tasks: Pick<TaskRepository, 'findById'>;
  readonly candidates?: MemoryCandidateRepository;
  /** MF-5 seam: atomically emit the bounded Candidate batch and its Events. */
  readonly emitter?: MemoryRuntimeEventEmitter;
  readonly extractor?: Pick<MemoryExtractor, 'extract'>;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function safeEvidence(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || !nonBlank(value)) return '';
  const bounded = truncate(value.trim(), maxLength);
  return areMemoryTextFieldsSafe([bounded]) ? bounded : '';
}

function categoryForDraft(draft: MemoryCandidateDraft, completed: boolean): CreateMemoryCandidateInput['category'] {
  if (!completed) return 'failure';
  switch (draft.type) {
    case 'overview': return 'architecture';
    case 'convention': return 'workflow';
    case 'decision': return 'decision';
    case 'experience': return 'knowledge';
  }
}

function terminalCandidateId(runId: string, index: number): string {
  return index === 0 ? `mcand_terminal_${runId}` : `mcand_terminal_${runId}_${index + 1}`;
}

interface TerminalArtifactEvidence {
  readonly eventId: string;
  readonly artifactId: string;
  readonly artifactType: 'review' | 'test';
  readonly summary: string;
  readonly sourceStageId: string | null;
}

const MAX_TERMINAL_ARTIFACTS = 8;

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

export class MemoryCandidateGenerationService {
  private readonly db: TransactionDatabase;
  private readonly candidates: MemoryCandidateRepository;
  private readonly runs: MemoryCandidateGenerationServiceDependencies['runs'];
  private readonly stages: MemoryCandidateGenerationServiceDependencies['stages'];
  private readonly tasks: MemoryCandidateGenerationServiceDependencies['tasks'];
  private readonly emitter: MemoryRuntimeEventEmitter | undefined;
  private readonly extractor: Pick<MemoryExtractor, 'extract'>;

  constructor(dependencies: MemoryCandidateGenerationServiceDependencies) {
    this.db = dependencies.store.getDatabase();
    this.candidates = dependencies.candidates ?? new MemoryCandidateRepository(this.db);
    this.runs = dependencies.runs;
    this.stages = dependencies.stages;
    this.tasks = dependencies.tasks;
    this.emitter = dependencies.emitter;
    this.extractor = dependencies.extractor ?? new MemoryExtractor();
  }

  generateForRunTerminal(input: GenerateForRunTerminalInput): TerminalGenerationResult {
    if (typeof input !== 'object' || input === null || Array.isArray(input)
      || Object.keys(input).some(key => !GENERATE_INPUT_KEYS.has(key))
      || !nonBlank(input.workspaceId)
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

    const existing = [0, 1, 2].map(index => this.candidates.findCandidateById(
      input.workspaceId, terminalCandidateId(input.runId, index),
    )).filter((candidate): candidate is MemoryCandidateRecord => candidate !== undefined);
    if (existing.length > 0) return { outcome: 'existing', candidate: existing[0], candidates: existing };

    const task = this.tasks.findById(input.workspaceId, run.taskId);
    const stageList = this.stages.listByRun(input.workspaceId, input.runId).slice(0, 32);
    const artifactEvidence = this.readTerminalArtifactEvidence(input.workspaceId, run.taskId, run.id, run.nextEventSequence);
    const stageLines = stageList.map(stage => {
      const duration = stage.startedAt !== undefined && stage.completedAt !== undefined
        ? `${Date.parse(stage.completedAt) - Date.parse(stage.startedAt)}ms`
        : 'unknown';
      const failureCode = safeEvidence(stage.failureCode, 120);
      const failureMessage = safeEvidence(stage.failureMessage, 400);
      return `${stage.workflowStageKey}: ${stage.status} (attempt ${stage.attempt}, duration ${duration})`
        + (failureCode ? `; failure code ${failureCode}` : '')
        + (failureMessage ? `; failure detail ${failureMessage}` : '');
    });
    const taskTitle = safeEvidence(task?.title, 200) || safeEvidence(run.objective, 200) || run.taskId;
    // Bounded durable facts: explicitly linked result summaries plus terminal
    // status and stage outcomes. Never artifact bytes, raw Provider output,
    // or hidden reasoning.
    const statusLabel = completed ? '完成' : run.status === 'cancelled' ? '已取消' : '失败';
    const statusSummary = truncate([
      ...artifactEvidence.map(artifact => `持久化${artifact.artifactType}结果：${artifact.summary}`),
      completed
        ? `Run ${input.runId} 完成（origin ${run.origin}，reason ${run.reason}）。`
        : `Run ${input.runId} ${statusLabel}（origin ${run.origin}，reason ${run.reason}，status ${run.status}）。`,
      completed || run.failureCode === undefined || run.failureCode === null
        ? ''
        : safeEvidence(run.failureCode, 120) ? `失败代码：${safeEvidence(run.failureCode, 120)}` : '',
      completed || !run.failureMessage
        ? ''
        : safeEvidence(run.failureMessage, 400) ? `失败说明：${safeEvidence(run.failureMessage, 400)}` : '',
      stageLines.length > 0 ? `Stage 结果：${stageLines.join('; ')}` : '',
    ].filter(Boolean).join('\n'), 12000);
    const extraction = this.extractor.extract({
      objective: taskTitle,
      resultSummary: statusSummary,
      fileChanges: [],
      visibleReplies: [],
    });
    const drafts = extraction.drafts.slice(0, 3).filter(draft => draft.operation !== 'ignore'
      && Number.isInteger(draft.confidence) && draft.confidence >= 0 && draft.confidence <= 100
      && nonBlank(draft.title) && nonBlank(draft.summary) && nonBlank(draft.content)
      && areMemoryTextFieldsSafe([draft.title, draft.summary, draft.content]));
    if (drafts.length === 0) return { outcome: 'none' };

    // Preserve the historical deterministic ID for the first draft; use stable
    // per-index IDs for additional extracted facts from this exact Run.
    const buildCandidate = (draft: MemoryCandidateDraft, index: number, duplicateResolved: boolean): CreateMemoryCandidateInput => {
      const content = truncate(draft.content, 12000);
      const exactHash = hashMemoryText(content);
      const sourceRefs = [
        { kind: 'task' as const, id: run.taskId },
        { kind: 'run' as const, id: input.runId },
        ...artifactEvidence.flatMap(artifact => [
          { kind: 'event' as const, id: artifact.eventId },
          { kind: 'artifact' as const, id: artifact.artifactId },
          ...(artifact.sourceStageId ? [{ kind: 'stage' as const, id: artifact.sourceStageId }] : []),
        ]),
        ...stageList.map(stage => ({ kind: 'stage' as const, id: stage.id })),
      ];
      const sources = [...new Map(sourceRefs.map(source => [`${source.kind}\u0000${source.id}`, source])).values()];
      return {
        id: terminalCandidateId(input.runId, index),
        workspaceId: input.workspaceId,
        scope: 'task',
        ownerTaskId: run.taskId,
        category: categoryForDraft(draft, completed),
        authority: 'agent-derived',
        // This Run-derived path always enters review. A marker's claimed
        // confidence cannot turn generated text into an auto-accepted Entry.
        confidence: Math.min(0.89, draft.confidence / 100),
        importance: 0.5,
        title: truncate(completed ? draft.title : `执行${statusLabel}：${draft.title}`, 200),
        summary: truncate(draft.summary, 1000),
        content,
        exactContentHash: exactHash,
        normalizedTextHash: hashMemoryText(normalizeMemoryText(content)),
        tokenEstimate: Math.max(1, Math.ceil(content.length / 4)),
        duplicateResolved,
        sources,
        createdAt: input.createdAt,
        minConfidence: 0.9,
        maxTokenEstimate: 4000,
      };
    };
    const plans: Array<{ merge: MergeExactMemorySourcesInput; fallbackCandidate: CreateMemoryCandidateInput }> = [];
    const candidateInputs: CreateMemoryCandidateInput[] = [];
    const exactEntriesByCandidateId = new Map<string, string>();
    let nearDuplicateOfEntryId: string | undefined;
    for (const [index, draft] of drafts.entries()) {
      const provisional = buildCandidate(draft, index, true);
      const boundary: MemoryEntryDedupScope = { scope: 'task', ownerTaskId: run.taskId, category: provisional.category };
      const exactHit = this.candidates.findEntryByExactHash(input.workspaceId, provisional.exactContentHash!, boundary);
      if (exactHit !== undefined) {
        const plan = {
          merge: { ...boundary, workspaceId: input.workspaceId, entryId: exactHit,
            exactContentHash: provisional.exactContentHash!, sources: provisional.sources, updatedAt: input.createdAt },
          fallbackCandidate: buildCandidate(draft, index, false),
        };
        plans.push(plan);
        exactEntriesByCandidateId.set(plan.fallbackCandidate.id, exactHit);
        continue;
      }
      const normalizedHit = this.candidates.findEntryByNormalizedHash(input.workspaceId, provisional.normalizedTextHash!, boundary);
      const ftsHit = normalizedHit === undefined
        ? this.findFtsNearDuplicate(input.workspaceId, run.taskId, provisional.category, provisional.title)
        : undefined;
      candidateInputs.push(buildCandidate(draft, index, normalizedHit === undefined && ftsHit === undefined));
      if (normalizedHit !== undefined || ftsHit !== undefined) nearDuplicateOfEntryId ??= normalizedHit ?? ftsHit;
    }
    try {
      if (this.emitter !== undefined) {
        const emitted = this.emitter.emitTerminalMemoryGeneration({
          workspaceId: input.workspaceId,
          runId: input.runId,
          eventContext: input.eventContext as RuntimeEventContextAuthoritySourceV1,
          timestamp: input.createdAt,
          candidates: candidateInputs,
          deduplications: plans,
        });
        const generatedCandidates = drafts.map((_, index) => this.candidates.findCandidateById(
          input.workspaceId, terminalCandidateId(input.runId, index),
        )).filter((candidate): candidate is MemoryCandidateRecord => candidate !== undefined);
        const matchedExactIds = new Set(emitted.deduplicatedEntries.map(entry => entry.id));
        const duplicateOfEntryId = nearDuplicateOfEntryId
          ?? [...exactEntriesByCandidateId.entries()].find(([candidateId]) =>
            !generatedCandidates.some(candidate => candidate.id === candidateId)
            && matchedExactIds.has(exactEntriesByCandidateId.get(candidateId)!))?.[1];
        return { outcome: emitted.candidates.length > 0 ? 'created' : emitted.deduplicatedEntries.length > 0 ? 'converged' : 'existing',
          ...(generatedCandidates[0] ? { candidate: generatedCandidates[0] } : {}),
          ...(generatedCandidates.length > 0 ? { candidates: generatedCandidates } : {}),
          ...(duplicateOfEntryId ? { duplicateOfEntryId } : {}) };
      }
      const saved = inTransaction(this.db, () => {
        const repository = new MemoryEntryRepository(this.db);
        const created: MemoryCandidateRecord[] = [];
        const mergedEntryIds: string[] = [];
        for (const plan of plans) {
          const result = repository.mergeExactSourcesWithinTransaction(plan.merge);
          if (result === undefined) created.push(this.candidates.createCandidateWithinTransaction(plan.fallbackCandidate));
          else mergedEntryIds.push(result.record.id);
        }
        for (const candidate of candidateInputs) created.push(this.candidates.createCandidateWithinTransaction(candidate));
        return { created, mergedEntryIds };
      });
      const generatedCandidates = drafts.map((_, index) => this.candidates.findCandidateById(
        input.workspaceId, terminalCandidateId(input.runId, index),
      )).filter((candidate): candidate is MemoryCandidateRecord => candidate !== undefined);
      const duplicateOfEntryId = nearDuplicateOfEntryId
        ?? [...exactEntriesByCandidateId.entries()].find(([candidateId, entryId]) =>
          !generatedCandidates.some(candidate => candidate.id === candidateId)
          && saved.mergedEntryIds.includes(entryId))?.[1];
      return { outcome: saved.created.length > 0 ? 'created' : saved.mergedEntryIds.length > 0 ? 'converged' : 'existing',
        ...(generatedCandidates[0] ? { candidate: generatedCandidates[0] } : {}),
        ...(generatedCandidates.length > 0 ? { candidates: generatedCandidates } : {}),
        ...(duplicateOfEntryId ? { duplicateOfEntryId } : {}) };
    } catch (error) {
      // Lost same-id race: the failed write rolled back, so any surviving row
      // can only have been written by the concurrent winner — converge on it.
      // The emitter path is included because it wraps the underlying UNIQUE
      // violation, and converging is still the truthful outcome.
      if ((error instanceof Error && /UNIQUE/i.test(error.message)) || this.emitter !== undefined) {
        const won = [0, 1, 2].map(index => this.candidates.findCandidateById(
          input.workspaceId, terminalCandidateId(input.runId, index),
        )).filter((candidate): candidate is MemoryCandidateRecord => candidate !== undefined);
        if (won.length > 0) return { outcome: 'existing', candidate: won[0], candidates: won };
      }
      throw new MemoryCandidateGenerationError('GENERATION_FAILED');
    }
  }

  /**
   * Reads only durable, public output summaries explicitly linked by this
   * Run's terminal event. Artifact bytes, provider logs, and other Run output
   * are deliberately outside the evidence bundle.
   */
  private readTerminalArtifactEvidence(
    workspaceId: string,
    taskId: string,
    runId: string,
    nextEventSequence: number,
  ): TerminalArtifactEvidence[] {
    const event = this.db.prepare(`
      SELECT id, payload_json FROM runtime_events
      WHERE workspace_id = ? AND task_id = ? AND run_id = ? AND type = 'run.completed'
        AND visibility = 'public' AND durability = 'durable' AND sequence < ?
      ORDER BY sequence DESC LIMIT 1
    `).get(workspaceId, taskId, runId, nextEventSequence) as { id: string; payload_json: string } | undefined;
    if (!event) return [];
    const payload = parseJson(event.payload_json);
    if (!isRunCompletedPayload(payload)) return [];

    const referencedIds = [...new Set([
      ...(payload.summaryArtifactId ? [payload.summaryArtifactId] : []),
      ...payload.artifactIds,
    ])].slice(0, MAX_TERMINAL_ARTIFACTS);
    const evidence: TerminalArtifactEvidence[] = [];
    const findArtifact = this.db.prepare(`
      SELECT id, artifact_type, summary, source_stage_id FROM runtime_artifacts
      WHERE workspace_id = ? AND canonical_run_id = ? AND provenance_kind = 'CANONICAL'
        AND id = ? AND artifact_type IN ('review', 'test')
    `);
    for (const artifactId of referencedIds) {
      if (!payload.artifactIds.includes(artifactId)) continue;
      const row = findArtifact.get(workspaceId, runId, artifactId) as {
        id: string; artifact_type: 'review' | 'test'; summary: string | null; source_stage_id: string | null;
      } | undefined;
      const summary = safeEvidence(row?.summary, 1_000);
      if (!row || !summary) continue;
      evidence.push({ eventId: event.id, artifactId: row.id, artifactType: row.artifact_type,
        summary, sourceStageId: row.source_stage_id });
    }
    return evidence;
  }

  /**
   * Dedup order step 4: FTS similarity over the Entry title — the densest
   * near-duplicate signal. All title tokens must match (AND semantics via
   * the neutralized query); summary/content tokens are too body-specific and
   * would miss partial overlaps. Any hit is a near-duplicate SIGNAL (never a
   * silent merge). Degraded FTS (unavailable/error) yields no signal;
   * structured hashes remain authoritative.
   */
  private findFtsNearDuplicate(workspaceId: string, taskId: string, category: string, title: string): string | undefined {
    const ftsQuery = toSafeFtsQuery(title);
    if (ftsQuery === null) return undefined;
    try {
      const row = this.db.prepare(
        'SELECT memory_entries_fts.memory_entry_id AS id'
          + ' FROM memory_entries_fts'
          + ' INNER JOIN memory_entries ON memory_entries.id = memory_entries_fts.memory_entry_id'
          + ' WHERE memory_entries.workspace_id = ?'
          + " AND memory_entries.status = 'active' AND memory_entries.scope = 'task' AND memory_entries.category = ?"
          + ' AND memory_entries.owner_task_id = ? AND memory_entries.owner_agent_id IS NULL'
          + ' AND memory_entries.owner_conversation_id IS NULL AND memory_entries.owner_run_id IS NULL'
          + ' AND memory_entries_fts MATCH ?'
          + ' ORDER BY bm25(memory_entries_fts) ASC, id ASC LIMIT 1',
      ).get(workspaceId, category, taskId, ftsQuery) as { id: string } | undefined;
      return row?.id;
    } catch {
      return undefined;
    }
  }
}
