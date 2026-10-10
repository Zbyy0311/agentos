import express from 'express';
import cors from 'cors';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Server as HttpServer } from 'node:http';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from './store/SqliteStore.js';
import { CompactionRepository } from './store/CompactionRepository.js';
import { inTransaction } from './store/Transaction.js';
import { WorkspaceManager } from './managers/WorkspaceManager.js';
import { createWorkspaceRoutes } from './routes/workspaces.js';
import { createTaskRoutes } from './routes/tasks.js';
import { createV2TaskRoutes } from './routes/v2Tasks.js';
import { createV2RunRoutes } from './routes/v2Runs.js';
import { createRunLifecycleRoutes } from './routes/runLifecycle.js';
import { createOperationRoutes } from './routes/operations.js';
import { createCanonicalRunRoutes } from './routes/canonicalRuns.js';
import { createCanonicalRunEventRoutes } from './routes/canonicalRunEvents.js';
import { createOpenApiRoutes } from './routes/openapi.js';
import { createAgentRoutes } from './routes/agents.js';
import { createGitRoutes } from './routes/git.js';
import { createConversationRoutes } from './routes/conversations.js';
import { createConversationRuntimeRoutes } from './routes/conversationRuntime.js';
import { createRuntimeInspectorRoutes } from './routes/runtimeInspector.js';
import { recoverInterruptedTaskRuntime, type RecoveredTaskRuntime } from './taskRecovery.js';
import { recoverInterruptedRuns } from './runRecovery.js';
import {
  preflightProcessRecoveryClassifications,
  createPreflightProcessRecoveryPort,
} from './processRecoveryPreflight.js';
import { createProductionRecoveredProcessVerifier } from '@agentos/process-runtime';
import { EventBus } from './events/EventBus.js';
import { createRunRoutes } from './routes/runs.js';
import { createArtifactRoutes } from './routes/artifacts.js';
import { createMemoryRoutes } from './routes/memories.js';
import { createMemoryCandidateRoutes } from './routes/memoryCandidates.js';
import { createMemoryRuntimeRoutes } from './routes/memoryRuntime.js';
import { createMemoryActionRoutes } from './routes/memoryActions.js';
import { createMemoryMaintenanceRoutes } from './routes/memoryMaintenance.js';
import { createMemoryImportRoutes } from './routes/memoryImport.js';
import { createApiNotFoundHandler, createProblemErrorHandler, createRequestIdMiddleware } from './problemDetails.js';
import { getSignalExitCode } from './signals.js';
import { resolveProjectRoot } from './projectRoot.js';
import { TaskRunService } from './services/TaskRunService.js';
import { LegacyCanonicalExecutionService } from './services/LegacyCanonicalExecutionService.js';
import { createProviderExecutionChain } from './services/run-engine/providerExecutionChain.js';
import { RuntimeArtifactService } from './services/RuntimeArtifactService.js';
import { PreferenceService } from './services/PreferenceService.js';
import { RetentionService } from './services/RetentionService.js';
import { createPreferenceRoutes } from './routes/preferences.js';
import { createAgentPresenceRoutes } from './routes/agentPresence.js';
import { createWorktreeRoutes } from './routes/worktrees.js';
import { WorktreeManager } from './services/WorktreeManager.js';
import { createStorageRoutes } from './routes/storage.js';
import { createApprovalRoutes } from './routes/approvals.js';
import { createApprovalDecisionRoutes } from './routes/approvalDecisions.js';
import { createArtifactCompletionRoutes } from './routes/artifactCompletions.js';
import { createRuntimeApprovalRoutes } from './routes/runtimeApprovals.js';
import { createProviderConfigRoutes } from './routes/providerConfigs.js';
import { createLocalCorsOptions, createLocalWriteGuard, resolveLocalApiSecurityConfig } from './localApiSecurity.js';
import { acquireServerOwnership, type ServerOwnership } from './serverOwnership.js';
import {
  WorkspaceAdmissionStartupReconciler,
  WorkspaceAdmissionStartupReconciliationError,
} from './services/WorkspaceAdmissionStartupReconciler.js';
import { TerminalMemoryCandidateReconciler } from './services/TerminalMemoryCandidateReconciler.js';
import { CollaborationWorkflowService } from './services/CollaborationWorkflowService.js';
import { createCollaborationRoutes } from './routes/collaborations.js';
import { createMaintenanceRoutes, createMaintenanceWriteBarrier } from './routes/maintenance.js';
import { createReadinessRoutes } from './routes/readiness.js';
import { MaintenanceBarrier } from './services/MaintenanceBarrier.js';
import { installMaintenanceRequestDrain } from './services/MaintenanceRequestDrain.js';
import { MaintenanceCoordinator, MaintenanceError } from './services/MaintenanceCoordinator.js';
import { createMaintenanceShutdownController } from './services/MaintenanceShutdown.js';
import { MaintenanceDiagnosticsService, inspectMaintenanceActivity } from './services/MaintenanceDiagnosticsService.js';
import { MaintenanceService } from './services/MaintenanceService.js';
import { closeLocalShutdownControl, startLocalShutdownControl } from './services/LocalShutdownControl.js';
import { WorkspaceGitRootRegistry } from './services/WorkspaceGitRootRegistry.js';
import { createDiagnosticLogger } from './services/DiagnosticLogger.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolveProjectRoot(__dirname);
// Match the Windows launcher contract: its DataPath is AGENTOS_PROJECT_ROOT.
// Keep AGENTOS_DATA_ROOT as a compatibility fallback for existing local installs.
const DATA_ROOT = resolve(process.env.AGENTOS_PROJECT_ROOT?.trim() || process.env.AGENTOS_DATA_ROOT?.trim() || PROJECT_ROOT);

