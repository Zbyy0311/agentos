/**
 * M4-P4 StageExecutionCoordinator: the exactly-one execution authority for a
 * provider-backed canonical Run/Stage attempt.
 *
 * Chain: exact ProviderRegistry resolution -> Adapter validate +
 * buildLaunchPlan (before claim) -> atomic Session + root Process
 * reservation -> CAS adapterStartRequestedAt -> fenced spawn via Process
 * Runtime -> raw output to artifact reference truth + Adapter parse ->
 * Adapter finalize -> Stage/Run outcome for the existing
 * LifecycleTransactionService. Duplicate dispatch joins the same durable
 * claim and never spawns a second Session/Process/Adapter start.
 *
 * Remediation notes (Independent Review):
 * - stdout and stderr are drained concurrently to avoid pipe backpressure
 *   deadlock; stream bytes remain the raw artifact truth.
 * - each stream uses a persistent streaming TextDecoder so multibyte UTF-8
 *   split across chunks is decoded losslessly.
 * - the durable starting->active Session state is handed to the terminal
 *   path through an execution-local deferred (no module-global map); the
 *   terminal Session CAS outcome is verified and failures fail closed.
 * - identical concurrent validation is coalesced in-flight only.
 */
import { createHash } from 'node:crypto';
import type {
  AgentSnapshotV1,
  ApiProblem,
  ProviderConfigurationSnapshotV1,
  RuntimeEventContext,
} from '@agentos/shared';
import {
  redactArgs,
} from '@agentos/process-runtime';
import type {
  DurableCasOutcome,
  DurableProcessCoordinator,
  DurableProcessView,
  DurableOutputWriter,
  DurableSessionView,
  ExitEvidence,
  NativeProcessHandle,
  PlatformProcessDriver,
  ProcessCleanupDisposition,
  ProcessStopOrigin,
  ProcessStopTicket,
  ProcessStopResult,
  ProcessProbePort,
  ValidatedLaunch,
} from '@agentos/process-runtime';
import {
  ProviderRegistry,
  resolveFrozenProviderIdentity,
} from '@agentos/agent-core/providers';
import type {
  ProviderConfigurationInput,
  ProviderLaunchPlan,
  ProviderNormalizedEvent,
  ProviderParseContext,
  ProviderValidationResult,
  RuntimeProviderAdapter,
} from '@agentos/agent-core/providers';
import type { DurableSessionRepositoryAdapter } from '../../store/process-runtime-adapters.js';

export interface StageExecutionInput {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly stageAttempt: number;
  readonly workflowStageKey: string;
  readonly agentSnapshot: AgentSnapshotV1;
  readonly providerSnapshot: ProviderConfigurationSnapshotV1;
  readonly workspaceRoot: string;
  readonly worktreePath?: string;
  readonly prompt: string;
  readonly operationId: string;
}

export type StageExecutionOutcome =
  | { readonly kind: 'active' }
  | {
      readonly kind: 'completed';
      readonly durationMs: number;
      readonly artifactIds: string[];
      readonly outputContractSatisfied: boolean;
      readonly output?: string;
    }
  | {
      readonly kind: 'stopped';
      readonly cleanup: ProcessCleanupDisposition | null;
      readonly proven: boolean;
      readonly stopOrigin: ProcessStopOrigin;
    }
  | { readonly kind: 'failed'; readonly problem: ApiProblem; readonly phase: string };

export interface StageAttemptCancelInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly stageAttempt: number;
  readonly correlationId: string;
  readonly causationId: string;
}

export type StageStopOutcome = Extract<StageExecutionOutcome, { readonly kind: 'stopped' }>;

export interface StageExecutionCoordinatorOptions {
  readonly registry: ProviderRegistry;
  readonly durableCoordinator: DurableProcessCoordinator;
  readonly sessionRepository: DurableSessionRepositoryAdapter;
  readonly driver: PlatformProcessDriver;
  readonly probe: ProcessProbePort;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly claimOwner?: string;
  readonly claimLeaseMs?: number;
  readonly now?: () => string;
  readonly stderrRetainedBytes?: number;
}

const DEFAULT_CLAIM_OWNER = 'run-engine';
const DEFAULT_CLAIM_LEASE_MS = 60_000;
const MAX_STDERR_RETAINED_BYTES = 256 * 1024;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type AttemptDisposition =
  | { readonly kind: 'natural'; readonly exit: ExitEvidence; readonly durationMs: number }
  | { readonly kind: 'stop'; readonly stop: ProcessStopResult; readonly stopOrigin: ProcessStopOrigin }
  | { readonly kind: 'startup-failure' }
  | { readonly kind: 'runtime-failure'; readonly error: unknown }
  | { readonly kind: 'p4-activation-failure'; readonly stop: ProcessStopResult };

interface LiveAttemptRendezvous {
  readonly key: string;
  readonly input: StageExecutionInput;
  readonly adapter: RuntimeProviderAdapter;
  readonly eventContext: RuntimeEventContext;
  readonly sessionId: string;
  readonly processId: string;
  readonly stdoutWriter: DurableOutputWriter;
  readonly stderrWriter: DurableOutputWriter;
  readonly final: Deferred<StageExecutionOutcome>;
  readonly captureStop: Deferred<void>;
  readonly parserContext: ProviderParseContext;
  readonly parsedEvents: ProviderNormalizedEvent[];
  readonly startedAtMs: number;
  handle?: NativeProcessHandle;
  stderrText: string;
  captureStopped: boolean;
  stdoutDrain?: Promise<void>;
  stderrDrain?: Promise<void>;
  stdoutDecoder?: TextDecoder;
  stderrDecoder?: TextDecoder;
  parserFinished?: boolean;
  finalizationPromise?: Promise<StageExecutionOutcome>;
  stopRequestPromise?: Promise<ProcessStopTicket>;
  stopAccepted: boolean;
  cleanupAuthorizationPromise?: Promise<void>;
  stopOrigin?: ProcessStopOrigin;
  naturalDisposition?: Extract<AttemptDisposition, { readonly kind: 'natural' }>;
}

