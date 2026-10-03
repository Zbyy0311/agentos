import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type {
  CollaborationCandidate,
  CollaborationCandidateSummary,
  CollaborationProgress,
  CollaborationProgressAgent,
  CollaborationProgressEvent,
  CollaborationProgressEvidence,
  CollaborationProgressRole,
  CollaborationProgressRun,
  CollaborationProgressRunStatus,
  CollaborationProgressStage,
  CollaborationProgressStageStatus,
  CollaborationReviewConclusion,
  CollaborationTask,
  CollaborationTaskDetails,
  CollaborationStatus,
  Run,
  Task as CanonicalTask,
  V2RunReason,
  Workspace,
} from '@agentos/shared';
import { redactRuntimeText } from '@agentos/agent-core';
import { getWorkflowTemplate } from '@agentos/shared';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { CollaborationRepository, CollaborationRepositoryError } from '../store/CollaborationRepository.js';
import { CollaborationControlError, CollaborationControlRepository, type CollaborationControl, type CollaborationControlAction } from '../store/CollaborationControlRepository.js';
import { createEntityId } from '../store/Identity.js';
import { readCollaborationApplicationFacts, collaborationApplicationTerminalReason } from '../store/CollaborationApplicationTerminalState.js';
import type { SqliteStore } from '../store/SqliteStore.js';
import { TaskRunService } from './TaskRunService.js';
import { IdempotencyService } from './IdempotencyService.js';
import { hashIdempotencyRequest, hashNormalizedIdempotencyKey } from '../idempotency/fingerprint.js';
import { WorktreeError, type WorktreeManager } from './WorktreeManager.js';
import { captureCollaborationCandidateSnapshot } from './CollaborationCandidateSnapshot.js';
import { collaborationCandidateContentHash } from './CollaborationCandidateContentHash.js';
import {
  buildCollaborationCandidatePreview,
  buildCollaborationCandidatePreviewFileDiff,
  type CollaborationCandidatePreview,
  type CollaborationCandidatePreviewFileDiff,
} from './CollaborationCandidatePreview.js';
import { CollaborationSnapshotGitContext } from './CollaborationSnapshotGitContext.js';
import { captureCollaborationPathBoundary } from './CollaborationPathBoundary.js';
import { assertCollaborationPathsWithinScope, normalizeCollaborationScope, COLLABORATION_SCOPE_POLICY_VERSION } from './CollaborationScopePolicy.js';
import { CollaborationApplyJournalService, type ApplyJournal } from './CollaborationApplyJournal.js';
import type { CollaborationStageCompletionInput, CollaborationStagePreparation, CollaborationStagePreparationInput } from './CollaborationStageHooks.js';
import type { CollaborationStageOutput } from '../store/CollaborationRepository.js';
import { buildCollaborationReviewPrompt, validateCollaborationReview } from './CollaborationReviewProtocol.js';
import { isTransactionActive } from '../store/Transaction.js';
import type { VerifiedMemoryFact, VerifiedMemoryFactService } from './VerifiedMemoryFactService.js';
import { COLLABORATION_ACCEPTANCE_RUNNER_VERSION } from './VerifiedMemoryFactService.js';

const execFileAsync = promisify(execFile);
const MAX_OBJECTIVE_BYTES = 16 * 1024;
const MAX_SCOPE_ITEMS = 20;
const MAX_COMMANDS = 5;
const MAX_COMMAND_BYTES = 1_000;
const MAX_TEST_OUTPUT_BYTES = 32 * 1024;

function candidateSummary(candidate: CollaborationCandidate): CollaborationCandidateSummary {
  return {
    id: candidate.id,
    round: candidate.round,
    diffHash: candidate.diffHash,
    contentHash: candidate.contentHash ?? collaborationCandidateContentHash({
      diffHash: candidate.diffHash,
      snapshotVersion: candidate.snapshotVersion ?? 1,
      manifestVersion: candidate.manifestVersion ?? 1,
      manifest: candidate.manifest,
    }),
    ...(candidate.snapshotVersion === undefined ? {} : { snapshotVersion: candidate.snapshotVersion }),
    ...(candidate.manifestVersion === undefined ? {} : { manifestVersion: candidate.manifestVersion }),
    testStatus: candidate.testStatus,
    ...(candidate.testCommand === undefined ? {} : { testCommand: candidate.testCommand }),
    ...(candidate.testExitCode === undefined ? {} : { testExitCode: candidate.testExitCode }),
    ...(candidate.reviewConclusion === undefined ? {} : { reviewConclusion: candidate.reviewConclusion }),
    ...(candidate.reviewSummary === undefined ? {} : { reviewSummary: candidate.reviewSummary }),
  };
}

export class CollaborationWorkflowError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CollaborationWorkflowError';
  }
}

export interface CollaborationWorkflowServiceOptions {
  readonly store: SqliteStore;
  readonly workspaces: WorkspaceManager;
  readonly worktrees: WorktreeManager;
  /** Host-local explicit reconnect mapping; memory/evidence paths keep Workspace.rootPath. */
  readonly workspaceGitRootFor?: (workspaceId: string) => string | undefined;
  /** Explicit host-local Git reconnect proof; portable restored roots do not qualify by fallback. */
  readonly workspaceGitRootIsExplicitlyReconnected?: (workspaceId: string) => boolean;
  readonly dispatchRun: (workspaceId: string, runId: string) => Promise<void>;
  readonly requestRunAdmission: (input: { workspaceId: string; runId: string }) => Promise<boolean>;
  readonly releaseRunAdmission: (input: { workspaceId: string; runId: string }) => Promise<void>;
  readonly cancelRun: (input: { workspaceId: string; runId: string; correlationId: string }) => Promise<{
    expectedRunVersion: number;
    terminatedProcessIds?: string[];
    worktreePreserved: boolean;
  }>;
  readonly registerWorktreePath: (runId: string, path: string) => void;
  readonly requestApplicationAdmission?: (input: { workspaceId: string; controlId: string }) => Promise<boolean>;
  readonly releaseApplicationAdmission?: (input: { workspaceId: string; controlId: string }) => Promise<void>;
  /** Production explicitly supplies its existing Runtime dispatch feature flag. */
  readonly runtimeDispatchEnabled?: boolean;
  /** Lazily supplied so old databases without migration 046 keep working. */
  readonly verifiedMemoryFacts?: () => Pick<VerifiedMemoryFactService, 'accumulateTerminal'> | undefined;
  /** Fact accumulation is best-effort and must never alter canonical Run completion. */
  readonly onVerifiedMemoryFactProblem?: (detail: string) => void;
  /** Fault-injection seam only; production does not supply it. */
  readonly applyFault?: (point: 'before_prepare' | 'before_write' | 'after_write' | 'before_commit' | 'recovery') => void;
}

export interface CreateCollaborationPlanInput {
  readonly id?: string;
  readonly workspaceId: string;
  readonly conversationId?: string;
  readonly sourceMessageId?: string;
  readonly title: string;
  readonly objective: string;
  readonly scope: string[];
  readonly acceptanceCommands: string[];
  readonly plannerAgentId: string;
  readonly implementerAgentId: string;
  readonly reviewerAgentId: string;
  readonly maxReworkRounds?: number;
}

export interface CollaborationMutationInput {
  readonly workspaceId: string;
  readonly collaborationId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey?: string;
  /** Apply requires all three frozen preview identity fields; other actions omit them. */
  readonly candidateId?: string;
  readonly candidateBaseCommit?: string;
  readonly candidateContentHash?: string;
}

export interface CollaborationRecoveryInput {
  readonly workspaceId: string;
  readonly collaborationId: string;
  readonly expectedTaskVersion: number;
  readonly expectedRunId: string;
  readonly expectedRunVersion: number;
  readonly idempotencyKey: string;
  readonly action: 'retry-known-failure' | 'new-linked-task';
}

export interface CollaborationRecoveryOptions {
  readonly taskId: string;
  readonly taskVersion: number;
  readonly runId?: string;
  readonly runVersion?: number;
  readonly failureCode?: string;
  readonly recoveryRequired?: boolean;
  readonly checkedBaseCommit?: string;
  readonly resumeRequest?: {
    readonly idempotencyKey: string;
    readonly expectedTaskVersion: number;
    readonly expectedRunId: string;
    readonly expectedRunVersion: number;
  };
  readonly actions: { readonly retryKnownFailure: boolean; readonly newLinkedTask: boolean };
  readonly reason?: string;
}

interface CollaborationRecoveryRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly collaboration_task_id: string;
  readonly prior_run_id: string;
  readonly action: string;
  readonly expected_task_version: number;
  readonly expected_run_version: number;
  readonly idempotency_key: string;
  readonly request_hash: string;
  readonly state: string;
  readonly new_run_id: string | null;
  readonly checked_base_commit: string | null;
  readonly result_json: string | null;
}

interface CandidateCapture {
  readonly headCommit: string;
  readonly diffText: string;
  readonly diffHash: string;
  readonly manifest: CollaborationCandidate['manifest'];
  readonly testStatus: CollaborationCandidate['testStatus'];
  readonly testCommand: string;
  readonly testExitCode: number;
  readonly testOutput: string;
  readonly sourceChangedDuringTests: boolean;
}

