/**
 * P5D Provider Fallback execution support (04-Provider-Specification §42).
 *
 * - Builds the frozen ProviderConfigurationSnapshotV1 for a fallback target.
 * - Owns the provider-switch approval gate: when the frozen fallback policy
 *   requires user approval and the switch target is high-risk, the switch is
 *   gated by a durable Runtime Approval Request (resolved through the existing
 *   RuntimeApprovalGate.resolve / runtime-approvals route). The switch itself
 *   never happens without a committed allow path — no silent fallback.
 * - Emits the public `provider.switch` Runtime Event (Invariant 27).
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  AgentSnapshotV1,
  ProviderConfigurationSnapshotV1,
  RuntimeEventContext,
} from '@agentos/shared';
import { inTransaction } from '../../store/Transaction.js';
import { createEntityId } from '../../store/Identity.js';
import { hashCanonicalJson } from '../../snapshots/canonicalJson.js';
import type { SqliteStore } from '../../store/SqliteStore.js';
import type { ProviderConfiguration } from '../../store/ProviderConfigurationRepository.js';
import { RuntimeApprovalRepository, type RuntimeApprovalRequestRecord } from '../../store/RuntimeApprovalRepository.js';
import { PolicyRepository } from '../../store/PolicyRepository.js';
import { PolicyEngine, type PolicyEvaluation, type PolicyEvaluationInput } from '../policy/PolicyEngine.js';
import type { LifecycleTransactionService } from '../LifecycleTransactionService.js';

export const PROVIDER_SWITCH_SOURCE_KEY_PREFIX = 'provider-switch:';
const POLICY_VERSION = 'lite-v1';
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export interface ProviderSwitchDescriptor {
  readonly workspaceId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly stageAttempt: number;
  readonly operationId: string;
  readonly fromProviderConfigId: string;
  readonly toProviderConfigId: string;
  readonly triggerErrorCode: string;
  /** 1-based provider attempt executing after the switch. */
  readonly attempt: number;
}

export type ProviderSwitchGateResult =
  | { readonly kind: 'allow' }
  | { readonly kind: 'wait'; readonly requestId: string }
  | { readonly kind: 'deny'; readonly code: string; readonly message: string };

/** Stable idempotency/fingerprint identity for one switch descriptor. */
export function providerSwitchFingerprint(descriptor: ProviderSwitchDescriptor): string {
  return hashCanonicalJson(descriptor);
}

export function providerSwitchSourceKey(descriptor: ProviderSwitchDescriptor): string {
  return PROVIDER_SWITCH_SOURCE_KEY_PREFIX + providerSwitchFingerprint(descriptor).slice(0, 64);
}

/** Build the frozen provider snapshot for a fallback target configuration. */
export function providerSnapshotFromConfiguration(
  config: ProviderConfiguration,
  workspaceRoot: string,
): ProviderConfigurationSnapshotV1 {
  let workspaceRelativeWorkingDirectory: string | null = null;
  if (config.workingDirectoryMode === 'custom') {
    if (!config.customWorkingDirectory) throw new Error('PROVIDER_FALLBACK_TARGET_INVALID: customWorkingDirectory missing');
    const workspaceRootResolved = resolve(workspaceRoot);
    const target = resolve(config.customWorkingDirectory);
    const workspaceRelative = relative(workspaceRootResolved, target);
    if (isAbsolute(workspaceRelative) || workspaceRelative === '..' || workspaceRelative.startsWith(`..${sep}`)) {
      throw new Error('PROVIDER_FALLBACK_TARGET_INVALID: customWorkingDirectory escapes the workspace');
    }
    workspaceRelativeWorkingDirectory = workspaceRelative || '.';
  }
  return {
    providerConfigId: config.id,
    name: config.name,
    providerType: config.providerType,
    adapterId: config.adapterId,
    runtimeMode: config.runtimeMode,
    executable: config.executable ?? null,
    argsTemplate: [...(config.argsTemplate ?? [])],
    ...(config.promptDelivery === undefined ? {} : { promptDelivery: config.promptDelivery }),
    ...(config.fallbackPolicy === undefined ? {} : { fallbackPolicy: structuredClone(config.fallbackPolicy) }),
    model: config.model ?? null,
    environmentProfileId: config.environmentProfileId ?? null,
    secretProfileId: config.secretProfileId ?? null,
    workingDirectoryMode: config.workingDirectoryMode,
    workspaceRelativeWorkingDirectory,
    capabilities: structuredClone(config.capabilities),
    timeoutPolicy: structuredClone(config.timeoutPolicy),
    approvalMode: config.approvalMode,
    outputMode: config.outputMode,
    enabled: config.enabled,
    version: config.version,
  };
}

