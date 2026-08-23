import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Store } from '../store/Store.js';
import type { SqliteStore } from '../store/SqliteStore.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { AGENT_CONFIGS, STAGE_ROLE_MAP } from '@agentos/agent-core';
import type { AgentStage, TaskItem, TaskLog, Workspace } from '@agentos/shared';
import { startSseHeartbeat } from './sse.js';
import {
  TaskRunService,
  type CreateLegacyRunForBridgeResult,
  type TaskRunServiceDeps,
} from '../services/TaskRunService.js';
import {
  LegacyCanonicalExecutionService,
  type LegacyCanonicalExecutionServiceLike,
  type LegacyPipelineRunner,
  type LegacyRunnerFactory,
} from '../services/LegacyCanonicalExecutionService.js';
import type { RunStreamService } from '../services/RunStreamService.js';
import {
  projectLegacyRuntimeEvent,
  type LegacyRuntimeProjectionContext,
} from '../services/LegacyRuntimeEventAdapter.js';

/** Minimal structural surface a Store must expose for Bridge persistence (SqliteStore satisfies it). */
export type PipelineRunner = LegacyPipelineRunner;
export type RunnerFactory = LegacyRunnerFactory;

export interface TaskRoutesDeps {
  /** Compatibility test seam; the execution service remains the only runner owner. */
  createRunner?: RunnerFactory;
  /** Bridge persistence; defaults to a TaskRunService over the given Store when capable. */
  taskRunService?: TaskRunService;
  legacyCanonicalExecutionService?: LegacyCanonicalExecutionServiceLike;
  runStreamService?: RunStreamService;
}

function asTaskRunStore(store: Store): TaskRunServiceDeps | undefined {
  const candidate = store as unknown as Partial<TaskRunServiceDeps>;
  if (
    typeof candidate.taskRepository === 'function'
    && typeof candidate.runRepository === 'function'
    && typeof candidate.workflowDefinitionRepository === 'function'
    && typeof candidate.runSnapshotRepository === 'function'
    && typeof candidate.runStageRepository === 'function'
    && typeof candidate.providerConfigurationRepository === 'function'
    && typeof candidate.findAgentSnapshotSource === 'function'
    && typeof candidate.runInTransaction === 'function'
    && typeof candidate.lifecycleTransactionService === 'function'
    && typeof candidate.operationService === 'function'
  ) {
    return candidate as TaskRunServiceDeps;
  }
  return undefined;
}

type LegacyExecutionStore = Store & Pick<
  SqliteStore,
  | 'runRepository'
  | 'runSnapshotRepository'
  | 'runStageRepository'
  | 'runtimeEventRepository'
  | 'runStreamService'
  | 'lifecycleTransactionService'
  | 'operationService'
  | 'runInTransaction'
>;

function asLegacyExecutionStore(store: Store): LegacyExecutionStore | undefined {
  const candidate = store as Partial<LegacyExecutionStore>;
  if (
    typeof candidate.runRepository === 'function'
    && typeof candidate.runSnapshotRepository === 'function'
    && typeof candidate.runStageRepository === 'function'
    && typeof candidate.runtimeEventRepository === 'function'
    && typeof candidate.runStreamService === 'function'
    && typeof candidate.lifecycleTransactionService === 'function'
    && typeof candidate.operationService === 'function'
    && typeof candidate.runInTransaction === 'function'
  ) {
    return candidate as LegacyExecutionStore;
  }
  return undefined;
}

function errorCode(err: unknown): string | undefined {
  return (err as { code?: unknown } | null)?.code as string | undefined;
}

