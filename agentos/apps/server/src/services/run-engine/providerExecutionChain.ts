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
  readonly engine: RunEngine;
  readonly coordinator: StageExecutionCoordinator;
  readonly dispatcher: RunEngineProviderDispatcher;
}

export function createProviderExecutionChain(options: ProviderExecutionChainOptions): ProviderExecutionChain {
  const store = options.store;
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
  const dispatcher = new RunEngineProviderDispatcher({
    engine,
    coordinator,
    runRepository: store.runRepository(),
    runStageRepository: store.runStageRepository(),
    runSnapshotRepository: store.runSnapshotRepository(),
    operationService: store.operationService(),
    lifecycleTransactionService: store.lifecycleTransactionService(),
    workspaceRootFor: options.workspaceRootFor,
    worktreePathFor: options.worktreePathFor,
  });
  return { engine, coordinator, dispatcher };
}