export class StageExecutionCoordinator {
  private readonly registry: ProviderRegistry;
  private readonly durableCoordinator: DurableProcessCoordinator;
  private readonly sessionRepository: DurableSessionRepositoryAdapter;
  private readonly driver: PlatformProcessDriver;
  private readonly probe: ProcessProbePort;
  private readonly environment: Readonly<Record<string, string | undefined>> | undefined;
  private readonly claimOwner: string;
  private readonly claimLeaseMs: number;
  private readonly now: () => string;
  private readonly stderrRetainedBytes: number;
  private readonly inFlightValidation = new Map<string, Promise<ProviderValidationResult>>();
  private readonly liveAttempts = new Map<string, LiveAttemptRendezvous>();

  constructor(options: StageExecutionCoordinatorOptions) {
    this.registry = options.registry;
    this.durableCoordinator = options.durableCoordinator;
    this.sessionRepository = options.sessionRepository;
    this.driver = options.driver;
    this.probe = options.probe;
    this.environment = options.environment;
    this.claimOwner = options.claimOwner ?? DEFAULT_CLAIM_OWNER;
    this.claimLeaseMs = options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
    this.now = options.now ?? (() => new Date().toISOString());
    this.stderrRetainedBytes = options.stderrRetainedBytes ?? MAX_STDERR_RETAINED_BYTES;
  }

  async execute(input: StageExecutionInput): Promise<StageExecutionOutcome> {
    const configuration = configurationFromSnapshot(input.providerSnapshot);
    const frozen = resolveFrozenProviderIdentity(configuration);
    if (frozen === undefined) {
      return this.failed('PROVIDER_ADAPTER_NOT_FOUND', 'Exact provider adapter identity could not be resolved', 'validation', input, false);
    }
    let adapter: RuntimeProviderAdapter;
    try {
      adapter = this.registry.get(frozen.adapterId, frozen.adapterVersion);
    } catch (error) {
      return this.failedFromError(error, 'validation', input);
    }
    const validation = await this.validateInFlight(input, adapter, configuration);
    if (!validation.valid) {
      const first = validation.errors[0];
      return this.failed(first.code, first.message, first.phase, input, first.retryable);
    }
    let plan: ProviderLaunchPlan;
    try {
      plan = await adapter.buildLaunchPlan({
        configuration,
        workspaceRoot: input.workspaceRoot,
        worktreePath: input.worktreePath,
        prompt: input.prompt,
        environment: this.environment,
      });
    } catch (error) {
      return this.failedFromError(error, 'startup', input);
    }

    const eventContext: RuntimeEventContext = {
      correlationId: input.operationId,
      causationId: input.operationId,
    };
    const claimLeaseExpiresAt = new Date(Date.parse(this.now()) + this.claimLeaseMs).toISOString();
    const established = await this.durableCoordinator.establishClaimAndReservation({
      session: {
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        runId: input.runId,
        stageId: input.stageId,
        stageAttempt: input.stageAttempt,
        authorityRole: 'primary-provider',
        agentId: input.agentSnapshot.agentId,
        providerConfigId: input.providerSnapshot.providerConfigId,
        providerConfigVersion: input.providerSnapshot.version,
        providerType: input.providerSnapshot.providerType,
        adapterId: frozen.adapterId,
        adapterVersion: frozen.adapterVersion,
        configSchemaVersion: adapter.manifest.configSchemaVersion,
        runtimeMode: plan.runtimeMode,
        claimEpoch: 1,
        claimOwnerId: this.claimOwner,
        claimLeaseExpiresAt,
        capabilities: input.providerSnapshot.capabilities,
        eventContext,
      },
      process: {
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        runId: input.runId,
        stageId: input.stageId,
        stageAttempt: input.stageAttempt,
        authorityRole: 'primary-provider',
        claimEpoch: 1,
        claimOwnerId: this.claimOwner,
        claimLeaseExpiresAt,
        processType: 'provider',
        platform: process.platform,
        executableResolved: plan.executable,
        executableFingerprint: sha256Hex(plan.executable),
        argsRedacted: redactArgs(plan.args),
        cwdResolved: plan.cwd,
        shell: 0,
        detached: 0,
        stdinMode: plan.stdinMode === 'none' ? 'closed' : 'pipe',
        stdoutMode: 'capture',
        stderrMode: 'capture',
        timeoutPolicy: { graceMs: input.providerSnapshot.timeoutPolicy.cancelGracePeriodMs },
        securityProfileRef: 'secprofile_default',
        eventContext,
      },
    });
    if (established.joinedExisting) {
      return { kind: 'active' };
    }

    const startRequested = await this.sessionRepository.casSetAdapterStartRequested({
      workspaceId: input.workspaceId,
      sessionId: established.session.sessionId,
      expectedVersion: established.session.version,
      expectedClaimEpoch: established.session.claimEpoch,
      expectedClaimOwner: established.session.claimOwnerId,
      timestamp: this.now(),
      eventContext,
    });
    if (startRequested.kind !== 'applied') {
      return { kind: 'active' };
    }

    let stdoutWriter: DurableOutputWriter | undefined;
    let stderrWriter: DurableOutputWriter | undefined;
    try {
      stdoutWriter = await this.durableCoordinator.beginOutput({
        workspaceId: input.workspaceId,
        runId: input.runId,
        processId: established.process.processId,
        stream: 'stdout',
        storageKey: 'sink/' + input.workspaceId + '/stdout/' + established.process.processId,
        contentType: 'text/plain',
        encoding: 'utf-8',
        redactionMode: 'scan',
        eventContext,
      });
      stderrWriter = await this.durableCoordinator.beginOutput({
        workspaceId: input.workspaceId,
        runId: input.runId,
        processId: established.process.processId,
        stream: 'stderr',
        storageKey: 'sink/' + input.workspaceId + '/stderr/' + established.process.processId,
        contentType: 'text/plain',
        encoding: 'utf-8',
        redactionMode: 'scan',
        eventContext,
      });
    } catch {
      await this.abortWriters(stdoutWriter, stderrWriter);
      await this.failBeforeSpawn(input, established.session.sessionId, established.process);
      return this.failed('PROVIDER_INTERNAL_ERROR', 'Provider output initialization failed', 'startup', input, false);
    }

    const currentSession = await this.sessionRepository.getSession(input.workspaceId, established.session.sessionId);
    const currentProcess = await this.durableCoordinator.getProcess(input.workspaceId, established.process.processId);
    if (
      currentSession === null
      || currentProcess === null
      || !sameSessionClaim(currentSession, established.session)
      || !sameProcessClaim(currentProcess, established.process)
      || currentSession.status !== 'starting'
      || currentProcess.status !== 'created'
    ) {
      await this.abortWriters(stdoutWriter, stderrWriter);
      await this.failBeforeSpawn(input, established.session.sessionId, currentProcess ?? established.process);
      return this.failed('LIVE_EXECUTION_UNAVAILABLE', 'Provider process authority is no longer startable', 'startup', input, false);
    }

    const entry: LiveAttemptRendezvous = {
      key: attemptKey(input),
      input,
      adapter,
      eventContext,
      sessionId: established.session.sessionId,
      processId: established.process.processId,
      stdoutWriter,
      stderrWriter,
      final: deferred<StageExecutionOutcome>(),
      captureStop: deferred<void>(),
      parserContext: (adapter as unknown as { createParseContext(): ProviderParseContext }).createParseContext(),
      parsedEvents: [],
      startedAtMs: Date.parse(this.now()),
      stderrText: '',
      captureStopped: false,
      stopAccepted: false,
    };
    this.liveAttempts.set(entry.key, entry);

    // Keep this call adjacent to registration: cancellation can observe the
    // live entry before the one spawn right is consumed, with no await in
    // between that would create a reconstruction window.
    const spawnedPromise = this.durableCoordinator.consumeSpawnRightAndSpawn({
      workspaceId: input.workspaceId,
      processId: established.process.processId,
      expectedVersion: established.process.version,
      expectedClaimEpoch: established.process.claimEpoch,
      expectedClaimOwner: established.process.claimOwnerId,
      timestamp: this.now(),
      eventContext,
      onAcceptedStop: ticket => this.authorizeAcceptedStop(
        entry,
        ticket,
        entry.stopOrigin ?? 'EXPLICIT_CANCEL',
      ),
      spawn: async () => {
        const launch: ValidatedLaunch = {
          executable: plan.executable,
          args: [...plan.args],
          cwd: plan.cwd,
          env: { ...plan.environment },
          envDiagnostics: [],
          shell: false,
        };
        const handle = await this.driver.spawn(launch);
        entry.handle = handle;
        return handle;
      },
    });
    const spawned = await spawnedPromise;
    const spawnSucceeded = spawned.kind === 'spawned'
      && spawned.outcome.kind === 'applied'
      && spawned.outcome.value.status === 'running';
    if (!spawnSucceeded) {
      const current = await this.durableCoordinator.getProcess(input.workspaceId, established.process.processId);
      if (entry.stopRequestPromise === undefined && current?.status === 'stopping') {
        await this.stopEntry(entry, 'EXPLICIT_CANCEL');
      } else if (entry.stopRequestPromise === undefined) {
        await this.finalizeAttemptOnce(entry, { kind: 'startup-failure' });
      } else {
        await this.stopEntry(entry, entry.stopOrigin ?? 'EXPLICIT_CANCEL');
      }
      return entry.final.promise;
    }

    const active = await this.sessionRepository.casSessionTransition({
        workspaceId: input.workspaceId,
        sessionId: established.session.sessionId,
        expectedVersion: currentSession.version,
        expectedClaimEpoch: established.session.claimEpoch,
        expectedClaimOwner: established.session.claimOwnerId,
        expectedFrom: 'starting',
        to: 'active',
        timestamp: this.now(),
        eventContext,
    });
    if (active.kind === 'applied') {
      void this.runToFinal(entry);
    } else if (entry.stopRequestPromise === undefined) {
      await this.stopEntry(entry, 'P4_ACTIVATION_FAILURE');
    }
    // This only joins an in-flight request; stopEntry decides ownership from
    // the ticket's durable stopAccepted result, never from Promise presence.
    if (entry.stopRequestPromise !== undefined) await this.stopEntry(entry, entry.stopOrigin ?? 'EXPLICIT_CANCEL');
    return entry.final.promise;
  }