const configuredInstanceId = process.env.AGENTOS_SERVER_INSTANCE_ID?.trim();
const serverInstanceId = configuredInstanceId && /^[\w.-]{1,80}$/u.test(configuredInstanceId)
  ? configuredInstanceId
  : randomUUID();
process.env.AGENTOS_SERVER_INSTANCE_ID = serverInstanceId;

const DIAG_LOG_DIR = join(DATA_ROOT, '.agentos', 'logs', 'diagnostics');
process.env.AGENTOS_DIAG_LOG_DIR = DIAG_LOG_DIR;
const diagLog = createDiagnosticLogger({ directory: DIAG_LOG_DIR, instanceId: serverInstanceId });

diagLog(`INSTANCE_START pid=${process.pid} ppid=${process.ppid} instanceId=${serverInstanceId}`);

type StartupPhase = 'ownership' | 'store' | 'recovery' | 'services' | 'routes' | 'listen' | 'running';

type StableStartupCode =
  | 'SERVER_ALREADY_RUNNING'
  | 'SERVER_OWNERSHIP_UNAVAILABLE'
  | 'MAINTENANCE_IN_PROGRESS'
  | 'MAINTENANCE_STATE_INVALID'
  | 'MAINTENANCE_STATE_UNREADABLE'
  | 'STARTUP_RECOVERY_FAILED'
  | 'STARTUP_ADMISSION_RECONCILIATION_FAILED'
  | 'SERVER_LISTEN_FAILED'
  | 'LOCAL_SHUTDOWN_CONTROL_INVALID'
  | 'LOCAL_SHUTDOWN_CONTROL_UNAVAILABLE'
  | 'SERVER_STARTUP_FAILED';

class StartupFailure extends Error {
  constructor(readonly stableCode: StableStartupCode) {
    super(stableCode);
    this.name = 'StartupFailure';
  }
}

class StartupAdmissionReconciliationFailure extends Error {
  constructor() {
    super('STARTUP_ADMISSION_RECONCILIATION_FAILED');
    this.name = 'StartupAdmissionReconciliationFailure';
  }
}

function classifyStartupError(error: unknown): StableStartupCode {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'SERVER_ALREADY_RUNNING' || code === 'SERVER_OWNERSHIP_UNAVAILABLE') {
    return code;
  }
  if (error instanceof StartupFailure) {
    return error.stableCode;
  }
  if (error instanceof StartupAdmissionReconciliationFailure) {
    return 'STARTUP_ADMISSION_RECONCILIATION_FAILED';
  }
  if (error instanceof MaintenanceError && (error.code === 'MAINTENANCE_IN_PROGRESS'
    || error.code === 'MAINTENANCE_STATE_INVALID' || error.code === 'MAINTENANCE_STATE_UNREADABLE')) {
    return error.code;
  }
  return 'SERVER_STARTUP_FAILED';
}

function listenHttpServer(app: express.Express, port: number, host: string): Promise<HttpServer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = app.listen(port, host);
    const onError = (): void => {
      rejectPromise(new StartupFailure('SERVER_LISTEN_FAILED'));
    };
    server.once('error', onError);
    server.once('listening', () => {
      server.removeListener('error', onError);
      server.on('error', () => {
        diagLog(`HTTP_SERVER_ERROR pid=${process.pid} instanceId=${serverInstanceId}`);
      });
      resolvePromise(server);
    });
  });
}

let ownership: ServerOwnership | undefined;
let store: SqliteStore | undefined;
let httpServer: HttpServer | undefined;
let stopOutboxPublisher: (() => void) | undefined;
let stopRetention: (() => void) | undefined;
let shuttingDown = false;
let maintenancePaused = false;
let startBackgroundWorkers: (() => void) | undefined;
let resumeBackgroundQueueWorkers: (() => void) | undefined;
let worktreeReconcile: Promise<void> | undefined;
let maintenanceCoordinator: MaintenanceCoordinator | undefined;
let localShutdownControl: import('node:net').Server | undefined;
const maintenanceBarrier = new MaintenanceBarrier();
const dispatchPermitContext = new AsyncLocalStorage<boolean>();

