import type {
  DurableAtomicSeam,
  DurableCasConflictKind,
  DurableProcessView,
  DurableSessionView,
  ProcessClaimTransferInput,
  ProcessReservationCreate,
  SessionClaimCreate,
  SessionClaimTransferInput,
} from '@agentos/process-runtime';
import { inTransaction, type TransactionDatabase } from './Transaction.js';
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
import { toDurableProcessView, toDurableSessionView } from './process-runtime-adapters.js';

/**
 * M4-P4 production atomic seam: exactly-one Session claim + root Process
 * reservation committed in ONE database transaction. A failed Process
 * reservation rolls the pair back (Session = 0, Process = 0). Paired claim
 * takeover commits both CASes or rolls the session CAS back; losers never
 * observe a partial pair.
 */
export class DurableAtomicSeamImpl implements DurableAtomicSeam {
  constructor(
    private readonly db: TransactionDatabase,
    private readonly sessionRepository: ProviderSessionRepository,
    private readonly processRepository: ProcessRepository,
  ) {}

  async createSessionAndRootProcess(input: {
    readonly session: SessionClaimCreate;
    readonly process: ProcessReservationCreate;
  }): Promise<{
    readonly session: DurableSessionView;
    readonly process: DurableProcessView;
    readonly joinedExisting: boolean;
    readonly sessionEventId?: string;
    readonly processEventId?: string;
  }> {
    let sessionResult!: { kind: 'created' | 'joined'; session: ProviderSession; eventId?: string };
    let processResult!: { kind: 'created' | 'joined'; process: RuntimeProcess; eventId?: string };
    inTransaction(this.db, () => {
      sessionResult = this.sessionRepository.createSession({
        workspaceId: input.session.workspaceId,
        taskId: input.session.taskId,
        runId: input.session.runId,
        stageId: input.session.stageId,
        stageAttempt: input.session.stageAttempt,
        authorityRole: input.session.authorityRole as 'primary-provider',
        agentId: input.session.agentId,
        providerConfigId: input.session.providerConfigId,
        providerConfigVersion: input.session.providerConfigVersion,
        providerType: input.session.providerType,
        adapterId: input.session.adapterId,
        adapterVersion: input.session.adapterVersion,
        configSchemaVersion: input.session.configSchemaVersion,
        runtimeMode: input.session.runtimeMode,
        claimEpoch: input.session.claimEpoch,
        claimOwnerId: input.session.claimOwnerId ?? null,
        claimLeaseExpiresAt: input.session.claimLeaseExpiresAt ?? null,
        capabilities: input.session.capabilities,
        eventContext: input.session.eventContext,
      });
      processResult = this.processRepository.createProcess({
        workspaceId: input.process.workspaceId,
        taskId: input.process.taskId,
        runId: input.process.runId,
        stageId: input.process.stageId ?? null,
        stageAttempt: input.process.stageAttempt ?? null,
        providerSessionId: input.process.providerSessionId
          ?? (input.process.authorityRole ? sessionResult.session.id : null),
        parentProcessId: input.process.parentProcessId ?? null,
        authorityRole: (input.process.authorityRole ?? null) as 'primary-provider' | null,
        claimEpoch: input.process.claimEpoch,
        claimOwnerId: input.process.claimOwnerId ?? null,
        claimLeaseExpiresAt: input.process.claimLeaseExpiresAt ?? null,
        processType: input.process.processType,
        platform: input.process.platform,
        executableResolved: input.process.executableResolved,
        executableFingerprint: input.process.executableFingerprint ?? null,
        argsRedacted: input.process.argsRedacted,
        cwdResolved: input.process.cwdResolved,
        shell: input.process.shell,
        detached: input.process.detached,
        stdinMode: input.process.stdinMode,
        stdoutMode: input.process.stdoutMode,
        stderrMode: input.process.stderrMode,
        timeoutPolicy: input.process.timeoutPolicy,
        securityProfileRef: input.process.securityProfileRef,
        eventContext: sessionResult.eventId === undefined
          ? input.process.eventContext
          : { ...input.process.eventContext, causationId: sessionResult.eventId },
      });
    });
    return {
      session: toDurableSessionView(sessionResult.session),
      process: toDurableProcessView(processResult.process),
      joinedExisting: processResult.kind === 'joined',
      ...(sessionResult.eventId === undefined ? {} : { sessionEventId: sessionResult.eventId }),
      ...(processResult.eventId === undefined ? {} : { processEventId: processResult.eventId }),
    };
  }