  async cancelAttempt(input: StageAttemptCancelInput): Promise<StageExecutionOutcome> {
    const session = await this.sessionRepository.getSessionByClaimKey(
      input.workspaceId,
      input.runId,
      input.stageId,
      input.stageAttempt,
      'primary-provider',
    );
    const process = await this.durableCoordinator.getRootProcessByClaim(
      input.workspaceId,
      input.runId,
      input.stageId,
      input.stageAttempt,
      'primary-provider',
    );
    if (
      session === null
      || process === null
      || session.workspaceId !== input.workspaceId
      || session.runId !== input.runId
      || session.stageId !== input.stageId
      || session.stageAttempt !== input.stageAttempt
      || process.workspaceId !== input.workspaceId
      || process.runId !== input.runId
      || process.stageId !== input.stageId
      || process.stageAttempt !== input.stageAttempt
      || process.authorityRole !== 'primary-provider'
    ) {
      throw new Error('LIVE_EXECUTION_UNAVAILABLE: exact Stage-attempt claim is unavailable');
    }

    const entry = this.liveAttempts.get(inputKey(input));
    if (process.status === 'created') {
      const ticket = await this.durableCoordinator.processCancelCoordinator.acceptStop({
        workspaceId: process.workspaceId,
        processId: process.processId,
        expectedClaimEpoch: process.claimEpoch,
        expectedClaimOwner: process.claimOwnerId,
        reason: 'cancel',
        idempotencyKey: 'attempt-cancel:' + inputKey(input),
        timestamp: this.now(),
        eventContext: { correlationId: input.correlationId, causationId: input.causationId },
        stopOrigin: 'EXPLICIT_CANCEL',
      });
      const stopped = await ticket.result;
      await this.failSessionIfNonTerminal(session, input, 'PROVIDER_CANCELLED_BEFORE_START');
      return stoppedOutcome(stopped, 'EXPLICIT_CANCEL');
    }
    if (entry === undefined) {
      throw new Error('LIVE_EXECUTION_UNAVAILABLE: exact live Stage-attempt rendezvous is unavailable');
    }
    await this.stopEntry(entry, 'EXPLICIT_CANCEL', input.correlationId, input.causationId);
    return entry.final.promise;
  }