async function withDispatchPermit(operation: () => Promise<void>): Promise<boolean> {
  if (dispatchPermitContext.getStore() === true) {
    await operation();
    return true;
  }
  const release = maintenanceBarrier.enterDispatcherStart();
  if (!release) return false;
  try {
    await dispatchPermitContext.run(true, operation);
    return true;
  } finally {
    release();
  }
}

async function resumeProductionQueues(input: {
  readonly runtimeDispatchEnabled: boolean;
  readonly barrier: MaintenanceBarrier;
  readonly withDispatchPermit: (operation: () => Promise<void>) => Promise<boolean>;
  readonly collaborationService: CollaborationWorkflowService;
  readonly providerExecutionChain: ReturnType<typeof createProviderExecutionChain>;
  readonly diagLog: (entry: string) => void;
}): Promise<void> {
  if (!input.runtimeDispatchEnabled || input.barrier.snapshot.quiescing) return;
  await input.withDispatchPermit(async () => {
    await input.collaborationService.resumeGrantedQueuedRuns()
      .catch(error => input.diagLog(`COLLABORATION_QUEUE_RESUME_ERROR error=${error instanceof Error ? error.message : String(error)}`));
    await input.providerExecutionChain.approvalGate.resumeApprovedUnconsumed()
      .catch(error => input.diagLog(`RUNTIME_APPROVAL_RESUME_ERROR error=${error instanceof Error ? error.message : String(error)}`));
  });
}

async function pauseBackgroundWorkers(): Promise<void> {
  maintenancePaused = true;
  if (stopOutboxPublisher) {
    try { stopOutboxPublisher(); } catch { /* best effort */ }
    stopOutboxPublisher = undefined;
  }
  if (stopRetention) {
    try { stopRetention(); } catch { /* best effort */ }
    stopRetention = undefined;
  }
  await worktreeReconcile;
}

function resumeBackgroundWorkers(): void {
  maintenancePaused = false;
  if (httpServer && !shuttingDown) {
    startBackgroundWorkers?.();
    resumeBackgroundQueueWorkers?.();
  }
}

async function stopOwnedBackgroundWorkers(): Promise<void> {
  try { await closeLocalShutdownControl(localShutdownControl); }
  catch (error) { diagLog(`SHUTDOWN_CONTROL_CLOSE_FAILED error=${String(error)}`); }
  localShutdownControl = undefined;
  if (stopOutboxPublisher) {
    try { stopOutboxPublisher(); } catch (error) { diagLog(`SHUTDOWN_OUTBOX_STOP_FAILED error=${String(error)}`); }
    stopOutboxPublisher = undefined;
  }
  if (stopRetention) {
    try { stopRetention(); } catch (error) { diagLog(`SHUTDOWN_RETENTION_STOP_FAILED error=${String(error)}`); }
    stopRetention = undefined;
  }
  await worktreeReconcile?.catch(error => {
    diagLog(`SHUTDOWN_WORKTREE_RECONCILE_FAILED error=${String(error)}`);
  });
}

const requestRuntimeShutdown = createMaintenanceShutdownController(() => ({
  barrier: maintenanceBarrier,
  coordinator: maintenanceCoordinator,
  inspectActivity: () => store
    ? inspectMaintenanceActivity(store.getDatabase() as any)
    : httpServer ? { counts: {}, unknown: true } : { counts: {} },
  server: httpServer,
  stopBackgroundWorkers: stopOwnedBackgroundWorkers,
  closeStore: () => {
    if (!store) return;
    try { store.close(); } catch (error) { diagLog(`SHUTDOWN_STORE_CLOSE_FAILED error=${String(error)}`); }
  },
  releaseOwnership: async () => {
    if (!ownership) return;
    try { await ownership.release(); } catch (error) { diagLog(`SHUTDOWN_OWNERSHIP_RELEASE_FAILED error=${String(error)}`); }
  },
  onFinished: exitCode => process.exit(exitCode),
  onDeferred: () => diagLog(`STOP_DEFERRED pid=${process.pid} instanceId=${serverInstanceId} reason=runtime-or-maintenance-drain; store-and-ownership-retained`),
  onError: error => diagLog(`SHUTDOWN_DRAIN_ERROR pid=${process.pid} instanceId=${serverInstanceId} error=${String(error)}`),
}));