function diagnosticText(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

const LEGACY_TASK_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isValidLegacyTaskId(taskId: string): boolean {
  return LEGACY_TASK_ID_PATTERN.test(taskId);
}

export function isContainedPath(rootPath: string, candidatePath: string): boolean {
  const root = resolve(rootPath);
  const candidate = resolve(candidatePath);
  const comparableRoot = process.platform === 'win32' ? root.toLowerCase() : root;
  const comparableCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  return comparableCandidate === comparableRoot || comparableCandidate.startsWith(comparableRoot + sep);
}

export function resolveLegacyTaskLogDir(workspaceRoot: string, taskId: string): string | null {
  if (!isValidLegacyTaskId(taskId)) return null;
  const logsRoot = resolve(workspaceRoot, '.agentos', 'logs');
  const candidate = resolve(logsRoot, taskId);
  return isContainedPath(logsRoot, candidate) ? candidate : null;
}

function legacyBridgeGuardMessage(err: unknown): string | undefined {
  switch (errorCode(err)) {
    case 'TASK_ARCHIVED':
      return 'Task is archived';
    case 'TASK_BLOCKED':
      return 'Task is blocked';
    case 'TASK_DONE':
      return 'Task is already completed';
    case 'TASK_CANCELLED':
      return 'Task is cancelled';
    case 'RUN_ACTIVE_EXISTS':
      return 'Task is already running';
    default:
      return undefined;
  }
}

export function applyStageFailure(task: TaskItem, err: unknown): TaskLog | null {
  const failedLog = err instanceof Error && 'log' in err ? (err.log as TaskLog | undefined) : undefined;
  if (failedLog) {
    task.outputs.push(failedLog);
  }
  task.status = 'failed';
  task.currentAgent = null;
  task.error = err instanceof Error ? err.message : String(err);
  task.updatedAt = new Date().toISOString();
  return failedLog ?? null;
}

export function touchTaskActivity(task: TaskItem, timestamp = new Date().toISOString()): void {
  task.lastActivityAt = timestamp;
  task.updatedAt = timestamp;
}

export function claimTaskRun(task: TaskItem): boolean {
  if (task.status === 'running') return false;
  task.status = 'running';
  return true;
}

export function getStageAgentName(workspace: Pick<Workspace, 'agents'>, stage: AgentStage): string {
  return workspace.agents.find(agent => agent.role === STAGE_ROLE_MAP[stage] && agent.enabled)?.name
    ?? AGENT_CONFIGS[stage].name
    ?? stage;
}

export function createTaskRoutes(store: Store, workspaceManager: WorkspaceManager, deps: TaskRoutesDeps = {}): Router {
  const router = Router({ mergeParams: true });
  const bridgeStore = asTaskRunStore(store);
  const taskRunService = deps.taskRunService ?? (bridgeStore ? new TaskRunService(bridgeStore) : undefined);
  const executionStore = asLegacyExecutionStore(store);
  const runStreamService = deps.runStreamService ?? executionStore?.runStreamService();
  const legacyCanonicalExecutionService = deps.legacyCanonicalExecutionService ?? (
    executionStore && taskRunService
      ? new LegacyCanonicalExecutionService(
          executionStore,
          taskRunService,
          executionStore.lifecycleTransactionService(),
          executionStore.operationService(),
          deps.createRunner,
        )
      : undefined
  );

  router.get('/', (req: Request, res: Response) => {
    const { workspaceId } = req.params as { workspaceId: string };
    if (!workspaceManager.get(workspaceId)) return res.status(404).json({ error: 'Workspace not found' });
    res.json({ tasks: store.loadTasks(workspaceId) });
  });

  router.post('/', (req: Request, res: Response) => {
    const { workspaceId } = req.params as { workspaceId: string };
    const { title } = req.body;
    if (!workspaceManager.get(workspaceId)) return res.status(404).json({ error: 'Workspace not found' });
    if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title is required' });

    const task: TaskItem = {
      id: randomUUID().slice(0, 8),
      workspaceId,
      title,
      status: 'pending',
      currentAgent: null,
      outputs: [],
      reviewDecision: 'unknown',
      reviewBlocked: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.saveTask(workspaceId, task);

    const memoryDir = workspaceMemoryDir(workspaceId, workspaceManager);
    if (memoryDir) {
      const line = `| ${task.id} | ${task.title} | pending | - | ${task.createdAt} | ${task.updatedAt} |\n`;
      appendTaskLine(memoryDir, line);
    }

    res.status(201).json({ task });
  });

  router.post('/:taskId/run', (req: Request, res: Response) => {
    const { workspaceId, taskId } = req.params as { workspaceId: string; taskId: string };
    const workspace = workspaceManager.get(workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

    const tasks = store.loadTasks(workspaceId);
    const task = tasks.find(t => t.id === taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!taskRunService || !runStreamService || !legacyCanonicalExecutionService) {
      return res.status(500).json({ error: 'Bridge persistence failed' });
    }

    if (
      taskRunService
      && (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled')
    ) {
      try {
        taskRunService.reconcileLegacyTerminalBeforeRetry({
          workspaceId,
          legacyTaskId: taskId,
          legacyStatus: task.status,
          legacyError: task.error,
        });
      } catch (err) {
        console.error(`[AgentOS Server] Legacy terminal reconciliation failed: ${diagnosticText(err)}`);
        return res.status(500).json({ error: 'Bridge persistence failed' });
      }
    }

    const taskBeforeClaim = structuredClone(task);
    if (!claimTaskRun(task)) {
      return res.status(409).json({ error: 'Task is already running' });
    }

    // M2.4 Bridge step 3: find-or-create v2 Task + queued Run in one SQLite transaction.
    let bridgeRunId: string | undefined;
    let runnerWorkspace = workspace;
    let bridgeStages: CreateLegacyRunForBridgeResult['stages'] = [];
    let bridgeResolvedStages: CreateLegacyRunForBridgeResult['resolvedConfiguration']['stages'] = [];
    if (taskRunService) {
      try {
        const bridge = taskRunService.createLegacyRunForBridge({
          workspaceId,
          legacyTaskId: taskId,
          title: task.title,
          createdBy: 'legacy_pipeline',
          objective: task.title,
          workspace,
        });
        if (
          !bridge.task
          || !bridge.run
          || !bridge.resolvedConfiguration
          || !bridge.runnerWorkspace
          || !bridge.snapshot
          || !bridge.stages
          || !bridge.startOperation
        ) {
          Object.assign(task, taskBeforeClaim);
          return res.status(500).json({ error: 'Bridge persistence failed' });
        }
        bridgeRunId = bridge.run.id;
        runnerWorkspace = bridge.runnerWorkspace;
        bridgeStages = bridge.stages;
        bridgeResolvedStages = bridge.resolvedConfiguration.stages;
      } catch (err) {
        Object.assign(task, taskBeforeClaim);
        const message = legacyBridgeGuardMessage(err);
        if (message) return res.status(409).json({ error: message });
        console.error(`[AgentOS Server] Legacy Run capture failed: ${errorCode(err) ?? 'RUN_SNAPSHOT_FAILED'}`);
        return res.status(500).json({ error: 'Bridge persistence failed' });
      }
    }
    task.outputs = [];
    task.error = undefined;
    task.reviewDecision = 'unknown';
    task.reviewBlocked = false;
    touchTaskActivity(task);
    try {
      store.saveTask(workspaceId, task);
    } catch (jsonErr) {
      // M2.4 Bridge claim compensation (step 4 failure): fail the queued Run via the
      // dedicated channel, reconcile the Task, then re-throw the original JSON error.
      if (taskRunService && bridgeRunId) {
        taskRunService.compensateLegacyClaimFailure(workspaceId, bridgeRunId, jsonErr);
      }
      throw jsonErr;
    }

    if (!bridgeRunId || !runStreamService || !legacyCanonicalExecutionService) {
      return res.status(500).json({ error: 'Bridge persistence failed' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const stopHeartbeat = startSseHeartbeat(res);
    let transportClosed = false;
    let unsubscribe = (): void => {};
    const cleanup = (endResponse = true): void => {
      if (transportClosed) return;
      transportClosed = true;
      unsubscribe();
      stopHeartbeat();
      if (endResponse && !res.writableEnded) {
        try { res.end(); } catch { /* transport cleanup is isolated */ }
      }
    };
    const writeFrame = (event: string, data: Record<string, unknown>): boolean => {
      if (transportClosed || res.writableEnded) return false;
      try {
        const accepted = res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        if (!accepted) cleanup();
        return accepted;
      } catch {
        cleanup();
        return false;
      }
    };

    const stageById = Object.fromEntries(bridgeStages.map(stage => {
      const resolved = bridgeResolvedStages.find(candidate => candidate.workflowStageKey === stage.workflowStageKey);
      return [stage.id, Object.freeze({
        stage: stage.workflowStageKey as AgentStage,
        agentName: resolved?.agent?.name ?? stage.workflowStageKey,
      })];
    }));
    const projectionContext: LegacyRuntimeProjectionContext = Object.freeze({
      taskId,
      stageById: Object.freeze(stageById),
    });

    res.on('close', () => cleanup(false));
    try {
      unsubscribe = runStreamService.subscribe({
        workspaceId,
        runId: bridgeRunId,
        afterSequence: 0,
        onEvent: event => {
          const frames = projectLegacyRuntimeEvent(event, projectionContext);
          let terminal = false;
          for (const frame of frames) {
            if (!writeFrame(frame.event, frame.data)) {
              throw new Error('LEGACY_TRANSPORT_WRITE_FAILED');
            }
            if (frame.event === 'done') terminal = true;
          }
          if (terminal) cleanup();
        },
        onOverflow: () => {
          writeFrame('error', { taskId, error: 'Stream overflow' });
          cleanup();
        },
      });
    } catch {
      writeFrame('error', { taskId, error: 'Pipeline stream failed' });
      cleanup();
    }

    void legacyCanonicalExecutionService.execute({
      workspaceId,
      legacyTaskId: taskId,
      runId: bridgeRunId,
      task,
      runnerWorkspace,
    }).catch(() => {
      if (!transportClosed) {
        writeFrame('error', { taskId, error: 'Pipeline failed' });
        cleanup();
      }
    });
  });

  router.get('/:taskId/logs', (req: Request, res: Response) => {
    const { workspaceId, taskId } = req.params as { workspaceId: string; taskId: string };
    const workspace = workspaceManager.get(workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

    const logDir = resolveLegacyTaskLogDir(workspace.rootPath, taskId);
    if (logDir === null) return res.status(400).json({ error: 'Invalid taskId' });
    if (!existsSync(logDir)) return res.json({ logs: {} });

    const logs: Record<string, string> = {};
    for (const file of readdirSync(logDir)) {
      if (file.endsWith('.log')) {
        logs[file.replace('.log', '')] = readFileSync(join(logDir, file), 'utf-8');
      }
    }
    res.json({ logs });
  });

  router.get('/:taskId/status', (req: Request, res: Response) => {
    const { workspaceId, taskId } = req.params as { workspaceId: string; taskId: string };
    const workspace = workspaceManager.get(workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

    const tasks = store.loadTasks(workspaceId);
    const task = tasks.find(t => t.id === taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    res.json({ task });
  });

  return router;
}

function workspaceMemoryDir(workspaceId: string, manager: WorkspaceManager): string | null {
  const workspace = manager.get(workspaceId);
  if (!workspace || !workspace.memoryEnabled) return null;
  return join(workspace.rootPath, 'agent-memory');
}

function appendTaskLine(memoryDir: string, line: string): void {
  const file = join(memoryDir, 'TASKS.md');
  try {
    mkdirSync(memoryDir, { recursive: true });
    appendFileSync(file, line, 'utf-8');
  } catch {
    // Ignore best-effort memory append failures.
  }
}