  private async validateInFlight(
    input: StageExecutionInput,
    adapter: RuntimeProviderAdapter,
    configuration: ProviderConfigurationInput,
  ): Promise<ProviderValidationResult> {
    const key = [
      input.workspaceId,
      input.runId,
      input.stageId,
      String(input.stageAttempt),
      input.providerSnapshot.providerConfigId,
      String(input.providerSnapshot.version),
      adapter.manifest.id,
      adapter.manifest.version,
    ].join('|');
    const existing = this.inFlightValidation.get(key);
    if (existing !== undefined) return existing;
    const promise = adapter.validate({
      configuration,
      probe: this.probe,
      environment: this.environment,
    }).finally(() => {
      this.inFlightValidation.delete(key);
    });
    this.inFlightValidation.set(key, promise);
    return promise;
  }

  private async runToFinal(entry: LiveAttemptRendezvous): Promise<void> {
    const handle = entry.handle;
    if (handle === undefined) return;
    const stdoutDecoder = new TextDecoder('utf-8');
    const stderrDecoder = new TextDecoder('utf-8');
    entry.stdoutDecoder = stdoutDecoder;
    entry.stderrDecoder = stderrDecoder;
    entry.stdoutDrain = this.drainStdout(entry, stdoutDecoder);
    entry.stderrDrain = this.drainStderr(entry, stderrDecoder);
    try {
      const observed = await Promise.race([
        handle.waitExit().then(exit => ({ kind: 'exit' as const, exit })),
        entry.captureStop.promise.then(() => ({ kind: 'stop' as const })),
      ]);
      if (observed.kind === 'stop') {
        await Promise.allSettled([entry.stdoutDrain, entry.stderrDrain]);
        return;
      }
      await Promise.all([entry.stdoutDrain, entry.stderrDrain]);
      if (entry.captureStopped || entry.stopAccepted) return;

      this.finishParserTail(entry);

      const processView = await this.durableCoordinator.getProcess(entry.input.workspaceId, entry.processId);
      if (processView === null) throw new Error('PROCESS_EXITED: process claim disappeared');
      if (processView.status === 'stopping') {
        await this.stopEntry(entry, stopOriginFromReason(processView.terminationReason));
        return;
      }
      const durationMs = Math.max(0, Date.parse(this.now()) - entry.startedAtMs);
      const procOutcome = await this.durableCoordinator.transitionProcess({
        workspaceId: entry.input.workspaceId,
        processId: processView.processId,
        expectedVersion: processView.version,
        expectedClaimEpoch: processView.claimEpoch,
        expectedClaimOwner: processView.claimOwnerId,
        expectedFrom: 'running',
        to: 'exited',
        timestamp: this.now(),
        exitCode: observed.exit.exitCode,
        exitSignal: observed.exit.signal,
        terminationReason: observed.exit.exitCode === 0 ? null : 'non-zero-exit',
        cleanupResult: null,
        durationMs,
        graceful: false,
        force: false,
        eventContext: entry.eventContext,
      });
      if (procOutcome.kind !== 'applied' && procOutcome.kind !== 'terminal') {
        const current = await this.durableCoordinator.getProcess(entry.input.workspaceId, entry.processId);
        if (current?.status === 'stopping') {
          await this.stopEntry(entry, stopOriginFromReason(current.terminationReason));
          return;
        }
        throw new Error('PROCESS_EXITED: durable Process terminal CAS failed');
      }
      const terminalProcess = procOutcome.value ?? await this.durableCoordinator.getProcess(entry.input.workspaceId, entry.processId);
      if (terminalProcess?.status === 'stopping') {
        await this.stopEntry(entry, stopOriginFromReason(terminalProcess.terminationReason));
        return;
      }
      entry.naturalDisposition = { kind: 'natural', exit: observed.exit, durationMs };
      await this.finalizeAttemptOnce(entry, entry.naturalDisposition);
    } catch (error) {
      if (entry.stopAccepted) return;
      await this.finalizeAttemptOnce(entry, { kind: 'runtime-failure', error });
    }
  }

  private async drainStdout(entry: LiveAttemptRendezvous, decoder: TextDecoder): Promise<void> {
    const handle = entry.handle;
    if (handle === undefined) return;
    const iterator = handle.streams.stdout[Symbol.asyncIterator]();
    let offset = 0;
    for (;;) {
      const nextPromise = iterator.next().then(result => ({ kind: 'next' as const, result }));
      const winner = await Promise.race([
        nextPromise,
        entry.captureStop.promise.then(() => ({ kind: 'stop' as const })),
      ]);
      if (winner.kind === 'stop') {
        try { void iterator.return?.(); } catch { /* best effort interruption */ }
        return;
      }
      if (winner.result.done || entry.captureStopped) return;
      const bytes = toBytes(winner.result.value);
      const text = decoder.decode(bytes, { stream: true });
      if (text.length > 0) {
        entry.parsedEvents.push(...entry.adapter.parseChunk(text, entry.parserContext).events);
      }
      if (entry.captureStopped) return;
      offset += bytes.length;
      const outcome = await entry.stdoutWriter.append({
        stream: 'stdout',
        sequence: offset,
        sourceOffset: offset - bytes.length,
        sourceBytes: bytes.length,
        bytes,
        text,
        binary: false,
      });
      requireAppend(outcome, 'STDOUT_APPEND');
    }
  }

