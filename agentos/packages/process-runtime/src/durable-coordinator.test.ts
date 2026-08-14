import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileArtifactSink } from './artifact-sink.js';
import type { RestrictedArtifactSink } from './artifact-sink.js';
import {
  DurableProcessCoordinator,
  OUTPUT_SEGMENT_RETAINED_BYTES,
} from './durable-coordinator.js';
import type { NativeProcessHandle, PlatformProcessDriver } from './driver.js';
import { BoundedProcessStream, type StreamChunk, type StreamName } from './streams.js';
import type {
  DurableAtomicSeam,
  DurableCasConflictKind,
  DurableCasOutcome,
  DurableOutputReferenceRepository,
  DurableOutputReferenceView,
  DurableProcessRepository,
  DurableProcessView,
  DurableSessionRepository,
  DurableSessionView,
  OutputReferenceCreate,
  ProcessClaimTransferInput,
  ProcessReservationCreate,
  SessionClaimCreate,
  SessionClaimTransferInput,
} from './repository-port.js';

/**
 * M4-P2B package-local integration tests. The fakes below implement the
 * durable ports with the same classified CAS semantics the SQLite
 * repositories expose; the atomic seam models one-transaction rollback;
 * FileArtifactSink tests prove the append-only restricted sink. Real-SQLite
 * coordinator integration lives in the server-side repository tests.
 */

const NOW = '2026-08-13T00:00:00.000Z';
const LATER = '2026-08-13T01:00:00.000Z';

function baseSessionView(overrides: Partial<DurableSessionView> = {}): DurableSessionView {
  return {
    sessionId: 'psess_1',
    workspaceId: 'ws_m4',
    taskId: 'task_m4',
    runId: 'run_m4',
    stageId: 'stage_m4',
    stageAttempt: 1,
    authorityRole: 'primary-provider',
    agentId: 'agent_m4',
    providerConfigId: 'pcfg_m4',
    providerConfigVersion: 1,
    providerType: 'kimicode',
    adapterId: 'adapter.cli',
    adapterVersion: '1.0.0',
    configSchemaVersion: 1,
    runtimeMode: 'cli',
    nativeSessionId: null,
    status: 'starting',
    claimEpoch: 1,
    claimOwnerId: null,
    claimLeaseExpiresAt: null,
    adapterStartRequestedAt: null,
    capabilitiesJson: '{}',
    errorCode: null,
    errorDetailRedacted: null,
    startedAt: null,
    lastActivityAt: null,
    completedAt: null,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...overrides,
  };
}

function baseProcessView(overrides: Partial<DurableProcessView> = {}): DurableProcessView {
  return {
    processId: 'proc_1',
    workspaceId: 'ws_m4',
    taskId: 'task_m4',
    runId: 'run_m4',
    stageId: 'stage_m4',
    stageAttempt: 1,
    providerSessionId: 'psess_1',
    parentProcessId: null,
    authorityRole: 'primary-provider',
    claimEpoch: 1,
    claimOwnerId: null,
    claimLeaseExpiresAt: null,
    processType: 'provider',
    platform: 'win32',
    status: 'created',
    executableResolved: 'C:\\bin\\agent.exe',
    executableFingerprint: null,
    argsRedactedJson: '["[REDACTED]"]',
    cwdResolved: 'E:\\ws',
    shell: 0,
    detached: 0,
    stdinMode: 'closed',
    stdoutMode: 'capture',
    stderrMode: 'capture',
    timeoutPolicyJson: '{"graceMs":5000}',
    securityProfileRef: 'secprofile_default',
    nativePid: null,
    nativeParentPid: null,
    nativeStartedAt: null,
    processGroupId: null,
    treeOwnershipMode: null,
    platformHandleId: null,
    recoveryTokenHash: null,
    recoveryClassification: null,
    recoveryEvidenceJson: null,
    recoveryCheckedAt: null,
    recoveryClassifierVersion: null,
    startedAt: null,
    readyAt: null,
    lastActivityAt: null,
    stoppingAt: null,
    exitedAt: null,
    exitCode: null,
    exitSignal: null,
    terminationReason: null,
    cleanupResult: null,
    survivorPidsRedactedJson: null,
    errorCode: null,
    errorDetailRedacted: null,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...overrides,
  };
}

function sessionClaim(): SessionClaimCreate {
  return {
    workspaceId: 'ws_m4',
    taskId: 'task_m4',
    runId: 'run_m4',
    stageId: 'stage_m4',
    stageAttempt: 1,
    authorityRole: 'primary-provider',
    agentId: 'agent_m4',
    providerConfigId: 'pcfg_m4',
    providerConfigVersion: 1,
    providerType: 'kimicode',
    adapterId: 'adapter.cli',
    adapterVersion: '1.0.0',
    configSchemaVersion: 1,
    runtimeMode: 'cli',
    claimEpoch: 1,
    capabilities: { streaming: true },
  };
}

function processReservation(overrides: Partial<ProcessReservationCreate> = {}): ProcessReservationCreate {
  return {
    workspaceId: 'ws_m4',
    taskId: 'task_m4',
    runId: 'run_m4',
    stageId: 'stage_m4',
    stageAttempt: 1,
    providerSessionId: 'psess_1',
    authorityRole: 'primary-provider',
    claimEpoch: 1,
    processType: 'provider',
    platform: 'win32',
    executableResolved: 'C:\\bin\\agent.exe',
    argsRedacted: ['[REDACTED]'],
    cwdResolved: 'E:\\ws',
    shell: 0,
    detached: 0,
    stdinMode: 'closed',
    stdoutMode: 'capture',
    stderrMode: 'capture',
    timeoutPolicy: { graceMs: 5000 },
    securityProfileRef: 'secprofile_default',
    ...overrides,
  };
}

function outputCreate(process: DurableProcessView): OutputReferenceCreate {
  return {
    workspaceId: process.workspaceId,
    runId: process.runId,
    processId: process.processId,
    stream: 'stdout',
    storageKey: 'sink/ws_m4/stdout-' + process.processId,
    contentType: 'text/plain',
    encoding: 'utf-8',
    redactionMode: 'scan',
  };
}

function applied<T>(outcome: DurableCasOutcome<T>): T {
  if (outcome.kind !== 'applied') {
    throw new Error('expected applied outcome, got ' + outcome.kind);
  }
  return outcome.value;
}

function makeHandle(pid: number): NativeProcessHandle {
  const empty = (async function* () {})();
  return {
    pid,
    identity: {
      pid,
      startedAtMs: Date.parse(NOW),
      executablePath: 'C:\\bin\\agent.exe',
      parentPid: 4000,
      groupId: 'g' + pid,
    },
    streams: { stdout: empty, stderr: empty },
    waitExit: async () => ({ exitCode: 0, signal: null, exitedAt: Date.parse(NOW) }),
  };
}

