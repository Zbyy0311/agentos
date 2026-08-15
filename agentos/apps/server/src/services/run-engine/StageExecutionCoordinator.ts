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
  DurableProcessCoordinator,
  DurableProcessView,
  NativeProcessHandle,
  PlatformProcessDriver,
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
    }
  | { readonly kind: 'failed'; readonly problem: ApiProblem; readonly phase: string };

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
    const validation = await adapter.validate({
      configuration,
      probe: this.probe,
      environment: this.environment,
    });
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

    const stdoutWriter = await this.durableCoordinator.beginOutput({
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
    const stderrWriter = await this.durableCoordinator.beginOutput({
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

    const final = deferred<StageExecutionOutcome>();
    const bound = deferred<DurableProcessView>();
    const startedAtMs = Date.parse(this.now());
    const spawned = await this.durableCoordinator.consumeSpawnRightAndSpawn({
      workspaceId: input.workspaceId,
      processId: established.process.processId,
      expectedVersion: established.process.version,
      expectedClaimEpoch: established.process.claimEpoch,
      expectedClaimOwner: established.process.claimOwnerId,
      timestamp: this.now(),
      eventContext,
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
        void this.runToFinal(handle, {
          adapter,
          input,
          eventContext,
          sessionId: established.session.sessionId,
          stdoutWriter,
          stderrWriter,
          startedAtMs,
          bound: bound.promise,
          final,
        });
        return handle;
      },
    });
    const spawnSucceeded = spawned.kind === 'spawned'
      && spawned.outcome.kind === 'applied'
      && spawned.outcome.value.status === 'running';
    if (!spawnSucceeded) {
      await this.sessionRepository.casSessionTransition({
        workspaceId: input.workspaceId,
        sessionId: established.session.sessionId,
        expectedVersion: established.session.version + 1,
        expectedClaimEpoch: established.session.claimEpoch,
        expectedClaimOwner: established.session.claimOwnerId,
        expectedFrom: 'starting',
        to: 'failed',
        timestamp: this.now(),
        failureCode: 'PROVIDER_START_FAILED',
        failureDetailRedacted: 'provider process could not start',
        eventContext,
      });
      await stdoutWriter.abort();
      await stderrWriter.abort();
      final.resolve(this.failed('PROVIDER_START_FAILED', 'Provider process could not start', 'startup', input, false));
    } else {
      bound.resolve(spawned.outcome.value);
      const active = await this.sessionRepository.casSessionTransition({
        workspaceId: input.workspaceId,
        sessionId: established.session.sessionId,
        expectedVersion: established.session.version + 1,
        expectedClaimEpoch: established.session.claimEpoch,
        expectedClaimOwner: established.session.claimOwnerId,
        expectedFrom: 'starting',
        to: 'active',
        timestamp: this.now(),
        eventContext,
      });
      if (active.kind === 'applied') {
        runToFinalSessionVersion.set(established.session.sessionId, active.value.version);
      }
    }
    return final.promise;
  }

  private async runToFinal(
    handle: NativeProcessHandle,
    context: {
      readonly adapter: RuntimeProviderAdapter;
      readonly input: StageExecutionInput;
      readonly eventContext: RuntimeEventContext;
      readonly sessionId: string;
      readonly stdoutWriter: Awaited<ReturnType<DurableProcessCoordinator['beginOutput']>>;
      readonly stderrWriter: Awaited<ReturnType<DurableProcessCoordinator['beginOutput']>>;
      readonly startedAtMs: number;
      readonly bound: Promise<DurableProcessView>;
      readonly final: Deferred<StageExecutionOutcome>;
    },
  ): Promise<void> {
    const parseContext: ProviderParseContext = (context.adapter as unknown as { createParseContext(): ProviderParseContext }).createParseContext();
    let parsedEvents: ProviderNormalizedEvent[] = [];
    let stderrText = '';
    let stdoutOffset = 0;
    let stderrOffset = 0;
    try {
      for await (const chunk of handle.streams.stdout) {
        const bytes = toBytes(chunk);
        const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        parsedEvents = [...parsedEvents, ...context.adapter.parseChunk(text, parseContext).events];
        stdoutOffset += bytes.length;
        await context.stdoutWriter.append({
          stream: 'stdout',
          sequence: stdoutOffset,
          sourceOffset: stdoutOffset - bytes.length,
          sourceBytes: bytes.length,
          bytes,
          text,
          binary: false,
        });
      }
      parsedEvents = [...parsedEvents, ...context.adapter.finishParse(parseContext).events];
      for await (const chunk of handle.streams.stderr) {
        const bytes = toBytes(chunk);
        const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        stderrText = boundedAppend(stderrText, text, this.stderrRetainedBytes);
        stderrOffset += bytes.length;
        await context.stderrWriter.append({
          stream: 'stderr',
          sequence: stderrOffset,
          sourceOffset: stderrOffset - bytes.length,
          sourceBytes: bytes.length,
          bytes,
          text,
          binary: false,
        });
      }
      const exit = await handle.waitExit();
      const durationMs = Date.now() - context.startedAtMs;
      const processView = await context.bound;
      await this.durableCoordinator.transitionProcess({
        workspaceId: context.input.workspaceId,
        processId: processView.processId,
        expectedVersion: processView.version,
        expectedClaimEpoch: processView.claimEpoch,
        expectedClaimOwner: processView.claimOwnerId,
        expectedFrom: 'running',
        to: 'exited',
        timestamp: this.now(),
        exitCode: exit.exitCode,
        exitSignal: exit.signal,
        terminationReason: exit.exitCode === 0 ? null : 'non-zero-exit',
        cleanupResult: null,
        durationMs,
        graceful: false,
        force: false,
        eventContext: context.eventContext,
      });
      const stdoutFinal = await context.stdoutWriter.finalize();
      const stderrFinal = await context.stderrWriter.finalize();
      const artifactIds = [stdoutFinal, stderrFinal]
        .map(result => result.outcome.kind === 'applied' || result.outcome.kind === 'duplicate' ? result.outcome.value.artifactId : undefined)
        .filter((id): id is string => typeof id === 'string');
      const finalized = await context.adapter.finalize({
        exitCode: exit.exitCode,
        signal: exit.signal,
        parsedEvents,
        stderr: stderrText,
        cancelled: false,
      });
      const activeVersion = runToFinalSessionVersion.get(context.sessionId) ?? (context.sessionId ? -1 : 0);
      await this.sessionRepository.casSessionTransition({
        workspaceId: context.input.workspaceId,
        sessionId: context.sessionId,
        expectedVersion: activeVersion,
        expectedClaimEpoch: 1,
        expectedClaimOwner: this.claimOwner,
        expectedFrom: 'active',
        to: finalized.status === 'completed' ? 'completed' : 'failed',
        timestamp: this.now(),
        failureCode: finalized.status === 'completed' ? undefined : finalized.error?.code,
        failureDetailRedacted: finalized.status === 'completed' ? undefined : 'provider session terminal',
        eventContext: context.eventContext,
      });
      if (finalized.status === 'completed') {
        context.final.resolve({
          kind: 'completed',
          durationMs,
          artifactIds,
          outputContractSatisfied: true,
        });
      } else {
        const error = finalized.error ?? { code: 'PROVIDER_SESSION_FAILED', phase: 'finalize', retryable: false, message: 'Provider session failed' };
        context.final.resolve(this.failed(error.code, error.message, error.phase, context.input, error.retryable));
      }
    } catch (error) {
      context.final.resolve(this.failedFromError(error, 'runtime', context.input));
    }
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

/** In-memory mapping of the Session version after the starting -> active CAS. */
const runToFinalSessionVersion = new Map<string, number>();

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