async function bootstrap(): Promise<void> {
  let phase: StartupPhase = 'ownership';
  try {
    const security = resolveLocalApiSecurityConfig(process.env);
    const runtimeDispatchEnabled = process.env.AGENTOS_RUNTIME_DISPATCH_ENABLED === 'true';

    // Data-Root ownership must be acquired before any SQLite, recovery,
    // reconcile, route, or listen side effect.
    ownership = await acquireServerOwnership(DATA_ROOT);

    const maintenance = new MaintenanceCoordinator(DATA_ROOT, serverInstanceId, maintenanceBarrier, {
      inspectActivity: () => store
        ? inspectMaintenanceActivity(store.getDatabase() as any)
        : { counts: {}, unknown: true },
      onPauseBackground: pauseBackgroundWorkers,
      onResumeBackground: resumeBackgroundWorkers,
    });
    maintenanceCoordinator = maintenance;
    await maintenance.initialize();
    maintenance.assertStartupWritable();

    phase = 'store';
    store = new SqliteStore(DATA_ROOT);
    const worktreeManager = new WorktreeManager(process.env.AGENTOS_WORKTREE_ROOT ?? join(DATA_ROOT, '.agentos', 'worktrees'));
    const workspaceManager = new WorkspaceManager(store);
    const workspaceGitRoots = new WorkspaceGitRootRegistry(DATA_ROOT, store, workspaceManager, worktreeManager);
    const taskRunService = new TaskRunService(store);
    const collaborationWorktreePaths = new Map<string, string>();
    let collaborationService!: CollaborationWorkflowService;
    const providerExecutionChain = createProviderExecutionChain({
      store,
      artifactRoot: join(DATA_ROOT, '.agentos', 'artifacts'),
      withDispatchPermit,
      workspaceRootFor: workspaceId => {
        const workspace = workspaceManager.get(workspaceId);
        if (workspace === undefined) throw new Error('WORKSPACE_NOT_FOUND: ' + workspaceId);
        return workspaceGitRoots.rootPathFor(workspaceId) ?? workspace.rootPath;
      },
      worktreePathFor: (_workspaceId, runId) => collaborationWorktreePaths.get(runId),
      continueOwnedRun: (workspaceId, runId) => collaborationService.resumeRun(workspaceId, runId),
      collaborationStageHooks: {
        canDispatch: (workspaceId, runId) => collaborationService.canDispatch(workspaceId, runId),
        beforeStage: input => collaborationService.beforeStage(input),
        completedStage: input => collaborationService.completedStage(input),
      },
    });
    collaborationService = new CollaborationWorkflowService({
      store,
      verifiedMemoryFacts: () => providerExecutionChain.verifiedMemoryFacts,
      workspaces: workspaceManager,
      worktrees: worktreeManager,
      workspaceGitRootFor: workspaceId => workspaceGitRoots.rootPathFor(workspaceId),
      workspaceGitRootIsExplicitlyReconnected: workspaceId => workspaceGitRoots.isExplicitlyReconnected(workspaceId),
      dispatchRun: async (workspaceId, runId) => {
        await withDispatchPermit(() => providerExecutionChain.dispatcher.driveSafely(workspaceId, runId));
      },
      requestRunAdmission: input => providerExecutionChain.admissionAuthority.requestCanonicalRun(input),
      releaseRunAdmission: input => providerExecutionChain.admissionAuthority.releaseCanonicalRun(input),
      requestApplicationAdmission: async input => Boolean((await providerExecutionChain.admissionAuthority.requestCollaborationApplication(input)).grantedAdmission),
      releaseApplicationAdmission: async input => { await providerExecutionChain.admissionAuthority.releaseCollaborationApplication(input); },
      cancelRun: input => providerExecutionChain.dispatcher.cancelRun(input),
      registerWorktreePath: (runId, path) => collaborationWorktreePaths.set(runId, path),
      runtimeDispatchEnabled,
    });

    phase = 'recovery';
    let recoveredTaskRuntime: RecoveredTaskRuntime;
    let recoveredRuns: number;
    try {
      // P6-M2b: classify every active running Run's native Process with the
      // existing M2a classifier + platform verifier ASYNC, BEFORE the SQLite
      // recovery transaction opens. The precomputed classifications then back
      // the synchronous port consumed inside the transaction, so no OS/native
      // verification is ever awaited while the transaction is open.
      const processRecoveryClassifications = await preflightProcessRecoveryClassifications(
        store,
        createProductionRecoveredProcessVerifier(),
      );
      recoveredTaskRuntime = recoverInterruptedTaskRuntime(
        store,
        taskRunService,
        createPreflightProcessRecoveryPort(processRecoveryClassifications),
      );
      recoveredRuns = recoverInterruptedRuns(store);
      const interruptedDiscussions = store.groupInteractionRepository().reconcileInterruptedOnStartup(new Date().toISOString());
      diagLog(`GROUP_RECOVERY interrupted=${interruptedDiscussions}`);
      // Data-root ownership is exclusive before store recovery starts, so any
      // persisted running compaction belongs to a process that has exited.
      const startupDatabase = store.getDatabase();
      const interruptedCompactions = inTransaction(startupDatabase, () =>
        new CompactionRepository(startupDatabase).reconcileInterruptedOnStartupWithinTransaction(new Date().toISOString()));
      if (interruptedCompactions > 0) diagLog(`COMPACTION_RECOVERY interrupted=${interruptedCompactions}`);
    } catch {
      // The recovery transaction already rolled back; only the stable code escapes.
      throw new StartupFailure('STARTUP_RECOVERY_FAILED');
    }

    // P6-L1E Startup Admission Reconciliation. Runs strictly AFTER existing
    // recovery (so recovery-terminal subjects are never backfilled) and BEFORE
    // services/routes/listen. It bootstraps missing pre-016 active-state
    // Admissions fail-closed (MODIFYING) and reuses the single L1D winner
    // algorithm for queue advancement. Any durable conflict aborts startup
    // with a stable, data-free code and leaves zero partial bootstrap state.
    try {
      await new WorkspaceAdmissionStartupReconciler({ store }).reconcileOnStartup();
    } catch (error) {
      // Reconciler throws only the stable, data-free boundary error; anything
      // else is collapsed to the same code here so no internal detail escapes.
      void (error instanceof WorkspaceAdmissionStartupReconciliationError);
      throw new StartupAdmissionReconciliationFailure();
    }

    // The collaboration projection converges only from persisted evidence;
    // startup observation never replays Provider calls or candidate writes.
    const collaborationRecovery = await collaborationService.reconcileOnStartup();
    diagLog(`COLLABORATION_RECOVERY tasks=${collaborationRecovery.tasks} controls=${collaborationRecovery.controls} unresolved=${collaborationRecovery.unresolved}`);

    // LITE-07-102 restart convergence. A terminal Run whose Candidate was lost
    // to a crash between the terminal commit and the dispatch-time trigger is
    // repaired here from the Run's own persisted terminal Event. The sweep is
    // idempotent, never mutates a Run, and is contained: a failure is reported
    // and startup continues, exactly like the dispatch-time trigger.
    try {
      const sweep = new TerminalMemoryCandidateReconciler({
        store,
        generator: providerExecutionChain.terminalCandidateGenerator,
        verifiedMemoryFacts: () => providerExecutionChain.verifiedMemoryFacts,
        onProblem: detail => diagLog(`TERMINAL_CANDIDATE_SWEEP ${detail}`),
      }).reconcileOnStartup();
      if (sweep.generated > 0 || sweep.missingAuthority > 0 || sweep.unresolved > 0) {
        diagLog('TERMINAL_CANDIDATE_SWEEP'
          + ` terminalRuns=${sweep.terminalRuns} generated=${sweep.generated}`
          + ` existing=${sweep.existing} missingAuthority=${sweep.missingAuthority}`
          + ` unresolved=${sweep.unresolved}`);
      }
    } catch (error) {
      diagLog(`TERMINAL_CANDIDATE_SWEEP_FAILED ${error instanceof Error ? error.name : 'unknown'}`);
    }

    phase = 'services';
    const legacyCanonicalExecutionService = new LegacyCanonicalExecutionService(
      store,
      taskRunService,
      store.lifecycleTransactionService(),
      store.operationService(),
      undefined,
      providerExecutionChain.terminalCandidateGeneratorWithFacts,
    );
    const outboxPublisher = store.createOutboxPublisher({
      workerId: `server:${serverInstanceId}`,
      onError: error => {
        diagLog(`OUTBOX_PUBLISHER_ERROR code=${error.code}${error.outboxId === undefined ? '' : ` outboxId=${error.outboxId}`}`);
      },
    });
    const eventBus = new EventBus(
      draft => store!.appendAgentEvent(draft),
      (error, event) => {
        diagLog(`EVENT_SUBSCRIBER_ERROR eventId=${event.eventId} sequence=${event.sequence} error=${error instanceof Error ? error.message : String(error)}`);
      },
    );
    const artifactService = new RuntimeArtifactService(store, DATA_ROOT);
    const preferenceService = new PreferenceService(store);
    const retentionService = new RetentionService(store, undefined, error => {
      diagLog(`RETENTION_ERROR error=${error instanceof Error ? error.message : String(error)}`);
    });
    const maintenanceDiagnostics = new MaintenanceDiagnosticsService(
      store,
      workspaceManager,
    );
    maintenanceDiagnostics.setMaintenanceStatusReader(() => {
      const status = maintenance.status;
      return {
        active: status.active,
        quiescing: status.quiescing,
        recoveredAfterRestart: status.recoveredAfterRestart,
        ...(status.state ? { operation: {
          kind: status.state.kind,
          status: status.state.status,
          startedAt: status.state.startedAt,
          leaseExpiresAt: status.state.leaseExpiresAt,
        } } : {}),
      };
    });
    const maintenanceService = new MaintenanceService(DATA_ROOT, store.getDatabase() as any, workspaceManager.list());
    const resumeQueueWorkers = () => {
      void resumeProductionQueues({
        runtimeDispatchEnabled,
        barrier: maintenanceBarrier,
        withDispatchPermit,
        collaborationService,
        providerExecutionChain,
        diagLog,
      }).catch(error => diagLog(`RUNTIME_QUEUE_RESUME_ERROR error=${error instanceof Error ? error.message : String(error)}`));
    };
    resumeBackgroundQueueWorkers = resumeQueueWorkers;

    phase = 'routes';
    const app = express();
    const parsedPort = Number.parseInt(process.env.PORT ?? '3000', 10);
    const PORT = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 3000;

    // M3 P4A request-id lifecycle runs ahead of the CORS / write-guard
    // termination boundary, so even a security rejection carries the stable
    // X-Request-ID header that its ApiProblem body references. Every API
    // response carries X-Request-ID (client value echoed only when it is a
    // safe token) so ApiProblem bodies and logs can be correlated.
    app.use(createRequestIdMiddleware());
    app.use(cors(createLocalCorsOptions(security)));
    app.use(createLocalWriteGuard(security));
    app.use(createMaintenanceWriteBarrier(maintenanceBarrier));
    // M3 P3C-1 canonical lifecycle routes — the single additive /api mount
    // for POST /api/runs/:runId/start. Mounted ahead of the global strict
    // JSON parser because the route owns a scoped non-strict parser so that
    // non-object JSON bodies reach its frozen VALIDATION_FAILED contract.
    // P6-M1 Production Runtime Dispatch Activation. Feature-gated and default
    // OFF: only when AGENTOS_RUNTIME_DISPATCH_ENABLED=true does an accepted
    // (non-replayed) canonical start trigger the background
    // RunEngineProviderDispatcher drive. driveSafely contains failures so the
    // route never crashes and no run strands silently. Legacy execution,
    // Process ownership, spawning authority, StageExecutor, and the
    // Conversation model are unchanged.
    app.use('/api', createRunLifecycleRoutes(store, {
      runtimeDispatch: {
        enabled: runtimeDispatchEnabled,
        drive: async (workspaceId, runId) => {
          await withDispatchPermit(() => providerExecutionChain.dispatcher.driveSafely(workspaceId, runId));
        },
      },
    }));
    app.use('/api', createOperationRoutes(store, {
      activeRunCancellation: input => providerExecutionChain.dispatcher.cancelRun(input),
    }));
    // M3 P5A read-only Event/Replay routes resolve the opaque Run locator
    // before query validation and do not consume request bodies.
    app.use('/api', createCanonicalRunEventRoutes(store));
    app.use(express.json({ limit: '50mb' }));

    app.get('/api/health', (_req, res) => {
      res.json({ ok: true, service: 'agentos-server', time: new Date().toISOString() });
    });
    app.use('/api', createReadinessRoutes(maintenanceDiagnostics));
    app.use('/api/maintenance', createMaintenanceRoutes({
      coordinator: maintenance,
      diagnostics: maintenanceDiagnostics,
      service: maintenanceService,
      instanceId: serverInstanceId,
      workspaceGitRoots,
    }));

    app.use('/api/workspaces', createWorkspaceRoutes(workspaceManager));
    app.use('/api/workspaces/:workspaceId', createConversationRoutes(store, workspaceManager, undefined, eventBus, artifactService, preferenceService, worktreeManager));
    app.use('/api/workspaces/:workspaceId/runtime', createConversationRuntimeRoutes(store, workspaceManager));
    app.use('/api/workspaces/:workspaceId/runtime', createRuntimeInspectorRoutes(store, workspaceManager));
    app.use('/api/workspaces/:workspaceId', createRunRoutes(store, workspaceManager));
    app.use('/api/workspaces/:workspaceId', createArtifactRoutes(store, workspaceManager, artifactService));
    app.use('/api/workspaces/:workspaceId', createArtifactCompletionRoutes(store, workspaceManager));
    app.use('/api/workspaces/:workspaceId', createRuntimeApprovalRoutes(store, workspaceManager, providerExecutionChain.approvalGate));
    app.use('/api/workspaces/:workspaceId', createMemoryRoutes(store, workspaceManager));
    app.use('/api/workspaces/:workspaceId', createMemoryCandidateRoutes(store, workspaceManager, eventBus));
    app.use('/api/workspaces/:workspaceId', createMemoryRuntimeRoutes(store, workspaceManager));
    app.use('/api/workspaces/:workspaceId', createMemoryActionRoutes(store, workspaceManager));
    app.use('/api/workspaces/:workspaceId', createMemoryMaintenanceRoutes(store, workspaceManager));
    app.use('/api/workspaces/:workspaceId', createMemoryImportRoutes(store, workspaceManager));
    app.use('/api/workspaces/:workspaceId', createPreferenceRoutes(store, workspaceManager, preferenceService));
    app.use('/api/workspaces/:workspaceId', createAgentPresenceRoutes(store, workspaceManager));
    app.use('/api/workspaces/:workspaceId', createWorktreeRoutes(workspaceManager, worktreeManager, artifactService, store,
      workspaceId => workspaceGitRoots.rootPathFor(workspaceId)));
    app.use('/api/workspaces/:workspaceId', createStorageRoutes(workspaceManager, DATA_ROOT, store, artifactService));
    app.use('/api/workspaces/:workspaceId', createApprovalRoutes(store, workspaceManager));
    app.use('/api/workspaces/:workspaceId', createApprovalDecisionRoutes(store, workspaceManager));
    app.use('/api/workspaces/:workspaceId', createProviderConfigRoutes(store, workspaceManager));
    app.use('/api/workspaces/:workspaceId', createCollaborationRoutes(collaborationService, workspaceManager));
    app.use('/api', createPreferenceRoutes(store, workspaceManager, preferenceService));
    app.use('/api/workspaces/:workspaceId/tasks', createTaskRoutes(store, workspaceManager, {
      taskRunService,
      legacyCanonicalExecutionService,
      runStreamService: store.runStreamService(),
    }));
    app.use('/api/workspaces/:workspaceId/v2', createV2TaskRoutes(store, workspaceManager));
    app.use('/api/workspaces/:workspaceId/v2', createV2RunRoutes(store, workspaceManager));
    // M3 P4B canonical top-level Run compatibility routes and the Basic
    // OpenAPI document. Mounted after the global strict JSON parser (the
    // same body-contract seam as the v2 routers) and after the more
    // specific /api/runs/:runId/preferences route, before the API 404
    // fallback. Legacy, current-v2, and the frozen Start/Retry/Operation
    // routes are preserved unchanged.
    app.use('/api', createCanonicalRunRoutes(store, workspaceManager));
    app.use('/api', createOpenApiRoutes());
    app.use('/api/workspaces/:workspaceId/git', createGitRoutes(workspaceManager, undefined,
      workspaceId => workspaceGitRoots.rootPathFor(workspaceId)));
    app.use('/api/agents', createAgentRoutes(workspaceManager));
    // M3 P4A: unknown API routes and unhandled errors are ApiProblem
    // responses (application/problem+json), never Express HTML or raw
    // internal messages.
    app.use('/api', createApiNotFoundHandler());
    app.use(createProblemErrorHandler());

    installMaintenanceRequestDrain(app);
    phase = 'listen';
    httpServer = await listenHttpServer(app, PORT, security.host);
    const localControlNonce = process.env.AGENTOS_LOCAL_SHUTDOWN_NONCE;
    const localControlPipe = process.env.AGENTOS_LOCAL_SERVER_SHUTDOWN_PIPE;
    const localControlInstance = process.env.AGENTOS_LOCAL_INSTANCE_ID;
    if (localControlNonce || localControlPipe || localControlInstance) {
      if (!localControlNonce || !localControlPipe || !localControlInstance || localControlInstance !== serverInstanceId) {
        throw new StartupFailure('LOCAL_SHUTDOWN_CONTROL_INVALID');
      }
      try {
        localShutdownControl = await startLocalShutdownControl({
          pipePath: localControlPipe,
          instanceId: localControlInstance,
          nonce: localControlNonce,
          onShutdown: () => { void shutdown('LOCAL_CONTROL', 0); },
        });
      } catch { throw new StartupFailure('LOCAL_SHUTDOWN_CONTROL_UNAVAILABLE'); }
    }

    phase = 'running';
    console.log(`[AgentOS Server] running on http://${security.host}:${PORT}`);
    console.log(`[AgentOS Server] API base: http://${security.host}:${PORT}/api`);
    diagLog(`SERVER_LISTEN pid=${process.pid} instanceId=${serverInstanceId} port=${PORT}`);

    let worktreeReconcileStarted = false;
    startBackgroundWorkers = () => {
      if (maintenancePaused || maintenanceBarrier.snapshot.quiescing || shuttingDown) return;
      if (!stopOutboxPublisher) {
        outboxPublisher.reclaimExpired();
        stopOutboxPublisher = outboxPublisher.start();
      }
      if (!worktreeReconcileStarted) {
        worktreeReconcileStarted = true;
        worktreeReconcile = worktreeManager.reconcile()
          .catch(error => { diagLog(`WORKTREE_RECONCILE_ERROR error=${error instanceof Error ? error.message : String(error)}`); })
          .finally(() => { worktreeReconcile = undefined; });
      }
      if (!stopRetention) {
        try {
          const result = retentionService.run();
          diagLog(`RETENTION_RUN reviewedMemoryCandidatesDeleted=${result.reviewedMemoryCandidatesDeleted}`);
        } catch (error) {
          diagLog(`RETENTION_ERROR error=${error instanceof Error ? error.message : String(error)}`);
        }
        stopRetention = retentionService.start();
      }
    };
    startBackgroundWorkers();
    if (runtimeDispatchEnabled && !maintenanceBarrier.snapshot.quiescing) {
      void withDispatchPermit(async () => {
        await collaborationService.resumeGrantedQueuedRuns()
          .catch(error => diagLog(`COLLABORATION_QUEUE_RESUME_ERROR error=${error instanceof Error ? error.message : String(error)}`));
        await providerExecutionChain.approvalGate.resumeApprovedUnconsumed()
          .catch(error => diagLog(`RUNTIME_APPROVAL_RESUME_ERROR error=${error instanceof Error ? error.message : String(error)}`));
      }).catch(error => diagLog(`RUNTIME_QUEUE_RESUME_ERROR error=${error instanceof Error ? error.message : String(error)}`));
    }

    if (recoveredTaskRuntime.recoveredLegacyTasks.length > 0) {
      console.warn(`[AgentOS Server] recovered ${recoveredTaskRuntime.recoveredLegacyTasks.length} interrupted running task(s) as failed`);
      diagLog(`RECOVERED_TASKS count=${recoveredTaskRuntime.recoveredLegacyTasks.length} tasks=${JSON.stringify(recoveredTaskRuntime.recoveredLegacyTasks)}`);
    }
    if (recoveredTaskRuntime.recoveredLegacyQueuedRuns.length > 0) {
      console.warn(`[AgentOS Server] recovered ${recoveredTaskRuntime.recoveredLegacyQueuedRuns.length} orphaned Legacy queued Run(s) as failed`);
      diagLog(`RECOVERED_LEGACY_QUEUED_RUNS count=${recoveredTaskRuntime.recoveredLegacyQueuedRuns.length} runs=${JSON.stringify(recoveredTaskRuntime.recoveredLegacyQueuedRuns.map(item => ({ workspaceId: item.workspaceId, taskId: item.taskId, runId: item.runId })))}`);
    }
    if (recoveredRuns > 0) {
      console.warn(`[AgentOS Server] recovered ${recoveredRuns} interrupted run(s) as failed`);
      diagLog(`RECOVERED_RUNS count=${recoveredRuns}`);
    }
  } catch (error) {
    // Single sanitized startup boundary: only stable codes escape this catch.
    const code = classifyStartupError(error);
    if (code === 'SERVER_ALREADY_RUNNING' || code === 'SERVER_OWNERSHIP_UNAVAILABLE' || code.startsWith('MAINTENANCE_')) {
      console.error(`[AgentOS Server] startup blocked: ${code}`);
    } else {
      console.error(`[AgentOS Server] startup failed: ${code}`);
    }
    diagLog(`STARTUP_ABORTED code=${code} pid=${process.pid} instanceId=${serverInstanceId} phase=${phase}`);
    shuttingDown = true;
    process.exitCode = 1;
    try {
      const drain = await requestRuntimeShutdown(1);
      if (drain === 'deferred') {
        diagLog(`STARTUP_CLEANUP_DEFERRED pid=${process.pid} instanceId=${serverInstanceId} phase=${phase}; store-and-ownership-retained`);
      }
    } catch (cleanupError) {
      diagLog(`STARTUP_CLEANUP_FAILED_CLOSED pid=${process.pid} instanceId=${serverInstanceId} phase=${phase} error=${String(cleanupError)}`);
    }
  }
}