  private async drainStderr(entry: LiveAttemptRendezvous, decoder: TextDecoder): Promise<void> {
    const handle = entry.handle;
    if (handle === undefined) return;
    const iterator = handle.streams.stderr[Symbol.asyncIterator]();
    let offset = 0;
    for (;;) {
      const nextPromise = iterator.next().then(result => ({ kind: 'next' as const, result }));
      const winner = await Promise.race([
        nextPromise,
        entry.captureStop.promise.then(() => ({ kind: 'stop' as const })),
      ]);
      if (winner.kind === 'stop') {
        try { void iterator.return?.(); } catch { /* best effort interruption */ }
        return;
      }
      if (winner.result.done || entry.captureStopped) return;
      const bytes = toBytes(winner.result.value);
      const text = decoder.decode(bytes, { stream: true });
      entry.stderrText = boundedAppend(entry.stderrText, text, this.stderrRetainedBytes);
      if (entry.captureStopped) return;
      offset += bytes.length;
      const outcome = await entry.stderrWriter.append({
        stream: 'stderr',
        sequence: offset,
        sourceOffset: offset - bytes.length,
        sourceBytes: bytes.length,
        bytes,
        text,
        binary: false,
      });
      requireAppend(outcome, 'STDERR_APPEND');
    }
  }

  private async stopEntry(
    entry: LiveAttemptRendezvous,
    origin: ProcessStopOrigin,
    correlationId = entry.eventContext.correlationId,
    causationId = entry.eventContext.causationId,
  ): Promise<StageExecutionOutcome> {
    if (entry.stopRequestPromise === undefined) {
      entry.stopOrigin = entry.stopOrigin ?? origin;
      entry.stopRequestPromise = this.acceptEntryStop(entry, origin, correlationId, causationId);
    }
    const ticket = await entry.stopRequestPromise;
    entry.stopAccepted = ticket.stopAccepted;
    if (!ticket.stopAccepted) {
      if (entry.finalizationPromise !== undefined) return entry.finalizationPromise;
      return entry.final.promise;
    }
    if (entry.finalizationPromise !== undefined) return entry.finalizationPromise;
    const stopped = await ticket.result;
    const winningOrigin = entry.stopOrigin ?? origin;
    const disposition: AttemptDisposition = winningOrigin === 'P4_ACTIVATION_FAILURE'
      ? { kind: 'p4-activation-failure', stop: stopped }
      : { kind: 'stop', stop: stopped, stopOrigin: winningOrigin };
    return this.finalizeAttemptOnce(entry, disposition);
  }

  private async acceptEntryStop(
    entry: LiveAttemptRendezvous,
    origin: ProcessStopOrigin,
    correlationId: string,
    causationId: string,
  ): Promise<ProcessStopTicket> {
    const process = await this.durableCoordinator.getProcess(entry.input.workspaceId, entry.processId);
    if (process === null) throw new Error('LIVE_EXECUTION_UNAVAILABLE: Process claim disappeared');
    const ticket = await this.durableCoordinator.processCancelCoordinator.acceptStop({
      workspaceId: process.workspaceId,
      processId: process.processId,
      expectedClaimEpoch: process.claimEpoch,
      expectedClaimOwner: process.claimOwnerId,
      reason: origin === 'EXPLICIT_CANCEL' ? 'cancel' : origin,
      idempotencyKey: 'attempt-stop:' + entry.key,
      timestamp: this.now(),
      eventContext: { correlationId, causationId },
      stopOrigin: origin,
    });
    await this.authorizeAcceptedStop(entry, ticket, origin);
    return ticket;
  }

  private async authorizeAcceptedStop(
    entry: LiveAttemptRendezvous,
    ticket: ProcessStopTicket,
    origin: ProcessStopOrigin,
  ): Promise<void> {
    if (!ticket.stopAccepted) return;
    entry.stopAccepted = true;
    if (entry.cleanupAuthorizationPromise === undefined) {
      entry.captureStopped = true;
      entry.captureStop.resolve(undefined);
      entry.cleanupAuthorizationPromise = (async () => {
        try {
          await entry.adapter.cancel({
            sessionId: entry.sessionId,
            processId: entry.processId,
            reason: origin === 'EXPLICIT_CANCEL' ? 'cancel' : origin,
            stopTicketAccepted: true,
            processPort: { requestGraceful: async () => ({ accepted: true }) },
          });
        } catch {
          // Provider graceful is optional; Process tree cleanup remains required.
        } finally {
          await ticket.startCleanup();
        }
      })();
    }
    await entry.cleanupAuthorizationPromise;
  }

  private finalizeAttemptOnce(
    entry: LiveAttemptRendezvous,
    disposition: AttemptDisposition,
  ): Promise<StageExecutionOutcome> {
    if (entry.finalizationPromise !== undefined) return entry.finalizationPromise;
    const promise = this.performFinalization(entry, disposition);
    entry.finalizationPromise = promise;
    void promise.then(
      () => {
        if (this.liveAttempts.get(entry.key) === entry) this.liveAttempts.delete(entry.key);
      },
      () => {
        if (this.liveAttempts.get(entry.key) === entry) this.liveAttempts.delete(entry.key);
      },
    );
    return promise;
  }

