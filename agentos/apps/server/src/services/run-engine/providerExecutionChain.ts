/**
 * M4-P4 additive production composition: wires the provider execution chain
 * over one SqliteStore. No default switch / cutover: this factory is only
 * the composition point for an authorized background dispatcher.
 */
import {
  DurableProcessCoordinator,
  FileArtifactSink,
  NodeProcessDriver,
  NodeProcessProbePort,
} from '@agentos/process-runtime';
import type { ProcessProbePort } from '@agentos/process-runtime';
import { KimiCodeProviderAdapter, ProviderRegistry } from '@agentos/agent-core/providers';
import type { SqliteStore } from '../../store/SqliteStore.js';

import {
  DurableOutputReferenceRepositoryAdapter,
  DurableProcessRepositoryAdapter,
  DurableSessionRepositoryAdapter,
} from '../../store/process-runtime-adapters.js';
import { RunEngine } from './RunEngine.js';
import { StageExecutor } from './StageExecutor.js';
import { StageExecutionCoordinator, type CanonicalRunEventObservationPort } from './StageExecutionCoordinator.js';
import { RunEngineProviderDispatcher } from './RunEngineProviderDispatcher.js';
import { WorkspaceAdmissionAuthority } from '../WorkspaceAdmissionAuthority.js';
import { MemoryContextBudgetSelector } from '../MemoryContextBudgetSelector.js';
import { MemoryContextResolver } from '../MemoryContextResolver.js';
import { MemoryCandidateGenerationService } from '../MemoryCandidateGenerationService.js';
import { MemoryEntryRepository } from '../../store/MemoryEntryRepository.js';
import { MemoryRetrievalService } from '../MemoryRetrievalService.js';
import { MemoryContextSnapshotRepository } from '../../store/MemoryContextSnapshotRepository.js';
import { MemoryRuntimeEventEmitter } from '../MemoryRuntimeEventEmitter.js';
import { DurableMemoryRuntimeEventContextAuthority } from '../MemoryRuntimeEventContextAuthority.js';

export interface ProviderExecutionChainOptions {
  readonly store: SqliteStore;
  readonly artifactRoot: string;
  readonly workspaceRootFor: (workspaceId: string) => string;
  readonly worktreePathFor?: (workspaceId: string, runId: string) => string | undefined;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly probe?: ProcessProbePort;
  readonly claimOwner?: string;
  readonly claimLeaseMs?: number;
}

export interface ProviderExecutionChain {
  readonly admissionAuthority: WorkspaceAdmissionAuthority;
  readonly engine: RunEngine;
  readonly coordinator: StageExecutionCoordinator;
  readonly dispatcher: RunEngineProviderDispatcher;
  readonly memoryContextResolver: MemoryContextResolver;
}

export function createProviderExecutionChain(options: ProviderExecutionChainOptions): ProviderExecutionChain {
  const store = options.store;
  const admissionAuthority = new WorkspaceAdmissionAuthority({ store });
  const driver = new NodeProcessDriver();
  const probe = options.probe ?? new NodeProcessProbePort();
  const seam = store.atomicSeam();
  const sessionAdapter = new DurableSessionRepositoryAdapter(store.providerSessionRepository());
  const processAdapter = new DurableProcessRepositoryAdapter(store.processRepository());
  const outputAdapter = new DurableOutputReferenceRepositoryAdapter(store.processOutputReferenceRepository());
  const durableCoordinator = new DurableProcessCoordinator({
    sessionRepository: sessionAdapter,
    processRepository: processAdapter,
    outputReferenceRepository: outputAdapter,
    artifactSink: new FileArtifactSink(options.artifactRoot),
    atomicSeam: seam,
    driver,
  });
  const adapter = new KimiCodeProviderAdapter({ probe });
  const registry = new ProviderRegistry([adapter]);
  const runEventObservation: CanonicalRunEventObservationPort = {
    subscribe: input => store.runStreamService().subscribe({
      workspaceId: input.workspaceId,
      runId: input.runId,
      afterSequence: input.afterSequence,
      onEvent: input.onEvent,
      onOverflow: () => undefined,
      onFailure: input.onFailure,
    }),
  };
  const coordinator = new StageExecutionCoordinator({
    registry,
    durableCoordinator,
    sessionRepository: sessionAdapter,
    driver,
    probe,
    runEventObservation,
    environment: options.environment ?? process.env,
    claimOwner: options.claimOwner,
    claimLeaseMs: options.claimLeaseMs,
  });
  const engine = new RunEngine({
    runRepository: store.runRepository(),
    operationService: store.operationService(),
    lifecycleTransactionService: store.lifecycleTransactionService(),
    snapshotRepository: store.runSnapshotRepository(),
    runStageRepository: store.runStageRepository(),
    stageExecutor: new StageExecutor(() => ({ outcome: 'active' })),
    runInTransaction: <T>(fn: () => T): T => store.runInTransaction(fn),
  });
  // MF-5 production wiring: the Memory Runtime owns ONE emitter over the
  // store's existing one-connection Runtime Event + Outbox writer, and ONE
  // durable causal-context authority. Both composition seams below (Run
  // startup snapshot, terminal Candidate) must use it, so the Memory fact and
  // the canonical Event that records it always share a transaction; an
  // unproven origin fails closed instead of fabricating causation.
  const memoryEventEmitter = new MemoryRuntimeEventEmitter({
    store,
    factWriter: store.runtimeEventOutboxWriter(),
    eventAuthority: new DurableMemoryRuntimeEventContextAuthority(store.getDatabase()),
  });
  // MF-4 Run startup integration: the dispatcher resolves, freezes, and gates
  // Memory through the MF-3 retrieval + MF-4 snapshot contracts before any
  // provider work, and injects only the bounded persisted context.
  const memoryContextResolver = new MemoryContextResolver({
    store,
    selector: new MemoryContextBudgetSelector(
      new MemoryRetrievalService(new MemoryEntryRepository(store.getDatabase())),
      new MemoryContextSnapshotRepository(store.getDatabase()),
    ),
    emitter: memoryEventEmitter,
  });
  const dispatcher = new RunEngineProviderDispatcher({
    engine,
    coordinator,
    admissionGate: admissionAuthority,
    memoryContextResolver,
    // MF-2R terminal-outcome trigger: bounded Evidence Bundle candidate after
    // the terminal commit; failures surface on stderr and never affect the Run.
    memoryCandidateGenerator: new MemoryCandidateGenerationService({
      store,
      runs: store.runRepository(),
      stages: store.runStageRepository(),
      tasks: store.taskRepository(),
      emitter: memoryEventEmitter,
    }),
    onCandidateGenerationError: (error, runId) => {
      console.error(`MEMORY_CANDIDATE_GENERATION_FAILED run=${runId}:`, error);
    },
    runRepository: store.runRepository(),
    runStageRepository: store.runStageRepository(),
    runSnapshotRepository: store.runSnapshotRepository(),
    operationService: store.operationService(),
    lifecycleTransactionService: store.lifecycleTransactionService(),
    workspaceRootFor: options.workspaceRootFor,
    worktreePathFor: options.worktreePathFor,
  });
  return { admissionAuthority, engine, coordinator, dispatcher, memoryContextResolver };
}
