/**
 * M4-P4 production adapters: server SQLite repositories exposed as the
 * Provider-neutral process-runtime Durable*Repository ports. All mutations
 * remain expected-version CAS + claim-fence; losers receive classified
 * outcomes and never retry implicitly.
 */
import type {
  DurableCasOutcome,
  DurableOutputReferenceRepository,
  DurableOutputReferenceView,
  DurableProcessRepository,
  DurableProcessView,
  DurableSessionRepository,
  DurableSessionView,
  OutputReferenceCreate,
  OutputFinalizeInput,
  OutputCheckpointInput,
  ProcessReservationCreate,
  ConsumeSpawnRightInput,
  BindNativeIdentityInput,
  ProcessTransitionInput,
  SessionClaimCreate,
  SessionStartRequestedInput,
  SessionTransitionInput,
} from '@agentos/process-runtime';
import {
  ProviderSessionRepository,
  type ProviderSession,
  type ProviderSessionMutationOutcome,
} from './ProviderSessionRepository.js';
import {
  ProcessRepository,
  type ProcessMutationOutcome,
  type RuntimeProcess,
} from './ProcessRepository.js';
import {
  ProcessOutputReferenceRepository,
  type ProcessOutputReference,
  type OutputReferenceMutationOutcome,
} from './ProcessOutputReferenceRepository.js';

export class DurableSessionRepositoryAdapter implements DurableSessionRepository {
  constructor(private readonly repository: ProviderSessionRepository) {}

  async createSessionClaim(input: SessionClaimCreate): Promise<
    | { readonly kind: 'created'; readonly session: DurableSessionView; readonly eventId?: string }
    | { readonly kind: 'joined'; readonly session: DurableSessionView }
  > {
    const result = this.repository.createSession({
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      runId: input.runId,
      stageId: input.stageId,
      stageAttempt: input.stageAttempt,
      authorityRole: input.authorityRole as 'primary-provider',
      agentId: input.agentId,
      providerConfigId: input.providerConfigId,
      providerConfigVersion: input.providerConfigVersion,
      providerType: input.providerType,
      adapterId: input.adapterId,
      adapterVersion: input.adapterVersion,
      configSchemaVersion: input.configSchemaVersion,
      runtimeMode: input.runtimeMode,
      nativeSessionId: input.nativeSessionId ?? null,
      claimEpoch: input.claimEpoch,
      claimOwnerId: input.claimOwnerId ?? null,
      claimLeaseExpiresAt: input.claimLeaseExpiresAt ?? null,
      capabilities: input.capabilities,
      eventContext: input.eventContext,
    });
    if (result.kind === 'created') {
      return { kind: 'created', session: toDurableSessionView(result.session), ...(result.eventId === undefined ? {} : { eventId: result.eventId }) };
    }
    return { kind: 'joined', session: toDurableSessionView(result.session) };
  }

  async casSetAdapterStartRequested(input: SessionStartRequestedInput): Promise<DurableCasOutcome<DurableSessionView>> {
    return mapSessionOutcome(this.repository.casSetAdapterStartRequested({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      expectedVersion: input.expectedVersion,
      expectedClaimEpoch: input.expectedClaimEpoch,
      expectedClaimOwner: input.expectedClaimOwner,
      timestamp: input.timestamp,
      eventContext: input.eventContext,
    }));
  }

  async casSessionTransition(input: SessionTransitionInput): Promise<DurableCasOutcome<DurableSessionView>> {
    return mapSessionOutcome(this.repository.transitionStatus({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      expectedVersion: input.expectedVersion,
      expectedClaimEpoch: input.expectedClaimEpoch,
      expectedClaimOwner: input.expectedClaimOwner,
      expectedFrom: input.expectedFrom,
      to: input.to,
      timestamp: input.timestamp,
      failureCode: input.failureCode,
      failureDetailRedacted: input.failureDetailRedacted,
      eventContext: input.eventContext,
    }));
  }

  async getSession(workspaceId: string, sessionId: string): Promise<DurableSessionView | null> {
    const session = this.repository.findById(workspaceId, sessionId);
    return session === undefined ? null : toDurableSessionView(session);
  }

  async getSessionByClaimKey(
    workspaceId: string,
    runId: string,
    stageId: string,
    stageAttempt: number,
    authorityRole: string,
  ): Promise<DurableSessionView | null> {
    const session = this.repository.findByClaimKey(
      workspaceId,
      runId,
      stageId,
      stageAttempt,
      authorityRole as 'primary-provider',
    );
    return session === undefined ? null : toDurableSessionView(session);
  }
}

export class DurableProcessRepositoryAdapter implements DurableProcessRepository {
  constructor(private readonly repository: ProcessRepository) {}