  private async performFinalization(
    entry: LiveAttemptRendezvous,
    disposition: AttemptDisposition,
  ): Promise<StageExecutionOutcome> {
    try {
      await Promise.allSettled([entry.stdoutDrain, entry.stderrDrain].filter((task): task is Promise<void> => task !== undefined));
      if (disposition.kind === 'natural') {
        return await this.finalizeNatural(entry, disposition);
      }
      if (disposition.kind === 'stop') {
        return await this.finalizeStopped(entry, disposition.stop, disposition.stopOrigin);
      }
      if (disposition.kind === 'p4-activation-failure') {
        await this.finalizeOrAbortOutputs(entry, disposition.stop.proven);
        await this.reconcileSession(entry, 'failed', 'PROVIDER_SESSION_FAILED', 'provider session activation failed');
        const outcome = this.failed('PROVIDER_SESSION_FAILED', 'Provider session could not transition to active', 'startup', entry.input, false);
        entry.final.resolve(outcome);
        return outcome;
      }
      if (disposition.kind === 'runtime-failure') {
        await this.abortWriters(entry.stdoutWriter, entry.stderrWriter);
        await this.reconcileSession(entry, 'failed', 'PROVIDER_SESSION_FAILED', 'provider session failed during capture');
        const outcome = this.failedFromError(disposition.error, 'runtime', entry.input);
        entry.final.resolve(outcome);
        return outcome;
      }
      await this.abortWriters(entry.stdoutWriter, entry.stderrWriter);
      await this.reconcileSession(entry, 'failed', 'PROVIDER_START_FAILED', 'provider process could not start');
      const outcome = this.failed('PROVIDER_START_FAILED', 'Provider process could not start', 'startup', entry.input, false);
      entry.final.resolve(outcome);
      return outcome;
    } catch (error) {
      try {
        await this.abortWriters(entry.stdoutWriter, entry.stderrWriter);
      } catch {
        // A failed writer abort is itself fail-closed; it must not create a
        // second finalization rejection or bypass the shared Deferred.
      }
      try {
        await this.reconcileSession(entry, 'failed', 'PROVIDER_SESSION_FAILED', 'provider session terminalization failed');
      } catch {
        // The returned Stage failure is already fail-closed; persisted state
        // remains the source of truth for recovery.
      }
      const outcome = this.failedFromError(error, 'runtime', entry.input);
      entry.final.resolve(outcome);
      return outcome;
    }
  }

  private async finalizeNatural(
    entry: LiveAttemptRendezvous,
    disposition: Extract<AttemptDisposition, { readonly kind: 'natural' }>,
  ): Promise<StageExecutionOutcome> {
    this.finishParserTail(entry);
    const artifactIds = await this.finalizeOutputs(entry);
    const finalized = await entry.adapter.finalize({
      exitCode: disposition.exit.exitCode,
      signal: disposition.exit.signal,
      parsedEvents: entry.parsedEvents,
      stderr: entry.stderrText,
      cancelled: false,
    });
    const desired = finalized.status === 'completed' ? 'completed' : 'failed';
    const session = await this.reconcileSession(
      entry,
      desired,
      finalized.status === 'completed' ? undefined : finalized.error?.code,
      finalized.status === 'completed' ? undefined : 'provider session terminal',
    );
    if (session.status === 'completed' && finalized.status === 'completed') {
      const outcome: StageExecutionOutcome = {
        kind: 'completed',
        durationMs: disposition.durationMs,
        artifactIds,
        outputContractSatisfied: true,
        ...(finalized.output === undefined ? {} : { output: finalized.output }),
      };
      entry.final.resolve(outcome);
      return outcome;
    }
    const error = finalized.error ?? { code: 'PROVIDER_SESSION_FAILED', phase: 'finalize', retryable: false, message: 'Provider session failed' };
    const outcome = this.failed(error.code, error.message, error.phase, entry.input, error.retryable);
    entry.final.resolve(outcome);
    return outcome;
  }

  private async finalizeStopped(
    entry: LiveAttemptRendezvous,
    stopped: ProcessStopResult,
    origin: ProcessStopOrigin,
  ): Promise<StageExecutionOutcome> {
    const explicit = origin === 'EXPLICIT_CANCEL';
    if (stopped.proven) {
      if (explicit && stopped.cleanup !== null) {
        this.finishParserTail(entry);
        await this.finalizeOutputs(entry);
        await entry.adapter.finalize({
          exitCode: null,
          signal: null,
          parsedEvents: entry.parsedEvents,
          stderr: entry.stderrText,
          cancelled: true,
        });
        await this.reconcileSession(entry, 'cancelled', undefined, undefined);
        const outcome = stoppedOutcome(stopped, origin);
        entry.final.resolve(outcome);
        return outcome;
      }
      if (explicit && stopped.cleanup === null) {
        await this.abortWriters(entry.stdoutWriter, entry.stderrWriter);
        await this.reconcileSession(entry, 'failed', 'PROVIDER_START_FAILED', 'provider process could not start');
        const outcome = this.failed('PROVIDER_START_FAILED', 'Provider process could not start', 'startup', entry.input, false);
        entry.final.resolve(outcome);
        return outcome;
      }
      this.finishParserTail(entry);
      await this.finalizeOutputs(entry);
      const providerError = origin === 'STARTUP_TIMEOUT'
        ? { code: 'PROVIDER_START_FAILED' as const, phase: 'startup' as const, retryable: false, message: 'Provider process could not start before timeout' }
        : { code: 'PROVIDER_SESSION_FAILED' as const, phase: 'runtime' as const, retryable: false, message: 'Provider session timed out' };
      await entry.adapter.finalize({
        exitCode: null,
        signal: null,
        parsedEvents: entry.parsedEvents,
        stderr: entry.stderrText,
        cancelled: false,
        providerError,
      });
      await this.reconcileSession(entry, 'failed', origin === 'STARTUP_TIMEOUT' ? 'PROVIDER_START_FAILED' : 'PROVIDER_SESSION_FAILED', 'provider timeout terminal');
      const outcome = this.failed(
        origin === 'STARTUP_TIMEOUT' ? 'PROVIDER_START_FAILED' : 'PROVIDER_SESSION_FAILED',
        origin === 'STARTUP_TIMEOUT' ? 'Provider process could not start before timeout' : 'Provider session timed out',
        origin === 'STARTUP_TIMEOUT' ? 'startup' : 'runtime',
        entry.input,
        false,
      );
      entry.final.resolve(outcome);
      return outcome;
    }

    await this.abortWriters(entry.stdoutWriter, entry.stderrWriter);
    await this.reconcileSession(entry, 'failed', 'PROVIDER_SESSION_FAILED', 'provider process cleanup could not be proven');
    if (explicit || origin === 'STARTUP_TIMEOUT' || origin === 'IDLE_TIMEOUT' || origin === 'TOTAL_TIMEOUT') {
      const outcome = stoppedOutcome(stopped, origin);
      entry.final.resolve(outcome);
      return outcome;
    }
    const outcome = this.failed('PROVIDER_SESSION_FAILED', 'Provider process cleanup could not be proven', 'runtime', entry.input, false);
    entry.final.resolve(outcome);
    return outcome;
  }