interface ReviewEvidence {
  readonly conclusion: CollaborationReviewConclusion;
  readonly summary: string;
  readonly stageId: string;
  readonly stageAttempt: number;
  readonly reviewerAgentId: string;
  readonly candidateDiffHash: string;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeOutput(value: string): string {
  const redacted = redactRuntimeText(value, MAX_TEST_OUTPUT_BYTES);
  return redacted.length <= MAX_TEST_OUTPUT_BYTES ? redacted : redacted.slice(0, MAX_TEST_OUTPUT_BYTES) + '\n[output truncated]';
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

export class CollaborationWorkflowService {
  private readonly repository: CollaborationRepository;
  private readonly controls: CollaborationControlRepository;
  private readonly journals: CollaborationApplyJournalService;
  private readonly taskRuns: TaskRunService;
  private readonly reviewPreparations = new Map<string, Promise<CollaborationStagePreparation | undefined>>();
  private readonly processing = new Set<string>();
  private readonly leaseByTask = new Map<string, string>();
  private recovering = false;

  constructor(private readonly options: CollaborationWorkflowServiceOptions) {
    this.repository = new CollaborationRepository(options.store.getDatabase());
    this.controls = new CollaborationControlRepository(options.store.getDatabase());
    this.journals = new CollaborationApplyJournalService(options.store.getDatabase());
    this.taskRuns = new TaskRunService(options.store, {
      idempotencyService: new IdempotencyService(options.store.idempotencyRepository()),
    });
  }

  async createPlan(input: CreateCollaborationPlanInput): Promise<CollaborationTask> {
    const workspace = this.requireWorkspace(input.workspaceId);
    const normalized = this.validatePlan(input, workspace);
    const workspaceRoot = this.gitRoot(workspace.id);
    await this.options.worktrees.preflight(workspaceRoot, { controlledGitContent: true });
    const baseCommit = await git(workspaceRoot, ['rev-parse', 'HEAD']);
    const planHash = hash(JSON.stringify({
      title: normalized.title, objective: normalized.objective, scope: normalized.scope,
      acceptanceCommands: normalized.acceptanceCommands, plannerAgentId: normalized.plannerAgentId,
      implementerAgentId: normalized.implementerAgentId, reviewerAgentId: normalized.reviewerAgentId,
      baseCommit, scopePolicyVersion: COLLABORATION_SCOPE_POLICY_VERSION,
    }));
    return this.repository.create({
      ...normalized, maxReworkRounds: normalized.maxReworkRounds ?? 2,
      workspaceId: workspace.id, baseCommit, planHash, scopePolicyVersion: COLLABORATION_SCOPE_POLICY_VERSION, createdAt: new Date().toISOString(),
    });
  }

  getDetails(workspaceId: string, collaborationId: string): CollaborationTaskDetails {
    const task = this.withPendingControl(this.requireTask(workspaceId, collaborationId));
    const candidates = this.repository.listCandidates(workspaceId, collaborationId).map(candidateSummary);
    return {
      task,
      ...(task.currentCandidateId === undefined ? {} : {
        candidate: candidates.find(candidate => candidate.id === task.currentCandidateId),
      }),
      candidates,
      reviews: this.repository.listReviews(workspaceId, collaborationId),
    };
  }

  getCandidatePreview(
    workspaceId: string,
    collaborationId: string,
    candidateId: string,
    candidateBaseCommit: string,
    candidateContentHash: string,
    pagination: { readonly offset: number; readonly limit: number },
  ): CollaborationCandidatePreview {
    this.requireWorkspace(workspaceId);
    const task = this.requireTask(workspaceId, collaborationId);
    const candidate = this.repository.findCandidate(workspaceId, candidateId);
    if (!candidate || candidate.collaborationTaskId !== task.id) {
      throw new CollaborationWorkflowError('COLLABORATION_CANDIDATE_NOT_FOUND', 'Candidate snapshot not found');
    }
    this.assertPreviewIdentity(task, candidate, candidateId, candidateBaseCommit, candidateContentHash);
    return buildCollaborationCandidatePreview(task, candidate, pagination);
  }

  getCandidatePreviewFileDiff(
    workspaceId: string,
    collaborationId: string,
    candidateId: string,
    candidateBaseCommit: string,
    candidateContentHash: string,
    fileIndex: number,
  ): CollaborationCandidatePreviewFileDiff {
    this.requireWorkspace(workspaceId);
    const task = this.requireTask(workspaceId, collaborationId);
    const candidate = this.repository.findCandidate(workspaceId, candidateId);
    if (!candidate || candidate.collaborationTaskId !== task.id) {
      throw new CollaborationWorkflowError('COLLABORATION_CANDIDATE_NOT_FOUND', 'Candidate snapshot not found');
    }
    this.assertPreviewIdentity(task, candidate, candidateId, candidateBaseCommit, candidateContentHash);
    return buildCollaborationCandidatePreviewFileDiff(task, candidate, fileIndex);
  }

  private assertPreviewIdentity(
    task: CollaborationTask,
    candidate: CollaborationCandidate,
    candidateId: string,
    candidateBaseCommit: string,
    candidateContentHash: string,
  ): void {
    if (task.currentCandidateId !== candidateId || candidate.id !== candidateId
      || candidate.baseCommit !== candidateBaseCommit || task.baseCommit !== candidateBaseCommit
      || candidate.contentHash !== candidateContentHash || !/^[a-f0-9]{64}$/u.test(candidateContentHash)) {
      throw new CollaborationWorkflowError('COLLABORATION_CANDIDATE_CHANGED', 'The candidate differs from the frozen preview; refresh before loading it');
    }
  }

  list(workspaceId: string, options: { conversationId?: string; limit?: number; offset?: number } = {}): CollaborationTask[] {
    this.requireWorkspace(workspaceId);
    return this.repository.list(workspaceId, options).map(task => this.withPendingControl(task));
  }

  getProgress(workspaceId: string, collaborationId: string): CollaborationProgress {
    const details = this.getDetails(workspaceId, collaborationId);
    const runChain = this.collectRunChain(workspaceId, details.task);
    const heldApplications = this.options.store.getDatabase().prepare(
      "SELECT c.id FROM collaboration_controls c JOIN workspace_admissions a"
        + " ON a.workspace_id = c.workspace_id AND a.collaboration_control_id = c.id"
        + " WHERE c.workspace_id = ? AND c.collaboration_task_id = ? AND c.action = 'apply'"
        + " AND a.subject_kind = 'COLLABORATION_APPLICATION' AND a.state = 'GRANTED'",
    ).all(workspaceId, collaborationId) as { id: string }[];
    for (const held of heldApplications) {
      const facts = readCollaborationApplicationFacts(this.options.store.getDatabase(), workspaceId, held.id);
      if (facts && collaborationApplicationTerminalReason(facts)) {
        runChain.warnings.push('应用结果已安全提交或回滚，但写入准入尚未释放；恢复时将幂等释放，不会再次应用候选');
      }
    }
    const progressRuns = runChain.runs.map(run => this.projectProgressRun(workspaceId, details.task, run));
    const events = progressRuns.flatMap(run => run.stages.flatMap(stage => {
      const raw = this.publicEvents(workspaceId, run.runId).filter(event => event.stageId === stage.stageId);
      return raw;
    })).sort((left, right) => left.sequence - right.sequence);
    const currentRun = progressRuns.at(-1);
    const currentStage = this.resolveCurrentStage(details.task.status, currentRun);
    const currentAgent = currentStage?.agent;
    const waitingReason = details.task.failureReason
      ?? (currentRun?.status === 'waiting_approval' ? '执行已暂停，等待审批' : undefined)
      ?? (currentRun?.status === 'paused' ? '执行已暂停，等待恢复' : undefined);
    return {
      task: details.task,
      runs: progressRuns,
      ...(currentRun === undefined ? {} : { currentRunId: currentRun.runId }),
      ...(currentStage === undefined ? {} : { currentStage }),
      ...(currentAgent === undefined ? {} : { currentAgent }),
      ...(waitingReason === undefined ? {} : { waitingReason }),
      ...(runChain.warnings.length === 0 ? {} : { warnings: runChain.warnings }),
      events: events.slice(-80),
      eventCursor: progressRuns.reduce((max, run) => Math.max(max, run.highWatermark), 0),
      candidates: details.candidates,
      reviews: details.reviews,
    };
  }

  async beforeStage(input: CollaborationStagePreparationInput): Promise<CollaborationStagePreparation | undefined> {
    const task = this.repository.findByCanonicalRun(input.workspaceId, input.runId);
    if (!task) return undefined;
    this.assertExecutionFence(task, input.runId);
    if (input.stage.workflowStageKey !== 'review') return undefined;
    const key = `${input.workspaceId}:${input.runId}:${input.stage.id}:${input.stage.attempt}`;
    const pending = this.reviewPreparations.get(key);
    if (pending) return pending;
    const preparation = this.prepareReviewStage(input, task);
    this.reviewPreparations.set(key, preparation);
    try {
      return await preparation;
    } finally {
      if (this.reviewPreparations.get(key) === preparation) this.reviewPreparations.delete(key);
    }
  }

  /**
   * Best-effort post-commit hook for the canonical collaboration Run. Authority
   * is re-derived from its durable terminal Event so callers cannot supply a
   * model-authored or cross-Run event context. Reconciliation retries failures.
   */
  accumulateTerminal(input: { readonly workspaceId: string; readonly runId: string }): readonly VerifiedMemoryFact[] {
    const db = this.options.store.getDatabase();
    if (isTransactionActive(db) || !this.options.verifiedMemoryFacts) return [];
    try {
      if (!this.requireWorkspace(input.workspaceId).memoryEnabled || !hasVerifiedMemoryFactSchema(db)) return [];
      const run = db.prepare(`SELECT r.task_id,r.status FROM runs r
        JOIN collaboration_tasks c ON c.workspace_id=r.workspace_id AND c.canonical_run_id=r.id
          AND c.canonical_task_id=r.task_id
        WHERE r.workspace_id=? AND r.id=?`).get(input.workspaceId, input.runId) as
        { task_id: string; status: string } | undefined;
      if (!run || !['completed', 'failed', 'cancelled'].includes(run.status)) return [];
      const eventType = run.status === 'completed' ? 'run.completed'
        : run.status === 'failed' ? 'run.failed' : 'run.cancelled';
      const event = db.prepare(`SELECT id,correlation_id,timestamp FROM runtime_events
        WHERE workspace_id=? AND task_id=? AND run_id=? AND type=? AND durability='durable'
          AND correlation_id<>'' ORDER BY sequence DESC LIMIT 1`).get(
        input.workspaceId, run.task_id, input.runId, eventType,
      ) as { id: string; correlation_id: string; timestamp: string } | undefined;
      if (!event) return [];
      return this.options.verifiedMemoryFacts()?.accumulateTerminal({
        workspaceId: input.workspaceId,
        runId: input.runId,
        createdAt: event.timestamp,
        eventContext: {
          origin: 'persisted_event', eventId: event.id,
          context: { correlationId: event.correlation_id, causationId: event.id },
        },
      }) ?? [];
    } catch (error) {
      try { this.options.onVerifiedMemoryFactProblem?.(`COLLABORATION_MEMORY_FACT_FAILED run=${input.runId}: ${error instanceof Error ? error.message : String(error)}`); }
      catch { /* telemetry must not affect terminal Run handling */ }
      return [];
    }
  }

  private async prepareReviewStage(input: CollaborationStagePreparationInput, task: CollaborationTask): Promise<CollaborationStagePreparation> {
    let candidate: CollaborationCandidate | undefined;
    try {
      candidate = this.repository.findCandidateForRun(input.workspaceId, task.id, input.runId);
      if (!candidate && input.stage.status !== 'ready') {
        throw new CollaborationWorkflowError('COLLABORATION_CANDIDATE_MISSING', '评审阶段已启动但冻结候选缺失；不会在恢复时从活动工作区重新生成');
      }
      if (!candidate) candidate = await this.captureAndPersistCandidate(task, input.runId, input.worktreePath);
      if (candidate.snapshotVersion !== 2 || !candidate.diffText || hash(candidate.diffText) !== candidate.diffHash) {
        throw new CollaborationWorkflowError('COLLABORATION_CANDIDATE_INVALID', '候选快照不完整，不能启动评审');
      }
      if (candidate.testOutput?.includes('COLLABORATION_TEST_MUTATED_CANDIDATE')) {
        throw new CollaborationWorkflowError('COLLABORATION_TEST_MUTATED_CANDIDATE', '验收命令修改了候选文件，已阻止评审');
      }
      if (task.status !== 'reviewing' || task.currentCandidateId !== candidate.id) {
        this.progress(task, 'reviewing', input.runId, undefined, candidate.id);
      }
      const reviewPath = await this.ensureReviewWorktree(task, candidate, input.workspaceRoot);
      this.assertExecutionFence(task, input.runId);
      return {
        workspaceRoot: reviewPath,
        worktreePath: reviewPath,
        promptAddition: buildCollaborationReviewPrompt({
          candidateId: candidate.id,
          candidateHash: candidate.diffHash,
          runId: input.runId,
          stageAttempt: input.stage.attempt,
          reviewerAgentId: task.reviewerAgentId,
        }),
      };
    } catch (cause) {
      const latest = this.repository.findById(input.workspaceId, task.id) ?? task;
      const message = cause instanceof Error ? cause.message : '评审候选准备失败';
      if (this.canDispatch(input.workspaceId, input.runId) && latest.status !== 'blocked') {
        this.progress(latest, 'blocked', input.runId, message, candidate?.id);
      }
      throw cause;
    }
  }

  async completedStage(input: CollaborationStageCompletionInput): Promise<void> {
    const task = this.repository.findByCanonicalRun(input.workspaceId, input.runId);
    if (!task) return;
    if (!this.canDispatch(input.workspaceId, input.runId)) return;
    const raw = input.output;
    const outputHash = raw === undefined || raw.trim().length === 0 ? undefined : hash(raw);
    if (input.stage.workflowStageKey === 'review') {
      const candidate = this.repository.findCandidateForRun(input.workspaceId, task.id, input.runId);
      const validation = candidate && candidate.snapshotVersion === 2
        ? validateCollaborationReview(raw, {
          candidateId: candidate.id,
          candidateHash: candidate.diffHash,
          runId: input.runId,
          stageAttempt: input.stage.attempt,
          reviewerAgentId: task.reviewerAgentId,
        })
        : { valid: false as const, reason: candidate ? '冻结候选版本不支持评审' : '评审候选不存在' };
      const valid = validation.valid && input.agentId === task.reviewerAgentId;
      const parsed = validation.valid ? { ...validation.review, summary: safeOutput(validation.review.summary) } : undefined;
      const invalidReason = input.agentId !== task.reviewerAgentId
        ? '实际评审 Agent 与冻结评审角色不匹配'
        : validation.valid ? undefined : validation.reason;
      const record: CollaborationStageOutput = {
        workspaceId: input.workspaceId, collaborationTaskId: task.id, runId: input.runId,
        stageId: input.stage.id, stageAttempt: input.stage.attempt, agentId: input.agentId,
        role: input.role, status: valid ? 'available' : raw?.trim() ? 'invalid' : 'missing',
        ...(valid && parsed ? { publicOutput: parsed.summary } : {}),
        ...(outputHash === undefined ? {} : { outputHash }),
        ...(!valid ? { reason: invalidReason ?? '评审结论无效' } : {}),
        ...(valid && parsed ? {
          reviewCandidateId: parsed.candidateId,
          reviewCandidateHash: parsed.candidateHash,
          reviewConclusion: parsed.conclusion,
        } : {}),
        createdAt: new Date().toISOString(),
      };
      this.repository.recordStageOutput(record);
      return;
    }
    const publicOutput = raw?.trim() ? safePublicOutput(raw) : undefined;
    this.repository.recordStageOutput({
      workspaceId: input.workspaceId, collaborationTaskId: task.id, runId: input.runId,
      stageId: input.stage.id, stageAttempt: input.stage.attempt, agentId: input.agentId,
      role: input.role, status: publicOutput ? 'available' : 'missing',
      ...(publicOutput ? { publicOutput } : {}), ...(outputHash ? { outputHash } : {}),
      ...(!publicOutput ? { reason: 'Agent 未返回可公开的阶段摘要' } : {}),
      createdAt: new Date().toISOString(),
    });
  }

  private collectRunChain(workspaceId: string, task: CollaborationTask): { runs: Run[]; warnings: string[] } {
    const runs: Run[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();
    let runId = task.canonicalRunId;
    if (runId !== undefined && task.canonicalTaskId === undefined) {
      warnings.push('协作任务缺少 canonical Task 关联，无法完整核验 Run 归属');
    }
    while (runId !== undefined && !seen.has(runId)) {
      seen.add(runId);
      const run = this.options.store.runRepository().findById(workspaceId, runId);
      if (!run) {
        warnings.push(`Run 关联缺失：${runId}`);
        break;
      }
      if (task.canonicalTaskId !== undefined && run.taskId !== task.canonicalTaskId) {
        warnings.push(`Run 关联不匹配：${runId}`);
        break;
      }
      runs.unshift(run);
      runId = run.parentRunId;
    }
    if (runId !== undefined && seen.has(runId)) warnings.push(`Run 关联存在循环：${runId}`);
    return { runs, warnings };
  }

  private projectProgressRun(workspaceId: string, task: CollaborationTask, run: Run): CollaborationProgressRun {
    const snapshot = this.options.store.runSnapshotRepository().findByRunId(workspaceId, run.id);
    const stages = this.options.store.runStageRepository().listByRun(workspaceId, run.id);
    const snapshotStages = snapshot?.payload && 'workflow' in snapshot.payload && Array.isArray(snapshot.payload.workflow.stages)
      ? snapshot.payload.workflow.stages : [];
    const progressStages = stages.map(stage => {
      const frozen = snapshotStages.find(item => item.workflowStageKey === stage.workflowStageKey);
      const agentSnapshot = frozen?.agent;
      const agent = agentSnapshot ? {
        agentId: agentSnapshot.agentId,
        name: agentSnapshot.name,
        role: progressRole(stage.workflowStageKey),
        roleTitle: agentSnapshot.roleTitle,
      } satisfies CollaborationProgressAgent : undefined;
      const outputRecord = this.repository.findStageOutput(workspaceId, run.id, stage.id, stage.attempt);
      const output = outputRecord?.status === 'available' ? outputRecord.publicOutput ?? '' : '';
      const outputStatus = stage.status === 'pending' || stage.status === 'ready'
        ? 'not_started'
        : outputRecord?.status ?? (stage.status === 'completed' ? 'unavailable' : undefined);
      const outputReason = outputRecord?.reason
        ?? (stage.status === 'completed' && !output ? '该历史阶段未保存可公开的最终答复' : undefined);
      const evidence = this.progressEvidence(task, run.id, stage.workflowStageKey);
      const stageProgress: CollaborationProgressStage = {
        runId: run.id,
        stageId: stage.id,
        stageKey: stage.workflowStageKey,
        label: stageLabel(stage.workflowStageKey),
        sequence: stage.sequence,
        attempt: stage.attempt,
        status: progressStageStatus(stage.status),
        ...(agent === undefined ? {} : { agent }),
        ...(stage.startedAt === undefined ? {} : { startedAt: stage.startedAt }),
        ...(stage.completedAt === undefined ? {} : { completedAt: stage.completedAt }),
        ...(stage.failureMessage === undefined ? {} : { failureMessage: stage.failureMessage }),
        ...(output.length === 0 ? {} : { publicOutput: safePublicOutput(output) }),
        ...(outputStatus === undefined ? {} : { publicOutputStatus: outputStatus === 'missing' ? 'not_recorded' : outputStatus }),
        ...(outputReason === undefined ? {} : { publicOutputReason: outputReason }),
        evidence,
      };
      return stageProgress;
    });
    const highWatermark = this.options.store.runtimeEventRepository().listByRunAfterSequence(run.id, 0)
      .reduce((max, record) => Math.max(max, record.event.sequence), 0);
    return {
      runId: run.id,
      ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
      status: progressRunStatus(run.status),
      createdAt: run.createdAt,
      ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
      ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
      ...(run.failureMessage === undefined ? {} : { failureMessage: run.failureMessage }),
      highWatermark,
      stages: progressStages,
    };
  }

  private publicEvents(workspaceId: string, runId: string): CollaborationProgressEvent[] {
    return this.options.store.runtimeEventRepository().listByRunAfterSequence(runId, 0)
      .filter(record => record.event.visibility === 'public' && record.event.durability === 'durable')
      .map(record => {
        const event = record.event;
        const payload = event.payload;
        const summary = publicEventSummary(event.type, payload);
        return {
          eventId: event.id,
          runId: event.runId,
          sequence: event.sequence,
          type: event.type,
          timestamp: event.timestamp,
          ...(event.stageId === undefined ? {} : { stageId: event.stageId }),
          ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
          ...(summary === undefined ? {} : { summary }),
        } satisfies CollaborationProgressEvent;
      });
  }

  private progressEvidence(task: CollaborationTask, runId: string, stageKey: string): CollaborationProgressEvidence[] {
    const candidates = this.repository.listCandidates(task.workspaceId, task.id).filter(candidate => candidate.canonicalRunId === runId);
    const evidence: CollaborationProgressEvidence[] = [];
    for (const candidate of candidates) {
      if (stageKey === 'implement') evidence.push({ kind: 'candidate', label: `候选版本 · 第 ${candidate.round + 1} 轮`, status: candidate.status, runId });
      if (stageKey === 'review') {
        evidence.push({ kind: 'test', label: '验收命令', status: candidate.testStatus, runId });
        if (candidate.reviewArtifactId) evidence.push({ kind: 'artifact', label: '评审证据', artifactId: candidate.reviewArtifactId, runId });
      }
    }
    for (const review of this.repository.listReviews(task.workspaceId, task.id).filter(item => item.canonicalRunId === runId)) {
      if (stageKey === 'review') evidence.push({ kind: 'review', label: '结构化评审', status: review.conclusion, artifactId: review.artifactId, runId });
    }
    return evidence;
  }

  private resolveCurrentStage(status: CollaborationStatus, run: CollaborationProgressRun | undefined): CollaborationProgressStage | undefined {
    if (!run) return undefined;
    const active = run.stages.find(stage => ['ready', 'starting', 'running', 'waiting_approval', 'paused'].includes(stage.status));
    if (active) return active;
    const terminalProblem = run.stages.find(stage => ['failed', 'cancelled'].includes(stage.status));
    if (terminalProblem) return terminalProblem;
    if (status === 'reviewing' || status === 'awaiting_application' || status === 'changes_requested') {
      return run.stages.find(stage => stage.stageKey === 'review') ?? run.stages.at(-1);
    }
    return [...run.stages].reverse().find(stage => !['skipped', 'pending'].includes(stage.status))
      ?? run.stages.find(stage => stage.status === 'pending')
      ?? run.stages.at(-1);
  }

  /** Continue the same canonical Run after its durable Runtime approval. */
  async resumeRun(workspaceId: string, runId: string): Promise<boolean> {
    const task = this.repository.findByCanonicalRun(workspaceId, runId);
    if (!task) return false;
    if (!['queued', 'running', 'reviewing'].includes(task.status)) return true;
    if (this.recovering || this.options.runtimeDispatchEnabled === false || !this.canDispatch(workspaceId, runId)) return true;
    const run = this.options.store.runRepository().findById(workspaceId, runId);
    if (!run || run.recoveryRequired || ['completed', 'failed', 'cancelled'].includes(run.status)) return true;
    const admission = this.options.store.getDatabase().prepare(
      "SELECT state FROM workspace_admissions WHERE workspace_id = ? AND canonical_run_id = ? AND subject_kind = 'CANONICAL_RUN'",
    ).get(workspaceId, runId) as { state: string } | undefined;
    if (admission?.state !== 'GRANTED') return true;
    const stages = this.options.store.runStageRepository().listByRun(workspaceId, runId);
    const reviewStage = stages.find(stage => stage.workflowStageKey === 'review');
    const candidate = this.repository.findCandidateForRun(workspaceId, task.id, runId);
    const reviewStarted = Boolean(candidate && reviewStage && ['starting', 'running'].includes(reviewStage.status));
    const reviewLease = reviewStarted && candidate ? this.findReviewLease(candidate) : undefined;
    const leaseId = reviewLease?.id ?? this.resolveLeaseId(task);
    const record = leaseId === undefined ? undefined : this.options.worktrees.getRecord(leaseId);
    if (!record) {
      this.progress(task, 'blocked', runId, 'The isolated worktree is unavailable; execution was not resumed');
      return true;
    }
    this.options.registerWorktreePath(runId, record.absolutePath);
    await this.driveAndFinalize(task.id, workspaceId, runId);
    return true;
  }

  async confirm(input: CollaborationMutationInput): Promise<CollaborationTask> {
    return this.executeControl('confirm', input, control => this.confirmInternal(input, control));
  }

  async getRecoveryOptions(workspaceId: string, collaborationId: string): Promise<CollaborationRecoveryOptions> {
    const task = this.requireTask(workspaceId, collaborationId);
    const run = task.canonicalRunId ? this.options.store.runRepository().findById(workspaceId, task.canonicalRunId) : undefined;
    const db = this.options.store.getDatabase();
    const schema = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'p2_collaboration_recoveries'").get();
    if (schema) {
      const retryRecovery = db.prepare(`SELECT * FROM p2_collaboration_recoveries
        WHERE workspace_id = ? AND collaboration_task_id = ? AND action = 'retry-known-failure'
          AND state = 'recovery_required' ORDER BY updated_at DESC,created_at DESC LIMIT 1`)
        .get(workspaceId, task.id) as CollaborationRecoveryRow | undefined;
      if (retryRecovery) {
        const proof = this.inspectRetryRecoveryResume(task, retryRecovery);
        const priorRun = this.options.store.runRepository().findById(workspaceId, retryRecovery.prior_run_id);
        const unavailableRetry = (reason: string): CollaborationRecoveryOptions => ({
          taskId: task.id, taskVersion: task.version,
          ...(run === undefined ? {} : { runId: run.id, runVersion: run.version }),
          ...(priorRun?.failureCode === undefined ? {} : { failureCode: priorRun.failureCode }),
          recoveryRequired: true, actions: { retryKnownFailure: false, newLinkedTask: false }, reason,
        });
        if ((!proof.safe && !proof.linkedTaskOnly) || !priorRun) {
          return unavailableRetry(proof.reason ?? '恢复记录无法与原失败 Run 对应；操作保持封锁');
        }
        let checkedBaseCommit: string;
        try {
          const workspace = this.requireWorkspace(workspaceId);
          const workspaceRoot = this.gitRoot(workspace.id);
          checkedBaseCommit = await this.options.worktrees.preflight(workspaceRoot, { controlledGitContent: true });
        } catch {
          return unavailableRetry(proof.linkedTaskOnly
            ? '子 Run 已有 Start 授权；请先恢复干净、可检查的源基线，再创建关联任务'
            : '原重试已被接受但尚未授权启动；请先恢复干净、可检查的源基线');
        }
        if (proof.linkedTaskOnly) {
          if (!proof.childRunId || run?.id !== proof.childRunId || task.canonicalRunId !== proof.childRunId
            || task.status !== 'queued') {
            return unavailableRetry('Start 授权对应的 queued 子 Run 已变化；恢复操作保持封锁');
          }
          return {
            taskId: task.id, taskVersion: task.version, runId: run.id, runVersion: run.version,
            ...(priorRun.failureCode === undefined ? {} : { failureCode: priorRun.failureCode }),
            recoveryRequired: true, checkedBaseCommit,
            actions: { retryKnownFailure: false, newLinkedTask: true },
            reason: 'queued 子 Run 已有持久化 Start 授权；不会重放该 Run。可在已检查的干净基线上创建需重新确认的关联任务',
          };
        }
        if (checkedBaseCommit !== task.baseCommit
          || (retryRecovery.checked_base_commit !== null && checkedBaseCommit !== retryRecovery.checked_base_commit)) {
          return unavailableRetry('原重试绑定的干净基线已变化；不会在新基线上启动。恢复该基线后可用同一请求安全续办');
        }
        return {
          taskId: task.id, taskVersion: retryRecovery.expected_task_version,
          runId: retryRecovery.prior_run_id, runVersion: retryRecovery.expected_run_version,
          ...(priorRun.failureCode === undefined ? {} : { failureCode: priorRun.failureCode }),
          recoveryRequired: false, checkedBaseCommit,
          resumeRequest: {
            idempotencyKey: retryRecovery.idempotency_key,
            expectedTaskVersion: retryRecovery.expected_task_version,
            expectedRunId: retryRecovery.prior_run_id,
            expectedRunVersion: retryRecovery.expected_run_version,
          },
          actions: { retryKnownFailure: true, newLinkedTask: false },
          reason: '此重试 Run 已持久化但尚无 Start/Provider 证据；将复用同一 Run 与 attempt，不会创建第二个子 Run',
        };
      }
    }
    const unresolvedSideEffect = Boolean(run && (run.recoveryRequired === true || run.failureCode === 'RUN_PROCESS_MISSING'
      || run.failureCode === 'RUN_PROCESS_UNKNOWN' || run.failureCode?.includes('RECOVERY')));
    const interruptedRecoveryRun = Boolean(run && ['starting', 'running'].includes(run.status) && unresolvedSideEffect);
    const unavailable = (reason: string): CollaborationRecoveryOptions => ({
      taskId: task.id, taskVersion: task.version,
      ...(run === undefined || run === null ? {} : {
        runId: run.id, runVersion: run.version,
        ...(run.failureCode === undefined ? {} : { failureCode: run.failureCode }),
        recoveryRequired: run.recoveryRequired,
      }),
      actions: { retryKnownFailure: false, newLinkedTask: false }, reason,
    });
    if (!run || !['failed', 'blocked'].includes(task.status)
      || (run.status !== 'failed' && !interruptedRecoveryRun)) {
      return unavailable('当前任务与 Run 尚不处于可恢复的终态');
    }
    if (this.controls.pending(workspaceId, task.id)) return unavailable('协作控制操作仍在处理中');
    if (!schema) return unavailable('恢复记录迁移尚未安装');
    const priorRecovery = db.prepare(`SELECT state,action,new_collaboration_task_id,new_run_id,result_json
      FROM p2_collaboration_recoveries
      WHERE workspace_id = ? AND collaboration_task_id = ? AND prior_run_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(workspaceId, task.id, run.id) as {
        state: string; action: string; new_collaboration_task_id: string | null;
        new_run_id: string | null; result_json: string | null;
      } | undefined;
    const resumableLinkedTask = priorRecovery?.action === 'new-linked-task'
      && ['reserved', 'recovery_required'].includes(priorRecovery.state)
      && priorRecovery.new_collaboration_task_id === null
      && priorRecovery.new_run_id === null
      && priorRecovery.result_json === null;
    if (priorRecovery && !resumableLinkedTask) {
      return unavailable(priorRecovery.state === 'completed'
        ? '该 Run 已有完成的恢复动作'
        : priorRecovery.state === 'recovery_required' || priorRecovery.state === 'dispatching'
          ? '先前恢复动作的结果未能证明；不会重放旧 Provider 调用'
          : '该 Run 已有恢复动作正在处理');
    }

    let checkedBaseCommit: string;
    try {
      const workspace = this.requireWorkspace(workspaceId);
      const workspaceRoot = this.gitRoot(workspace.id);
      checkedBaseCommit = await this.options.worktrees.preflight(workspaceRoot, { controlledGitContent: true });
    } catch {
      return unavailable('当前源工作区不是干净且可检查的基线');
    }

    let retryKnownFailure = false;
    if (!unresolvedSideEffect && checkedBaseCommit === task.baseCommit) {
      try { this.assertKnownFailureRetryEligible(task, run); retryKnownFailure = true; } catch { /* The mutation route remains authoritative. */ }
    }
    return {
      taskId: task.id, taskVersion: task.version, runId: run.id, runVersion: run.version,
      ...(run.failureCode === undefined ? {} : { failureCode: run.failureCode }),
      recoveryRequired: run.recoveryRequired, checkedBaseCommit,
      actions: { retryKnownFailure, newLinkedTask: unresolvedSideEffect },
      ...(!retryKnownFailure && !unresolvedSideEffect && checkedBaseCommit !== task.baseCommit
        ? { reason: '任务原基线已变化；已知失败不能在新基线上重试' } : {}),
    };
  }

  private inspectRetryRecoveryResume(
    task: CollaborationTask,
    recovery: CollaborationRecoveryRow,
  ): { readonly safe: boolean; readonly linkedTaskOnly?: boolean; readonly childRunId?: string; readonly startOperationId?: string; readonly reason?: string } {
    const reject = (reason: string) => ({ safe: false as const, reason });
    if (recovery.workspace_id !== task.workspaceId || recovery.collaboration_task_id !== task.id
      || recovery.action !== 'retry-known-failure' || recovery.state !== 'recovery_required') {
      return reject('恢复记录与当前工作区/任务不匹配；操作保持封锁');
    }
    const parentRun = this.options.store.runRepository().findById(task.workspaceId, recovery.prior_run_id);
    if (!parentRun || parentRun.version !== recovery.expected_run_version || parentRun.status !== 'failed'
      || parentRun.recoveryRequired || !parentRun.failureCode
      || !new Set(['PROVIDER_CONFIG_INVALID', 'PROVIDER_CAPABILITY_UNAVAILABLE', 'PROVIDER_VERSION_UNSUPPORTED',
        'RUN_CONFIGURATION_INVALID', 'WORKSPACE_ADMISSION_DENIED']).has(parentRun.failureCode)) {
      return reject('原失败 Run 不再满足无副作用重试条件；不会继续启动');
    }
    if (this.controls.pending(task.workspaceId, task.id)) return reject('协作控制操作仍在处理中；重试保持封锁');

    const db = this.options.store.getDatabase();
    const retryKey = `p2-retry-${hash(recovery.idempotency_key).slice(0, 48)}`;
    let childRunId: string | undefined;
    try {
      const record = this.options.store.idempotencyRepository().findVerifiedByScope(
        task.workspaceId, 'run.retry', hashNormalizedIdempotencyKey(retryKey),
      );
      if (record) {
        const expectedHash = hashIdempotencyRequest({
          operation: 'run.retry', workspaceId: task.workspaceId,
          pathParams: { runId: parentRun.id }, domainInput: {}, expectedVersion: parentRun.version,
        });
        if (record.requestHash !== expectedHash || record.envelope.operation !== 'run.retry') {
          return reject('子 Run 的幂等收据与原恢复请求不匹配；操作保持封锁');
        }
        childRunId = record.envelope.body.run.id;
      }
    } catch {
      return reject('子 Run 幂等收据无法验证；操作保持封锁');
    }

    const children = db.prepare(`SELECT id,status,recovery_required FROM runs
      WHERE workspace_id = ? AND task_id = ? AND parent_run_id = ? ORDER BY created_at,id`)
      .all(task.workspaceId, parentRun.taskId, parentRun.id) as Array<{ id: string; status: string; recovery_required: number | null }>;
    if (children.length > 1 || (childRunId !== undefined && (children.length !== 1 || children[0]!.id !== childRunId))
      || (recovery.new_run_id !== null && (childRunId !== recovery.new_run_id || children[0]?.id !== recovery.new_run_id))) {
      return reject('原重试对应的子 Run 数量或身份不唯一；操作保持封锁');
    }
    if (children.length === 0) {
      if (childRunId !== undefined || recovery.new_run_id !== null) return reject('恢复记录指向的子 Run 缺失；操作保持封锁');
      const retryOperations = db.prepare(`SELECT COUNT(*) AS count FROM operations
        WHERE workspace_id = ? AND run_id = ? AND type = 'run.retry'`).get(task.workspaceId, parentRun.id) as { count: number | bigint };
      if (Number(retryOperations.count) !== 0) return reject('已有未能绑定的 Run retry 操作；操作保持封锁');
    } else {
      const child = children[0]!;
      if (child.status !== 'queued' || child.recovery_required === 1) return reject('子 Run 已离开 queued 状态或带有恢复标记；不会重放');
      const retryOperations = db.prepare(`SELECT COUNT(*) AS count FROM operations
        WHERE workspace_id = ? AND run_id = ? AND type = 'run.retry' AND status = 'completed'`)
        .get(task.workspaceId, parentRun.id) as { count: number | bigint };
      if (Number(retryOperations.count) !== 1) return reject('子 Run 缺少唯一、已完成的原 retry 授权记录');
      childRunId = child.id;
      const admissionEvidence = this.retryChildAdmissionEvidence(task.workspaceId, child.id);
      if (admissionEvidence) return reject(`已存在${admissionEvidence}证据；恢复保持封锁`);
      const sideEffect = this.retryChildRuntimeSideEffectEvidence(task.workspaceId, task.id, child.id);
      if (sideEffect) return reject(`已存在${sideEffect}证据；恢复保持封锁，不会重放副作用`);
    }

    const expectedTaskVersion = recovery.expected_task_version;
    const stillOnParent = task.canonicalRunId === parentRun.id && task.version === expectedTaskVersion
      && ['failed', 'blocked'].includes(task.status);
    const linkedButNotStarted = childRunId !== undefined && task.canonicalRunId === childRunId
      && task.version === expectedTaskVersion + 1 && task.status === 'queued';
    if (!stillOnParent && !linkedButNotStarted) return reject('任务版本或 canonical Run 已变化；请刷新恢复状态');
    if (task.baseCommit.length === 0) return reject('原任务缺少基线绑定；操作保持封锁');
    const processCount = db.prepare('SELECT COUNT(*) AS count FROM runtime_processes WHERE workspace_id = ? AND run_id = ?')
      .get(task.workspaceId, parentRun.id) as { count: number | bigint };
    const outputCount = db.prepare(`SELECT COUNT(*) AS count FROM collaboration_stage_outputs
      WHERE workspace_id = ? AND collaboration_task_id = ? AND canonical_run_id = ?`)
      .get(task.workspaceId, task.id, parentRun.id) as { count: number | bigint };
    if (Number(processCount.count) !== 0 || Number(outputCount.count) !== 0) {
      return reject('原 Run 出现 Provider 进程或阶段输出；不会继续重试');
    }
    if (childRunId !== undefined) {
      const startOperations = this.options.store.operationService().listByRun(task.workspaceId, childRunId)
        .filter(operation => operation.type === 'run.start');
      if (startOperations.length > 0) {
        const start = startOperations.length === 1 ? startOperations[0] : undefined;
        if (!linkedButNotStarted || !start || start.status !== 'queued') {
          return reject('子 Run 已有 Start 授权或状态不唯一；不会重放副作用');
        }
        return {
          safe: false, linkedTaskOnly: true, childRunId, startOperationId: start.id,
          reason: 'queued 子 Run 已有 Start 授权；不会重放旧 Run，可检查干净基线后创建关联任务',
        };
      }
    }
    return { safe: true, ...(childRunId === undefined ? {} : { childRunId }) };
  }

  /** Admission is queue authority, not proof that a Provider was started. Startup reconciliation
   * is required to reconstruct it for an existing queued Run. Only a uniquely-bound active
   * canonical admission is compatible with pre-Start continuation. */
  private retryChildAdmissionEvidence(workspaceId: string, runId: string): string | undefined {
    const db = this.options.store.getDatabase();
    const rows = db.prepare(`SELECT subject_kind,state FROM workspace_admissions
      WHERE workspace_id = ? AND canonical_run_id = ? ORDER BY created_at,id`).all(workspaceId, runId) as Array<{ subject_kind: string; state: string }>;
    if (rows.length > 1) return '运行准入记录不唯一';
    if (rows.some(row => row.subject_kind !== 'CANONICAL_RUN'
      || !['REQUESTED', 'QUEUED', 'GRANTED'].includes(row.state))) return '运行准入状态不匹配';
    return undefined;
  }

  private retryChildRuntimeSideEffectEvidence(workspaceId: string, collaborationTaskId: string, runId: string): string | undefined {
    const db = this.options.store.getDatabase();
    const checks: Array<[string, string, unknown[]]> = [
      ['Provider session', 'SELECT COUNT(*) AS count FROM provider_sessions WHERE workspace_id = ? AND run_id = ?', [workspaceId, runId]],
      ['运行进程', 'SELECT COUNT(*) AS count FROM runtime_processes WHERE workspace_id = ? AND run_id = ?', [workspaceId, runId]],
      ['阶段输出', 'SELECT COUNT(*) AS count FROM collaboration_stage_outputs WHERE workspace_id = ? AND collaboration_task_id = ? AND canonical_run_id = ?', [workspaceId, collaborationTaskId, runId]],
      ['运行阶段事件', `SELECT COUNT(*) AS count FROM runtime_events WHERE workspace_id = ? AND run_id = ?
        AND type NOT IN ('run.created','stage.created')`, [workspaceId, runId]],
    ];
    for (const [label, sql, params] of checks) {
      const row = db.prepare(sql).get(...params) as { count: number | bigint };
      if (Number(row.count) !== 0) return label;
    }
    return undefined;
  }

  private retryChildSideEffectEvidence(workspaceId: string, collaborationTaskId: string, runId: string): string | undefined {
    const starts = this.options.store.operationService().listByRun(workspaceId, runId)
      .filter(operation => operation.type === 'run.start');
    if (starts.length > 0) return 'Start 授权';
    return this.retryChildAdmissionEvidence(workspaceId, runId)
      ?? this.retryChildRuntimeSideEffectEvidence(workspaceId, collaborationTaskId, runId);
  }

  async recover(input: CollaborationRecoveryInput): Promise<{
    readonly action: CollaborationRecoveryInput['action'];
    readonly task: CollaborationTask;
    readonly priorRunId: string;
    readonly newRunId?: string;
    readonly checkedBaseCommit: string;
    readonly replayed: boolean;
    readonly pending?: boolean;
  }> {
    if (!Number.isSafeInteger(input.expectedTaskVersion) || input.expectedTaskVersion < 1
      || !Number.isSafeInteger(input.expectedRunVersion) || input.expectedRunVersion < 1
      || !nonBlank(input.expectedRunId) || !nonBlank(input.idempotencyKey) || input.idempotencyKey.length > 200) {
      throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_INVALID', 'Recovery versions, Run and idempotency key are required');
    }
    const db = this.options.store.getDatabase();
    const requestHash = hash(JSON.stringify({
      workspaceId: input.workspaceId, collaborationId: input.collaborationId,
      action: input.action, expectedTaskVersion: input.expectedTaskVersion,
      expectedRunId: input.expectedRunId, expectedRunVersion: input.expectedRunVersion,
    }));
    if (input.action === 'new-linked-task') return this.recoverWithLinkedTask(input, requestHash);

    const claim = this.options.store.runInTransaction(() => {
      const existing = db.prepare('SELECT * FROM p2_collaboration_recoveries WHERE workspace_id = ? AND idempotency_key = ?')
        .get(input.workspaceId, input.idempotencyKey) as CollaborationRecoveryRow | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash || existing.action !== input.action) {
          throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_IDEMPOTENCY_CONFLICT', 'Idempotency key was used for different recovery intent');
        }
        if (existing.state === 'completed' && existing.result_json) {
          return { kind: 'replay' as const, result: JSON.parse(existing.result_json) as {
            action: CollaborationRecoveryInput['action']; task: CollaborationTask; priorRunId: string;
            newRunId?: string; checkedBaseCommit: string;
          } };
        }
        if (existing.state === 'reserved' || existing.state === 'dispatching') return { kind: 'pending' as const };
        if (existing.state === 'recovery_required' && existing.action === 'retry-known-failure') {
          const task = this.requireTask(input.workspaceId, input.collaborationId);
          const proof = this.inspectRetryRecoveryResume(task, existing);
          const run = this.options.store.runRepository().findById(input.workspaceId, existing.prior_run_id);
          if (!proof.safe || !run || existing.collaboration_task_id !== input.collaborationId
            || existing.expected_task_version !== input.expectedTaskVersion
            || existing.prior_run_id !== input.expectedRunId || existing.expected_run_version !== input.expectedRunVersion) {
            throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_REQUIRED', proof.reason
              ?? 'Interrupted retry cannot be resumed safely; inspect the recovery evidence before taking another action');
          }
          const resumed = db.prepare(`UPDATE p2_collaboration_recoveries SET state = 'reserved',error_code = NULL,updated_at = ?
            WHERE id = ? AND state = 'recovery_required' AND request_hash = ?`)
            .run(new Date().toISOString(), existing.id, requestHash) as { changes?: number | bigint };
          if (Number(resumed.changes ?? 0) !== 1) {
            throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_STALE', 'Interrupted retry claim changed before it could resume');
          }
          return { kind: 'reserved' as const, recoveryId: existing.id, task, run,
            expectedBaseCommit: existing.checked_base_commit ?? undefined };
        }
        throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_REQUIRED', 'Prior recovery did not reach a proven terminal state; create a clean linked task after checking the baseline');
      }
      const task = this.requireTask(input.workspaceId, input.collaborationId);
      const run = task.canonicalRunId && this.options.store.runRepository().findById(input.workspaceId, task.canonicalRunId);
      if (task.version !== input.expectedTaskVersion || task.canonicalRunId !== input.expectedRunId
        || !run || run.version !== input.expectedRunVersion || !['failed', 'blocked'].includes(task.status)
        || this.controls.pending(input.workspaceId, task.id)) {
        throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_STALE', 'Current task, Run or action changed; refresh before recovering');
      }
      if (run.status !== 'failed') {
        const unresolvedSideEffect = run.recoveryRequired === true || ['starting', 'running'].includes(run.status)
          || run.failureCode === 'RUN_PROCESS_MISSING' || run.failureCode === 'RUN_PROCESS_UNKNOWN'
          || run.failureCode?.includes('RECOVERY') === true;
        if (unresolvedSideEffect) {
          throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_UNRESOLVED', 'Run has not reached a proven safe failure; retry is forbidden');
        }
        throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_STALE', 'Current Run is not a retryable failed Run; refresh before recovering');
      }
      this.assertKnownFailureRetryEligible(task, run);
      const recoveryId = createEntityId('operation');
      const now = new Date().toISOString();
      try {
        db.prepare(`INSERT INTO p2_collaboration_recoveries (
          id,workspace_id,collaboration_task_id,prior_run_id,action,expected_task_version,expected_run_version,
          idempotency_key,request_hash,state,planned_collaboration_task_id,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,'reserved',?,?,?)`).run(
          recoveryId, input.workspaceId, task.id, run.id, input.action, input.expectedTaskVersion,
          input.expectedRunVersion, input.idempotencyKey, requestHash, null, now, now,
        );
      } catch (error) {
        if (String(error).includes('UNIQUE constraint failed')) {
          throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_STALE', 'A recovery action already owns this prior Run');
        }
        throw error;
      }
      return { kind: 'reserved' as const, recoveryId, task, run, expectedBaseCommit: undefined };
    });
    if (claim.kind === 'replay') return { ...claim.result, replayed: true };
    if (claim.kind === 'pending') {
      const task = this.requireTask(input.workspaceId, input.collaborationId);
      return { action: input.action, task, priorRunId: input.expectedRunId, checkedBaseCommit: task.baseCommit, replayed: true, pending: true };
    }

    try {
      const task = claim.task;
      const workspace = this.requireWorkspace(input.workspaceId);
      const workspaceRoot = this.gitRoot(workspace.id);
      const checkedBaseCommit = await this.options.worktrees.preflight(workspaceRoot, { controlledGitContent: true });
      if (checkedBaseCommit !== task.baseCommit || (claim.expectedBaseCommit !== undefined
        && checkedBaseCommit !== claim.expectedBaseCommit)) {
        throw new CollaborationWorkflowError('COLLABORATION_BASE_CHANGED', 'The checked source baseline changed; no retry Run was started');
      }
      const boundBaseline = this.options.store.runInTransaction(() => db.prepare(`UPDATE p2_collaboration_recoveries
        SET checked_base_commit = COALESCE(checked_base_commit,?),updated_at = ?
        WHERE id = ? AND state = 'reserved' AND (checked_base_commit IS NULL OR checked_base_commit = ?)`)
        .run(checkedBaseCommit, new Date().toISOString(), claim.recoveryId, checkedBaseCommit) as { changes?: number | bigint });
      if (Number(boundBaseline.changes ?? 0) !== 1) {
        throw new CollaborationWorkflowError('COLLABORATION_BASE_CHANGED', 'Recovery is bound to a different checked source baseline');
      }
      const retryKey = `p2-retry-${hash(input.idempotencyKey).slice(0, 48)}`;
      const retry = this.taskRuns.retryRunOperationForV2(input.workspaceId, claim.run.id, retryKey, claim.run.version, () => {
        const currentTask = this.requireTask(input.workspaceId, task.id);
        const currentRun = this.options.store.runRepository().findById(input.workspaceId, claim.run.id);
        const recovery = db.prepare('SELECT state FROM p2_collaboration_recoveries WHERE id = ?')
          .get(claim.recoveryId) as { state: string } | undefined;
        if (currentTask.version !== input.expectedTaskVersion || currentTask.canonicalRunId !== claim.run.id
          || currentRun?.version !== input.expectedRunVersion || currentTask.controlEpoch !== task.controlEpoch
          || this.controls.pending(input.workspaceId, task.id) || recovery?.state !== 'reserved') {
          throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_STALE', 'Task, Run or recovery claim changed before canonical retry acceptance');
        }
        this.assertKnownFailureRetryEligible(currentTask, currentRun);
        const changed = db.prepare(`UPDATE p2_collaboration_recoveries SET state = 'dispatching',checked_base_commit = ?,updated_at = ?
          WHERE id = ? AND state = 'reserved' AND checked_base_commit = ?`)
          .run(checkedBaseCommit, new Date().toISOString(), claim.recoveryId, checkedBaseCommit) as { changes?: number | bigint };
        if (Number(changed.changes ?? 0) !== 1) {
          throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_STALE', 'Recovery claim was no longer reserved');
        }
      });
      const newRunId = retry.body.run.id;
      const bindRetry = this.options.store.runInTransaction(() => db.prepare(`UPDATE p2_collaboration_recoveries
        SET state = 'dispatching',new_run_id = ?,checked_base_commit = ?,updated_at = ?
        WHERE id = ? AND state IN ('reserved','dispatching') AND (new_run_id IS NULL OR new_run_id = ?)
          AND checked_base_commit = ?`)
        .run(newRunId, checkedBaseCommit, new Date().toISOString(), claim.recoveryId, newRunId, checkedBaseCommit) as { changes?: number | bigint });
      if (Number(bindRetry.changes ?? 0) !== 1) {
        throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_REQUIRED', 'The accepted retry Run could not be bound uniquely to its recovery record');
      }
      const implementer = workspace.agents.find(agent => agent.id === task.implementerAgentId);
      if (!implementer) throw new CollaborationWorkflowError('COLLABORATION_AGENT_UNAVAILABLE', 'Implementer is unavailable');
      let lease = this.options.worktrees.listLeases().find(item => item.workspaceId === workspace.id
        && item.runId === newRunId && item.executionId === `collaboration-${task.id}` && item.status === 'active');
      if (!lease) {
        try {
          lease = await this.options.worktrees.createLease({
            workspaceId: workspace.id, workspaceRoot, runId: newRunId,
            executionId: `collaboration-${task.id}`, agentId: implementer.id, controlledGitContent: true,
            expectedBaseCommit: checkedBaseCommit,
          });
        } catch (error) {
          if (error instanceof WorktreeError && error.code === 'workspace_changed') {
            throw new CollaborationWorkflowError('COLLABORATION_BASE_CHANGED', 'The clean source baseline changed while the recovery worktree was being created; no Provider call was started');
          }
          throw error;
        }
      }
      const leaseRecord = this.options.worktrees.getRecord(lease.id);
      if (!leaseRecord || leaseRecord.status !== 'active') throw new CollaborationWorkflowError('COLLABORATION_WORKTREE_MISSING', 'Fresh checked worktree is unavailable');
      if (leaseRecord.baseCommit !== checkedBaseCommit) {
        throw new CollaborationWorkflowError('COLLABORATION_BASE_CHANGED', 'The source baseline changed while the recovery worktree was being created; no Provider call was started');
      }
      this.options.registerWorktreePath(newRunId, leaseRecord.absolutePath);

      let currentTask = this.requireTask(input.workspaceId, task.id);
      if (currentTask.canonicalRunId !== newRunId) {
        this.options.store.runInTransaction(() => {
          currentTask = this.requireTask(input.workspaceId, task.id);
          if (currentTask.version !== input.expectedTaskVersion || currentTask.canonicalRunId !== claim.run.id
            || currentTask.controlEpoch !== task.controlEpoch || this.controls.pending(input.workspaceId, task.id)) {
            throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_STALE', 'Task action fence changed before linking the retry Run');
          }
          currentTask = this.repository.progress({ workspaceId: task.workspaceId, id: task.id,
            expectedVersion: currentTask.version, status: 'queued', canonicalRunId: newRunId,
            reworkRound: task.reworkRound + 1, expectedRunId: claim.run.id,
            expectedControlEpoch: task.controlEpoch ?? 0 });
        });
      } else if (currentTask.version !== input.expectedTaskVersion + 1 || currentTask.status !== 'queued') {
        throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_STALE', 'The retry task link changed; refresh recovery state before Start authorization');
      }
      const currentRun = this.options.store.runRepository().findById(workspace.id, newRunId);
      if (!currentRun || currentRun.status !== 'queued' || currentRun.recoveryRequired) {
        throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_REQUIRED', 'New Run is not safely startable');
      }
      const [sourceBaseCommit, leaseBaseCommit] = await Promise.all([
        this.options.worktrees.preflight(workspaceRoot, { controlledGitContent: true }),
        this.options.worktrees.preflight(leaseRecord.absolutePath, { controlledGitContent: true }),
      ]);
      if (sourceBaseCommit !== checkedBaseCommit || leaseBaseCommit !== checkedBaseCommit) {
        throw new CollaborationWorkflowError('COLLABORATION_BASE_CHANGED', 'The clean source or retry worktree changed before Start authorization');
      }
      const startKey = `p2-start-${hash(input.idempotencyKey).slice(0, 48)}`;
      const start = this.taskRuns.startRunOperationForV2(workspace.id, newRunId, startKey, currentRun.version, 'MODIFYING', () => {
        const latestTask = this.requireTask(input.workspaceId, task.id);
        const latestRun = this.options.store.runRepository().findById(workspace.id, newRunId);
        const recovery = db.prepare(`SELECT state,new_run_id,checked_base_commit FROM p2_collaboration_recoveries WHERE id = ?`)
          .get(claim.recoveryId) as { state: string; new_run_id: string | null; checked_base_commit: string | null } | undefined;
        if (latestTask.version !== currentTask.version || latestTask.canonicalRunId !== newRunId
          || latestTask.controlEpoch !== task.controlEpoch || this.controls.pending(input.workspaceId, task.id)
          || latestRun?.version !== currentRun.version || latestRun.status !== 'queued' || latestRun.recoveryRequired
          || recovery?.state !== 'dispatching' || recovery.new_run_id !== newRunId
          || recovery.checked_base_commit !== checkedBaseCommit) {
          throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_STALE', 'Task action or canonical Run changed before Start acceptance');
        }
        const sideEffect = this.retryChildSideEffectEvidence(input.workspaceId, task.id, newRunId);
        if (sideEffect) {
          throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_REQUIRED', `Retry Start is fenced by existing ${sideEffect} evidence`);
        }
      });
      if (start.replayed) throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_REQUIRED', 'Start authorization already exists; the Provider call will not be replayed');
      const admitted = await this.options.requestRunAdmission({ workspaceId: workspace.id, runId: newRunId });
      currentTask = this.requireTask(input.workspaceId, task.id);
      if (admitted && this.options.runtimeDispatchEnabled !== false && currentTask.status === 'queued') {
        this.options.store.runInTransaction(() => {
          const latestTask = this.requireTask(input.workspaceId, task.id);
          if (latestTask.version !== currentTask.version || latestTask.canonicalRunId !== newRunId
            || latestTask.controlEpoch !== task.controlEpoch || this.controls.pending(input.workspaceId, task.id)) {
            throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_STALE', 'Task action changed before Provider dispatch');
          }
          this.repository.progress({ workspaceId: task.workspaceId, id: task.id,
            expectedVersion: latestTask.version, status: 'running', canonicalRunId: newRunId,
            expectedRunId: newRunId, expectedControlEpoch: task.controlEpoch ?? 0 });
        });
      }
      currentTask = this.requireTask(input.workspaceId, task.id);
      const result = { action: input.action, task: currentTask, priorRunId: claim.run.id, newRunId, checkedBaseCommit };
      this.options.store.runInTransaction(() => {
        db.prepare(`UPDATE p2_collaboration_recoveries SET new_run_id = ?,checked_base_commit = ?,
          state = 'completed',result_json = ?,updated_at = ? WHERE id = ? AND state = 'dispatching'`)
          .run(newRunId, checkedBaseCommit, JSON.stringify(result), new Date().toISOString(), claim.recoveryId);
      });
      if (admitted && this.options.runtimeDispatchEnabled !== false) void this.driveAndFinalize(task.id, workspace.id, newRunId);
      return { ...result, replayed: false };
    } catch (error) {
      this.options.store.runInTransaction(() => db.prepare(`UPDATE p2_collaboration_recoveries SET state = 'recovery_required',
        error_code = ?,updated_at = ? WHERE id = ? AND state IN ('reserved','dispatching')`).run(
          error instanceof CollaborationWorkflowError ? error.code : 'COLLABORATION_RECOVERY_REQUIRED',
          new Date().toISOString(), claim.recoveryId,
        ));
      throw error;
    }
  }

  private async recoverWithLinkedTask(input: CollaborationRecoveryInput, requestHash: string): Promise<{
    readonly action: 'new-linked-task';
    readonly task: CollaborationTask;
    readonly priorRunId: string;
    readonly checkedBaseCommit: string;
    readonly replayed: boolean;
  }> {
    const db = this.options.store.getDatabase();
    type RecoveryRow = {
      id: string; request_hash: string; action: string; state: string; result_json: string | null;
      planned_collaboration_task_id: string | null; new_collaboration_task_id: string | null; new_run_id: string | null;
    };
    const findKeyedRecovery = (): RecoveryRow | undefined => db.prepare(`SELECT id,request_hash,action,state,result_json,
      planned_collaboration_task_id,new_collaboration_task_id,new_run_id
      FROM p2_collaboration_recoveries WHERE workspace_id = ? AND idempotency_key = ?`)
      .get(input.workspaceId, input.idempotencyKey) as RecoveryRow | undefined;
    const resolveExisting = (existing: RecoveryRow) => {
      if (existing.request_hash !== requestHash || existing.action !== input.action) {
        throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_IDEMPOTENCY_CONFLICT', 'Idempotency key was used for different recovery intent');
      }
      if (existing.state === 'completed' && existing.result_json) {
        return { ...(JSON.parse(existing.result_json) as {
          action: 'new-linked-task'; task: CollaborationTask; priorRunId: string; checkedBaseCommit: string;
        }), replayed: true };
      }
      if (!['reserved', 'recovery_required'].includes(existing.state)
        || existing.new_collaboration_task_id !== null || existing.new_run_id !== null || existing.result_json !== null) {
        throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_REQUIRED', 'Prior linked recovery is not in a safely resumable state');
      }
      return undefined;
    };

    const releaseCancelledRetryAdmission = async (priorRunId: string): Promise<void> => {
      const cancelledRetry = db.prepare(`SELECT 1 AS present FROM p2_collaboration_recoveries retry
        JOIN runs child ON child.workspace_id = retry.workspace_id AND child.parent_run_id = retry.prior_run_id
        WHERE retry.workspace_id = ? AND retry.collaboration_task_id = ? AND retry.action = 'retry-known-failure'
          AND retry.state = 'recovery_required' AND child.id = ? AND child.status = 'cancelled' LIMIT 1`)
        .get(input.workspaceId, input.collaborationId, priorRunId);
      if (cancelledRetry) await this.releaseRunAdmission({ workspaceId: input.workspaceId, runId: priorRunId });
    };

    const keyedBeforePreflight = findKeyedRecovery();
    if (keyedBeforePreflight) {
      const resolved = resolveExisting(keyedBeforePreflight);
      if (resolved) {
        await releaseCancelledRetryAdmission(resolved.priorRunId);
        return resolved;
      }
    }

    const task = this.requireTask(input.workspaceId, input.collaborationId);
    const run = task.canonicalRunId && this.options.store.runRepository().findById(input.workspaceId, task.canonicalRunId);
    const unresolvedSideEffect = Boolean(run && (run.recoveryRequired === true || run.failureCode === 'RUN_PROCESS_MISSING'
      || run.failureCode === 'RUN_PROCESS_UNKNOWN' || run.failureCode?.includes('RECOVERY')));
    const interruptedRecoveryRun = Boolean(run && ['starting', 'running'].includes(run.status) && unresolvedSideEffect);
    const interruptedRetryRecovery = db.prepare(`SELECT * FROM p2_collaboration_recoveries
      WHERE workspace_id = ? AND collaboration_task_id = ? AND action = 'retry-known-failure'
        AND state = 'recovery_required' ORDER BY updated_at DESC,created_at DESC LIMIT 1`)
      .get(input.workspaceId, task.id) as CollaborationRecoveryRow | undefined;
    const interruptedRetryProof = interruptedRetryRecovery
      ? this.inspectRetryRecoveryResume(task, interruptedRetryRecovery) : undefined;
    const queuedRetryStartOnly = Boolean(run && task.status === 'queued' && run.status === 'queued'
      && interruptedRetryProof?.linkedTaskOnly && interruptedRetryProof.childRunId === run.id);
    if (task.version !== input.expectedTaskVersion || task.canonicalRunId !== input.expectedRunId
      || !run || run.version !== input.expectedRunVersion
      || (!queuedRetryStartOnly && (!['failed', 'blocked'].includes(task.status)
        || (run.status !== 'failed' && !interruptedRecoveryRun)))
      || this.controls.pending(input.workspaceId, task.id)) {
      throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_STALE', 'Current task, Run or action changed; refresh before recovering');
    }
    if (!unresolvedSideEffect && !queuedRetryStartOnly) {
      throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_NOT_REQUIRED', 'A new linked task is reserved for unresolved Provider side effects');
    }

    const workspace = this.requireWorkspace(input.workspaceId);
    const workspaceRoot = this.gitRoot(workspace.id);
    let checkedBaseCommit: string;
    try {
      checkedBaseCommit = await this.options.worktrees.preflight(workspaceRoot, { controlledGitContent: true });
    } catch {
      // A dirty/uninspectable baseline must not consume the unique recovery
      // action. The caller may repair the workspace and retry the same intent.
      throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_UNRESOLVED', 'A clean, checkable source baseline is required for linked recovery');
    }

    const result = this.options.store.runInTransaction(() => {
      const existing = findKeyedRecovery();
      if (existing) {
        const resolved = resolveExisting(existing);
        if (resolved) return resolved;
      }

      const currentTask = this.requireTask(input.workspaceId, task.id);
      const currentRun = this.options.store.runRepository().findById(input.workspaceId, run.id);
      if (currentTask.version !== input.expectedTaskVersion || currentTask.canonicalRunId !== run.id
        || currentRun?.version !== input.expectedRunVersion || currentTask.controlEpoch !== task.controlEpoch
        || this.controls.pending(input.workspaceId, task.id)) {
        throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_STALE', 'Task or prior Run changed during baseline verification');
      }

      if (queuedRetryStartOnly) {
        const currentRetry = interruptedRetryRecovery
          ? db.prepare('SELECT * FROM p2_collaboration_recoveries WHERE id = ?').get(interruptedRetryRecovery.id) as CollaborationRecoveryRow | undefined
          : undefined;
        const proof = currentRetry ? this.inspectRetryRecoveryResume(currentTask, currentRetry) : undefined;
        if (!proof?.linkedTaskOnly || proof.childRunId !== run.id || !proof.startOperationId
          || currentTask.status !== 'queued' || currentRun?.status !== 'queued') {
          throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_REQUIRED', proof?.reason
            ?? 'Queued retry Start evidence changed; no Provider call will be replayed');
        }
        const startOperation = this.options.store.operationService().listByRun(input.workspaceId, run.id)
          .find(operation => operation.id === proof.startOperationId && operation.type === 'run.start');
        if (!startOperation || startOperation.status !== 'queued') {
          throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_REQUIRED', 'Queued retry Start authorization changed; no Provider call will be replayed');
        }
        this.options.store.operationService().cancelWithinTransaction({
          workspaceId: input.workspaceId, operationId: startOperation.id, expectedVersion: startOperation.version,
        });
        const cancelledRun = this.options.store.runRepository().findById(input.workspaceId, run.id);
        if (cancelledRun?.status !== 'cancelled') {
          throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_REQUIRED', 'Queued retry Run could not be cancelled safely');
        }
        this.repository.progress({
          workspaceId: input.workspaceId, id: task.id, expectedVersion: currentTask.version,
          status: 'blocked', expectedRunId: run.id,
          failureReason: 'A queued Start authorization was persisted before interruption. The old Provider call was not replayed; continue through a newly confirmed linked task.',
        });
      }

      let recoveryId: string;
      let plannedTaskId: string;
      if (existing) {
        recoveryId = existing.id;
        plannedTaskId = existing.planned_collaboration_task_id ?? createEntityId('task').replace(/^task_/, 'collab_');
        const resumed = db.prepare(`UPDATE p2_collaboration_recoveries SET state = 'reserved',planned_collaboration_task_id = ?,
          checked_base_commit = ?,error_code = NULL,updated_at = ? WHERE id = ? AND state IN ('reserved','recovery_required')`)
          .run(plannedTaskId, checkedBaseCommit, new Date().toISOString(), recoveryId) as { changes?: number | bigint };
        if (Number(resumed.changes ?? 0) !== 1) {
          throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_STALE', 'Linked recovery claim changed before it could resume');
        }
      } else {
        const otherAction = db.prepare(`SELECT id FROM p2_collaboration_recoveries WHERE workspace_id = ?
          AND collaboration_task_id = ? AND prior_run_id = ? AND action = ?`)
          .get(input.workspaceId, task.id, run.id, input.action);
        if (otherAction) throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_STALE', 'A recovery action already owns this prior Run');
        recoveryId = createEntityId('operation');
        plannedTaskId = createEntityId('task').replace(/^task_/, 'collab_');
        const now = new Date().toISOString();
        db.prepare(`INSERT INTO p2_collaboration_recoveries (
          id,workspace_id,collaboration_task_id,prior_run_id,action,expected_task_version,expected_run_version,
          idempotency_key,request_hash,state,planned_collaboration_task_id,checked_base_commit,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,'reserved',?,?,?,?)`).run(
          recoveryId, input.workspaceId, task.id, run.id, input.action, input.expectedTaskVersion,
          input.expectedRunVersion, input.idempotencyKey, requestHash, plannedTaskId, checkedBaseCommit, now, now,
        );
      }

      const linkedTask = this.repository.findById(input.workspaceId, plannedTaskId)
        ?? this.createLinkedRecoveryTask(task, plannedTaskId, checkedBaseCommit, run);
      const result = { action: 'new-linked-task' as const, task: linkedTask, priorRunId: run.id, checkedBaseCommit };
      const completed = db.prepare(`UPDATE p2_collaboration_recoveries SET new_collaboration_task_id = ?,
        checked_base_commit = ?,state = 'completed',result_json = ?,updated_at = ? WHERE id = ? AND state = 'reserved'`)
        .run(linkedTask.id, checkedBaseCommit, JSON.stringify(result), new Date().toISOString(), recoveryId) as { changes?: number | bigint };
      if (Number(completed.changes ?? 0) !== 1) {
        throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_STALE', 'Linked recovery claim was not completed');
      }
      return { ...result, replayed: false };
    });
    if (result.replayed) await releaseCancelledRetryAdmission(result.priorRunId);
    else if (queuedRetryStartOnly) await this.releaseRunAdmission({ workspaceId: input.workspaceId, runId: run!.id });
    return result;
  }

  async cancel(input: CollaborationMutationInput): Promise<CollaborationTask> {
    return this.executeControl('cancel', input, async control => {
      const task = this.controls.assertOwned(control);
      let cancelled: CollaborationTask | undefined;
      if (task.canonicalRunId !== undefined) {
        const run = this.options.store.runRepository().findById(input.workspaceId, task.canonicalRunId);
        if (!run) throw new CollaborationWorkflowError('COLLABORATION_RUN_MISSING', 'Canonical Run not found');
        if (!['completed', 'failed', 'cancelled'].includes(run.status)) {
          // Start Operation completion is historical authorization, not Run completion.
          this.options.store.runInTransaction(() => this.controls.bind(control, { runId: run.id }));
          const evidence = await this.options.cancelRun({
            workspaceId: input.workspaceId, runId: run.id, correlationId: control.id,
          });
          cancelled = this.options.store.runInTransaction(() => {
            this.controls.assertOwned(control);
            const currentRun = this.options.store.runRepository().findById(input.workspaceId, run.id)!;
            if (currentRun.version !== evidence.expectedRunVersion) throw new CollaborationWorkflowError('COLLABORATION_CONFLICT', 'Run changed while cancellation was being proven');
            const operation = this.options.store.operationService().listByRun(input.workspaceId, run.id).find(candidate => candidate.type === 'run.start');
            if (operation && ['queued', 'running', 'waiting_approval', 'paused'].includes(operation.status)) {
              this.options.store.operationService().cancelWithinTransaction({
                workspaceId: input.workspaceId, operationId: operation.id, expectedVersion: operation.version,
                evidence: { ...evidence, terminatedProcessIds: evidence.terminatedProcessIds ?? [] },
              });
            } else {
              this.options.store.lifecycleTransactionService().cancelRunForOperationWithEvidenceWithinTransaction({
                workspaceId: input.workspaceId, runId: run.id, correlationId: control.id,
                expectedRunVersion: evidence.expectedRunVersion, terminatedProcessIds: evidence.terminatedProcessIds ?? [],
                worktreePreserved: evidence.worktreePreserved,
              });
            }
            const result = this.repository.cancel(input.workspaceId, input.collaborationId, input.expectedVersion, new Date().toISOString(), control.id);
            this.controls.finish(control, result);
            return result;
          });
        }
      }
      if (!cancelled) cancelled = this.options.store.runInTransaction(() => {
        const result = this.repository.cancel(input.workspaceId, input.collaborationId, input.expectedVersion, new Date().toISOString(), control.id);
        this.controls.finish(control, result); return result;
      });
      this.markTaskWorktreeFailed(cancelled);
      if (task.canonicalRunId !== undefined) await this.releaseRunAdmission({ workspaceId: input.workspaceId, runId: task.canonicalRunId });
      return cancelled;
    });
  }

  async apply(input: CollaborationMutationInput): Promise<CollaborationTask> {
    return this.executeControl('apply', input, control => this.applyInternal(input, control));
  }

  private async applyInternal(input: CollaborationMutationInput, control: CollaborationControl): Promise<CollaborationTask> {
    const task = this.controls.assertOwned(control);
    if (task.status !== 'awaiting_application' || task.currentCandidateId === undefined) {
      throw new CollaborationWorkflowError('COLLABORATION_APPLY_NOT_READY', 'Only an approved candidate can be applied');
    }
    const candidate = this.repository.findCandidate(input.workspaceId, task.currentCandidateId);
    if (!candidate) throw new CollaborationWorkflowError('COLLABORATION_CANDIDATE_NOT_FOUND', 'Candidate snapshot not found');
    if ((input.candidateId !== undefined || input.candidateBaseCommit !== undefined || input.candidateContentHash !== undefined)
      && (input.candidateId !== candidate.id || input.candidateBaseCommit !== candidate.baseCommit
        || input.candidateBaseCommit !== task.baseCommit || input.candidateContentHash !== candidate.contentHash)) {
      throw new CollaborationWorkflowError('COLLABORATION_CANDIDATE_CHANGED', 'The candidate differs from the frozen preview; refresh before applying');
    }
    this.assertApplicationEvidence(task, candidate);
    if (!this.options.requestApplicationAdmission || !this.options.releaseApplicationAdmission) {
      throw new CollaborationWorkflowError('COLLABORATION_ADMISSION_UNAVAILABLE', '应用写入准入尚不可用，未修改文件');
    }
    const admitted = await this.options.requestApplicationAdmission({ workspaceId: task.workspaceId, controlId: control.id });
    if (!admitted) throw new CollaborationWorkflowError('COLLABORATION_WRITER_CONFLICT', '工作区正在被其他执行占用，候选未应用');
    const workspace = this.requireWorkspace(input.workspaceId);
    const workspaceRoot = this.gitRoot(workspace.id);
    let journal: ApplyJournal | undefined;
    try {
      this.controls.assertOwned(control);
      await this.options.worktrees.preflight(workspaceRoot, { controlledGitContent: true });
      if (await git(workspaceRoot, ['rev-parse', 'HEAD']) !== candidate.baseCommit || candidate.baseCommit !== task.baseCommit) {
        throw new CollaborationWorkflowError('COLLABORATION_BASE_CHANGED', '目标基线已变化，候选未应用');
      }
      this.options.applyFault?.('before_prepare');
      journal = await this.journals.prepare(control, task, candidate, workspaceRoot);
      this.options.store.runInTransaction(() => this.controls.bind(control, { candidateId: candidate.id }));
      this.options.applyFault?.('before_write');
      if (!await this.journals.matches(journal, 'pre')) throw new CollaborationWorkflowError('COLLABORATION_WORKSPACE_DIRTY', '应用前文件已改变');
      this.controls.assertOwned(control);
      // These postimages are derived from the exact reviewed patch using a
      // private index. Do not reopen the live repository's filter configuration.
      await this.journals.writePrepared(journal);
      this.journals.setState(journal, 'written');
      this.options.applyFault?.('after_write');
      const applied = await captureCollaborationCandidateSnapshot(workspaceRoot, candidate.baseCommit, task.scope);
      if (applied.patchHash !== candidate.diffHash || !await this.journals.matches(journal, 'post')) {
        throw new CollaborationWorkflowError('COLLABORATION_APPLY_VERIFY_FAILED', '应用结果与已评审候选不一致');
      }
      await this.journals.syncImages(journal, 'post');
      const result = this.options.store.runInTransaction(() => {
        this.controls.assertOwned(control); this.assertApplicationEvidence(task, candidate);
        this.repository.markCandidateApplied(input.workspaceId, candidate.id);
        const updated = this.repository.markApplied(input.workspaceId, input.collaborationId, input.expectedVersion, input.idempotencyKey, new Date().toISOString(), control.id);
        this.journals.setState(journal!, 'committed'); this.controls.finish(control, updated);
        this.options.applyFault?.('before_commit');
        return updated;
      });
      await this.releaseApplicationAdmission({ workspaceId: task.workspaceId, controlId: control.id });
      return result;
    } catch (error) {
      // Commit succeeded but release failed: never undo an acknowledged application.
      if (this.controls.find(task.workspaceId, control.id)?.state === 'completed') return this.requireTask(task.workspaceId, task.id);
      let recovered = false;
      if (journal) {
        recovered = await this.journals.rollback(journal, () => {
          this.controls.assertOwned(control);
          this.controls.fail(control, error, false, journal!.recoveryPath);
        }).catch(() => false);
        if (!recovered) this.options.store.runInTransaction(() => this.controls.fail(control, error, true, journal?.recoveryPath));
      } else {
        this.options.store.runInTransaction(() => this.controls.fail(control, error, false));
        recovered = true; // No target write is possible without the durable journal.
      }
      if (recovered) await this.releaseApplicationAdmission({ workspaceId: task.workspaceId, controlId: control.id });
      if (!recovered) throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_REQUIRED', '文件状态无法安全回滚；写入权已保留，请查看恢复材料');
      throw error;
    }
  }

  private assertApplicationEvidence(task: CollaborationTask, candidate: CollaborationCandidate): void {
    const stored = this.repository.findCandidate(task.workspaceId, candidate.id);
    const review = this.repository.findReviewForCandidate(task.workspaceId, candidate.id);
    const run = this.options.store.runRepository().findById(task.workspaceId, candidate.canonicalRunId);
    const stage = review && this.options.store.runStageRepository().findById(task.workspaceId, candidate.canonicalRunId, review.stageId);
    if (!stored || stored.version !== candidate.version || stored.diffHash !== candidate.diffHash || stored.diffText !== candidate.diffText
      || !run || run.status !== 'completed' || run.recoveryRequired || candidate.snapshotVersion !== 2 || candidate.collaborationTaskId !== task.id || candidate.canonicalRunId !== task.canonicalRunId
      || candidate.diffHash !== hash(candidate.diffText) || candidate.status !== 'reviewed' || candidate.testStatus !== 'passed'
      || candidate.testExitCode !== 0 || !candidate.testOutput || candidate.testCommand !== task.acceptanceCommands.join(' && ')
      || !review || review.candidateDiffHash !== candidate.diffHash || review.canonicalRunId !== candidate.canonicalRunId
      || review.collaborationTaskId !== task.id || review.conclusion !== 'approved' || review.reviewerAgentId !== task.reviewerAgentId
      || !stage || stage.workflowStageKey !== 'review' || stage.status !== 'completed' || stage.attempt !== review.stageAttempt
      || !this.readReviewEvidence(task.workspaceId, candidate, review.stageId, review.stageAttempt, task.reviewerAgentId)) {
      throw new CollaborationWorkflowError('COLLABORATION_REVIEW_INVALID', '缺少同一候选、Run、Agent、attempt 的有效评审和实际测试证据');
    }
    this.scopeFor(task);
  }

  private async confirmInternal(input: CollaborationMutationInput, control: CollaborationControl): Promise<CollaborationTask> {
    const task = this.controls.assertOwned(control);
    this.scopeFor(task);
    this.assertConversationAssociation(task.workspaceId, task.conversationId, task.sourceMessageId);
    if (task.version !== input.expectedVersion) throw new CollaborationWorkflowError('COLLABORATION_CONFLICT', 'Task version changed');
    const workspace = this.requireWorkspace(input.workspaceId);
    const workspaceRoot = this.gitRoot(workspace.id);
    await this.options.worktrees.preflight(workspaceRoot, { controlledGitContent: true });
    const baseCommit = await git(workspaceRoot, ['rev-parse', 'HEAD']);
    if (baseCommit !== task.baseCommit) throw new CollaborationWorkflowError('COLLABORATION_BASE_CHANGED', 'The workspace changed after the plan was created');
    const agents = new Map(workspace.agents.map(agent => [agent.id, agent]));
    const planner = agents.get(task.plannerAgentId);
    const implementer = agents.get(task.implementerAgentId);
    const reviewer = agents.get(task.reviewerAgentId);
    if (!planner || !implementer || !reviewer) throw new CollaborationWorkflowError('COLLABORATION_AGENT_UNAVAILABLE', 'A selected Agent is no longer available');

    const template = getWorkflowTemplate('plan-implement-review');
    if (!template) throw new CollaborationWorkflowError('COLLABORATION_TEMPLATE_UNAVAILABLE', 'The collaboration template is unavailable');
    const objective = this.objectiveFor(task);
    const isRework = task.canonicalRunId !== undefined;
    let created;
    try {
      created = this.options.store.runInTransaction(() => {
        this.controls.assertOwned(control);
        const graph = this.options.store.workflowTemplateService().instantiateTemplateRunWithinTransaction({
        workspace, template,
        roleBindings: { planner: planner.role, implementer: implementer.role, reviewer: reviewer.role },
        agentBindings: { plan: planner.id, implement: implementer.id, review: reviewer.id },
        worktreeMode: 'required',
        createdBy: 'collaboration-workflow', taskTitle: task.title, objective, createdAt: new Date().toISOString(),
        includeOptionalSecurityReview: false, reason: isRework ? 'review-fix' : 'initial',
        ...(task.canonicalTaskId === undefined ? {} : { taskId: task.canonicalTaskId }),
        ...(isRework ? { parentRunId: task.canonicalRunId } : {}),
        });
        this.options.store.lifecycleTransactionService().createRunGraphEventsWithinTransaction(graph.run, graph.snapshot, graph.stages);
        if (task.canonicalTaskId === undefined) {
          this.repository.confirm({ workspaceId: task.workspaceId, id: task.id, expectedVersion: task.version,
            canonicalTaskId: graph.task.id, canonicalRunId: graph.run.id, confirmedAt: new Date().toISOString(),
            idempotencyKey: input.idempotencyKey, controlId: control.id });
          const canonical = this.options.store.taskRepository().findById(task.workspaceId, graph.task.id);
          if (canonical) this.options.store.taskRepository().transitionStatus(task.workspaceId, canonical.id, canonical.version, 'in_progress');
        } else {
          this.repository.progress({ workspaceId: task.workspaceId, id: task.id, expectedVersion: task.version, status: 'queued',
            canonicalRunId: graph.run.id, reworkRound: task.reworkRound + 1, controlId: control.id,
            expectedRunId: task.canonicalRunId, expectedControlEpoch: control.epoch });
        }
        this.controls.bind(control, { runId: graph.run.id });
        return graph;
      });
    } catch (error) {
      throw new CollaborationWorkflowError('COLLABORATION_RUN_CREATE_FAILED', error instanceof Error ? error.message : String(error));
    }

    try {
    await this.options.worktrees.preflight(workspaceRoot, { controlledGitContent: true });
    const lease = task.canonicalRunId === undefined
      ? await this.options.worktrees.createLease({
        workspaceId: workspace.id, workspaceRoot, runId: created.run.id,
        executionId: `collaboration-${task.id}`, agentId: implementer.id,
        controlledGitContent: true,
      })
      : undefined;
    if (lease) {
      const record = this.options.worktrees.getRecord(lease.id);
      if (!record) throw new CollaborationWorkflowError('COLLABORATION_WORKTREE_MISSING', 'Worktree lease was not persisted');
      this.leaseByTask.set(task.id, lease.id);
      this.options.registerWorktreePath(created.run.id, record.absolutePath);
    } else {
      const previousLeaseId = this.resolveLeaseId(task);
      const record = previousLeaseId === undefined ? undefined : this.options.worktrees.getRecord(previousLeaseId);
      if (!record) throw new CollaborationWorkflowError('COLLABORATION_WORKTREE_MISSING', 'The rework worktree is no longer available');
      this.options.registerWorktreePath(created.run.id, record.absolutePath);
    }

    } catch (error) {
      // No start authorization or Provider exists yet. Persist the graph's failed
      // preparation ownership, rather than leaving an executable orphan Run.
      this.options.store.runInTransaction(() => {
        this.controls.assertOwned(control);
        const run = this.options.store.runRepository().findById(workspace.id, created.run.id)!;
        this.options.store.lifecycleTransactionService().cancelRunForOperationWithEvidenceWithinTransaction({
          workspaceId: workspace.id, runId: run.id, correlationId: control.id, expectedRunVersion: run.version,
          terminatedProcessIds: [], worktreePreserved: true,
        });
        const current = this.requireTask(task.workspaceId, task.id);
        this.repository.progress({ workspaceId: task.workspaceId, id: task.id, expectedVersion: current.version, status: 'blocked',
          expectedRunId: created.run.id, expectedControlEpoch: control.epoch, controlId: control.id,
          failureReason: '隔离工作区准备失败；未启动 Provider' });
        this.controls.fail(control, error, false);
      });
      this.markTaskWorktreeFailed(this.requireTask(task.workspaceId, task.id));
      throw error;
    }
    const currentRun = this.options.store.runRepository().findById(workspace.id, created.run.id);
    if (!currentRun) throw new CollaborationWorkflowError('COLLABORATION_RUN_MISSING', 'Canonical Run disappeared after creation');
    this.taskRuns.startRunOperationForV2(workspace.id, created.run.id, undefined, currentRun.version);
    const admitted = await this.options.requestRunAdmission({ workspaceId: workspace.id, runId: created.run.id });
    const current = this.requireTask(task.workspaceId, task.id);
    if (admitted && this.options.runtimeDispatchEnabled !== false && current.status === 'queued') {
      this.options.store.runInTransaction(() => this.repository.progress({
        workspaceId: task.workspaceId, id: task.id, expectedVersion: current.version, status: 'running',
        canonicalRunId: created.run.id,
        controlId: control.id, expectedControlEpoch: control.epoch,
      }));
    }
    const result = this.requireTask(task.workspaceId, task.id);
    // Commit control completion before background hooks can advance this task.
    this.options.store.runInTransaction(() => this.controls.finish(control, result));
    if (admitted && this.options.runtimeDispatchEnabled !== false) void this.driveAndFinalize(task.id, workspace.id, created.run.id);
    return result;
  }

  /** Startup convergence is read/proof based. It never dispatches a Provider. */
  async reconcileOnStartup(): Promise<{ tasks: number; controls: number; unresolved: number }> {
    this.recovering = true;
    try { return await this.reconcilePersistedState(); } finally { this.recovering = false; }
  }

  private async reconcilePersistedState(): Promise<{ tasks: number; controls: number; unresolved: number }> {
    let tasks = 0; let controls = 0; let unresolved = 0;
    const db = this.options.store.getDatabase();
    const recoveryTable = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'p2_collaboration_recoveries'").get();
    if (recoveryTable) {
      const interruptedRecoveries = db.prepare(`UPDATE p2_collaboration_recoveries
        SET state = 'recovery_required',error_code = 'COLLABORATION_RECOVERY_INTERRUPTED',updated_at = ?
        WHERE state IN ('reserved','dispatching')`).run(new Date().toISOString()) as { changes?: number | bigint };
      unresolved += Number(interruptedRecoveries.changes ?? 0);
    }
    let journals: ApplyJournal[] = [];
    try { journals = await this.journals.loadPending(); } catch {
      // Keep corrupt/missing recovery material visible and fenced, not silently
      // released, and do not take the rest of the read-only product offline.
      for (const control of this.controls.listPending().filter(item => item.action === 'apply')) {
        this.options.store.runInTransaction(() => this.setRecoveredControl(control, true, '应用恢复材料缺失或校验失败；未改动目标文件'));
        unresolved++;
      }
    }
    for (const journal of journals) {
      const control = this.controls.find(journal.workspaceId, journal.controlId);
      if (!control || control.action !== 'apply') throw new Error('Application recovery ownership missing');
      try {
        this.options.applyFault?.('recovery');
        const { task, candidate } = this.assertApplicationRecoveryOwnership(control, journal);
        const workspace = this.requireWorkspace(journal.workspaceId);
        if (resolve(this.gitRoot(workspace.id)) !== resolve(journal.targetRoot) || await git(this.gitRoot(workspace.id), ['rev-parse', 'HEAD']) !== journal.baseCommit) throw new Error('Recovery baseline changed');
        if (await this.journals.matches(journal, 'pre')) {
          // git status may execute clean filters even for byte-identical files.
          // A changed/unsupported context remains fenced for manual recovery.
          await this.options.worktrees.preflight(this.gitRoot(workspace.id), { controlledGitContent: true });
          this.options.store.runInTransaction(() => {
            this.assertApplicationRecoveryOwnership(control, journal);
            this.journals.setState(journal, 'recovered');
            this.setRecoveredControl(control, false, '恢复已证明候选未写入或已完全回滚');
          });
        } else if (await this.journals.matches(journal, 'post')) {
          this.assertApplicationEvidence(task, candidate);
          const snapshot = await captureCollaborationCandidateSnapshot(this.gitRoot(workspace.id), candidate.baseCommit, this.scopeFor(task));
          if (snapshot.patchHash !== journal.candidateHash) throw new Error('Recovery has additional changes');
          this.options.store.runInTransaction(() => {
            this.assertApplicationRecoveryOwnership(control, journal);
            // This is proof-based state convergence, not another file application.
            this.options.store.getDatabase().prepare("UPDATE collaboration_controls SET state = 'running' WHERE workspace_id = ? AND id = ? AND epoch = ? AND state IN ('reserved','running','recovery_required')")
              .run(control.workspaceId, control.id, control.epoch);
            this.controls.assertOwned(control);
            this.repository.markCandidateApplied(control.workspaceId, candidate.id);
            const applied = this.repository.markApplied(control.workspaceId, task.id, control.expectedVersion, control.idempotencyKey, new Date().toISOString(), control.id);
            this.journals.setState(journal, 'committed'); this.controls.finish(control, applied);
          });
        } else throw new Error('Recovery images do not match; no files were overwritten');
        await this.releaseApplicationAdmission({ workspaceId: control.workspaceId, controlId: control.id });
        controls++;
      } catch (error) {
        const facts = readCollaborationApplicationFacts(this.options.store.getDatabase(), control.workspaceId, control.id);
        if (facts && collaborationApplicationTerminalReason(facts)) {
          // A release/queue failure cannot undo an atomically committed safe
          // result. Leave the durable pair intact for the next recovery sweep.
          unresolved++;
          continue;
        }
        this.options.store.runInTransaction(() => {
          this.journals.setState(journal, 'recovery_required');
          this.setRecoveredControl(control, true, error instanceof Error ? error.message : '恢复状态不明', journal.recoveryPath);
        });
        unresolved++;
      }
    }
    for (const control of this.controls.listPending()) {
      if (control.action === 'apply') {
        const journal = this.options.store.getDatabase().prepare('SELECT state FROM collaboration_apply_journals WHERE control_id = ?').get(control.id);
        if (journal) continue;
        // An application cannot write without its durable journal. An empty
        // control therefore proves zero target writes and is safe to release.
        const task = this.requireTask(control.workspaceId, control.collaborationTaskId);
        if (task.version !== control.expectedVersion || task.controlEpoch !== control.epoch) {
          this.options.store.runInTransaction(() => this.setRecoveredControl(control, true, '应用控制版本或所有权已变化；保留写入占位'));
          unresolved++; continue;
        }
        this.options.store.runInTransaction(() => {
          const current = this.requireTask(control.workspaceId, control.collaborationTaskId);
          if (current.version !== control.expectedVersion || current.controlEpoch !== control.epoch) throw new Error('Recovery control ownership changed');
          this.setRecoveredControl(control, false, '应用准备中断，尚未写入目标文件');
        });
        try {
          await this.releaseApplicationAdmission({ workspaceId: control.workspaceId, controlId: control.id });
          controls++;
        } catch { unresolved++; }
        continue;
      }
      const task = this.requireTask(control.workspaceId, control.collaborationTaskId);
      const run = control.runId ? this.options.store.runRepository().findById(control.workspaceId, control.runId) : undefined;
      if (control.action === 'cancel' && (!control.runId || (run && ['completed', 'failed', 'cancelled'].includes(run.status)))) {
        this.options.store.runInTransaction(() => {
          this.options.store.getDatabase().prepare("UPDATE collaboration_controls SET state = 'running' WHERE workspace_id = ? AND id = ? AND epoch = ?")
            .run(control.workspaceId, control.id, control.epoch);
          const cancelled = this.repository.cancel(task.workspaceId, task.id, control.expectedVersion, new Date().toISOString(), control.id);
          this.controls.finish(control, cancelled);
        });
        this.markTaskWorktreeFailed(this.requireTask(task.workspaceId, task.id));
        if (run) await this.releaseRunAdmission({ workspaceId: run.workspaceId, runId: run.id });
        controls++;
      } else if (!control.runId) {
        this.options.store.runInTransaction(() => this.setRecoveredControl(control, false, '控制准备中断，尚未创建执行'));
        controls++;
      } else {
        this.options.store.runInTransaction(() => this.setRecoveredControl(control, true, '执行控制在重启前中断；不会重放调用，需处理持久化执行状态'));
        unresolved++;
      }
    }
    const rows = this.options.store.getDatabase().prepare("SELECT workspace_id,id FROM collaboration_tasks WHERE status IN ('queued','running','reviewing','changes_requested') ORDER BY workspace_id,id")
      .all() as { workspace_id: string; id: string }[];
    for (const row of rows) {
      const task = this.requireTask(row.workspace_id, row.id);
      if (this.controls.pending(task.workspaceId, task.id)) continue;
      const run = task.canonicalRunId && this.options.store.runRepository().findById(task.workspaceId, task.canonicalRunId);
      if (!run) { this.progress(task, 'blocked', task.canonicalRunId, '当前 canonical Run 关联缺失；未重放执行'); tasks++; continue; }
      this.resolveLeaseId(task);
      if (run.recoveryRequired === true) {
        this.progress(task, 'blocked', run.id, '当前 Run 有未确认的进程/副作用；未自动重放 Provider'); tasks++; unresolved++;
      } else if (run.status === 'failed' || run.status === 'cancelled') {
        const status = run.status === 'cancelled' ? 'cancelled' : run.failureCode === 'RUN_PROCESS_UNKNOWN' || run.failureCode?.includes('RECOVERY') ? 'blocked' : 'failed';
        this.progress(task, status, run.id, run.failureMessage ?? `canonical Run ${run.status}`); tasks++;
      } else if (run.status === 'completed') {
        // Completed history is adjudicated only from persisted evidence. Never
        // regenerate candidate files or silently schedule rework on startup.
        const candidate = this.repository.findCandidateForRun(task.workspaceId, task.id, run.id);
        let accepted = false;
        try { if (candidate) { this.assertApplicationEvidence({ ...task, currentCandidateId: candidate.id }, candidate); accepted = true; } } catch { /* explicit missing evidence */ }
        const reviewing = task.status === 'reviewing' ? task : this.progress(task, 'reviewing', run.id);
        this.progress(reviewing, accepted ? 'awaiting_application' : 'blocked', run.id,
          accepted ? undefined : '已完成 Run 的冻结候选、实际测试或当前 attempt 评审证据缺失；不会重新生成或补签', candidate?.id);
        tasks++;
      } else if (run.status === 'running' || run.status === 'starting') {
        this.progress(task, 'blocked', run.id, '重启后的活动进程/副作用未能完整确认；未自动重放 Provider'); tasks++; unresolved++;
      }
      // queued and waiting_approval preserve their durable waiting semantics.
    }
    return { tasks, controls, unresolved };
  }

  private assertApplicationRecoveryOwnership(control: CollaborationControl, journal: ApplyJournal): { task: CollaborationTask; candidate: CollaborationCandidate } {
    const current = this.controls.find(control.workspaceId, control.id);
    const task = this.requireTask(control.workspaceId, control.collaborationTaskId);
    const candidate = this.repository.findCandidate(control.workspaceId, journal.candidateId);
    if (!current || !['reserved', 'running', 'recovery_required'].includes(current.state)
      || current.action !== 'apply' || current.epoch !== control.epoch
      || task.version !== control.expectedVersion || task.controlEpoch !== control.epoch
      || task.status !== 'awaiting_application' || task.currentCandidateId !== journal.candidateId
      || !candidate || candidate.collaborationTaskId !== task.id
      || journal.controlId !== control.id || journal.workspaceId !== control.workspaceId || journal.taskId !== task.id
      || current.candidateId !== candidate.id || current.runId !== candidate.canonicalRunId
      || task.canonicalRunId !== candidate.canonicalRunId
      || journal.candidateHash !== candidate.diffHash || candidate.diffHash !== hash(candidate.diffText)
      || journal.baseCommit !== candidate.baseCommit || journal.baseCommit !== task.baseCommit) {
      throw new Error('Recovery candidate, version or control ownership changed');
    }
    return { task, candidate };
  }

  private setRecoveredControl(control: CollaborationControl, uncertain: boolean, reason: string, reference?: string): void {
    this.options.store.getDatabase().prepare("UPDATE collaboration_controls SET state = ?,error_code = ?,error_message = ?,recovery_reference = COALESCE(?,recovery_reference),updated_at = ? WHERE workspace_id = ? AND id = ? AND epoch = ? AND state IN ('reserved','running','recovery_required')")
      .run(uncertain ? 'recovery_required' : 'failed', uncertain ? 'COLLABORATION_RECOVERY_REQUIRED' : 'COLLABORATION_INTERRUPTED', safeOutput(reason), reference ?? null,
        new Date().toISOString(), control.workspaceId, control.id, control.epoch);
  }

  private async driveAndFinalize(collaborationId: string, workspaceId: string, runId: string): Promise<void> {
    if (this.processing.has(`${workspaceId}:${collaborationId}:${runId}`)) return;
    this.processing.add(`${workspaceId}:${collaborationId}:${runId}`);
    try {
      await this.options.dispatchRun(workspaceId, runId);
      const task = this.requireTask(workspaceId, collaborationId);
      if (!this.canDispatch(workspaceId, runId)) return;
      const run = this.options.store.runRepository().findById(workspaceId, runId);
      if (!run) throw new CollaborationWorkflowError('COLLABORATION_RUN_MISSING', 'Canonical Run not found');
      if (run.status === 'cancelled') {
        await this.releaseRunAdmission({ workspaceId, runId });
        this.progress(task, 'cancelled', runId);
        return;
      }
      if (run.status === 'failed') {
        await this.releaseRunAdmission({ workspaceId, runId });
        if (task.status !== 'blocked') this.progress(task, 'failed', runId, run.failureMessage ?? 'Canonical Run failed');
        return;
      }
      if (run.status !== 'completed') return;
      await this.releaseRunAdmission({ workspaceId, runId });
      this.progress(task, 'reviewing', runId);
      await this.captureAndDecide(collaborationId, workspaceId, runId);
    } catch (error) {
      const terminalRun = this.options.store.runRepository().findById(workspaceId, runId);
      if (terminalRun && ['completed', 'failed', 'cancelled'].includes(terminalRun.status)) {
        await this.releaseRunAdmission({ workspaceId, runId }).catch(() => undefined);
      }
      const task = this.repository.findById(workspaceId, collaborationId);
      if (task && !['applied', 'cancelled', 'blocked'].includes(task.status)) {
        try {
          const failed = this.progress(task, 'failed', runId, error instanceof Error ? error.message : String(error));
          this.markTaskWorktreeFailed(failed);
        } catch { /* durable state is already the source of truth */ }
      } else if (task) {
        this.markTaskWorktreeFailed(task);
      }
    } finally {
      this.processing.delete(`${workspaceId}:${collaborationId}:${runId}`);
    }
  }

  private async captureAndDecide(collaborationId: string, workspaceId: string, runId: string): Promise<void> {
    if (!this.canDispatch(workspaceId, runId)) return;
    let task = this.requireTask(workspaceId, collaborationId);
    const candidate = this.repository.findCandidateForRun(workspaceId, collaborationId, runId);
    const reviewStage = this.options.store.runStageRepository().listByRun(workspaceId, runId).find(stage => stage.workflowStageKey === 'review');
    if (!candidate || !reviewStage) {
      this.progress(task, 'blocked', runId, '候选快照或评审阶段缺失，不能判定任务通过', candidate?.id);
      return;
    }
    const reviewLease = this.findReviewLease(candidate);
    const reviewRecord = reviewLease ? this.options.worktrees.getRecord(reviewLease.id) : undefined;
    if (!reviewRecord) {
      this.progress(task, 'blocked', runId, '评审工作区丢失，候选保留且未授权应用', candidate.id);
      return;
    }
    const reviewSnapshot = await captureCollaborationCandidateSnapshot(reviewRecord.absolutePath, candidate.baseCommit, task.scope).catch(() => undefined);
    if (!reviewSnapshot || reviewSnapshot.patchHash !== candidate.diffHash) {
      this.progress(task, 'blocked', runId, '评审工作区内容发生变化，评审结果无效', candidate.id);
      return;
    }
    const evidence = this.readReviewEvidence(workspaceId, candidate, reviewStage.id, reviewStage.attempt, task.reviewerAgentId);
    if (!evidence) {
      const stageOutput = this.repository.findStageOutput(workspaceId, runId, reviewStage.id, reviewStage.attempt);
      this.progress(task, 'blocked', runId, stageOutput?.reason ?? '评审证据缺失或未绑定当前候选版本', candidate.id);
      return;
    }
    const existingReview = this.repository.findReviewForCandidate(workspaceId, candidate.id);
    if (existingReview && (existingReview.candidateDiffHash !== candidate.diffHash
      || existingReview.stageAttempt !== evidence.stageAttempt
      || existingReview.reviewerAgentId !== evidence.reviewerAgentId)) {
      this.progress(task, 'blocked', runId, '已有评审记录与当前候选版本不一致', candidate.id);
      return;
    }
    const reviewed = this.options.store.runInTransaction(() => {
      this.assertExecutionFence(task, runId);
      if (!existingReview) {
        this.repository.createReview({
          id: `review_${randomUUID()}`, collaborationTaskId: collaborationId, candidateId: candidate.id,
          workspaceId, canonicalRunId: runId, stageId: evidence.stageId, stageAttempt: evidence.stageAttempt,
          reviewerAgentId: evidence.reviewerAgentId, candidateDiffHash: evidence.candidateDiffHash,
          conclusion: evidence.conclusion, summary: evidence.summary, createdAt: new Date().toISOString(),
        });
      }
      return candidate.status === 'reviewed' ? candidate : this.repository.reviewCandidate({
        workspaceId, candidateId: candidate.id, conclusion: evidence.conclusion,
        summary: evidence.summary, reviewerAgentId: evidence.reviewerAgentId,
      });
    });
    task = this.requireTask(workspaceId, collaborationId);
    const accepted = evidence.conclusion === 'approved' && candidate.testStatus === 'passed';
    if (accepted) {
      this.progress(task, 'awaiting_application', runId, undefined, reviewed.id);
      return;
    }
    const feedback = [
      ...(evidence.conclusion === 'changes_requested' ? [evidence.summary] : []),
      ...(candidate.testStatus !== 'passed' ? [`验收命令未通过或修改了冻结候选。\n${candidate.testOutput ?? ''}`] : []),
    ].filter(Boolean).join('\n\n') || '评审未能确认候选满足任务要求';
    if (task.reworkRound >= task.maxReworkRounds) {
      this.progress(task, 'blocked', runId, `返工次数已用尽：${feedback}`, reviewed.id);
      return;
    }
    this.progress(task, 'changes_requested', runId, feedback, reviewed.id);
    const reworkTask = this.requireTask(workspaceId, collaborationId);
    // Keep the approved plan immutable. Feedback is frozen into the new Run's
    // objective, not silently appended to the task's approved objective/hash.
    const reworkInput = { workspaceId, collaborationId, expectedVersion: reworkTask.version, idempotencyKey: `rework:${collaborationId}:${runId}:${candidate.id}` };
    await this.executeControl('rework', reworkInput, control => this.confirmInternal(reworkInput, control));
  }

  private readReviewEvidence(
    workspaceId: string,
    candidate: CollaborationCandidate,
    stageId: string,
    stageAttempt: number,
    expectedReviewerId: string,
  ): ReviewEvidence | undefined {
    const output = this.repository.findStageOutput(workspaceId, candidate.canonicalRunId, stageId, stageAttempt);
    if (!output || output.status !== 'available' || output.role !== 'reviewer'
      || output.agentId !== expectedReviewerId || output.reviewCandidateId !== candidate.id
      || output.reviewCandidateHash !== candidate.diffHash || !output.reviewConclusion || !output.publicOutput) return undefined;
    const stage = this.options.store.runStageRepository().findById(workspaceId, candidate.canonicalRunId, stageId);
    if (!stage || stage.attempt !== stageAttempt || stage.status !== 'completed') return undefined;
    return {
      conclusion: output.reviewConclusion, summary: output.publicOutput,
      stageId, stageAttempt, reviewerAgentId: output.agentId, candidateDiffHash: output.reviewCandidateHash,
    };
  }

  private async captureAndPersistCandidate(task: CollaborationTask, runId: string, worktreePath?: string): Promise<CollaborationCandidate> {
    this.assertExecutionFence(task, runId);
    const leaseId = this.resolveLeaseId(task);
    const worktree = worktreePath ?? (leaseId === undefined ? undefined : this.options.worktrees.getRecord(leaseId)?.absolutePath);
    if (!worktree) throw new CollaborationWorkflowError('COLLABORATION_WORKTREE_MISSING', '实施工作区不可用，无法冻结候选');
    const snapshot = await captureCollaborationCandidateSnapshot(worktree, task.baseCommit, task.scope);
    let output = '';
    let exitCode = 0;
    for (const command of task.acceptanceCommands) {
      try {
        const result = await execFileAsync(command, { cwd: worktree, shell: true, timeout: 120_000, windowsHide: true, maxBuffer: MAX_TEST_OUTPUT_BYTES * 2 });
        output += `$ ${command}\n${safeOutput(`${String(result.stdout ?? '')}${String(result.stderr ?? '')}`)}\n`;
      } catch (error) {
        exitCode = typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1;
        output += `$ ${command}\n${safeOutput(`${String((error as { stdout?: unknown }).stdout ?? '')}${String((error as { stderr?: unknown }).stderr ?? '')}`)}\n`;
        break;
      }
    }
    const afterTests = await captureCollaborationCandidateSnapshot(worktree, task.baseCommit, task.scope).catch(() => undefined);
    const sourceChangedDuringTests = afterTests === undefined
      || afterTests.patchHash !== snapshot.patchHash
      || afterTests.headCommit !== snapshot.headCommit;
    if (sourceChangedDuringTests) output = `COLLABORATION_TEST_MUTATED_CANDIDATE: acceptance command changed candidate files; review is blocked.\n${output}`;
    const candidateManifest = new Map<string, CollaborationCandidate['manifest'][number]>(snapshot.untrackedManifest.map(item => [item.path, item]));
    for (const item of snapshot.binaryManifest) candidateManifest.set(item.path, item);
    const capture: CandidateCapture = {
      headCommit: snapshot.headCommit, diffText: snapshot.patch, diffHash: snapshot.patchHash,
      manifest: [...candidateManifest.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
      testStatus: exitCode === 0 && !sourceChangedDuringTests ? 'passed' : 'failed',
      testCommand: task.acceptanceCommands.join(' && '), testExitCode: exitCode,
      testOutput: safeOutput(output), sourceChangedDuringTests,
    };
    try {
      return this.options.store.runInTransaction(() => {
        this.assertExecutionFence(task, runId);
        const createdAt = new Date().toISOString();
        const candidate = this.repository.createCandidate({
      id: createEntityId('artifact'), collaborationTaskId: task.id, workspaceId: task.workspaceId,
      canonicalRunId: runId, round: task.reworkRound, baseCommit: task.baseCommit,
      headCommit: capture.headCommit, diffHash: capture.diffHash, diffText: capture.diffText,
      snapshotVersion: 2, manifestVersion: 2, manifest: capture.manifest, testStatus: capture.testStatus,
      testCommand: capture.testCommand, testExitCode: capture.testExitCode, testOutput: capture.testOutput,
      status: 'created', createdAt,
        });
        // Migration 046 is parent-registered. Keep candidate capture operational
        // on older stores, and only attest the exact persisted, unchanged run.
        if (this.requireWorkspace(task.workspaceId).memoryEnabled && !capture.sourceChangedDuringTests
          && dbTableExists(this.options.store.getDatabase(), 'memory_test_runner_receipts')) {
          const persisted = this.options.store.getDatabase().prepare(`SELECT head_commit,test_status,test_exit_code,test_output
            FROM collaboration_candidates WHERE id=? AND workspace_id=? AND canonical_run_id=?`).get(
            candidate.id, task.workspaceId, runId,
          ) as { head_commit: string; test_status: string; test_exit_code: number | null; test_output: string | null } | undefined;
          if (!persisted || !['passed', 'failed'].includes(persisted.test_status)
            || typeof persisted.test_exit_code !== 'number' || !Number.isSafeInteger(persisted.test_exit_code)
            || typeof persisted.test_output !== 'string') {
            throw new Error('COLLABORATION_TEST_RECEIPT_SOURCE_INVALID');
          }
          this.options.store.getDatabase().prepare(`INSERT INTO memory_test_runner_receipts
            (candidate_id,workspace_id,run_id,commit_id,result,exit_code,output_sha256,runner_version,created_at)
            VALUES(?,?,?,?,?,?,?,?,?)`).run(
            candidate.id, candidate.workspaceId, candidate.canonicalRunId, persisted.head_commit,
            persisted.test_status, persisted.test_exit_code, hash(persisted.test_output),
            COLLABORATION_ACCEPTANCE_RUNNER_VERSION, createdAt,
          );
        }
        return candidate;
      });
    } catch (cause) {
      const existing = this.repository.findCandidateForRun(task.workspaceId, task.id, runId);
      if (existing?.snapshotVersion === 2 && existing.diffHash === capture.diffHash) return existing;
      throw cause;
    }
  }

  private async ensureReviewWorktree(task: CollaborationTask, candidate: CollaborationCandidate, workspaceRoot: string): Promise<string> {
    this.assertExecutionFence(task, candidate.canonicalRunId);
    const existing = this.findReviewLease(candidate);
    let record = existing ? this.options.worktrees.getRecord(existing.id) : undefined;
    if (!record) {
      const baseCommit = await git(workspaceRoot, ['rev-parse', 'HEAD']);
      if (baseCommit !== task.baseCommit) throw new CollaborationWorkflowError('COLLABORATION_BASE_CHANGED', '目标仓库基线变化，评审已停止');
      const lease = await this.options.worktrees.createLease({
        workspaceId: task.workspaceId, workspaceRoot, runId: candidate.canonicalRunId,
        executionId: `collaboration-review-${candidate.id}`, agentId: task.reviewerAgentId,
        controlledGitContent: true,
      });
      record = this.options.worktrees.getRecord(lease.id);
      if (!record) throw new CollaborationWorkflowError('COLLABORATION_REVIEW_WORKTREE_MISSING', '评审隔离工作区未能保存');
      await materializeFrozenReviewPatch(record.absolutePath, candidate, task.scope);
    } else if (record.status !== 'active' && record.status !== 'creating') {
      throw new CollaborationWorkflowError('COLLABORATION_REVIEW_WORKTREE_CLOSED', '评审工作区已关闭，不会重放评审');
    }
    if (record.baseCommit !== candidate.baseCommit) throw new CollaborationWorkflowError('COLLABORATION_BASE_CHANGED', '评审工作区基线与候选不一致');
    const snapshot = await captureCollaborationCandidateSnapshot(record.absolutePath, candidate.baseCommit, task.scope);
    if (snapshot.patchHash !== candidate.diffHash) throw new CollaborationWorkflowError('COLLABORATION_REVIEW_WORKTREE_INVALID', '评审副本与冻结候选不一致');
    this.options.registerWorktreePath(candidate.canonicalRunId, record.absolutePath);
    return record.absolutePath;
  }

  private findReviewLease(candidate: CollaborationCandidate) {
    return this.options.worktrees.listLeases().find(lease => lease.executionId === `collaboration-review-${candidate.id}`
      && lease.workspaceId === candidate.workspaceId && lease.runId === candidate.canonicalRunId);
  }

  private objectiveFor(task: CollaborationTask): string {
    const priorReview = task.status === 'changes_requested' && task.currentCandidateId
      ? this.repository.findReviewForCandidate(task.workspaceId, task.currentCandidateId) : undefined;
    return [
      '[AgentOS collaboration task]',
      `Title: ${task.title}`,
      `Objective: ${task.objective}`,
      `Scope:\n${task.scope.map(item => `- ${item}`).join('\n')}`,
      `Acceptance commands:\n${task.acceptanceCommands.map(command => `- ${command}`).join('\n')}`,
      ...(priorReview ? [`Bounded rework round ${task.reworkRound + 1}:\n${priorReview.summary}\n${task.failureReason ?? ''}`] : []),
      `This task is isolated in a dedicated Git worktree. Do not modify the original workspace, commit, push, merge, or deploy.`,
    ].join('\n');
  }

  private progress(task: CollaborationTask, status: CollaborationStatus, runId?: string, failureReason?: string, candidateId?: string): CollaborationTask {
    return this.options.store.runInTransaction(() => this.repository.progress({
      workspaceId: task.workspaceId, id: task.id, expectedVersion: task.version, status,
      ...(runId === undefined ? {} : { canonicalRunId: runId }),
      ...(candidateId === undefined ? {} : { currentCandidateId: candidateId }),
      ...(failureReason === undefined ? {} : { failureReason }),
      expectedRunId: task.canonicalRunId, expectedControlEpoch: task.controlEpoch ?? 0,
    }));
  }

  /** Called at every dispatch boundary, including after asynchronous preparation. */
  canDispatch(workspaceId: string, runId: string): boolean {
    const run = this.options.store.runRepository().findById(workspaceId, runId);
    const matches = run && this.options.store.getDatabase().prepare('SELECT id FROM collaboration_tasks WHERE workspace_id = ? AND canonical_task_id = ?')
      .all(workspaceId, run.taskId) as { id: string }[] | undefined;
    const task = matches?.length === 1 ? this.repository.findById(workspaceId, matches[0].id) : undefined;
    if (!task) return run?.createdBy !== 'collaboration-workflow';
    if (this.options.runtimeDispatchEnabled === false) return false;
    if (task.canonicalRunId !== runId || !['queued', 'running', 'reviewing'].includes(task.status)
      || this.controls.pending(workspaceId, task.id)) return false;

    // A retry recovery row owns this child until the original idempotent
    // recovery either authorizes Start or is safely redirected to a linked
    // task. Startup admission reconciliation may grant the queued child, but
    // that queue claim alone must not dispatch it or change its task state.
    const retryRecoveryPending = this.options.store.getDatabase().prepare(`SELECT 1 AS pending
      FROM p2_collaboration_recoveries retry
      JOIN runs child ON child.workspace_id = retry.workspace_id AND child.parent_run_id = retry.prior_run_id
      WHERE retry.workspace_id = ? AND retry.collaboration_task_id = ? AND retry.action = 'retry-known-failure'
        AND retry.state IN ('reserved','dispatching','recovery_required') AND child.id = ? LIMIT 1`)
      .get(workspaceId, task.id, runId);
    if (retryRecoveryPending) return false;

    if (run?.status === 'queued') {
      const starts = this.options.store.operationService().listByRun(workspaceId, runId)
        .filter(operation => operation.type === 'run.start');
      // The Engine is authorized only by one queued Start Operation. In
      // particular, a recovered queued retry with no Start remains resumable
      // under its original recovery key instead of being claimed as running.
      if (starts.length !== 1 || starts[0]?.status !== 'queued') return false;
    }
    return true;
  }

  private assertExecutionFence(task: CollaborationTask, runId: string): void {
    const latest = this.requireTask(task.workspaceId, task.id);
    if (latest.canonicalRunId !== runId || (latest.controlEpoch ?? 0) !== (task.controlEpoch ?? 0)
      || !this.canDispatch(task.workspaceId, runId)) {
      throw new CollaborationWorkflowError('COLLABORATION_CONFLICT', '执行关联或控制栅栏已改变，旧结果不再推进');
    }
  }

  private scopeFor(task: CollaborationTask) {
    if (task.scopePolicyVersion !== undefined && task.scopePolicyVersion !== COLLABORATION_SCOPE_POLICY_VERSION) {
      throw new CollaborationWorkflowError('COLLABORATION_SCOPE_INVALID', '历史范围规则不可解释；请创建新任务重新确认');
    }
    return normalizeCollaborationScope(task.scope);
  }

  private withPendingControl(task: CollaborationTask): CollaborationTask {
    const control = this.controls.pending(task.workspaceId, task.id);
    if (!control) return task;
    return { ...task, pendingControl: { id: control.id, action: control.action,
      state: control.state as 'reserved' | 'running' | 'recovery_required', epoch: control.epoch,
      ...(control.errorMessage ? { reason: safeOutput(control.errorMessage) } : {}),
      ...(control.recoveryReference ? { recoveryReference: control.recoveryReference } : {}) } };
  }

  private async executeControl(
    action: CollaborationControlAction,
    input: CollaborationMutationInput,
    execute: (control: CollaborationControl) => Promise<CollaborationTask>,
  ): Promise<CollaborationTask> {
    const claim = this.options.store.runInTransaction(() => this.controls.reserve({ ...input, action }));
    if (claim.replay) {
      if (claim.control.state === 'completed' && claim.control.result) {
        // Durable cancellation/application may precede its queue release. A
        // replay repairs only that proven terminal release, never the action.
        try {
          if (action === 'cancel' && claim.control.result.canonicalRunId) {
            await this.releaseRunAdmission({ workspaceId: input.workspaceId, runId: claim.control.result.canonicalRunId });
          } else if (action === 'apply') {
            await this.releaseApplicationAdmission({ workspaceId: input.workspaceId, controlId: claim.control.id });
          }
        } catch (error) {
          console.warn('[Collaboration] Terminal control release remains pending', error instanceof Error ? error.message : String(error));
        }
        return claim.control.result;
      }
      if (claim.control.state === 'failed') throw new CollaborationControlError(claim.control.errorCode ?? 'COLLABORATION_CONTROL_FAILED', claim.control.errorMessage ?? 'Control failed');
      return this.withPendingControl(claim.task); // No replay of uncertain effects.
    }
    try {
      const result = await execute(claim.control);
      if (this.controls.find(input.workspaceId, claim.control.id)?.state !== 'completed') {
        this.options.store.runInTransaction(() => this.controls.finish(claim.control, result));
      }
      return result;
    } catch (error) {
      const current = this.controls.find(input.workspaceId, claim.control.id);
      if (current?.state === 'completed' && current.result) return current.result;
      this.options.store.runInTransaction(() => this.controls.fail(claim.control, error,
        current?.state === 'running'));
      if (action === 'apply' && this.controls.find(input.workspaceId, claim.control.id)?.state === 'failed') {
        await this.releaseApplicationAdmission({ workspaceId: input.workspaceId, controlId: claim.control.id });
      }
      throw error;
    }
  }

  private requireWorkspace(workspaceId: string): Workspace {
    const workspace = this.options.workspaces.get(workspaceId);
    if (!workspace) throw new CollaborationWorkflowError('WORKSPACE_NOT_FOUND', 'Workspace not found');
    const explicitlyReconnected = this.options.workspaceGitRootIsExplicitlyReconnected?.(workspaceId) === true
      && Boolean(this.options.workspaceGitRootFor?.(workspaceId));
    if (!workspace.gitEnabled && !explicitlyReconnected) {
      throw new CollaborationWorkflowError('COLLABORATION_REQUIRES_GIT', 'Collaboration tasks require a Git workspace');
    }
    return workspace;
  }

  private gitRoot(workspaceId: string): string {
    return this.options.workspaceGitRootFor?.(workspaceId) ?? this.requireWorkspace(workspaceId).rootPath;
  }

  private requireTask(workspaceId: string, collaborationId: string): CollaborationTask {
    const task = this.repository.findById(workspaceId, collaborationId);
    if (!task) throw new CollaborationWorkflowError('COLLABORATION_NOT_FOUND', 'Collaboration task not found');
    return task;
  }

  /** Rehydrate the task-to-worktree association after a server restart. */
  private resolveLeaseId(task: CollaborationTask): string | undefined {
    const cached = this.leaseByTask.get(task.id);
    if (cached !== undefined) return cached;
    const lease = this.options.worktrees.listLeases().find(candidate =>
      candidate.executionId === `collaboration-${task.id}`
      && candidate.workspaceId === task.workspaceId
      && candidate.status === 'active',
    );
    if (lease !== undefined) this.leaseByTask.set(task.id, lease.id);
    return lease?.id;
  }

  /**
   * Failed and cancelled collaboration runs keep their worktree as recovery
   * material, but must no longer look writable to a later run. This is a
   * synchronous best-effort state transition so an execution failure cannot
   * be masked by lease bookkeeping.
   */
  private markTaskWorktreeFailed(task: CollaborationTask): void {
    const cached = this.leaseByTask.get(task.id);
    const lease = cached === undefined
      ? this.options.worktrees.listLeases().find(candidate =>
        candidate.executionId === `collaboration-${task.id}`
        && candidate.workspaceId === task.workspaceId
        && (candidate.status === 'active' || candidate.status === 'creating'),
      )
      : this.options.worktrees.getLease(cached);
    if (!lease || (lease.status !== 'active' && lease.status !== 'creating')) return;
    try { this.options.worktrees.markFailedPreserved(lease.id); } catch { /* preserve the terminal task state */ }
  }

  /**
   * Releasing one canonical Run may grant a queued collaboration Run. The
   * admission authority owns the queue decision; this service only observes
   * the durable GRANTED row and resumes that task's canonical Run.
   */
  private async releaseRunAdmission(input: { workspaceId: string; runId: string }): Promise<void> {
    await this.options.releaseRunAdmission(input);
    await this.resumeGrantedQueuedRuns(input.workspaceId);
  }

  private async releaseApplicationAdmission(input: { workspaceId: string; controlId: string }): Promise<void> {
    await this.options.releaseApplicationAdmission?.(input);
    await this.resumeGrantedQueuedRuns(input.workspaceId);
  }

  /** No list-page cap, no new Run, and no Provider replay during startup recovery. */
  async resumeGrantedQueuedRuns(workspaceId?: string): Promise<void> {
    if (this.recovering || this.options.runtimeDispatchEnabled === false) return;
    const rows = this.options.store.getDatabase().prepare(
      "SELECT t.workspace_id AS workspaceId,t.canonical_run_id AS runId"
        + " FROM collaboration_tasks t JOIN workspace_admissions a"
        + " ON a.workspace_id = t.workspace_id AND a.canonical_run_id = t.canonical_run_id"
        + " JOIN runs r ON r.workspace_id = t.workspace_id AND r.id = t.canonical_run_id"
        + " AND r.task_id = t.canonical_task_id"
        + " WHERE t.status = 'queued' AND a.subject_kind = 'CANONICAL_RUN' AND a.state = 'GRANTED'"
        + " AND r.status = 'queued' AND COALESCE(r.recovery_required,0) = 0"
        + (workspaceId === undefined ? '' : ' AND t.workspace_id = ?')
        + ' ORDER BY a.request_order,a.id',
    ).all(...(workspaceId === undefined ? [] : [workspaceId])) as Array<{ workspaceId: string; runId: string }>;
    for (const row of rows) {
      if (!this.canDispatch(row.workspaceId, row.runId)) continue;
      const task = this.repository.findByCanonicalRun(row.workspaceId, row.runId);
      if (!task || task.status !== 'queued') continue;
      // CAS marks this existing queued Run claimed before the first await. A
      // duplicate release cannot schedule the same pending writer a second time.
      this.progress(task, 'running', row.runId);
      await this.resumeRun(row.workspaceId, row.runId);
    }
  }

  private validatePlan(input: CreateCollaborationPlanInput, workspace: Workspace): Omit<CreateCollaborationPlanInput, 'workspaceId'> {
    this.assertConversationAssociation(workspace.id, input.conversationId, input.sourceMessageId);
    if (!nonBlank(input.title) || input.title.length > 200) throw new CollaborationWorkflowError('COLLABORATION_INVALID', 'A short title is required');
    if (!nonBlank(input.objective) || Buffer.byteLength(input.objective, 'utf8') > MAX_OBJECTIVE_BYTES) throw new CollaborationWorkflowError('COLLABORATION_INVALID', 'A bounded objective is required');
    if (!Array.isArray(input.scope) || input.scope.length === 0 || input.scope.length > MAX_SCOPE_ITEMS || input.scope.some(item => !nonBlank(item) || item.length > 300)) throw new CollaborationWorkflowError('COLLABORATION_INVALID', 'Scope must contain bounded non-empty items');
    if (!Array.isArray(input.acceptanceCommands) || input.acceptanceCommands.length === 0 || input.acceptanceCommands.length > MAX_COMMANDS || input.acceptanceCommands.some(command => !nonBlank(command) || Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES)) throw new CollaborationWorkflowError('COLLABORATION_INVALID', 'At least one bounded acceptance command is required');
    const ids = [input.plannerAgentId, input.implementerAgentId, input.reviewerAgentId];
    if (ids.some(id => !nonBlank(id)) || new Set(ids).size !== ids.length) throw new CollaborationWorkflowError('COLLABORATION_INVALID', 'Planner, implementer and reviewer must be different Agents');
    const byId = new Map(workspace.agents.map(agent => [agent.id, agent]));
    const planner = byId.get(input.plannerAgentId); const implementer = byId.get(input.implementerAgentId); const reviewer = byId.get(input.reviewerAgentId);
    const plannerSource = this.options.store.findAgentSnapshotSource(workspace.id, input.plannerAgentId);
    const implementerSource = this.options.store.findAgentSnapshotSource(workspace.id, input.implementerAgentId);
    const reviewerSource = this.options.store.findAgentSnapshotSource(workspace.id, input.reviewerAgentId);
    if (!planner || !implementer || !reviewer || !planner.enabled || !implementer.enabled || !reviewer.enabled
      || !plannerSource?.enabled || !implementerSource?.enabled || !reviewerSource?.enabled) {
      throw new CollaborationWorkflowError('COLLABORATION_AGENT_UNAVAILABLE', 'Selected Agent is unavailable');
    }
    if (!plannerSource.permissions.includes('read') || !implementerSource.permissions.includes('write')
      || (!reviewerSource.permissions.includes('read') && !reviewerSource.permissions.includes('review'))) {
      throw new CollaborationWorkflowError('COLLABORATION_PERMISSION_INVALID', 'Planner, implementer and reviewer permissions are insufficient');
    }
    const maxReworkRounds = input.maxReworkRounds ?? 2;
    if (!Number.isSafeInteger(maxReworkRounds) || maxReworkRounds < 0 || maxReworkRounds > 2) throw new CollaborationWorkflowError('COLLABORATION_INVALID', 'maxReworkRounds must be between 0 and 2');
    return {
      ...(input.id === undefined ? {} : { id: input.id }),
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }),
      title: input.title.trim(), objective: input.objective.trim(), scope: [...normalizeCollaborationScope(input.scope).paths],
      acceptanceCommands: input.acceptanceCommands.map(command => command.trim()), plannerAgentId: input.plannerAgentId,
      implementerAgentId: input.implementerAgentId, reviewerAgentId: input.reviewerAgentId, maxReworkRounds,
    };
  }

  private assertKnownFailureRetryEligible(task: CollaborationTask, run: Run): void {
    const allowed = new Set([
      'PROVIDER_CONFIG_INVALID', 'PROVIDER_CAPABILITY_UNAVAILABLE', 'PROVIDER_VERSION_UNSUPPORTED',
      'RUN_CONFIGURATION_INVALID', 'WORKSPACE_ADMISSION_DENIED',
    ]);
    if (!['failed', 'blocked'].includes(task.status) || run.status !== 'failed' || run.recoveryRequired
      || !run.failureCode || !allowed.has(run.failureCode)) {
      throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_UNRESOLVED', 'Run failure does not prove that a new attempt is safe');
    }
    const processes = this.options.store.getDatabase().prepare(
      'SELECT COUNT(*) AS count FROM runtime_processes WHERE workspace_id = ? AND run_id = ?',
    ).get(task.workspaceId, run.id) as { count: number | bigint };
    const outputs = this.options.store.getDatabase().prepare(`SELECT COUNT(*) AS count FROM collaboration_stage_outputs
      WHERE workspace_id = ? AND collaboration_task_id = ? AND canonical_run_id = ? AND output_status = 'available'`)
      .get(task.workspaceId, task.id, run.id) as { count: number | bigint };
    if (Number(processes.count) !== 0 || Number(outputs.count) !== 0) {
      throw new CollaborationWorkflowError('COLLABORATION_RECOVERY_UNRESOLVED', 'Provider process or late stage output prevents a safe retry');
    }
  }

  private createLinkedRecoveryTask(
    prior: CollaborationTask, id: string, baseCommit: string, priorRun: Run,
  ): CollaborationTask {
    const workspace = this.requireWorkspace(prior.workspaceId);
    this.scopeFor(prior);
    const title = `${prior.title.slice(0, 184)} (linked recovery)`;
    const lineage = `\n\nRecovery history: linked from collaboration ${prior.id}, Run ${priorRun.id}; prior failure ${priorRun.failureCode ?? 'unknown'}. The interrupted Provider call was not resumed.`;
    const objective = Buffer.byteLength(prior.objective + lineage, 'utf8') <= MAX_OBJECTIVE_BYTES
      ? prior.objective + lineage : prior.objective;
    const input: CreateCollaborationPlanInput = {
      id, workspaceId: prior.workspaceId, conversationId: prior.conversationId,
      sourceMessageId: prior.sourceMessageId, title, objective, scope: [...prior.scope],
      acceptanceCommands: [...prior.acceptanceCommands], plannerAgentId: prior.plannerAgentId,
      implementerAgentId: prior.implementerAgentId, reviewerAgentId: prior.reviewerAgentId,
      maxReworkRounds: prior.maxReworkRounds,
    };
    const normalized = this.validatePlan(input, workspace);
    const planHash = hash(JSON.stringify({
      title: normalized.title, objective: normalized.objective, scope: normalized.scope,
      acceptanceCommands: normalized.acceptanceCommands, plannerAgentId: normalized.plannerAgentId,
      implementerAgentId: normalized.implementerAgentId, reviewerAgentId: normalized.reviewerAgentId,
      baseCommit, scopePolicyVersion: COLLABORATION_SCOPE_POLICY_VERSION,
    }));
    return this.repository.create({
      ...normalized, id, workspaceId: prior.workspaceId, planHash, baseCommit,
      maxReworkRounds: prior.maxReworkRounds, scopePolicyVersion: COLLABORATION_SCOPE_POLICY_VERSION,
      createdAt: new Date().toISOString(),
    });
  }

  private assertConversationAssociation(workspaceId: string, conversationId?: string, sourceMessageId?: string): void {
    if (sourceMessageId && !conversationId) throw new CollaborationWorkflowError('COLLABORATION_ASSOCIATION_INVALID', '来源消息必须绑定所属群聊');
    if (!conversationId) return;
    const conversation = this.options.store.conversationRepository().findConversationById(workspaceId, conversationId);
    if (!conversation || conversation.kind !== 'group' || conversation.status !== 'active') {
      throw new CollaborationWorkflowError('COLLABORATION_ASSOCIATION_INVALID', '群聊不存在、归属不匹配或已归档；不会创建执行');
    }
    if (sourceMessageId) {
      const source = this.options.store.conversationRepository().findMessageById(workspaceId, sourceMessageId);
      if (!source || source.conversationId !== conversationId || source.senderType !== 'user' || source.status !== 'final') {
        throw new CollaborationWorkflowError('COLLABORATION_ASSOCIATION_INVALID', '来源消息不属于该工作区和群聊');
      }
    }
  }
}

function dbTableExists(db: ReturnType<SqliteStore['getDatabase']>, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
}

function hasVerifiedMemoryFactSchema(db: ReturnType<SqliteStore['getDatabase']>): boolean {
  return dbTableExists(db, 'memory_verified_facts')
    && dbTableExists(db, 'memory_test_runner_receipts')
    && dbTableExists(db, 'memory_auto_accept_policy');
}

function progressRole(stageKey: string): CollaborationProgressRole {
  if (stageKey === 'plan') return 'planner';
  if (stageKey === 'implement') return 'implementer';
  if (stageKey === 'review') return 'reviewer';
  return 'other';
}

function stageLabel(stageKey: string): string {
  if (stageKey === 'plan') return '规划';
  if (stageKey === 'implement') return '实施';
  if (stageKey === 'review') return '评审';
  return stageKey;
}

function progressStageStatus(value: string): CollaborationProgressStageStatus {
  const allowed: CollaborationProgressStageStatus[] = ['pending', 'ready', 'starting', 'running', 'waiting_approval', 'paused', 'completed', 'failed', 'cancelled', 'skipped'];
  return allowed.includes(value as CollaborationProgressStageStatus) ? value as CollaborationProgressStageStatus : 'unknown';
}

function progressRunStatus(value: string): CollaborationProgressRunStatus {
  const allowed: CollaborationProgressRunStatus[] = ['queued', 'running', 'waiting_approval', 'paused', 'completed', 'failed', 'cancelled'];
  return allowed.includes(value as CollaborationProgressRunStatus) ? value as CollaborationProgressRunStatus : 'unknown';
}

function safePublicOutput(value: string): string {
  const normalized = redactRuntimeText(value, 6_000).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  return normalized.length <= 6_000 ? normalized : `${normalized.slice(-6_000)}\n[公开输出已截断]`;
}

function publicEventSummary(type: string, payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = payload as Record<string, unknown>;
  if (type === 'stream.text_delta' && value.channel === 'assistant' && typeof value.delta === 'string') return value.delta;
  if (typeof value.summary === 'string') return `${value.summary}\n`;
  if (typeof value.outputPreview === 'string') return `${value.outputPreview}\n`;
  return undefined;
}

async function git(cwd: string, args: string[]): Promise<string> {
  // Collaboration uses this helper only for metadata (currently HEAD).
  if (args[0] !== 'rev-parse') throw new Error('COLLABORATION_GIT_CONTEXT_INVALID: source content commands are prohibited');
  const context = await CollaborationSnapshotGitContext.create(cwd);
  try { return (await context.sourceMetadata(args)).toString('utf8').trim(); }
  finally { await context.dispose(); }
}

async function materializeFrozenReviewPatch(root: string, candidate: CollaborationCandidate, scope: readonly string[]): Promise<void> {
  const context = await CollaborationSnapshotGitContext.create(root);
  try {
    await context.run(['read-tree', candidate.baseCommit]);
    const patch = Buffer.from(candidate.diffText, 'utf8');
    await context.run(['apply', '--cached', '--check', '--binary', '--whitespace=nowarn', '-'], patch);
    await context.run(['apply', '--cached', '--binary', '--whitespace=nowarn', '-'], patch);
    const paths = (await context.run(['diff', '--cached', '--name-only', '--no-renames', '-z', '--no-ext-diff', '--no-textconv', candidate.baseCommit])).toString('utf8').split('\0').filter(Boolean);
    assertCollaborationPathsWithinScope(normalizeCollaborationScope(scope), paths);
    await captureCollaborationPathBoundary(root, paths);
    await context.freezeCheckoutAttributes(paths);
    const present = new Set((await context.run(['ls-files', '-z'])).toString('utf8').split('\0').filter(Boolean));
    await context.assertSourceContextUnchanged();
    const post = paths.filter(path => present.has(path));
    if (post.length) await context.run(['checkout-index', '--force', '--stdin', '-z', `--prefix=${root.replaceAll('\\', '/')}/`], Buffer.from(post.join('\0') + '\0'));
    for (const path of paths) if (!present.has(path)) {
      await captureCollaborationPathBoundary(root, [path]);
      await unlink(resolve(root, ...path.split('/')));
    }
    await captureCollaborationPathBoundary(root, paths);
  } finally { await context.dispose(); }
}
