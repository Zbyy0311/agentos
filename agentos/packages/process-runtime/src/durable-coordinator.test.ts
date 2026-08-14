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
import type {
  DurableCasOutcome,
  DurableOutputReferenceRepository,
  DurableOutputReferenceView,
  DurableProcessRepository,
  DurableProcessView,
  DurableSessionRepository,
  DurableSessionView,
  OutputReferenceCreate,
  ProcessReservationCreate,
  SessionClaimCreate,
} from './repository-port.js';

/**
 * M4-P2B package-local integration tests. The fakes below implement the
 * durable ports with the same classified CAS semantics the SQLite
 * repositories expose, so races and compensation are exercised without a
 * database; FileArtifactSink tests prove the append-only restricted sink.
 */

const NOW = '2026-08-13T00:00:00.000Z';

function applyOutcome<T>(
  current: T | undefined,
  expectedVersion: number,
  predicate: () => boolean,
  next: () => T,
): DurableCasOutcome<T> {
  if (current === undefined) return { kind: 'not-found' as const };
  if (!predicate()) return { kind: 'state-mismatch' as const, value: current };
  if ((current as { version: number }).version !== expectedVersion) {
    return { kind: 'version-conflict' as const, value: current };
  }
  return { kind: 'applied' as const, value: next() };
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
    const session: DurableSessionView = {
      sessionId: 'psess_' + Math.random().toString(36).slice(2),
      workspaceId: input.workspaceId,
      runId: input.runId,
      stageId: input.stageId,
      stageAttempt: input.stageAttempt,
      status: 'starting',
      claimEpoch: input.claimEpoch,
      claimOwnerId: input.claimOwnerId,
      adapterStartRequestedAt: null,
      version: 1,
    };
    this.sessions.set(`${input.workspaceId}/${session.sessionId}`, session);
    return { kind: 'created' as const, session };
  }

  async casSetAdapterStartRequested(input: Parameters<DurableSessionRepository['casSetAdapterStartRequested']>[0]) {
    const session = this.sessions.get(`${input.workspaceId}/${input.sessionId}`);
    if (session === undefined) return { kind: 'not-found' as const };
    if (session.adapterStartRequestedAt !== null) {
      return { kind: 'already-requested' as const, value: session };
    }
    return applyOutcome(session, input.expectedVersion, () => session.status === 'starting', () => {
      const next = { ...session, adapterStartRequestedAt: input.timestamp, version: session.version + 1 };
      this.sessions.set(`${input.workspaceId}/${input.sessionId}`, next);
      return next;
    });
  }

  async casSessionTransition(input: Parameters<DurableSessionRepository['casSessionTransition']>[0]) {
    const session = this.sessions.get(`${input.workspaceId}/${input.sessionId}`);
    if (session === undefined) return { kind: 'not-found' as const };
    if (['completed', 'failed', 'cancelled'].includes(session.status)) {
      return { kind: 'terminal' as const, value: session };
    }
    return applyOutcome(session, input.expectedVersion, () => session.status === input.expectedFrom, () => {
      const next = { ...session, status: input.to, version: session.version + 1 };
      this.sessions.set(`${input.workspaceId}/${input.sessionId}`, next);
      return next;
    });
  }

  async getSession(workspaceId: string, sessionId: string) {
    return this.sessions.get(`${workspaceId}/${sessionId}`) ?? null;
  }
}

class FakeProcessRepository implements DurableProcessRepository {
  processes = new Map<string, DurableProcessView>();
  rootClaims = new Map<string, string>();
  failNextCreate = false;

  async createProcessReservation(input: ProcessReservationCreate) {
    if (this.failNextCreate) throw new Error('fake reservation failure');
    if (input.authorityRole !== null) {
      const claimKey = `${input.workspaceId}/${input.runId}/${input.authorityRole}`;
      const existingId = this.rootClaims.get(claimKey);
      const existing = existingId === undefined ? undefined : this.processes.get(existingId);
      if (existing !== undefined) return { kind: 'joined' as const, process: existing };
      const process: DurableProcessView = {
        processId: 'proc_' + Math.random().toString(36).slice(2),
        workspaceId: input.workspaceId,
        runId: input.runId,
        status: 'created',
        claimEpoch: input.claimEpoch,
        claimOwnerId: input.claimOwnerId,
        nativePid: null,
        version: 1,
      };
      this.rootClaims.set(claimKey, `${input.workspaceId}/${process.processId}`);
      this.processes.set(`${input.workspaceId}/${process.processId}`, process);
      return { kind: 'created' as const, process };
    }
    const process: DurableProcessView = {
      processId: 'proc_' + Math.random().toString(36).slice(2),
      workspaceId: input.workspaceId,
      runId: input.runId,
      status: 'created',
      claimEpoch: input.claimEpoch,
      claimOwnerId: input.claimOwnerId,
      nativePid: null,
      version: 1,
    };
    this.processes.set(`${input.workspaceId}/${process.processId}`, process);
    return { kind: 'created' as const, process };
  }