  private async finalizeOutputs(entry: LiveAttemptRendezvous): Promise<string[]> {
    const stdoutFinal = await entry.stdoutWriter.finalize();
    const stderrFinal = await entry.stderrWriter.finalize();
    requireOutputFinalize(stdoutFinal, 'STDOUT_FINALIZE');
    requireOutputFinalize(stderrFinal, 'STDERR_FINALIZE');
    return [stdoutFinal, stderrFinal]
      .map(result => result.outcome.kind === 'applied' || result.outcome.kind === 'duplicate' || result.outcome.kind === 'finalized'
        ? (result.outcome as { value: { artifactId: string } }).value.artifactId
        : undefined)
      .filter((id): id is string => typeof id === 'string');
  }

  private async finalizeOrAbortOutputs(entry: LiveAttemptRendezvous, proven: boolean): Promise<void> {
    if (proven) {
      await this.finalizeOutputs(entry);
    } else {
      await this.abortWriters(entry.stdoutWriter, entry.stderrWriter);
    }
  }

  private finishParserTail(entry: LiveAttemptRendezvous): void {
    if (entry.parserFinished) return;
    entry.parserFinished = true;
    const stdoutTail = entry.stdoutDecoder?.decode() ?? '';
    if (stdoutTail.length > 0) {
      entry.parsedEvents.push(...entry.adapter.parseChunk(stdoutTail, entry.parserContext).events);
    }
    entry.parsedEvents.push(...entry.adapter.finishParse(entry.parserContext).events);
    const stderrTail = entry.stderrDecoder?.decode() ?? '';
    if (stderrTail.length > 0) {
      entry.stderrText = boundedAppend(entry.stderrText, stderrTail, this.stderrRetainedBytes);
    }
  }

  private async abortWriters(stdout: DurableOutputWriter | undefined, stderr: DurableOutputWriter | undefined): Promise<void> {
    await Promise.all([
      stdout === undefined ? Promise.resolve() : stdout.abort(),
      stderr === undefined ? Promise.resolve() : stderr.abort(),
    ]);
  }

  private async reconcileSession(
    entry: LiveAttemptRendezvous,
    to: 'completed' | 'failed' | 'cancelled',
    failureCode?: string,
    failureDetailRedacted?: string,
  ): Promise<DurableSessionView> {
    const current = await this.sessionRepository.getSession(entry.input.workspaceId, entry.sessionId);
    if (current === null) throw new Error('PROVIDER_SESSION_TERMINAL_FAILED: session disappeared');
    if (isTerminalSession(current.status)) return current;
    const outcome = await this.sessionRepository.casSessionTransition({
      workspaceId: current.workspaceId,
      sessionId: current.sessionId,
      expectedVersion: current.version,
      expectedClaimEpoch: current.claimEpoch,
      expectedClaimOwner: current.claimOwnerId,
      expectedFrom: current.status,
      to,
      timestamp: this.now(),
      failureCode,
      failureDetailRedacted,
      eventContext: entry.eventContext,
    });
    if (outcome.kind === 'applied' || outcome.kind === 'duplicate' || outcome.kind === 'terminal') {
      if (outcome.value !== undefined) return outcome.value;
    }
    const persisted = await this.sessionRepository.getSession(entry.input.workspaceId, entry.sessionId);
    if (persisted !== null && isTerminalSession(persisted.status)) return persisted;
    throw new Error('PROVIDER_SESSION_TERMINAL_FAILED: terminal Session CAS did not settle');
  }

  private async failBeforeSpawn(
    input: StageExecutionInput,
    sessionId: string,
    process: DurableProcessView,
  ): Promise<void> {
    if (process.status === 'created') {
      await this.durableCoordinator.transitionProcess({
        workspaceId: process.workspaceId,
        processId: process.processId,
        expectedVersion: process.version,
        expectedClaimEpoch: process.claimEpoch,
        expectedClaimOwner: process.claimOwnerId,
        expectedFrom: 'created',
        to: 'failed',
        timestamp: this.now(),
        errorCode: 'PROCESS_ARTIFACT_WRITE_FAILED',
        errorDetailRedacted: 'provider output initialization failed',
        failureOutcome: 'cancelled-before-spawn',
        eventContext: { correlationId: input.operationId, causationId: input.operationId },
      });
    }
    const session = await this.sessionRepository.getSession(input.workspaceId, sessionId);
    if (session !== null && !isTerminalSession(session.status)) {
      await this.sessionRepository.casSessionTransition({
        workspaceId: session.workspaceId,
        sessionId: session.sessionId,
        expectedVersion: session.version,
        expectedClaimEpoch: session.claimEpoch,
        expectedClaimOwner: session.claimOwnerId,
        expectedFrom: session.status,
        to: 'failed',
        timestamp: this.now(),
        failureCode: 'PROVIDER_START_FAILED',
        failureDetailRedacted: 'provider process could not start',
        eventContext: { correlationId: input.operationId, causationId: input.operationId },
      });
    }
  }

  private async failSessionIfNonTerminal(
    session: DurableSessionView,
    input: StageAttemptCancelInput,
    failureCode: string,
  ): Promise<void> {
    const current = await this.sessionRepository.getSession(input.workspaceId, session.sessionId);
    if (current === null || isTerminalSession(current.status)) return;
    await this.sessionRepository.casSessionTransition({
      workspaceId: current.workspaceId,
      sessionId: current.sessionId,
      expectedVersion: current.version,
      expectedClaimEpoch: current.claimEpoch,
      expectedClaimOwner: current.claimOwnerId,
      expectedFrom: current.status,
      to: 'failed',
      timestamp: this.now(),
      failureCode,
      failureDetailRedacted: 'provider process cancelled before start',
      eventContext: { correlationId: input.correlationId, causationId: input.causationId },
    });
  }