async function shutdown(signal: string, exitCode: number): Promise<void> {
  if (shuttingDown) {
    if (exitCode !== 0) await requestRuntimeShutdown(exitCode).catch(() => undefined);
    return;
  }
  shuttingDown = true;
  diagLog(`SIGNAL=${signal} pid=${process.pid} instanceId=${serverInstanceId}`);
  await requestRuntimeShutdown(exitCode).catch(error => {
    diagLog(`SHUTDOWN_FAILED_CLOSED pid=${process.pid} instanceId=${serverInstanceId} error=${String(error)}`);
  });
}

process.on('SIGINT',  () => { void shutdown('SIGINT', getSignalExitCode('SIGINT')); });
process.on('SIGTERM', () => { void shutdown('SIGTERM', getSignalExitCode('SIGTERM')); });
process.on('SIGHUP',  () => { void shutdown('SIGHUP', getSignalExitCode('SIGHUP')); });

process.on('exit', (code) => {
  diagLog(`PROCESS_EXIT code=${code} pid=${process.pid} instanceId=${serverInstanceId}`);
});

process.on('uncaughtException', (err) => {
  diagLog(`UNCAUGHT_EXCEPTION pid=${process.pid} instanceId=${serverInstanceId} error=${err.message} stack=${err.stack?.split('\n').slice(0, 6).join('|')}`);
  requestRuntimeShutdown(1);
});

process.on('unhandledRejection', (reason) => {
  diagLog(`UNHANDLED_REJECTION pid=${process.pid} instanceId=${serverInstanceId} reason=${reason}`);
});

await bootstrap();