  async createProcessReservation(input: ProcessReservationCreate): Promise<
    | { readonly kind: 'created'; readonly process: DurableProcessView; readonly eventId?: string }
    | { readonly kind: 'joined'; readonly process: DurableProcessView }
  > {
    const result = this.repository.createProcess({
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      runId: input.runId,
      stageId: input.stageId ?? null,
      stageAttempt: input.stageAttempt ?? null,
      providerSessionId: input.providerSessionId ?? null,
      parentProcessId: input.parentProcessId ?? null,
      authorityRole: (input.authorityRole ?? null) as 'primary-provider' | null,
      claimEpoch: input.claimEpoch,
      claimOwnerId: input.claimOwnerId ?? null,
      claimLeaseExpiresAt: input.claimLeaseExpiresAt ?? null,
      processType: input.processType,
      platform: input.platform,
      executableResolved: input.executableResolved,
      executableFingerprint: input.executableFingerprint ?? null,
      argsRedacted: input.argsRedacted,
      cwdResolved: input.cwdResolved,
      shell: input.shell,
      detached: input.detached,
      stdinMode: input.stdinMode,
      stdoutMode: input.stdoutMode,
      stderrMode: input.stderrMode,
      timeoutPolicy: input.timeoutPolicy,
      securityProfileRef: input.securityProfileRef,
      eventContext: input.eventContext,
    });
    if (result.kind === 'created') {
      return { kind: 'created', process: toDurableProcessView(result.process), ...(result.eventId === undefined ? {} : { eventId: result.eventId }) };
    }
    return { kind: 'joined', process: toDurableProcessView(result.process) };
  }

  async casConsumeSpawnRight(input: ConsumeSpawnRightInput): Promise<DurableCasOutcome<DurableProcessView>> {
    return mapProcessOutcome(this.repository.casStartProcess({
      workspaceId: input.workspaceId,
      processId: input.processId,
      expectedVersion: input.expectedVersion,
      expectedClaimEpoch: input.expectedClaimEpoch,
      expectedClaimOwner: input.expectedClaimOwner,
      timestamp: input.timestamp,
      eventContext: input.eventContext,
    }));
  }

  async casBindNativeIdentity(input: BindNativeIdentityInput): Promise<DurableCasOutcome<DurableProcessView>> {
    return mapProcessOutcome(this.repository.casBindNativeIdentity({
      workspaceId: input.workspaceId,
      processId: input.processId,
      expectedVersion: input.expectedVersion,
      expectedClaimEpoch: input.expectedClaimEpoch,
      expectedClaimOwner: input.expectedClaimOwner,
      timestamp: input.timestamp,
      nativePid: input.identity.nativePid,
      nativeParentPid: input.identity.nativeParentPid ?? null,
      nativeStartedAt: input.identity.nativeStartedAt,
      nativeBirthIdentity: input.identity.nativeBirthIdentity ?? null,
      processGroupId: input.identity.processGroupId ?? null,
      platformHandleId: input.identity.platformHandleId ?? null,
      // P6-M2a: forward the one-time recovery token (in-transit plaintext);
      // the repository persists only its SHA-256 hash + classifier evidence.
      ...(input.identity.recoveryToken === undefined
        ? {}
        : { recoveryToken: input.identity.recoveryToken }),
      eventContext: input.eventContext,
    }));
  }

  async casProcessTransition(input: ProcessTransitionInput): Promise<DurableCasOutcome<DurableProcessView>> {
    return mapProcessOutcome(this.repository.transitionStatus({
      workspaceId: input.workspaceId,
      processId: input.processId,
      expectedVersion: input.expectedVersion,
      expectedClaimEpoch: input.expectedClaimEpoch,
      expectedClaimOwner: input.expectedClaimOwner,
      expectedFrom: input.expectedFrom,
      to: input.to,
      timestamp: input.timestamp,
      errorCode: input.errorCode ?? null,
      errorDetailRedacted: input.errorDetailRedacted ?? null,
      exitCode: input.exitCode ?? null,
      exitSignal: input.exitSignal ?? null,
      terminationReason: input.terminationReason ?? null,
      cleanupResult: (input.cleanupResult ?? null) as import('@agentos/process-runtime').CleanupResult | null,
      eventContext: input.eventContext,
      gracefulRequested: input.gracefulRequested,
      graceDeadline: input.graceDeadline,
      forceDeadline: input.forceDeadline,
      idempotencyKeyHash: input.idempotencyKeyHash,
      durationMs: input.durationMs,
      graceful: input.graceful,
      force: input.force,
      failureOutcome: input.failureOutcome,
      cancelReason: input.cancelReason,
      cancelCausationId: input.cancelCausationId,
      spawnFailureEvidence: input.spawnFailureEvidence,
    }));
  }