  private failed(
    code: string,
    detail: string,
    phase: string,
    input: StageExecutionInput,
    retryable: boolean,
  ): { readonly kind: 'failed'; readonly problem: ApiProblem; readonly phase: string } {
    return { kind: 'failed', phase, problem: providerProblem(code, detail, phase, input, retryable) };
  }

  private failedFromError(error: unknown, phase: string, input: StageExecutionInput): { readonly kind: 'failed'; readonly problem: ApiProblem; readonly phase: string } {
    const message = error instanceof Error ? error.message : String(error);
    return this.failed('PROVIDER_INTERNAL_ERROR', message, phase, input, false);
  }
}

function requireAppend<T>(outcome: DurableCasOutcome<T>, label: string): void {
  if (outcome.kind === 'applied' || outcome.kind === 'duplicate') return;
  throw new Error(label + ': ' + outcome.kind);
}

function requireDurable<T>(outcome: DurableCasOutcome<T>, label: string): void {
  if (outcome.kind === 'applied' || outcome.kind === 'duplicate' || outcome.kind === 'terminal') return;
  throw new Error(label + ': ' + outcome.kind);
}

function requireOutputFinalize(result: { outcome: DurableCasOutcome<{ artifactId: string }> }, label: string): void {
  if (result.outcome.kind === 'applied' || result.outcome.kind === 'duplicate' || result.outcome.kind === 'finalized') return;
  throw new Error(label + ': ' + result.outcome.kind);
}

function attemptKey(input: Pick<StageExecutionInput, 'workspaceId' | 'runId' | 'stageId' | 'stageAttempt'>): string {
  return [input.workspaceId, input.runId, input.stageId, String(input.stageAttempt)].join('|');
}

function inputKey(input: StageAttemptCancelInput): string {
  return attemptKey(input);
}

function sameSessionClaim(left: DurableSessionView, right: DurableSessionView): boolean {
  return left.sessionId === right.sessionId
    && left.workspaceId === right.workspaceId
    && left.runId === right.runId
    && left.stageId === right.stageId
    && left.stageAttempt === right.stageAttempt
    && left.authorityRole === right.authorityRole
    && left.claimEpoch === right.claimEpoch
    && left.claimOwnerId === right.claimOwnerId;
}

function sameProcessClaim(left: DurableProcessView, right: DurableProcessView): boolean {
  return left.processId === right.processId
    && left.workspaceId === right.workspaceId
    && left.runId === right.runId
    && left.stageId === right.stageId
    && left.stageAttempt === right.stageAttempt
    && left.authorityRole === right.authorityRole
    && left.claimEpoch === right.claimEpoch
    && left.claimOwnerId === right.claimOwnerId;
}

function isTerminalSession(status: DurableSessionView['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function stoppedOutcome(stop: ProcessStopResult, stopOrigin: ProcessStopOrigin): StageStopOutcome {
  return {
    kind: 'stopped',
    cleanup: stop.cleanup,
    proven: stop.proven,
    stopOrigin,
  };
}

function stopOriginFromReason(reason: string | null): ProcessStopOrigin {
  if (reason === 'STARTUP_TIMEOUT' || reason === 'IDLE_TIMEOUT' || reason === 'TOTAL_TIMEOUT' || reason === 'P4_ACTIVATION_FAILURE' || reason === 'SHUTDOWN') {
    return reason;
  }
  return 'EXPLICIT_CANCEL';
}

function configurationFromSnapshot(snapshot: ProviderConfigurationSnapshotV1): ProviderConfigurationInput {
  return {
    id: snapshot.providerConfigId,
    name: snapshot.name,
    providerType: snapshot.providerType,
    adapterId: snapshot.adapterId,
    runtimeMode: snapshot.runtimeMode,
    ...(snapshot.executable === null ? {} : { executable: snapshot.executable }),
    argsTemplate: [...snapshot.argsTemplate],
    ...(snapshot.model === null ? {} : { model: snapshot.model }),
    ...(snapshot.environmentProfileId === null ? {} : { environmentProfileId: snapshot.environmentProfileId }),
    ...(snapshot.secretProfileId === null ? {} : { secretProfileId: snapshot.secretProfileId }),
    workingDirectoryMode: snapshot.workingDirectoryMode,
    ...(snapshot.workspaceRelativeWorkingDirectory === null ? {} : { customWorkingDirectory: snapshot.workspaceRelativeWorkingDirectory }),
    capabilities: snapshot.capabilities,
    timeoutPolicy: snapshot.timeoutPolicy,
    approvalMode: snapshot.approvalMode,
    outputMode: snapshot.outputMode,
    enabled: snapshot.enabled,
    version: snapshot.version,
  };
}

function providerProblem(
  code: string,
  detail: string,
  phase: string,
  input: StageExecutionInput,
  retryable: boolean,
): ApiProblem {
  return {
    type: 'https://agentos.dev/problems/' + code.toLowerCase(),
    title: 'Provider stage failed',
    status: code === 'PROVIDER_AUTH_REQUIRED' ? 401 : 502,
    code,
    detail,
    instance: '/runs/' + input.runId,
    requestId: 'provider-' + input.operationId,
    retryable,
    context: {
      workspaceId: input.workspaceId,
      runId: input.runId,
      operationId: input.operationId,
      stageId: input.stageId,
    },
  };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function toBytes(chunk: Uint8Array): Uint8Array {
  return chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
}

function boundedAppend(current: string, next: string, maxBytes: number): string {
  const combined = current + next;
  if (Buffer.byteLength(combined, 'utf8') <= maxBytes) return combined;
  let keep = combined;
  while (Buffer.byteLength(keep, 'utf8') > maxBytes && keep.length > 0) {
    keep = keep.slice(Math.max(0, keep.length - 1024));
  }
  return keep;
}