function makeChunk(
  bytes: Uint8Array,
  sourceBytes = bytes.length,
  sourceOffset = 0,
  stream: StreamName = 'stdout',
): StreamChunk {
  return {
    stream,
    sequence: 1,
    sourceOffset,
    sourceBytes,
    bytes,
    text: new TextDecoder('utf-8', { fatal: false }).decode(bytes),
    binary: bytes.includes(0),
  };
}

class FakeSessionRepository implements DurableSessionRepository {
  sessions = new Map<string, DurableSessionView>();
  failNextCreate = false;

  async createSessionClaim(input: SessionClaimCreate) {
    if (this.failNextCreate) throw new Error('fake session failure');
    const existing = [...this.sessions.values()].find((s) => (
      s.workspaceId === input.workspaceId
      && s.runId === input.runId
      && s.stageId === input.stageId
      && s.stageAttempt === input.stageAttempt
    ));
    if (existing !== undefined) return { kind: 'joined' as const, session: existing };
    const session = baseSessionView({
      sessionId: 'psess_' + Math.random().toString(36).slice(2, 12),
      workspaceId: input.workspaceId,
      runId: input.runId,
      stageId: input.stageId,
      stageAttempt: input.stageAttempt,
      claimEpoch: input.claimEpoch,
      claimOwnerId: input.claimOwnerId ?? null,
      claimLeaseExpiresAt: input.claimLeaseExpiresAt ?? null,
    });
    this.sessions.set(input.workspaceId + '/' + session.sessionId, session);
    return { kind: 'created' as const, session };
  }

  remove(sessionId: string): void {
    for (const [key, session] of this.sessions) {
      if (session.sessionId === sessionId) this.sessions.delete(key);
    }
  }

  async casSetAdapterStartRequested(input: Parameters<DurableSessionRepository['casSetAdapterStartRequested']>[0]) {
    const session = this.sessions.get(input.workspaceId + '/' + input.sessionId);
    if (session === undefined) return { kind: 'not-found' as const };
    if (session.adapterStartRequestedAt !== null) {
      return { kind: 'already-requested' as const, value: session };
    }
    if (session.status !== 'starting') return { kind: 'state-mismatch' as const, value: session };
    if (session.version !== input.expectedVersion) {
      return { kind: 'version-conflict' as const, value: session };
    }
    const next = { ...session, adapterStartRequestedAt: input.timestamp, version: session.version + 1 };
    this.sessions.set(input.workspaceId + '/' + input.sessionId, next);
    return { kind: 'applied' as const, value: next };
  }

  async casSessionTransition(input: Parameters<DurableSessionRepository['casSessionTransition']>[0]) {
    const session = this.sessions.get(input.workspaceId + '/' + input.sessionId);
    if (session === undefined) return { kind: 'not-found' as const };
    if (['completed', 'failed', 'cancelled'].includes(session.status)) {
      return { kind: 'terminal' as const, value: session };
    }
    if (session.status !== input.expectedFrom) {
      return { kind: 'state-mismatch' as const, value: session };
    }
    if (session.version !== input.expectedVersion) {
      return { kind: 'version-conflict' as const, value: session };
    }
    const next = { ...session, status: input.to, version: session.version + 1 };
    this.sessions.set(input.workspaceId + '/' + input.sessionId, next);
    return { kind: 'applied' as const, value: next };
  }

  async casTransferClaim(input: SessionClaimTransferInput) {
    const session = this.sessions.get(input.workspaceId + '/' + input.sessionId);
    if (session === undefined) return { kind: 'not-found' as const };
    if (session.status !== 'starting' || session.adapterStartRequestedAt !== null) {
      return { kind: 'state-mismatch' as const, value: session };
    }
    if (session.version !== input.expectedVersion || session.claimEpoch !== input.expectedClaimEpoch) {
      return { kind: 'version-conflict' as const, value: session };
    }
    const next = {
      ...session,
      claimEpoch: session.claimEpoch + 1,
      claimOwnerId: input.newClaimOwner,
      claimLeaseExpiresAt: input.newClaimLeaseExpiresAt,
      version: session.version + 1,
    };
    this.sessions.set(input.workspaceId + '/' + input.sessionId, next);
    return { kind: 'applied' as const, value: next };
  }

  async getSession(workspaceId: string, sessionId: string) {
    return this.sessions.get(workspaceId + '/' + sessionId) ?? null;
  }
}

class FakeProcessRepository implements DurableProcessRepository {
  processes = new Map<string, DurableProcessView>();
  rootClaims = new Map<string, string>();
  failNextCreate = false;
  failNextBind = false;

  async createProcessReservation(input: ProcessReservationCreate) {
    if (this.failNextCreate) throw new Error('fake reservation failure');
    if (input.authorityRole !== null) {
      const claimKey = input.workspaceId + '/' + input.runId + '/' + input.authorityRole;
      const existingId = this.rootClaims.get(claimKey);
      const existing = existingId === undefined ? undefined : this.processes.get(existingId);
      if (existing !== undefined) return { kind: 'joined' as const, process: existing };
      const process = baseProcessView({
        processId: 'proc_' + Math.random().toString(36).slice(2, 12),
        workspaceId: input.workspaceId,
        runId: input.runId,
        claimEpoch: input.claimEpoch,
        claimOwnerId: input.claimOwnerId ?? null,
      });
      this.rootClaims.set(claimKey, input.workspaceId + '/' + process.processId);
      this.processes.set(input.workspaceId + '/' + process.processId, process);
      return { kind: 'created' as const, process };
    }
    const process = baseProcessView({
      processId: 'proc_' + Math.random().toString(36).slice(2, 12),
      workspaceId: input.workspaceId,
      runId: input.runId,
      claimEpoch: input.claimEpoch,
      claimOwnerId: input.claimOwnerId ?? null,
    });
    this.processes.set(input.workspaceId + '/' + process.processId, process);
    return { kind: 'created' as const, process };
  }

  remove(processId: string): void {
    for (const [key, process] of this.processes) {
      if (process.processId === processId) this.processes.delete(key);
    }
  }

  async casConsumeSpawnRight(input: Parameters<DurableProcessRepository['casConsumeSpawnRight']>[0]) {
    const process = this.processes.get(input.workspaceId + '/' + input.processId);
    if (process === undefined) return { kind: 'not-found' as const };
    if (process.status !== 'created') return { kind: 'state-mismatch' as const, value: process };
    if (process.version !== input.expectedVersion) {
      return { kind: 'version-conflict' as const, value: process };
    }
    const next = { ...process, status: 'starting' as const, version: process.version + 1 };
    this.processes.set(input.workspaceId + '/' + input.processId, next);
    return { kind: 'applied' as const, value: next };
  }

