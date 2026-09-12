import { createEntityId } from '../store/Identity.js';
import { inTransaction } from '../store/Transaction.js';
import { hashCanonicalJson } from '../snapshots/canonicalJson.js';
import type { AgentSnapshotV1 } from '@agentos/shared';
import { redactArgs } from '@agentos/process-runtime';
import type { ProviderLaunchPlan } from '@agentos/agent-core/providers';
import type { SqliteStore } from '../store/SqliteStore.js';
import { RuntimeApprovalRepository, RuntimeApprovalRepositoryError, type RuntimeApprovalRequestRecord } from '../store/RuntimeApprovalRepository.js';
import { ApprovalDecisionRepository } from '../store/ApprovalDecisionRepository.js';
import { MemoryCandidateRepository } from '../store/MemoryCandidateRepository.js';
import { MemoryRuntimeEventEmitter } from './MemoryRuntimeEventEmitter.js';
import { DurableMemoryRuntimeEventContextAuthority } from './MemoryRuntimeEventContextAuthority.js';
import { hashMemoryText, normalizeMemoryText } from './MemoryCandidateGenerationService.js';
import type { LifecycleTransactionService } from './LifecycleTransactionService.js';
import type { StageExecutionInput } from './run-engine/StageExecutionCoordinator.js';

const POLICY_VERSION = 'lite-v1';
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export type RuntimeApprovalDecision = 'approve_once' | 'reject';
export type ApprovalGateBeforeLaunchResult =
  | { readonly kind: 'allow'; readonly requestId?: string }
  | { readonly kind: 'wait'; readonly requestId: string }
  | { readonly kind: 'deny'; readonly code: string; readonly message: string };

export class RuntimeApprovalGateError extends Error {
  constructor(readonly code: 'INPUT_INVALID' | 'NOT_FOUND' | 'CONFLICT' | 'EXPIRED' | 'STALE' | 'DENIED') {
    super('RUNTIME_APPROVAL_' + code);
    this.name = 'RuntimeApprovalGateError';
  }
}

interface ApprovalIdentity {
  readonly runSnapshotId: string;
  readonly sourceKey: string;
  readonly actionFingerprint: string;
  readonly agentSnapshotHash: string;
  readonly providerSnapshotHash: string;
  readonly launchPlanHash: string;
  readonly snapshotJson: string;
  readonly snapshotHash: string;
}

export class RuntimeApprovalGate {
  private readonly requests: RuntimeApprovalRepository;
  private readonly decisions: ApprovalDecisionRepository;
  private readonly candidates: MemoryCandidateRepository;
  private readonly emitter: MemoryRuntimeEventEmitter;

  constructor(
    private readonly store: SqliteStore,
    private readonly options: {
      lifecycle?: LifecycleTransactionService;
      now?: () => string;
      ttlMs?: number;
      continueRun?: (workspaceId: string, runId: string) => Promise<void>;
    } = {},
  ) {
    const db = store.getDatabase();
    this.requests = new RuntimeApprovalRepository(db);
    this.decisions = new ApprovalDecisionRepository(db);
    this.candidates = new MemoryCandidateRepository(db);
    this.emitter = new MemoryRuntimeEventEmitter({
      store,
      factWriter: store.runtimeEventOutboxWriter(),
      eventAuthority: new DurableMemoryRuntimeEventContextAuthority(db),
    });
  }

  beforeLaunch(input: StageExecutionInput, plan: ProviderLaunchPlan): ApprovalGateBeforeLaunchResult {
    if (!requiresUserApproval(input.agentSnapshot)) return { kind: 'allow' };
    const identity = this.identity(input, plan);
    const existing = this.requests.findLatestBySourceKey(input.workspaceId, identity.sourceKey);
    const now = this.now();
    if (existing) {
      if (existing.status === 'approved') {
        this.assertSameAction(existing, identity, now);
        return { kind: 'allow', requestId: existing.id };
      }
      if (existing.status === 'pending') {
        this.assertSameAction(existing, identity, now);
        return { kind: 'wait', requestId: existing.id };
      }
      if (existing.status === 'rejected' || existing.status === 'cancelled') {
        return { kind: 'deny', code: 'RUNTIME_APPROVAL_DENIED', message: 'The original approval decision rejected this action' };
      }
      if (existing.status === 'expired') {
        return { kind: 'deny', code: 'RUNTIME_APPROVAL_EXPIRED', message: 'Approval expired; request a new decision' };
      }
    }
    return this.createRequest(input, identity, now);
  }