  async casConsumeSpawnRight(input: Parameters<DurableProcessRepository['casConsumeSpawnRight']>[0]) {
    const process = this.processes.get(`${input.workspaceId}/${input.processId}`);
    if (process === undefined) return { kind: 'not-found' as const };
    if (process.status !== 'created') return { kind: 'state-mismatch' as const, value: process };
    return applyOutcome(process, input.expectedVersion, () => process.status === 'created', () => {
      const next = { ...process, status: 'starting' as const, version: process.version + 1 };
      this.processes.set(`${input.workspaceId}/${input.processId}`, next);
      return next;
    });
  }

  async casBindNativeIdentity(input: Parameters<DurableProcessRepository['casBindNativeIdentity']>[0]) {
    const process = this.processes.get(`${input.workspaceId}/${input.processId}`);
    if (process === undefined) return { kind: 'not-found' as const };
    if (process.status !== 'starting' && process.status !== 'stopping') {
      return { kind: 'state-mismatch' as const, value: process };
    }
    return applyOutcome(process, input.expectedVersion, () => true, () => {
      const next = {
        ...process,
        status: process.status === 'starting' ? 'running' as const : process.status,
        nativePid: input.identity.nativePid,
        version: process.version + 1,
      };
      this.processes.set(`${input.workspaceId}/${input.processId}`, next);
      return next;
    });
  }

  async casProcessTransition(input: Parameters<DurableProcessRepository['casProcessTransition']>[0]) {
    const process = this.processes.get(`${input.workspaceId}/${input.processId}`);
    if (process === undefined) return { kind: 'not-found' as const };
    if (process.status === 'exited' || process.status === 'failed') {
      return { kind: 'terminal' as const, value: process };
    }
    return applyOutcome(process, input.expectedVersion, () => process.status === input.expectedFrom, () => {
      const next = { ...process, status: input.to, version: process.version + 1 };
      this.processes.set(`${input.workspaceId}/${input.processId}`, next);
      return next;
    });
  }

  async getProcess(workspaceId: string, processId: string) {
    return this.processes.get(`${workspaceId}/${processId}`) ?? null;
  }
}

class FakeOutputReferenceRepository implements DurableOutputReferenceRepository {
  references = new Map<string, DurableOutputReferenceView>();