  async casBindNativeIdentity(input: Parameters<DurableProcessRepository['casBindNativeIdentity']>[0]) {
    const process = this.processes.get(input.workspaceId + '/' + input.processId);
    if (process === undefined) return { kind: 'not-found' as const };
    if (process.status !== 'starting' && process.status !== 'stopping') {
      return { kind: 'state-mismatch' as const, value: process };
    }
    if (this.failNextBind) return { kind: 'state-mismatch' as const, value: process };
    if (process.version !== input.expectedVersion) {
      return { kind: 'version-conflict' as const, value: process };
    }
    const next = {
      ...process,
      status: process.status === 'starting' ? 'running' as const : process.status,
      nativePid: input.identity.nativePid,
      nativeParentPid: input.identity.nativeParentPid ?? null,
      nativeStartedAt: input.identity.nativeStartedAt,
      processGroupId: input.identity.processGroupId ?? null,
      startedAt: process.status === 'starting' ? input.timestamp : process.startedAt,
      version: process.version + 1,
    };
    this.processes.set(input.workspaceId + '/' + input.processId, next);
    return { kind: 'applied' as const, value: next };
  }

  async casProcessTransition(input: Parameters<DurableProcessRepository['casProcessTransition']>[0]) {
    const process = this.processes.get(input.workspaceId + '/' + input.processId);
    if (process === undefined) return { kind: 'not-found' as const };
    if (process.status === 'exited' || process.status === 'failed') {
      return { kind: 'terminal' as const, value: process };
    }
    if (process.status !== input.expectedFrom) {
      return { kind: 'state-mismatch' as const, value: process };
    }
    if (process.version !== input.expectedVersion) {
      return { kind: 'version-conflict' as const, value: process };
    }
    const next = {
      ...process,
      status: input.to,
      cleanupResult: input.cleanupResult ?? process.cleanupResult,
      errorCode: input.errorCode ?? process.errorCode,
      errorDetailRedacted: input.errorDetailRedacted ?? process.errorDetailRedacted,
      exitedAt: (input.to === 'exited' || input.to === 'failed') ? input.timestamp : process.exitedAt,
      exitCode: input.exitCode ?? process.exitCode,
      version: process.version + 1,
    };
    this.processes.set(input.workspaceId + '/' + input.processId, next);
    return { kind: 'applied' as const, value: next };
  }

  async casTransferClaim(input: ProcessClaimTransferInput) {
    const process = this.processes.get(input.workspaceId + '/' + input.processId);
    if (process === undefined) return { kind: 'not-found' as const };
    if (process.status !== 'created' || process.nativePid !== null) {
      return { kind: 'state-mismatch' as const, value: process };
    }
    if (process.version !== input.expectedVersion || process.claimEpoch !== input.expectedClaimEpoch) {
      return { kind: 'version-conflict' as const, value: process };
    }
    const next = {
      ...process,
      claimEpoch: process.claimEpoch + 1,
      claimOwnerId: input.newClaimOwner,
      claimLeaseExpiresAt: input.newClaimLeaseExpiresAt,
      version: process.version + 1,
    };
    this.processes.set(input.workspaceId + '/' + input.processId, next);
    return { kind: 'applied' as const, value: next };
  }

  async getProcess(workspaceId: string, processId: string) {
    return this.processes.get(workspaceId + '/' + processId) ?? null;
  }
}

class FakeAtomicSeam implements DurableAtomicSeam {
  constructor(
    private readonly sessionRepository: FakeSessionRepository,
    private readonly processRepository: FakeProcessRepository,
  ) {}

  async createSessionAndRootProcess(input: { session: SessionClaimCreate; process: ProcessReservationCreate }) {
    const sessionResult = await this.sessionRepository.createSessionClaim(input.session);
    let processResult;
    try {
      // The seam binds the root Process to the Session created in the same
      // transaction (mirrors the real one-transaction adapter).
      processResult = await this.processRepository.createProcessReservation({
        ...input.process,
        providerSessionId: input.process.providerSessionId
          ?? (input.process.authorityRole ? sessionResult.session.sessionId : null),
      });
    } catch (error) {
      // Atomic rollback: a created Session is removed when the paired
      // Process reservation fails — never a failed-Session substitute.
      if (sessionResult.kind === 'created') {
        this.sessionRepository.remove(sessionResult.session.sessionId);
      }
      throw error;
    }
    return {
      session: sessionResult.session,
      process: processResult.process,
      joinedExisting: processResult.kind === 'joined',
    };
  }

  async casTransferClaimPair(input: {
    session: SessionClaimTransferInput;
    process: ProcessClaimTransferInput;
  }) {
    const sessionCurrent = this.sessionRepository.sessions.get(
      input.session.workspaceId + '/' + input.session.sessionId,
    );
    const processCurrent = this.processRepository.processes.get(
      input.process.workspaceId + '/' + input.process.processId,
    );
    if (sessionCurrent === undefined || processCurrent === undefined) {
      return {
        kind: 'conflict' as const,
        reason: 'not-found' as const,
        session: sessionCurrent ?? baseSessionView(),
        process: processCurrent ?? baseProcessView(),
      };
    }
    const sessionValid = sessionCurrent.status === 'starting'
      && sessionCurrent.adapterStartRequestedAt === null
      && sessionCurrent.version === input.session.expectedVersion
      && sessionCurrent.claimEpoch === input.session.expectedClaimEpoch;
    const processValid = processCurrent.status === 'created'
      && processCurrent.nativePid === null
      && processCurrent.version === input.process.expectedVersion
      && processCurrent.claimEpoch === input.process.expectedClaimEpoch;
    if (!sessionValid || !processValid) {
      const reason: DurableCasConflictKind = !sessionValid
        ? 'fence-conflict'
        : 'version-conflict';
      return {
        kind: 'conflict' as const,
        reason,
        session: sessionCurrent,
        process: processCurrent,
      };
    }
    const sessionNext = {
      ...sessionCurrent,
      claimEpoch: sessionCurrent.claimEpoch + 1,
      claimOwnerId: input.session.newClaimOwner,
      claimLeaseExpiresAt: input.session.newClaimLeaseExpiresAt,
      version: sessionCurrent.version + 1,
    };
    const processNext = {
      ...processCurrent,
      claimEpoch: processCurrent.claimEpoch + 1,
      claimOwnerId: input.process.newClaimOwner,
      claimLeaseExpiresAt: input.process.newClaimLeaseExpiresAt,
      version: processCurrent.version + 1,
    };
    this.sessionRepository.sessions.set(input.session.workspaceId + '/' + input.session.sessionId, sessionNext);
    this.processRepository.processes.set(input.process.workspaceId + '/' + input.process.processId, processNext);
    return { kind: 'applied' as const, session: sessionNext, process: processNext };
  }
}

class FakeDriver implements PlatformProcessDriver {
  terminateResult: Awaited<ReturnType<PlatformProcessDriver['terminateTree']>> = {
      classification: 'complete',
      attemptedMembers: [1],
      errors: [],
    };
  verifyResult: Awaited<ReturnType<PlatformProcessDriver['verifySurvivors']>> = {
    classification: 'complete',
    knownPids: [],
  };
  gracefulStopCalls = 0;
  terminateTreeCalls = 0;
  verifySurvivorsCalls = 0;
  terminateTreeThrows = false;
  verifySurvivorsThrows = false;