  /** Re-check immediately before consuming the one spawn right. */
  assertLaunchStillValid(input: StageExecutionInput, plan: ProviderLaunchPlan, requestId: string): void {
    const current = this.requests.findById(input.workspaceId, requestId);
    if (!current) throw new RuntimeApprovalGateError('NOT_FOUND');
    const result = this.beforeLaunch(input, plan);
    if (result.kind !== 'allow' || result.requestId !== requestId) throw new RuntimeApprovalGateError('STALE');
  }

  afterLaunchAuthority(input: StageExecutionInput, requestId: string | undefined): void {
    if (requestId === undefined) return;
    inTransaction(this.store.getDatabase(), () => {
      const current = this.requests.findById(input.workspaceId, requestId);
      if (!current || current.runId !== input.runId || current.stageId !== input.stageId ||
          current.stageAttempt !== input.stageAttempt || current.status !== 'approved' ||
          current.expiresAt <= this.now()) {
        throw new RuntimeApprovalGateError('STALE');
      }
      if (current.consumedAt === null) {
        this.requests.markConsumedWithinTransaction({
          workspaceId: input.workspaceId, id: current.id, expectedVersion: current.version,
          consumedAt: this.now(),
        });
      }
    });
  }

  resolve(input: {
    workspaceId: string; requestId: string; expectedVersion: number;
    decision: RuntimeApprovalDecision; decidedBy: string;
  }): { request: RuntimeApprovalRequestRecord; replayed: boolean; candidateId: string | null } {
    if (!input.workspaceId.trim() || !input.requestId.trim() || !input.decidedBy.trim() ||
      !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 ||
      (input.decision !== 'approve_once' && input.decision !== 'reject')) {
      throw new RuntimeApprovalGateError('INPUT_INVALID');
    }
    const current = this.requests.findById(input.workspaceId, input.requestId);
    const now = this.now();
    if (current?.status === 'pending' && current.expiresAt <= now) {
      // Expiry is durable; it also releases the one-pending-request fence.
      inTransaction(this.store.getDatabase(), () => this.requests.markExpiredWithinTransaction({
        workspaceId: input.workspaceId, id: current.id, expectedVersion: current.version, now,
      }));
      throw new RuntimeApprovalGateError('EXPIRED');
    }
    try {
      const result = inTransaction(this.store.getDatabase(), () => this.resolveWithinTransaction(input));
      if (input.decision === 'approve_once') {
        // The continuation is deliberately after commit; a continuation failure
        // never rewrites the committed user decision.
        void this.options.continueRun?.(input.workspaceId, result.request.runId);
      }
      return result;
    } catch (error) {
      if (error instanceof RuntimeApprovalRepositoryError && error.code === 'CONFLICT') {
        const existing = this.requests.findById(input.workspaceId, input.requestId);
        if (existing && existing.status !== 'pending' && existing.resolution === input.decision) {
          return { request: existing, replayed: true, candidateId: existing.candidateId };
        }
        if (existing && existing.status !== 'pending') throw new RuntimeApprovalGateError('CONFLICT');
      }
      throw error;
    }
  }

  list(workspaceId: string): RuntimeApprovalRequestRecord[] {
    return this.requests.listForWorkspace(workspaceId);
  }

  async resumeApprovedUnconsumed(): Promise<number> {
    const records = this.requests.listApprovedUnconsumed();
    let resumed = 0;
    for (const record of records) {
      const run = this.store.runRepository().findById(record.workspaceId, record.runId);
      // Recovery uncertainty owns the Run; do not bypass it or merely join an
      // orphaned Process claim as if execution were being observed.
      if (!run || run.recoveryRequired === true) continue;
      await this.options.continueRun?.(record.workspaceId, record.runId);
      resumed += 1;
    }
    return resumed;
  }