  async createReference(input: OutputReferenceCreate) {
    const key = `${input.workspaceId}/${input.processId}/${input.stream}`;
    const existing = this.references.get(key);
    if (existing !== undefined) return { kind: 'joined' as const, reference: existing };
    const reference: DurableOutputReferenceView = {
      processId: input.processId,
      stream: input.stream,
      workspaceId: input.workspaceId,
      runId: input.runId,
      artifactId: 'artifact_' + Math.random().toString(36).slice(2),
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
    const key = `${input.workspaceId}/${input.processId}/${input.stream}`;
    const reference = this.references.get(key);
    if (reference === undefined) return { kind: 'not-found' as const };
    if (reference.finalized) return { kind: 'finalized' as const, value: reference };
    const same = reference.sourceBytesSeen === input.sourceBytesSeen
      && reference.retainedBytes === input.retainedBytes
      && reference.nextSourceOffset === input.nextSourceOffset
      && reference.segmentCount === input.segmentCount
      && reference.truncated === input.truncated;
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
    const key = `${input.workspaceId}/${input.processId}/${input.stream}`;
    const reference = this.references.get(key);
    if (reference === undefined) return { kind: 'not-found' as const };
    if (reference.finalized) return { kind: 'duplicate' as const, value: reference };
    if (reference.version !== input.expectedVersion) {
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
    return this.references.get(`${workspaceId}/${processId}/${stream}`) ?? null;
  }
}

class FakeArtifactSink implements RestrictedArtifactSink {
  readonly artifacts = new Map<string, Uint8Array[]>();

  async open(artifactId: string, storageKey: string) {
    const chunks: Uint8Array[] = [];
    this.artifacts.set(artifactId, chunks);
    return {
      artifactId,
      storageKey,
      append: async (bytes: Uint8Array) => {
        chunks.push(Uint8Array.from(bytes));
      },
      finalize: async () => {
        const all = Buffer.concat(chunks.map((c) => Buffer.from(c)));
        return { sha256: createHash('sha256').update(all).digest('hex'), retainedBytes: all.length };
      },
      abort: async () => {
        this.artifacts.delete(artifactId);
      },
    };
  }
}

function sessionClaim(): SessionClaimCreate {
  return {
    workspaceId: 'ws_m4',
    runId: 'run_m4',
    stageId: 'stage_m4',
    stageAttempt: 1,
    authorityRole: 'primary-provider',
    claimEpoch: 1,
    claimOwnerId: null,
  };
}

function processReservation(session: DurableSessionView): ProcessReservationCreate {
  return {
    workspaceId: session.workspaceId,
    runId: session.runId,
    stageId: session.stageId,
    stageAttempt: session.stageAttempt,
    providerSessionId: session.sessionId,
    parentProcessId: null,
    authorityRole: 'primary-provider',
    claimEpoch: session.claimEpoch,
    claimOwnerId: session.claimOwnerId,
    processType: 'provider',
    platform: 'win32',
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

describe('DurableProcessCoordinator', () => {
  it('establish creates exactly one Session and one root Process; duplicates join', async () => {
    const sessionRepository = new FakeSessionRepository();
    const processRepository = new FakeProcessRepository();
    const coordinator = new DurableProcessCoordinator({
      sessionRepository,
      processRepository,
      outputReferenceRepository: new FakeOutputReferenceRepository(),
      artifactSink: new FakeArtifactSink(),
    });
    const first = await coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation({
        sessionId: 'x',
        workspaceId: 'ws_m4',
        runId: 'run_m4',
        stageId: 'stage_m4',
        stageAttempt: 1,
        status: 'starting',
        claimEpoch: 1,
        claimOwnerId: null,
        adapterStartRequestedAt: null,
        version: 1,
      }),
    });
    expect(first.session.status).toBe('starting');
    expect(first.process.status).toBe('created');
    expect(first.joinedExisting).toBe(false);
    const second = await coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation(first.session),
    });
    expect(second.joinedExisting).toBe(true);
    expect(second.session.sessionId).toBe(first.session.sessionId);
    expect(second.process.processId).toBe(first.process.processId);
    expect(sessionRepository.sessions.size).toBe(1);
    expect(processRepository.processes.size).toBe(1);
  });

  it('durable compensation fails the Session when the Process reservation fails', async () => {
    const sessionRepository = new FakeSessionRepository();
    const processRepository = new FakeProcessRepository();
    processRepository.failNextCreate = true;
    const coordinator = new DurableProcessCoordinator({
      sessionRepository,
      processRepository,
      outputReferenceRepository: new FakeOutputReferenceRepository(),
      artifactSink: new FakeArtifactSink(),
    });
    await expect(coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation({
        sessionId: 'x',
        workspaceId: 'ws_m4',
        runId: 'run_m4',
        stageId: 'stage_m4',
        stageAttempt: 1,
        status: 'starting',
        claimEpoch: 1,
        claimOwnerId: null,
        adapterStartRequestedAt: null,
        version: 1,
      }),
    })).rejects.toThrow('fake reservation failure');
    const session = [...sessionRepository.sessions.values()][0];
    expect(session.status).toBe('failed');
    expect(processRepository.processes.size).toBe(0);
  });

  it('only the winning created->starting CAS calls spawn; losers join without spawning', async () => {
    const sessionRepository = new FakeSessionRepository();
    const processRepository = new FakeProcessRepository();
    const coordinator = new DurableProcessCoordinator({
      sessionRepository,
      processRepository,
      outputReferenceRepository: new FakeOutputReferenceRepository(),
      artifactSink: new FakeArtifactSink(),
    });
    const established = await coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation({
        sessionId: 'x',
        workspaceId: 'ws_m4',
        runId: 'run_m4',
        stageId: 'stage_m4',
        stageAttempt: 1,
        status: 'starting',
        claimEpoch: 1,
        claimOwnerId: null,
        adapterStartRequestedAt: null,
        version: 1,
      }),
    });
    const process = established.process;
    let spawnCalls = 0;
    const spawn = async () => {
      spawnCalls += 1;
      return { nativePid: 4242, nativeParentPid: 4000, nativeStartedAt: NOW };
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
    expect(processRepository.getProcess(process.workspaceId, process.processId)).resolves.toMatchObject({
      status: 'running',
      nativePid: 4242,
    });
  });

  it('spawn failure is durably compensated as process.failed; never respawns', async () => {
    const sessionRepository = new FakeSessionRepository();
    const processRepository = new FakeProcessRepository();
    const coordinator = new DurableProcessCoordinator({
      sessionRepository,
      processRepository,
      outputReferenceRepository: new FakeOutputReferenceRepository(),
      artifactSink: new FakeArtifactSink(),
    });
    const established = await coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation({
        sessionId: 'x',
        workspaceId: 'ws_m4',
        runId: 'run_m4',
        stageId: 'stage_m4',
        stageAttempt: 1,
        status: 'starting',
        claimEpoch: 1,
        claimOwnerId: null,
        adapterStartRequestedAt: null,
        version: 1,
      }),
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
        throw new Error('native spawn exploded');
      },
    });
    expect(spawnCalls).toBe(1);
    expect(result.kind).toBe('spawned');
    const failedProcess = applied(result.outcome);
    expect(failedProcess.status).toBe('failed');
    expect(spawnCalls).toBe(1);
  });

  it('output writer persists only redacted bytes, advances monotonic checkpoints and finalizes', async () => {
    const sessionRepository = new FakeSessionRepository();
    const processRepository = new FakeProcessRepository();
    const outputRepository = new FakeOutputReferenceRepository();
    const sink = new FakeArtifactSink();
    const coordinator = new DurableProcessCoordinator({
      sessionRepository,
      processRepository,
      outputReferenceRepository: outputRepository,
      artifactSink: sink,
    });
    const established = await coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation({
        sessionId: 'x',
        workspaceId: 'ws_m4',
        runId: 'run_m4',
        stageId: 'stage_m4',
        stageAttempt: 1,
        status: 'starting',
        claimEpoch: 1,
        claimOwnerId: null,
        adapterStartRequestedAt: null,
        version: 1,
      }),
    });
    const writer = await coordinator.beginOutput(outputCreate(established.process));
    const sourceBytes = new TextEncoder().encode('RAW-SOURCE-NEVER-PERSISTED').length;
    const redacted = new TextEncoder().encode('hello [REDACTED] world');
    const first = applied(await writer.append({ sourceBytes, bytes: redacted }));
    expect(first.sourceBytesSeen).toBe(sourceBytes);
    expect(first.retainedBytes).toBe(redacted.length);
    expect(first.nextSourceOffset).toBe(sourceBytes);
    expect(first.segmentCount).toBe(1);
    const persisted = Buffer.concat(sink.artifacts.get(writer.reference.artifactId)!);
    expect(persisted.toString('utf8')).toBe('hello [REDACTED] world');
    expect(persisted.toString('utf8')).not.toContain('RAW-SOURCE');
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
    const hash = createHash('sha256')
      .update(Buffer.concat(sink.artifacts.get(writer.reference.artifactId)!))
      .digest('hex');
    expect(finalized.sha256).toBe(hash);
    await expect(writer.append({ sourceBytes: 1, bytes: new Uint8Array([1]) })).rejects.toThrow(/closed/);
  });

  it('truncate marks the reference with a bounded reason and source counts continue', async () => {
    const sessionRepository = new FakeSessionRepository();
    const processRepository = new FakeProcessRepository();
    const coordinator = new DurableProcessCoordinator({
      sessionRepository,
      processRepository,
      outputReferenceRepository: new FakeOutputReferenceRepository(),
      artifactSink: new FakeArtifactSink(),
    });
    const established = await coordinator.establishClaimAndReservation({
      session: sessionClaim(),
      process: processReservation({
        sessionId: 'x',
        workspaceId: 'ws_m4',
        runId: 'run_m4',
        stageId: 'stage_m4',
        stageAttempt: 1,
        status: 'starting',
        claimEpoch: 1,
        claimOwnerId: null,
        adapterStartRequestedAt: null,
        version: 1,
      }),
    });
    const writer = await coordinator.beginOutput(outputCreate(established.process));
    await writer.append({ sourceBytes: 100, bytes: new TextEncoder().encode('abc') });
    const truncated = await writer.truncate('retained-cap');
    expect(truncated.kind).toBe('applied');
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
      await expect(sink.open('artifact_abc', 'sink/ws_m4/out.bin')).rejects.toThrow();
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