  async spawn(): Promise<NativeProcessHandle> {
    throw new Error('unused');
  }
  async gracefulStop() {
    this.gracefulStopCalls += 1;
    return { delivered: true, detail: 'ok' };
  }
  async terminateTree() {
    this.terminateTreeCalls += 1;
    if (this.terminateTreeThrows) throw new Error('terminateTree unavailable');
    return this.terminateResult;
  }
  async verifySurvivors() {
    this.verifySurvivorsCalls += 1;
    if (this.verifySurvivorsThrows) throw new Error('verifySurvivors unavailable');
    return this.verifyResult;
  }
  async inspectIdentity() {
    return { kind: 'match' as const, identity: makeHandle(1).identity };
  }
}

class FakeOutputReferenceRepository implements DurableOutputReferenceRepository {
  references = new Map<string, DurableOutputReferenceView>();
  failNextCheckpoint = false;
  throwNextCheckpoint = false;
  failNextFinalizeVersion: number | null = null;

  async createReference(input: OutputReferenceCreate) {
    const key = input.workspaceId + '/' + input.processId + '/' + input.stream;
    const existing = this.references.get(key);
    if (existing !== undefined) return { kind: 'joined' as const, reference: existing };
    const reference: DurableOutputReferenceView = {
      processId: input.processId,
      stream: input.stream,
      workspaceId: input.workspaceId,
      runId: input.runId,
      artifactId: 'artifact_' + Math.random().toString(36).slice(2, 12),
      storageKey: input.storageKey,
      sourceBytesSeen: 0,
      retainedBytes: 0,
      nextSourceOffset: 0,
      segmentCount: 0,
      truncated: false,
      truncationReason: null,
      finalized: false,
      sha256: null,
      version: 1,
    };
    this.references.set(key, reference);
    return { kind: 'created' as const, reference };
  }

  async checkpoint(input: Parameters<DurableOutputReferenceRepository['checkpoint']>[0]) {
    const key = input.workspaceId + '/' + input.processId + '/' + input.stream;
    const reference = this.references.get(key);
    if (reference === undefined) return { kind: 'not-found' as const };
    if (reference.finalized) return { kind: 'finalized' as const, value: reference };
    if (this.throwNextCheckpoint) {
      this.throwNextCheckpoint = false;
      throw new Error('checkpoint exploded');
    }
    if (this.failNextCheckpoint) {
      this.failNextCheckpoint = false;
      return { kind: 'version-conflict' as const, value: reference };
    }
    const same = reference.sourceBytesSeen === input.sourceBytesSeen
      && reference.retainedBytes === input.retainedBytes
      && reference.nextSourceOffset === input.nextSourceOffset
      && reference.segmentCount === input.segmentCount
      && reference.truncated === input.truncated
      && reference.truncationReason === (input.truncationReason ?? null);
    if (same) return { kind: 'duplicate' as const, value: reference };
    if (reference.version !== input.expectedVersion) {
      return { kind: 'version-conflict' as const, value: reference };
    }
    const regression = input.sourceBytesSeen < reference.sourceBytesSeen
      || input.retainedBytes < reference.retainedBytes
      || input.nextSourceOffset < reference.nextSourceOffset
      || input.segmentCount < reference.segmentCount;
    if (regression) return { kind: 'non-monotonic' as const, value: reference };
    const next: DurableOutputReferenceView = {
      ...reference,
      sourceBytesSeen: input.sourceBytesSeen,
      retainedBytes: input.retainedBytes,
      nextSourceOffset: input.nextSourceOffset,
      segmentCount: input.segmentCount,
      truncated: input.truncated,
      truncationReason: input.truncationReason ?? null,
      version: reference.version + 1,
    };
    this.references.set(key, next);
    return { kind: 'applied' as const, value: next };
  }

  async finalizeReference(input: Parameters<DurableOutputReferenceRepository['finalizeReference']>[0]) {
    const key = input.workspaceId + '/' + input.processId + '/' + input.stream;
    const reference = this.references.get(key);
    if (reference === undefined) return { kind: 'not-found' as const };
    if (reference.finalized) return { kind: 'duplicate' as const, value: reference };
    if (reference.version !== input.expectedVersion) {
      if (this.failNextFinalizeVersion === reference.version) {
        this.failNextFinalizeVersion = null;
      }
      return { kind: 'version-conflict' as const, value: reference };
    }
    if (this.failNextFinalizeVersion === reference.version) {
      this.failNextFinalizeVersion = null;
      return { kind: 'version-conflict' as const, value: reference };
    }
    const next: DurableOutputReferenceView = {
      ...reference,
      finalized: true,
      sha256: input.sha256,
      version: reference.version + 1,
    };
    this.references.set(key, next);
    return { kind: 'applied' as const, value: next };
  }

  async getReference(workspaceId: string, processId: string, stream: 'stdout' | 'stderr') {
    return this.references.get(workspaceId + '/' + processId + '/' + stream) ?? null;
  }
}

class FakeArtifactSink implements RestrictedArtifactSink {
  readonly artifacts = new Map<string, Uint8Array[]>();
  openFailure = false;

  async open(artifactId: string, storageKey: string) {
    if (this.openFailure) throw new Error('sink open exploded');
    const chunks: Uint8Array[] = [];
    this.artifacts.set(artifactId, chunks);
    let finalized = false;
    let finalResult: { sha256: string; retainedBytes: number } | null = null;
    return {
      artifactId,
      storageKey,
      append: async (bytes: Uint8Array) => {
        chunks.push(Uint8Array.from(bytes));
      },
      truncateTo: async (retainedBytes: number) => {
        let total = 0;
        const kept: Uint8Array[] = [];
        for (const chunk of chunks) {
          if (total + chunk.length > retainedBytes) {
            kept.push(chunk.subarray(0, retainedBytes - total));
            total += retainedBytes - total;
            break;
          }
          kept.push(chunk);
          total += chunk.length;
        }
        chunks.length = 0;
        chunks.push(...kept);
      },
      finalize: async () => {
        if (finalized && finalResult !== null) return finalResult;
        const all = Buffer.concat(chunks.map((c) => Buffer.from(c)));
        finalResult = {
          sha256: createHash('sha256').update(all).digest('hex'),
          retainedBytes: all.length,
        };
        finalized = true;
        return finalResult;
      },
      abort: async () => {
        this.artifacts.delete(artifactId);
      },
    };
  }

  bytesOf(artifactId: string): Buffer {
    return Buffer.concat((this.artifacts.get(artifactId) ?? []).map((c) => Buffer.from(c)));
  }
}