  async getProcess(workspaceId: string, processId: string): Promise<DurableProcessView | null> {
    const process = this.repository.findById(workspaceId, processId);
    return process === undefined ? null : toDurableProcessView(process);
  }

  async getRootProcessByClaim(
    workspaceId: string,
    runId: string,
    stageId: string,
    stageAttempt: number,
    authorityRole: string,
  ): Promise<DurableProcessView | null> {
    const process = this.repository.findByRootClaim(
      workspaceId,
      runId,
      stageId,
      stageAttempt,
      authorityRole as 'primary-provider',
    );
    return process === undefined ? null : toDurableProcessView(process);
  }
}

export class DurableOutputReferenceRepositoryAdapter implements DurableOutputReferenceRepository {
  constructor(private readonly repository: ProcessOutputReferenceRepository) {}

  async createReference(input: OutputReferenceCreate): Promise<
    | { readonly kind: 'created'; readonly reference: DurableOutputReferenceView; readonly eventId?: string }
    | { readonly kind: 'joined'; readonly reference: DurableOutputReferenceView }
  > {
    const result = this.repository.createReference({
      workspaceId: input.workspaceId,
      runId: input.runId,
      processId: input.processId,
      stream: input.stream,
      storageKey: input.storageKey,
      contentType: input.contentType,
      encoding: input.encoding,
      redactionMode: input.redactionMode,
      eventContext: input.eventContext,
    });
    const reference = toDurableOutputReferenceView(result.reference);
    if (result.kind === 'created') {
      return { kind: 'created', reference, ...(result.eventId === undefined ? {} : { eventId: result.eventId }) };
    }
    return { kind: 'joined', reference };
  }

  async checkpoint(input: OutputCheckpointInput): Promise<DurableCasOutcome<DurableOutputReferenceView>> {
    return mapOutputOutcome(this.repository.checkpoint({
      workspaceId: input.workspaceId,
      processId: input.processId,
      stream: input.stream,
      expectedVersion: input.expectedVersion,
      sourceBytesSeen: input.sourceBytesSeen,
      retainedBytes: input.retainedBytes,
      nextSourceOffset: input.nextSourceOffset,
      segmentCount: input.segmentCount,
      truncated: input.truncated,
      truncationReason: input.truncationReason ?? null,
      updatedAt: input.updatedAt,
      eventContext: input.eventContext,
    }));
  }

  async finalizeReference(input: OutputFinalizeInput): Promise<DurableCasOutcome<DurableOutputReferenceView>> {
    return mapOutputOutcome(this.repository.finalizeReference({
      workspaceId: input.workspaceId,
      processId: input.processId,
      stream: input.stream,
      expectedVersion: input.expectedVersion,
      sha256: input.sha256,
      finalizedAt: input.finalizedAt,
      eventContext: input.eventContext,
    }));
  }

  async getReference(workspaceId: string, processId: string, stream: 'stdout' | 'stderr'): Promise<DurableOutputReferenceView | null> {
    const reference = this.repository.findReference(workspaceId, processId, stream);
    return reference === undefined ? null : toDurableOutputReferenceView(reference);
  }
}

export function toDurableSessionView(session: ProviderSession): DurableSessionView {
  return {
    sessionId: session.id,
    workspaceId: session.workspaceId,
    taskId: session.taskId,
    runId: session.runId,
    stageId: session.stageId,
    stageAttempt: session.stageAttempt,
    authorityRole: session.authorityRole,
    agentId: session.agentId,
    providerConfigId: session.providerConfigId,
    providerConfigVersion: session.providerConfigVersion,
    providerType: session.providerType,
    adapterId: session.adapterId,
    adapterVersion: session.adapterVersion,
    configSchemaVersion: session.configSchemaVersion,
    runtimeMode: session.runtimeMode,
    nativeSessionId: session.nativeSessionId,
    status: session.status,
    claimEpoch: session.claimEpoch,
    claimOwnerId: session.claimOwnerId,
    claimLeaseExpiresAt: session.claimLeaseExpiresAt,
    adapterStartRequestedAt: session.adapterStartRequestedAt,
    capabilitiesJson: session.capabilitiesJson,
    errorCode: session.errorCode,
    errorDetailRedacted: session.errorDetailRedacted,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
    completedAt: session.completedAt,
    version: session.version,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    archivedAt: session.archivedAt,
  };
}