  private createRequest(input: StageExecutionInput, identity: ApprovalIdentity, requestedAt: string): ApprovalGateBeforeLaunchResult {
    const db = this.store.getDatabase();
    return inTransaction(db, () => {
      const run = this.store.runRepository().findById(input.workspaceId, input.runId);
      const stage = this.store.runStageRepository().listByRun(input.workspaceId, input.runId)
        .find(candidate => candidate.id === input.stageId);
      if (!run || !stage || run.status !== 'running' || stage.status !== 'running' || stage.attempt !== input.stageAttempt) {
        throw new RuntimeApprovalGateError('STALE');
      }
      const latest = this.requests.findLatestBySourceKey(input.workspaceId, identity.sourceKey);
      const request = this.requests.createWithinTransaction({
        id: createEntityId('approval'), workspaceId: input.workspaceId, runId: input.runId,
        runSnapshotId: identity.runSnapshotId, stageId: input.stageId, stageAttempt: input.stageAttempt,
        operationId: input.operationId, sourceKey: identity.sourceKey,
        requestRound: latest === undefined ? 1 : latest.requestRound + 1,
        category: 'command', riskLevel: 'high', title: 'Approve provider stage execution',
        description: 'The frozen Provider launch plan may modify the Workspace.',
        actionFingerprint: identity.actionFingerprint,
        agentSnapshotHash: identity.agentSnapshotHash,
        providerSnapshotHash: identity.providerSnapshotHash,
        launchPlanHash: identity.launchPlanHash,
        requestSnapshotJson: identity.snapshotJson, snapshotHash: identity.snapshotHash,
        policyVersion: POLICY_VERSION, requestedAt,
        expiresAt: new Date(Date.parse(requestedAt) + (this.options.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
        createdAt: requestedAt, updatedAt: requestedAt,
      });
      const lifecycle = this.lifecycle().requestApprovalWithinTransaction({
        workspaceId: input.workspaceId, runId: input.runId, stageId: input.stageId,
        expectedRunVersion: run.version, expectedStageVersion: stage.version,
        correlationId: input.operationId, causationId: input.operationId,
        approvalRequestId: request.id, category: 'command', riskLevel: 'high',
        title: request.title, description: request.description,
        requestSummary: { snapshotHash: request.snapshotHash, launchPlanHash: request.launchPlanHash },
        expiresAt: request.expiresAt,
      });
      this.requests.linkRequiredEventWithinTransaction({
        workspaceId: input.workspaceId, id: request.id, expectedVersion: request.version,
        eventId: lifecycle.events[0]!.id, now: requestedAt,
      });
      return { kind: 'wait', requestId: request.id };
    });
  }

  private resolveWithinTransaction(input: {
    workspaceId: string; requestId: string; expectedVersion: number;
    decision: RuntimeApprovalDecision; decidedBy: string;
  }): { request: RuntimeApprovalRequestRecord; replayed: false; candidateId: string | null } {
    const db = this.store.getDatabase();
    const request = this.requests.findById(input.workspaceId, input.requestId);
    if (!request) throw new RuntimeApprovalGateError('NOT_FOUND');
    const now = this.now();
    if (request.status !== 'pending' || request.version !== input.expectedVersion) throw new RuntimeApprovalRepositoryError('CONFLICT');
    if (request.expiresAt <= now) {
      throw new RuntimeApprovalGateError('EXPIRED');
    }
    const run = this.store.runRepository().findById(input.workspaceId, request.runId);
    const snapshot = this.store.runSnapshotRepository().findByRunId(input.workspaceId, request.runId);
    const stage = this.store.runStageRepository().listByRun(input.workspaceId, request.runId)
      .find(candidate => candidate.id === request.stageId);
    if (!run || !snapshot || !stage || request.stageId === null || run.status !== 'waiting_approval' || stage.status !== 'waiting_approval' ||
        snapshot.id !== request.runSnapshotId || stage.attempt !== request.stageAttempt) {
      throw new RuntimeApprovalGateError('STALE');
    }
    const operation = this.store.operationService().listByRun(input.workspaceId, request.runId)
      .find(candidate => candidate.id === request.operationId && candidate.type === 'run.start');
    if (!operation) throw new RuntimeApprovalGateError('STALE');
    const decisionRecord = this.decisions.recordDecision({
      id: createEntityId('approval'), workspaceId: input.workspaceId, runId: request.runId,
      approvalRequestId: request.id, agentId: stage.name, provider: 'provider.stage', toolName: 'provider.stage.execution',
      actionFingerprint: request.actionFingerprint, riskLevel: request.riskLevel,
      decision: input.decision === 'approve_once' ? 'allow_once' : 'deny', decidedBy: input.decidedBy,
      decidedAt: now, createdAt: now,
    });
    const decided = this.requests.markDecisionWithinTransaction({
      workspaceId: input.workspaceId, id: request.id, expectedVersion: request.version, now,
      status: input.decision === 'approve_once' ? 'approved' : 'rejected',
      resolution: input.decision, decisionRecordId: decisionRecord.id,
      decidedBy: input.decidedBy, decidedAt: now,
    });
    if (input.decision === 'reject') {
      const lifecycle = this.lifecycle().resolveApprovalToFailureWithinTransaction({
        workspaceId: input.workspaceId, runId: request.runId, stageId: request.stageId!,
        expectedRunVersion: run.version, expectedStageVersion: stage.version,
        correlationId: operation.correlationId, causationId: operation.id,
        approvalRequestId: request.id, decision: 'reject', decidedBy: input.decidedBy,
        errorCode: 'RUNTIME_APPROVAL_REJECTED', message: 'Approval rejected', phase: 'approval', retryable: false,
      });
      this.requests.linkResolutionEvidenceWithinTransaction({
        workspaceId: input.workspaceId, id: request.id, expectedVersion: decided.version, now,
        approvalResolvedEventId: lifecycle.events[0]!.id,
      });
      return { request: this.requests.findById(input.workspaceId, request.id)!, replayed: false, candidateId: null };
    }
    const lifecycle = this.lifecycle().resolveApprovalToRunningWithinTransaction({
      workspaceId: input.workspaceId, runId: request.runId, stageId: request.stageId!,
      expectedRunVersion: run.version, expectedStageVersion: stage.version,
      correlationId: operation.correlationId, causationId: operation.id,
      approvalRequestId: request.id, decision: 'approve_once', decidedBy: input.decidedBy,
    });
    const resolvedEvent = lifecycle.events[0]!;
    const content = [
      '决定：approve_once', `审批请求：${request.id}`, `Run：${request.runId}`,
      `动作指纹：${request.actionFingerprint}`, `快照：${request.snapshotHash}`,
    ].join('\n');
    const candidate = this.candidates.createCandidateWithinTransaction({
      id: createEntityId('memoryCandidate'), workspaceId: input.workspaceId, scope: 'workspace',
      category: 'decision', authority: 'user-explicit', confidence: 0.6, importance: 0.5,
      title: '审批决定：Provider Stage 执行', summary: '用户批准了一次冻结的 Provider Stage 执行。',
      content, exactContentHash: hashMemoryText(content),
      normalizedTextHash: hashMemoryText(normalizeMemoryText(content)),
      tokenEstimate: Math.max(1, Math.ceil(content.length / 4)),
      sources: [{ kind: 'run', id: request.runId }, { kind: 'event', id: resolvedEvent.id }],
      createdAt: now, minConfidence: 0.9, maxTokenEstimate: 4000,
    });
    const candidateEvent = this.emitter.emitPersistedApprovalCandidateWithinTransaction({
      workspaceId: input.workspaceId, runId: request.runId, requestId: request.id,
      decisionId: decisionRecord.id, candidateId: candidate.id, resolvedEventId: resolvedEvent.id,
      timestamp: now,
      eventContext: { origin: 'operation', operationId: operation.id,
        context: { correlationId: operation.correlationId, causationId: operation.id } },
    });
    this.requests.linkResolutionEvidenceWithinTransaction({
      workspaceId: input.workspaceId, id: request.id, expectedVersion: decided.version, now,
      approvalResolvedEventId: resolvedEvent.id, candidateId: candidate.id, candidateEventId: candidateEvent.eventId,
    });
    return { request: this.requests.findById(input.workspaceId, request.id)!, replayed: false, candidateId: candidate.id };
  }

  private identity(input: StageExecutionInput, plan: ProviderLaunchPlan): ApprovalIdentity {
    const snapshot = this.store.runSnapshotRepository().findByRunId(input.workspaceId, input.runId);
    if (!snapshot) throw new RuntimeApprovalGateError('STALE');
    const agentHash = hashCanonicalJson(input.agentSnapshot);
    const providerHash = hashCanonicalJson(input.providerSnapshot);
    const launchHash = hashCanonicalJson({
      executable: plan.executable, args: plan.args, cwd: plan.cwd,
      environmentKeys: Object.keys(plan.environment).sort(),
      environmentValuesHash: hashCanonicalJson(plan.environment),
      redactedEnvironmentKeys: plan.redactedEnvironmentKeys, secretRefs: plan.secretRefs,
      stdinMode: plan.stdinMode, promptDelivery: plan.promptDelivery, promptHash: hashMemoryText(input.prompt),
    });
    const actionFingerprint = hashCanonicalJson({
      workspaceId: input.workspaceId, runId: input.runId, stageId: input.stageId, stageAttempt: input.stageAttempt,
      operationId: input.operationId, runSnapshotId: snapshot.id, agentHash, providerHash, launchHash,
    });
    const safeSnapshot = {
      schemaVersion: 1, policyVersion: POLICY_VERSION, workspaceId: input.workspaceId,
      runId: input.runId, runSnapshotId: snapshot.id, stageId: input.stageId, stageAttempt: input.stageAttempt,
      operationId: input.operationId,
      agent: { agentId: input.agentSnapshot.agentId, version: input.agentSnapshot.version, permissions: input.agentSnapshot.permissions },
      provider: {
        providerConfigId: input.providerSnapshot.providerConfigId,
        version: input.providerSnapshot.version, providerType: input.providerSnapshot.providerType,
        adapterId: input.providerSnapshot.adapterId,
      },
      launch: {
        executable: plan.executable, args: redactArgs(plan.args), cwd: plan.cwd,
        environmentKeys: Object.keys(plan.environment).sort(),
        redactedEnvironmentKeys: plan.redactedEnvironmentKeys, secretRefs: plan.secretRefs,
        stdinMode: plan.stdinMode, promptDelivery: plan.promptDelivery,
      },
    };
    const snapshotJson = JSON.stringify(sortForJson(safeSnapshot));
    return {
      runSnapshotId: snapshot.id,
      sourceKey: hashCanonicalJson({
        workspaceId: input.workspaceId, runId: input.runId, stageId: input.stageId,
        stageAttempt: input.stageAttempt, actionFingerprint,
      }).slice(0, 64),
      actionFingerprint, agentSnapshotHash: agentHash, providerSnapshotHash: providerHash,
      launchPlanHash: launchHash, snapshotJson,
      snapshotHash: hashCanonicalJson(safeSnapshot),
    };
  }

  private assertSameAction(request: RuntimeApprovalRequestRecord, identity: ApprovalIdentity, now: string): void {
    if (request.runSnapshotId !== identity.runSnapshotId || request.actionFingerprint !== identity.actionFingerprint ||
      request.agentSnapshotHash !== identity.agentSnapshotHash ||
      request.providerSnapshotHash !== identity.providerSnapshotHash || request.launchPlanHash !== identity.launchPlanHash) {
      throw new RuntimeApprovalGateError('STALE');
    }
    if (request.expiresAt <= now) throw new RuntimeApprovalGateError('EXPIRED');
  }

  private lifecycle(): LifecycleTransactionService {
    return this.options.lifecycle ?? this.store.lifecycleTransactionService();
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
}

function requiresUserApproval(agent: AgentSnapshotV1): boolean {
  return agent.permissions.some(permission => permission === 'write')
    || !agent.permissions.every(permission => permission === 'read' || permission === 'review');
}

function sortForJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForJson);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
    .map(key => [key, sortForJson((value as Record<string, unknown>)[key])]));
}