function makeCoordinator(
  overrides: {
    sessionRepository?: FakeSessionRepository;
    processRepository?: FakeProcessRepository;
    outputRepository?: FakeOutputReferenceRepository;
    sink?: FakeArtifactSink;
    driver?: FakeDriver;
  } = {},
) {
  const sessionRepository = overrides.sessionRepository ?? new FakeSessionRepository();
  const processRepository = overrides.processRepository ?? new FakeProcessRepository();
  const outputRepository = overrides.outputRepository ?? new FakeOutputReferenceRepository();
  const sink = overrides.sink ?? new FakeArtifactSink();
  const driver = overrides.driver ?? new FakeDriver();
  const coordinator = new DurableProcessCoordinator({
    sessionRepository,
    processRepository,
    outputReferenceRepository: outputRepository,
    artifactSink: sink,
    atomicSeam: new FakeAtomicSeam(sessionRepository, processRepository),
    driver,
  });
  return { sessionRepository, processRepository, outputRepository, sink, driver, coordinator };
}

describe('DurableProcessCoordinator', () => {
  it('establish creates exactly one Session and one root Process atomically; duplicates join', async () => {
    const { sessionRepository, processRepository, coordinator } = makeCoordinator();
    const first = await coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation(),
    });
    expect(first.session.status).toBe('starting');
    expect(first.process.status).toBe('created');
    expect(first.joinedExisting).toBe(false);
    const second = await coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation({ providerSessionId: first.session.sessionId }),
    });
    expect(second.joinedExisting).toBe(true);
    expect(second.session.sessionId).toBe(first.session.sessionId);
    expect(second.process.processId).toBe(first.process.processId);
    expect(sessionRepository.sessions.size).toBe(1);
    expect(processRepository.processes.size).toBe(1);
  });

  it('Process reservation failure rolls back the pair atomically (Session=0, Process=0)', async () => {
    const { sessionRepository, processRepository, coordinator } = makeCoordinator();
    processRepository.failNextCreate = true;
    await expect(coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation(),
    })).rejects.toThrow('fake reservation failure');
    expect(sessionRepository.sessions.size).toBe(0);
    expect(processRepository.processes.size).toBe(0);
  });

  it('paired Session+root takeover commits together and rolls back together', async () => {
    const { coordinator } = makeCoordinator();
    const established = await coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation(),
    });
    const ok = await coordinator.transferClaimPair({
      session: {
        workspaceId: established.session.workspaceId,
        sessionId: established.session.sessionId,
        expectedVersion: established.session.version,
        expectedClaimEpoch: established.session.claimEpoch,
        expectedClaimOwner: established.session.claimOwnerId,
        timestamp: LATER,
        newClaimOwner: 'svc-2',
        newClaimLeaseExpiresAt: '2026-08-13T02:00:00.000Z',
      },
      process: {
        workspaceId: established.process.workspaceId,
        processId: established.process.processId,
        expectedVersion: established.process.version,
        expectedClaimEpoch: established.process.claimEpoch,
        expectedClaimOwner: established.process.claimOwnerId,
        timestamp: LATER,
        newClaimOwner: 'svc-2',
        newClaimLeaseExpiresAt: '2026-08-13T02:00:00.000Z',
      },
    });
    expect(ok.kind).toBe('applied');
    expect(ok.session.claimEpoch).toBe(2);
    expect(ok.process.claimEpoch).toBe(2);
    // A stale/conflicting pair rolls back both.
    const stale = await coordinator.transferClaimPair({
      session: {
        workspaceId: established.session.workspaceId,
        sessionId: established.session.sessionId,
        expectedVersion: 2,
        expectedClaimEpoch: 2,
        expectedClaimOwner: 'svc-2',
        timestamp: LATER,
        newClaimOwner: 'svc-3',
        newClaimLeaseExpiresAt: '2026-08-13T03:00:00.000Z',
      },
      process: {
        workspaceId: established.process.workspaceId,
        processId: established.process.processId,
        expectedVersion: 1,
        expectedClaimEpoch: 1,
        expectedClaimOwner: 'svc-1',
        timestamp: LATER,
        newClaimOwner: 'svc-3',
        newClaimLeaseExpiresAt: '2026-08-13T03:00:00.000Z',
      },
    });
    if (stale.kind !== 'conflict') throw new Error('expected conflict pair outcome');
    expect(stale.reason).toBe('version-conflict');
    // Both remain at the previously committed state (epoch 2 / svc-2).
    expect(stale.session.claimEpoch).toBe(2);
    expect(stale.process.claimEpoch).toBe(2);
  });

  it('only the winning created->starting CAS calls spawn; losers join without spawning', async () => {
    const { coordinator } = makeCoordinator();
    const established = await coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation(),
    });
    const process = established.process;
    let spawnCalls = 0;
    const spawn = async () => {
      spawnCalls += 1;
      return makeHandle(4242);
    };
    const winner = await coordinator.consumeSpawnRightAndSpawn({
      workspaceId: process.workspaceId,
      processId: process.processId,
      expectedVersion: process.version,
      expectedClaimEpoch: process.claimEpoch,
      expectedClaimOwner: process.claimOwnerId,
      timestamp: NOW,
      spawn,
    });
    expect(winner.kind).toBe('spawned');
    const winnerProcess = applied(winner.outcome);
    expect(winnerProcess.status).toBe('running');
    expect(winnerProcess.nativePid).toBe(4242);
    expect(spawnCalls).toBe(1);
    expect(coordinator.retainedHandleCount).toBe(1);
    expect(coordinator.isHandleRetained(process.processId)).toBe(true);
    const loser = await coordinator.consumeSpawnRightAndSpawn({
      workspaceId: process.workspaceId,
      processId: process.processId,
      expectedVersion: process.version,
      expectedClaimEpoch: process.claimEpoch,
      expectedClaimOwner: process.claimOwnerId,
      timestamp: NOW,
      spawn,
    });
    expect(loser.kind).toBe('joined');
    expect(loser.outcome.kind).toBe('state-mismatch');
    expect(spawnCalls).toBe(1);
  });

  it('spawn failure is durably compensated as process.failed with a fixed detail; never respawns', async () => {
    const { coordinator } = makeCoordinator();
    const established = await coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation(),
    });
    const process = established.process;
    let spawnCalls = 0;
    const result = await coordinator.consumeSpawnRightAndSpawn({
      workspaceId: process.workspaceId,
      processId: process.processId,
      expectedVersion: process.version,
      expectedClaimEpoch: process.claimEpoch,
      expectedClaimOwner: process.claimOwnerId,
      timestamp: NOW,
      spawn: async () => {
        spawnCalls += 1;
        throw new Error('native spawn exploded with a secret token');
      },
    });
    expect(spawnCalls).toBe(1);
    expect(result.kind).toBe('spawned');
    const failedProcess = applied(result.outcome);
    expect(failedProcess.status).toBe('failed');
    expect(failedProcess.errorCode).toBe('PROCESS_SPAWN_FAILED');
    expect(failedProcess.errorDetailRedacted).toBe('native spawn failed');
    expect(failedProcess.errorDetailRedacted).not.toContain('secret token');
  });

  it('registration failure runs terminateTree->verifySurvivors; no-survivor terminalizes failed', async () => {
    const { processRepository, driver, coordinator } = makeCoordinator();
    const established = await coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation(),
    });
    const process = established.process;
    processRepository.failNextBind = true;
    const result = await coordinator.consumeSpawnRightAndSpawn({
      workspaceId: process.workspaceId,
      processId: process.processId,
      expectedVersion: process.version,
      expectedClaimEpoch: process.claimEpoch,
      expectedClaimOwner: process.claimOwnerId,
      timestamp: NOW,
      spawn: async () => makeHandle(4242),
    });
    expect(driver.gracefulStopCalls).toBe(1);
    expect(driver.terminateTreeCalls).toBe(1);
    expect(driver.verifySurvivorsCalls).toBe(1);
    const failedProcess = applied(result.outcome);
    expect(failedProcess.status).toBe('failed');
    expect(failedProcess.errorCode).toBe('PROCESS_REGISTRATION_FAILED');
    expect(failedProcess.cleanupResult).toBe('TERMINATED');
    expect(coordinator.retainedHandleCount).toBe(0);
  });

  it('registration failure with survivors stays uncertainty (orphaned), never fake success', async () => {
    const { processRepository, driver, coordinator } = makeCoordinator();
    const established = await coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation(),
    });
    const process = established.process;
    processRepository.failNextBind = true;
    driver.verifyResult = { classification: 'survivors', knownPids: [999] };
    const result = await coordinator.consumeSpawnRightAndSpawn({
      workspaceId: process.workspaceId,
      processId: process.processId,
      expectedVersion: process.version,
      expectedClaimEpoch: process.claimEpoch,
      expectedClaimOwner: process.claimOwnerId,
      timestamp: NOW,
      spawn: async () => makeHandle(4242),
    });
    const uncertain = applied(result.outcome);
    // P1 #orphan semantics: a starting Process with survivors becomes
    // the unknown uncertainty state, never a fake cleanup success.
    expect(uncertain.status).toBe('unknown');
    expect(uncertain.cleanupResult).toBe('SURVIVORS');
    expect(uncertain.errorCode).toBe('PROCESS_REGISTRATION_FAILED');
    expect(coordinator.retainedHandleCount).toBe(0);
  });

  it('cleanup terminateTree throw fails closed as unknown platform uncertainty', async () => {
    const { processRepository, driver, coordinator } = makeCoordinator();
    const established = await coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation(),
    });
    const process = established.process;
    processRepository.failNextBind = true;
    driver.terminateTreeThrows = true;
    const result = await coordinator.consumeSpawnRightAndSpawn({
      workspaceId: process.workspaceId,
      processId: process.processId,
      expectedVersion: process.version,
      expectedClaimEpoch: process.claimEpoch,
      expectedClaimOwner: process.claimOwnerId,
      timestamp: NOW,
      spawn: async () => makeHandle(4242),
    });
    const uncertain = applied(result.outcome);
    expect(uncertain.status).toBe('unknown');
    expect(uncertain.cleanupResult).toBe('UNKNOWN_PLATFORM_UNAVAILABLE');
    expect(uncertain.status).not.toBe('failed');
    expect(driver.verifySurvivorsCalls).toBe(0);
  });

  it('cleanup verifySurvivors throw fails closed as unknown platform uncertainty', async () => {
    const { processRepository, driver, coordinator } = makeCoordinator();
    const established = await coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation(),
    });
    const process = established.process;
    processRepository.failNextBind = true;
    driver.verifySurvivorsThrows = true;
    const result = await coordinator.consumeSpawnRightAndSpawn({
      workspaceId: process.workspaceId,
      processId: process.processId,
      expectedVersion: process.version,
      expectedClaimEpoch: process.claimEpoch,
      expectedClaimOwner: process.claimOwnerId,
      timestamp: NOW,
      spawn: async () => makeHandle(4242),
    });
    const uncertain = applied(result.outcome);
    expect(uncertain.status).toBe('unknown');
    expect(uncertain.cleanupResult).toBe('UNKNOWN_PLATFORM_UNAVAILABLE');
    expect(uncertain.status).not.toBe('failed');
    expect(driver.terminateTreeCalls).toBe(1);
  });

  it('starting x cancel late success binds same identity, stays stopping, cleans up; never running', async () => {
    const { processRepository, driver, coordinator } = makeCoordinator();
    const established = await coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation(),
    });
    const process = established.process;
    let spawnCalls = 0;
    const result = await coordinator.consumeSpawnRightAndSpawn({
      workspaceId: process.workspaceId,
      processId: process.processId,
      expectedVersion: process.version,
      expectedClaimEpoch: process.claimEpoch,
      expectedClaimOwner: process.claimOwnerId,
      timestamp: NOW,
      spawn: async () => {
        spawnCalls += 1;
        // Cancel races during spawn: starting -> stopping before the handle
        // returns, exactly like the P1 starting x cancel schedule.
        const current = await processRepository.getProcess(process.workspaceId, process.processId);
        await processRepository.casProcessTransition({
          workspaceId: process.workspaceId,
          processId: process.processId,
          expectedVersion: current!.version,
          expectedClaimEpoch: current!.claimEpoch,
          expectedClaimOwner: current!.claimOwnerId,
          expectedFrom: 'starting',
          to: 'stopping',
          timestamp: NOW,
        });
        return makeHandle(4242);
      },
    });
    expect(spawnCalls).toBe(1);
    expect(driver.terminateTreeCalls).toBe(1);
    expect(driver.verifySurvivorsCalls).toBe(1);
    const finalProcess = await processRepository.getProcess(process.workspaceId, process.processId);
    expect(finalProcess!.status).toBe('exited');
    expect(finalProcess!.nativePid).toBe(4242);
    expect(finalProcess!.cleanupResult).toBe('TERMINATED');
    expect(finalProcess!.status).not.toBe('running');
    expect(coordinator.retainedHandleCount).toBe(0);
    expect(spawnCalls).toBe(1);
  });

  it('output writer persists only redacted chunk bytes, advances monotonic checkpoints and finalizes', async () => {
    const { outputRepository, sink, coordinator } = makeCoordinator();
    const established = await coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation(),
    });
    const writer = await coordinator.beginOutput(outputCreate(established.process));
    const sourceBytes = 64;
    const redacted = new TextEncoder().encode('hello [REDACTED] world');
    const first = applied(await writer.append(makeChunk(redacted, sourceBytes)));
    expect(first.sourceBytesSeen).toBe(sourceBytes);
    expect(first.retainedBytes).toBe(redacted.length);
    expect(first.nextSourceOffset).toBe(sourceBytes);
    expect(first.segmentCount).toBe(1);
    const persisted = sink.bytesOf(writer.reference.artifactId);
    expect(persisted.toString('utf8')).toBe('hello [REDACTED] world');
    // Replaying the same checkpoint at the same offsets is idempotent.
    const duplicate = await outputRepository.checkpoint({
      workspaceId: first.workspaceId,
      processId: first.processId,
      stream: first.stream,
      expectedVersion: first.version,
      sourceBytesSeen: first.sourceBytesSeen,
      retainedBytes: first.retainedBytes,
      nextSourceOffset: first.nextSourceOffset,
      segmentCount: first.segmentCount,
      truncated: false,
    });
    expect(duplicate.kind).toBe('duplicate');
    expect(duplicate.value!.version).toBe(first.version);
    const finalized = await writer.finalize();
    expect(applied(finalized.outcome).finalized).toBe(true);
    const hash = createHash('sha256').update(sink.bytesOf(writer.reference.artifactId)).digest('hex');
    expect(finalized.sha256).toBe(hash);
    await expect(writer.append(makeChunk(new Uint8Array([1])))).rejects.toThrow(/closed/);
  });

  it('rejects replayed StreamChunk before writing duplicate artifact bytes', async () => {
    const { sink, coordinator } = makeCoordinator();
    const established = await coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation(),
    });
    const writer = await coordinator.beginOutput(outputCreate(established.process));
    const chunk = makeChunk(new TextEncoder().encode('abc'), 3, 0);
    await expect(writer.append(chunk)).resolves.toMatchObject({ kind: 'applied' });
    await expect(writer.append(chunk)).rejects.toThrow(/sourceOffset/);
    expect(sink.bytesOf(writer.reference.artifactId).toString('utf8')).toBe('abc');
    expect(writer.reference.nextSourceOffset).toBe(3);
  });

  it('rejects a sourceOffset gap before the sink is touched', async () => {
    const { sink, coordinator } = makeCoordinator();
    const established = await coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation(),
    });
    const writer = await coordinator.beginOutput(outputCreate(established.process));
    await expect(
      writer.append(makeChunk(new TextEncoder().encode('gap'), 3, 3)),
    ).rejects.toThrow(/sourceOffset/);
    expect(sink.bytesOf(writer.reference.artifactId).length).toBe(0);
    expect(writer.reference.nextSourceOffset).toBe(0);
  });

  it('rejects a stderr StreamChunk on a stdout writer before writing', async () => {
    const { sink, coordinator } = makeCoordinator();
    const established = await coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation(),
    });
    const writer = await coordinator.beginOutput(outputCreate(established.process));
    await expect(
      writer.append(makeChunk(new TextEncoder().encode('err'), 3, 0, 'stderr')),
    ).rejects.toThrow(/stream does not match/);
    expect(sink.bytesOf(writer.reference.artifactId).length).toBe(0);
    expect(writer.reference.nextSourceOffset).toBe(0);
  });

  it('accepts normal continuous source offsets 0 -> N -> M', async () => {
    const { sink, coordinator } = makeCoordinator();
    const established = await coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation(),
    });
    const writer = await coordinator.beginOutput(outputCreate(established.process));
    const first = applied(await writer.append(makeChunk(new TextEncoder().encode('abc'), 3, 0)));
    const second = applied(await writer.append(makeChunk(new TextEncoder().encode('def'), 3, 3)));
    const third = applied(await writer.append(makeChunk(new TextEncoder().encode('ghi'), 3, 6)));
    expect(first.nextSourceOffset).toBe(3);
    expect(second.nextSourceOffset).toBe(6);
    expect(third.nextSourceOffset).toBe(9);
    expect(sink.bytesOf(writer.reference.artifactId).toString('utf8')).toBe('abcdefghi');
  });

  it('raw Uint8Array can never be handed to the writer (StreamChunk seam only)', async () => {
    const { coordinator } = makeCoordinator();
    const established = await coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation(),
    });
    const writer = await coordinator.beginOutput(outputCreate(established.process));
    // @ts-expect-error raw bytes are not a persist-safe StreamChunk
    await expect(writer.append(new Uint8Array([104, 105]))).rejects.toThrow(/StreamChunks/);
  });

  it('retained cap fails closed BEFORE any byte commit', async () => {
    const { sink, coordinator } = makeCoordinator();
    const established = await coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation(),
    });
    const writer = await coordinator.beginOutput(outputCreate(established.process), {
      retainedCapBytes: 8,
    });
    const first = applied(await writer.append(makeChunk(new TextEncoder().encode('abcdefgh'))));
    expect(first.retainedBytes).toBe(8);
    await expect(
      writer.append(makeChunk(new TextEncoder().encode('more'), 4, 8)),
    ).rejects.toThrow(/retained cap exceeded/);
    expect(sink.bytesOf(writer.reference.artifactId).length).toBe(8);
    expect(writer.reference.truncated).toBe(true);
    expect(writer.reference.truncationReason).toBe('retained-cap');
  });

  it('checkpoint conflict reverts the uncommitted sink tail; retry never duplicates bytes', async () => {
    const { outputRepository, sink, coordinator } = makeCoordinator();
    const established = await coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation(),
    });
    const writer = await coordinator.beginOutput(outputCreate(established.process));
    await writer.append(makeChunk(new TextEncoder().encode('first')));
    const before = sink.bytesOf(writer.reference.artifactId).length;
    outputRepository.failNextCheckpoint = true;
    const conflicted = await writer.append(makeChunk(new TextEncoder().encode('-tail'), 5, 5));
    expect(conflicted.kind).toBe('version-conflict');
    // The uncommitted tail was reverted: sink length equals last commit.
    expect(sink.bytesOf(writer.reference.artifactId).length).toBe(before);
    const retry = await writer.append(makeChunk(new TextEncoder().encode('-tail'), 5, 5));
    expect(retry.kind).toBe('applied');
    expect(sink.bytesOf(writer.reference.artifactId).toString('utf8')).toBe('first-tail');
  });

  it('real FileArtifactSink rollback restores file offset and sha256 before retry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentos-real-sink-'));
    const sessionRepository = new FakeSessionRepository();
    const processRepository = new FakeProcessRepository();
    const outputRepository = new FakeOutputReferenceRepository();
    const coordinator = new DurableProcessCoordinator({
      sessionRepository,
      processRepository,
      outputReferenceRepository: outputRepository,
      artifactSink: new FileArtifactSink(root),
      atomicSeam: new FakeAtomicSeam(sessionRepository, processRepository),
      driver: new FakeDriver(),
    });
    try {
      const established = await coordinator.establishClaimAndReservation({
        session: sessionClaim(),
        process: processReservation(),
      });
      const writer = await coordinator.beginOutput(outputCreate(established.process));
      await writer.append(makeChunk(new TextEncoder().encode('first')));
      outputRepository.failNextCheckpoint = true;
      const conflicted = await writer.append(makeChunk(new TextEncoder().encode('-tail'), 5, 5));
      expect(conflicted.kind).toBe('version-conflict');

      const retried = await writer.append(makeChunk(new TextEncoder().encode('-tail'), 5, 5));
      expect(retried.kind).toBe('applied');
      const finalized = await writer.finalize();
      const path = join(root, ...writer.reference.storageKey.split('/'));
      const bytes = readFileSync(path);
      expect(bytes.toString('utf8')).toBe('first-tail');
      expect(finalized.retainedBytes).toBe(bytes.length);
      expect(finalized.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('checkpoint throw reverts the uncommitted sink tail and surfaces the failure', async () => {
    const { outputRepository, sink, coordinator } = makeCoordinator();
    const established = await coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation(),
    });
    const writer = await coordinator.beginOutput(outputCreate(established.process));
    await writer.append(makeChunk(new TextEncoder().encode('first')));
    const before = sink.bytesOf(writer.reference.artifactId).length;
    outputRepository.throwNextCheckpoint = true;
    await expect(
      writer.append(makeChunk(new TextEncoder().encode('-tail'), 5, 5)),
    ).rejects.toThrow(/checkpoint exploded/);
    expect(sink.bytesOf(writer.reference.artifactId).length).toBe(before);
  });

  it('finalize retries a CAS conflict against a fresh version and stores the real sha256', async () => {
    const { outputRepository, sink, coordinator } = makeCoordinator();
    const established = await coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation(),
    });
    const writer = await coordinator.beginOutput(outputCreate(established.process));
    await writer.append(makeChunk(new TextEncoder().encode('abc')));
    // First finalize attempt sees a stale expected version (simulated).
    outputRepository.failNextFinalizeVersion = 2;
    const finalized = await writer.finalize();
    expect(finalized.outcome.kind).toBe('applied');
    expect(finalized.sha256).toBe(
      createHash('sha256').update(sink.bytesOf(writer.reference.artifactId)).digest('hex'),
    );
    const stored = await outputRepository.getReference(
      established.process.workspaceId,
      established.process.processId,
      'stdout',
    );
    expect(stored!.finalized).toBe(true);
    expect(stored!.sha256).toBe(finalized.sha256);
  });

  it('beginOutput surfaces sink open failure while the reference stays consistent (zero counts)', async () => {
    const { outputRepository, sink, coordinator } = makeCoordinator();
    const established = await coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation(),
    });
    sink.openFailure = true;
    await expect(coordinator.beginOutput(outputCreate(established.process))).rejects.toThrow(/sink open exploded/);
    const reference = await outputRepository.getReference(
      established.process.workspaceId,
      established.process.processId,
      'stdout',
    );
    expect(reference!.sourceBytesSeen).toBe(0);
    expect(reference!.retainedBytes).toBe(0);
    expect(reference!.finalized).toBe(false);
  });

  it('raw secrets never reach the sink or the DB; only scanner output is persisted', async () => {
    const { sink, coordinator } = makeCoordinator();
    const established = await coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation(),
    });
    const writer = await coordinator.beginOutput(outputCreate(established.process));
    // Start from RAW secret input and run it through the real P1 scanner
    // (BoundedProcessStream), exactly like the production pipeline.
    const secret = 'hunter2-super-secret';
    const stream = new BoundedProcessStream({
      name: 'stdout',
      secretPatterns: [secret],
    });
    stream.push(new TextEncoder().encode('before ' + secret + ' after'));
    stream.finalize();
    let chunk: StreamChunk | null;
    let lastOutcome: DurableOutputReferenceView | null = null;
    while ((chunk = await stream.next()) !== null) {
      lastOutcome = applied(await writer.append(chunk));
    }
    expect(lastOutcome).not.toBeNull();
    const persisted = sink.bytesOf(writer.reference.artifactId).toString('utf8');
    expect(persisted).toContain('[REDACTED]');
    expect(persisted).not.toContain(secret);
    expect(lastOutcome!.retainedBytes).toBe(persisted.length);
    const finalized = await writer.finalize();
    expect(applied(finalized.outcome).finalized).toBe(true);
    expect(writer.reference.sha256).toBe(
      createHash('sha256').update(sink.bytesOf(writer.reference.artifactId)).digest('hex'),
    );
  });

  it('truncate marks the reference with a bounded reason and source counts continue', async () => {
    const { coordinator } = makeCoordinator();
    const established = await coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation(),
    });
    const writer = await coordinator.beginOutput(outputCreate(established.process));
    await writer.append(makeChunk(new TextEncoder().encode('abc'), 100));
    const truncated = await writer.truncate('retained-cap');
    const truncatedValue = applied(truncated);
    expect(truncatedValue.truncated).toBe(true);
    expect(truncatedValue.truncationReason).toBe('retained-cap');
    expect(truncatedValue.sourceBytesSeen).toBe(100);
  });

  it('segment count derives from the frozen 8 MiB rolling segment cap', () => {
    expect(OUTPUT_SEGMENT_RETAINED_BYTES).toBe(8 * 1024 * 1024);
  });
});