interface SwitchPolicyEngine {
  evaluate(input: PolicyEvaluationInput): PolicyEvaluation;
}

export interface ProviderSwitchApprovalGateOptions {
  readonly store: SqliteStore;
  readonly lifecycle?: LifecycleTransactionService;
  readonly now?: () => string;
  readonly ttlMs?: number;
  readonly policyEngine?: SwitchPolicyEngine;
}

/**
 * Gates one provider switch behind a durable user approval when required.
 * Approval requests are ordinary Runtime Approval requests (category
 * 'custom'): they are listed by the runtime-approvals route and resolved by
 * RuntimeApprovalGate.resolve, which transitions the Run/Stage back to
 * running and continues the Run — the dispatcher then observes the approved
 * unconsumed request through `findApprovedSwitch` and performs the switch.
 */
export class ProviderSwitchApprovalGate {
  private readonly requests: RuntimeApprovalRepository;
  private readonly policyEngine: SwitchPolicyEngine;

  constructor(private readonly options: ProviderSwitchApprovalGateOptions) {
    this.requests = new RuntimeApprovalRepository(options.store.getDatabase());
    this.policyEngine = options.policyEngine
      ?? new PolicyEngine(new PolicyRepository(options.store.getDatabase()), { now: () => this.now() });
  }

  /**
   * Decide whether a switch may proceed. `requireUserApproval=false` always
   * allows. With approval required, a LOW-risk target (launch policy allows
   * and no legacy permission heuristic applies) may switch without a request;
   * a high-risk target must hold a durable approved request; a policy deny
   * fails closed.
   */
  gateSwitch(
    descriptor: ProviderSwitchDescriptor,
    agentSnapshot: AgentSnapshotV1,
    toProviderSnapshot: ProviderConfigurationSnapshotV1,
    requireUserApproval: boolean,
  ): ProviderSwitchGateResult {
    const evaluation = this.evaluateTarget(descriptor, agentSnapshot, toProviderSnapshot);
    if (evaluation.decision === 'deny') {
      return { kind: 'deny', code: 'POLICY_DENIED', message: 'Policy denied the provider fallback switch' };
    }
    const lowRisk = evaluation.decision === 'allow' && !legacyHeuristicRequiresApproval(agentSnapshot);
    if (!requireUserApproval || lowRisk) return { kind: 'allow' };

    const now = this.now();
    const existing = this.requests.findLatestBySourceKey(descriptor.workspaceId, providerSwitchSourceKey(descriptor));
    if (existing !== undefined) {
      if (existing.status === 'approved') {
        if (existing.consumedAt !== null) {
          return { kind: 'deny', code: 'RUNTIME_APPROVAL_EXPIRED', message: 'The switch approval was already consumed' };
        }
        return { kind: 'allow' };
      }
      if (existing.status === 'pending') return { kind: 'wait', requestId: existing.id };
      if (existing.status === 'rejected' || existing.status === 'cancelled') {
        return { kind: 'deny', code: 'RUNTIME_APPROVAL_DENIED', message: 'The provider fallback switch was rejected' };
      }
      return { kind: 'deny', code: 'RUNTIME_APPROVAL_EXPIRED', message: 'The switch approval expired' };
    }
    return this.createRequest(descriptor, agentSnapshot, toProviderSnapshot, now);
  }