  async casTransferClaimPair(input: {
    readonly session: SessionClaimTransferInput;
    readonly process: ProcessClaimTransferInput;
  }): Promise<
    | {
        readonly kind: 'applied';
        readonly session: DurableSessionView;
        readonly process: DurableProcessView;
        readonly sessionEventId?: string;
        readonly processEventId?: string;
      }
    | {
        readonly kind: 'conflict';
        readonly reason: DurableCasConflictKind;
        readonly session: DurableSessionView;
        readonly process: DurableProcessView;
      }
  > {
    let sessionOutcome: ProviderSessionMutationOutcome | undefined;
    let processOutcome: ProcessMutationOutcome | undefined;
    let failureReason: DurableCasConflictKind | undefined;
    try {
      inTransaction(this.db, () => {
        sessionOutcome = this.sessionRepository.casTransferClaim({
          workspaceId: input.session.workspaceId,
          sessionId: input.session.sessionId,
          expectedVersion: input.session.expectedVersion,
          expectedClaimEpoch: input.session.expectedClaimEpoch,
          expectedClaimOwner: input.session.expectedClaimOwner,
          timestamp: input.session.timestamp,
          newClaimOwner: input.session.newClaimOwner,
          newClaimLeaseExpiresAt: input.session.newClaimLeaseExpiresAt,
          eventContext: input.session.eventContext,
        });
        if (sessionOutcome.kind !== 'applied') {
          failureReason = sessionOutcome.kind as DurableCasConflictKind;
          return;
        }
        processOutcome = this.processRepository.casTransferClaim({
          workspaceId: input.process.workspaceId,
          processId: input.process.processId,
          expectedVersion: input.process.expectedVersion,
          expectedClaimEpoch: input.process.expectedClaimEpoch,
          expectedClaimOwner: input.process.expectedClaimOwner,
          timestamp: input.process.timestamp,
          newClaimOwner: input.process.newClaimOwner,
          newClaimLeaseExpiresAt: input.process.newClaimLeaseExpiresAt,
          eventContext: input.process.eventContext,
        });
        if (processOutcome.kind !== 'applied') {
          failureReason = processOutcome.kind as DurableCasConflictKind;
          throw new PairedTransferConflictError(failureReason);
        }
      });
    } catch (error) {
      if (!(error instanceof PairedTransferConflictError)) throw error;
    }
    if (
      sessionOutcome !== undefined
      && sessionOutcome.kind === 'applied'
      && processOutcome !== undefined
      && processOutcome.kind === 'applied'
    ) {
      return {
        kind: 'applied',
        session: toDurableSessionView(sessionOutcome.session),
        process: toDurableProcessView(processOutcome.process),
        ...(sessionOutcome.eventId === undefined ? {} : { sessionEventId: sessionOutcome.eventId }),
        ...(processOutcome.eventId === undefined ? {} : { processEventId: processOutcome.eventId }),
      };
    }
    const session = this.sessionRepository.findById(input.session.workspaceId, input.session.sessionId);
    const process = this.processRepository.findById(input.process.workspaceId, input.process.processId);
    if (session === undefined || process === undefined) {
      throw new Error('DURABLE_ATOMIC_SEAM_FAILED: transfer pair views are missing');
    }
    return {
      kind: 'conflict',
      reason: failureReason ?? 'fence-conflict',
      session: toDurableSessionView(session),
      process: toDurableProcessView(process),
    };
  }
}

class PairedTransferConflictError extends Error {
  constructor(readonly reason: DurableCasConflictKind) {
    super('PAIRED_TRANSFER_CONFLICT');
    this.name = 'PairedTransferConflictError';
  }
}