describe('FileArtifactSink', () => {
  it('rejects storage keys that escape the sink root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentos-sink-'));
    try {
      const sink = new FileArtifactSink(root);
      for (const bad of ['../escape', 'a/../../escape', 'C:\\windows', 'a//b', '/abs']) {
        await expect(sink.open('artifact_x', bad)).rejects.toMatchObject({
          code: 'RESTRICTED_STORAGE_KEY_INVALID',
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes append-only bytes, computes the retained sha256 and never overwrites', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentos-sink-'));
    try {
      const sink = new FileArtifactSink(root);
      const session = await sink.open('artifact_abc', 'sink/ws_m4/out.bin');
      await session.append(new TextEncoder().encode('hello '));
      await session.append(new TextEncoder().encode('world'));
      const result = await session.finalize();
      const path = join(root, 'sink', 'ws_m4', 'out.bin');
      const bytes = readFileSync(path);
      expect(bytes.toString('utf8')).toBe('hello world');
      expect(result.retainedBytes).toBe(11);
      expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      // Finalize is idempotent.
      const again = await session.finalize();
      expect(again.sha256).toBe(result.sha256);
      await expect(sink.open('artifact_abc', 'sink/ws_m4/out.bin')).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('truncateTo reverts the uncommitted tail within the open write session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentos-sink-'));
    try {
      const sink = new FileArtifactSink(root);
      const session = await sink.open('artifact_t', 'sink/ws_m4/t.bin');
      await session.append(new TextEncoder().encode('committed'));
      await session.append(new TextEncoder().encode('-tail'));
      await session.truncateTo(9);
      const result = await session.finalize();
      expect(result.retainedBytes).toBe(9);
      const path = join(root, 'sink', 'ws_m4', 't.bin');
      expect(readFileSync(path).toString('utf8')).toBe('committed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('abort removes the partial artifact (compensation)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentos-sink-'));
    try {
      const sink = new FileArtifactSink(root);
      const session = await sink.open('artifact_xyz', 'sink/ws_m4/partial.bin');
      await session.append(new TextEncoder().encode('partial'));
      await session.abort();
      const path = join(root, 'sink', 'ws_m4', 'partial.bin');
      let exists = true;
      try {
        readFileSync(path);
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