  /** Approved, not yet consumed switch request for a Run/Stage, if any. */
  findApprovedSwitch(workspaceId: string, runId: string, stageId: string): RuntimeApprovalRequestRecord | undefined {
    return this.requests.listApprovedUnconsumed().find(record =>
      record.workspaceId === workspaceId
      && record.runId === runId
      && record.stageId === stageId
      && record.sourceKey.startsWith(PROVIDER_SWITCH_SOURCE_KEY_PREFIX));
  }

  /** Marks an approved switch request consumed after the switch committed. */
  consumeSwitch(requestId: string, workspaceId: string): void {
    inTransaction(this.options.store.getDatabase(), () => {
      const current = this.requests.findById(workspaceId, requestId);
      if (!current || current.status !== 'approved' || current.consumedAt !== null) {
        throw new Error('RUNTIME_APPROVAL_STALE: switch approval request is not approved and unconsumed');
      }
      this.requests.markConsumedWithinTransaction({
        workspaceId, id: current.id, expectedVersion: current.version, consumedAt: this.now(),
      });
    });
  }

  private evaluateTarget(
    descriptor: ProviderSwitchDescriptor,
    agentSnapshot: AgentSnapshotV1,
    toProviderSnapshot: ProviderConfigurationSnapshotV1,
  ): PolicyEvaluation {
    try {
      return this.policyEngine.evaluate({
        workspaceId: descriptor.workspaceId,
        action: 'provider.launch',
        agentPermissions: [...agentSnapshot.permissions],
        providerType: toProviderSnapshot.providerType,
        runId: descriptor.runId,
        stageId: descriptor.stageId,
      });
    } catch {
      // Fail closed: an unmeasurable target is high-risk and requires approval.
      return {
        decision: 'require_approval',
        matchedRuleIds: [],
        profileId: 'policy-engine-unavailable',
        evaluatedAt: this.now(),
      };
    }
  }