export function toDurableProcessView(process: RuntimeProcess): DurableProcessView {
  return {
    processId: process.id,
    workspaceId: process.workspaceId,
    taskId: process.taskId,
    runId: process.runId,
    stageId: process.stageId,
    stageAttempt: process.stageAttempt,
    providerSessionId: process.providerSessionId,
    parentProcessId: process.parentProcessId,
    authorityRole: process.authorityRole,
    claimEpoch: process.claimEpoch,
    claimOwnerId: process.claimOwnerId,
    claimLeaseExpiresAt: process.claimLeaseExpiresAt,
    processType: process.processType,
    platform: process.platform,
    status: process.status,
    executableResolved: process.executableResolved,
    executableFingerprint: process.executableFingerprint,
    argsRedactedJson: process.argsRedactedJson,
    cwdResolved: process.cwdResolved,
    shell: process.shell,
    detached: process.detached,
    stdinMode: process.stdinMode,
    stdoutMode: process.stdoutMode,
    stderrMode: process.stderrMode,
    timeoutPolicyJson: process.timeoutPolicyJson,
    securityProfileRef: process.securityProfileRef,
    nativePid: process.nativePid,
    nativeParentPid: process.nativeParentPid,
    nativeStartedAt: process.nativeStartedAt,
    nativeBirthIdentity: process.nativeBirthIdentity,
    processGroupId: process.processGroupId,
    treeOwnershipMode: process.treeOwnershipMode,
    platformHandleId: process.platformHandleId,
    recoveryTokenHash: process.recoveryTokenHash,
    recoveryClassification: process.recoveryClassification,
    recoveryEvidenceJson: process.recoveryEvidenceJson,
    recoveryCheckedAt: process.recoveryCheckedAt,
    recoveryClassifierVersion: process.recoveryClassifierVersion,
    startedAt: process.startedAt,
    readyAt: process.readyAt,
    lastActivityAt: process.lastActivityAt,
    stoppingAt: process.stoppingAt,
    exitedAt: process.exitedAt,
    exitCode: process.exitCode,
    exitSignal: process.exitSignal,
    terminationReason: process.terminationReason,
    cleanupResult: process.cleanupResult,
    survivorPidsRedactedJson: process.survivorPidsRedactedJson,
    errorCode: process.errorCode,
    errorDetailRedacted: process.errorDetailRedacted,
    version: process.version,
    createdAt: process.createdAt,
    updatedAt: process.updatedAt,
    archivedAt: process.archivedAt,
  };
}

function toDurableOutputReferenceView(reference: ProcessOutputReference): DurableOutputReferenceView {
  return {
    processId: reference.processId,
    stream: reference.stream,
    workspaceId: reference.workspaceId,
    runId: reference.runId,
    artifactId: reference.artifactId,
    storageKey: reference.storageKey,
    sourceBytesSeen: reference.sourceBytesSeen,
    retainedBytes: reference.retainedBytes,
    nextSourceOffset: reference.nextSourceOffset,
    segmentCount: reference.segmentCount,
    truncated: reference.truncated,
    truncationReason: reference.truncationReason,
    finalized: reference.finalized,
    sha256: reference.sha256,
    version: reference.version,
  };
}

function mapSessionOutcome(outcome: ProviderSessionMutationOutcome): DurableCasOutcome<DurableSessionView> {
  if (outcome.kind === 'workspace-mismatch' || outcome.kind === 'not-found') {
    return { kind: outcome.kind } as DurableCasOutcome<DurableSessionView>;
  }
  return {
    kind: outcome.kind,
    value: toDurableSessionView(outcome.session),
    ...(outcome.eventId === undefined ? {} : { eventId: outcome.eventId }),
  } as DurableCasOutcome<DurableSessionView>;
}

function mapProcessOutcome(outcome: ProcessMutationOutcome): DurableCasOutcome<DurableProcessView> {
  if (outcome.kind === 'workspace-mismatch' || outcome.kind === 'not-found') {
    return { kind: outcome.kind } as DurableCasOutcome<DurableProcessView>;
  }
  return {
    kind: outcome.kind,
    value: toDurableProcessView(outcome.process),
    ...(outcome.eventId === undefined ? {} : { eventId: outcome.eventId }),
  } as DurableCasOutcome<DurableProcessView>;
}

function mapOutputOutcome(outcome: OutputReferenceMutationOutcome): DurableCasOutcome<DurableOutputReferenceView> {
  if (outcome.kind === 'workspace-mismatch' || outcome.kind === 'not-found') {
    return { kind: outcome.kind } as DurableCasOutcome<DurableOutputReferenceView>;
  }
  return {
    kind: outcome.kind,
    value: toDurableOutputReferenceView(outcome.reference),
    ...(outcome.eventId === undefined ? {} : { eventId: outcome.eventId }),
  } as DurableCasOutcome<DurableOutputReferenceView>;
}