  private createRequest(
    descriptor: ProviderSwitchDescriptor,
    agentSnapshot: AgentSnapshotV1,
    toProviderSnapshot: ProviderConfigurationSnapshotV1,
    now: string,
  ): ProviderSwitchGateResult {
    const db = this.options.store.getDatabase();
    return inTransaction(db, () => {
      const run = this.options.store.runRepository().findById(descriptor.workspaceId, descriptor.runId);
      const stage = this.options.store.runStageRepository()
        .listByRun(descriptor.workspaceId, descriptor.runId)
        .find(candidate => candidate.id === descriptor.stageId);
      if (!run || !stage || run.status !== 'running' || stage.status !== 'running'
        || stage.attempt !== descriptor.stageAttempt) {
        return { kind: 'deny', code: 'RUNTIME_APPROVAL_STALE', message: 'Run/Stage state changed before the switch approval request' };
      }
      const snapshot = this.options.store.runSnapshotRepository().findByRunId(descriptor.workspaceId, descriptor.runId);
      if (!snapshot) {
        return { kind: 'deny', code: 'RUNTIME_APPROVAL_STALE', message: 'Run snapshot unavailable for the switch approval request' };
      }
      const fingerprint = providerSwitchFingerprint(descriptor);
      const agentHash = hashCanonicalJson(agentSnapshot);
      const providerHash = hashCanonicalJson(toProviderSnapshot);
      const sourceKey = providerSwitchSourceKey(descriptor);
      const safeSnapshot = {
        schemaVersion: 1, policyVersion: POLICY_VERSION,
        action: 'provider.switch',
        workspaceId: descriptor.workspaceId, runId: descriptor.runId, runSnapshotId: snapshot.id,
        stageId: descriptor.stageId, stageAttempt: descriptor.stageAttempt,
        operationId: descriptor.operationId,
        fromProviderConfigId: descriptor.fromProviderConfigId,
        toProviderConfigId: descriptor.toProviderConfigId,
        triggerErrorCode: descriptor.triggerErrorCode,
        attempt: descriptor.attempt,
        agent: { agentId: agentSnapshot.agentId, version: agentSnapshot.version, permissions: agentSnapshot.permissions },
        provider: {
          providerConfigId: toProviderSnapshot.providerConfigId,
          version: toProviderSnapshot.version,
          providerType: toProviderSnapshot.providerType,
          adapterId: toProviderSnapshot.adapterId,
        },
      };
      const snapshotJson = JSON.stringify(safeSnapshot);
      const snapshotHash = hashCanonicalJson(safeSnapshot);
      const latest = this.requests.findLatestBySourceKey(descriptor.workspaceId, sourceKey);
      const request = this.requests.createWithinTransaction({
        id: createEntityId('approval'), workspaceId: descriptor.workspaceId, runId: descriptor.runId,
        runSnapshotId: snapshot.id, stageId: descriptor.stageId, stageAttempt: descriptor.stageAttempt,
        operationId: descriptor.operationId, sourceKey,
        requestRound: latest === undefined ? 1 : latest.requestRound + 1,
        category: 'custom', riskLevel: 'high',
        title: 'Approve provider fallback switch',
        description: `Provider ${descriptor.fromProviderConfigId} failed with ${descriptor.triggerErrorCode}; approve switching to ${descriptor.toProviderConfigId}.`,
        actionFingerprint: fingerprint,
        agentSnapshotHash: agentHash,
        providerSnapshotHash: providerHash,
        launchPlanHash: snapshotHash,
        requestSnapshotJson: snapshotJson, snapshotHash,
        policyVersion: POLICY_VERSION, requestedAt: now,
        expiresAt: new Date(Date.parse(now) + (this.options.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
        createdAt: now, updatedAt: now,
      });
      const lifecycle = (this.options.lifecycle ?? this.options.store.lifecycleTransactionService());
      const approval = lifecycle.requestApprovalWithinTransaction({
        workspaceId: descriptor.workspaceId, runId: descriptor.runId, stageId: descriptor.stageId,
        expectedRunVersion: run.version, expectedStageVersion: stage.version,
        correlationId: descriptor.operationId, causationId: descriptor.operationId,
        approvalRequestId: request.id, category: 'custom', riskLevel: 'high',
        title: request.title, description: request.description,
        requestSummary: { snapshotHash: request.snapshotHash, switchFingerprint: fingerprint },
        expiresAt: request.expiresAt,
      });
      this.requests.linkRequiredEventWithinTransaction({
        workspaceId: descriptor.workspaceId, id: request.id, expectedVersion: request.version,
        eventId: approval.events[0]!.id, now,
      });
      return { kind: 'wait', requestId: request.id };
    });
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
}

/** Emits the public provider.switch Runtime Event for one committed switch. */
export function emitProviderSwitchEvent(
  store: SqliteStore,
  input: ProviderSwitchDescriptor & {
    readonly switchedAt: string;
    readonly approvalRequestId?: string;
    readonly eventContext: RuntimeEventContext;
  },
): void {
  inTransaction(store.getDatabase(), () => {
    store.runtimeEventOutboxWriter().appendWithinTransaction({
      type: 'provider.switch',
      workspaceId: input.workspaceId,
      runId: input.runId,
      stageId: input.stageId,
      timestamp: input.switchedAt,
      source: 'run-engine',
      eventContext: input.eventContext,
      payload: {
        stageAttempt: input.stageAttempt,
        fromProviderConfigId: input.fromProviderConfigId,
        toProviderConfigId: input.toProviderConfigId,
        triggerErrorCode: input.triggerErrorCode,
        attempt: input.attempt,
        switchedAt: input.switchedAt,
        ...(input.approvalRequestId === undefined ? {} : { approvalRequestId: input.approvalRequestId }),
      },
    });
  });
}

/** Pre-policy approval heuristic, retained for legacy-permission parity. */
function legacyHeuristicRequiresApproval(agent: AgentSnapshotV1): boolean {
  return agent.permissions.some(permission => permission === 'write')
    || !agent.permissions.every(permission => permission === 'read' || permission === 'review');
}
