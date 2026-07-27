import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../store/Store.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { AgentRunner, AGENT_CONFIGS, STAGE_ROLE_MAP } from '@agentos/agent-core';
import type { AgentStage, TaskItem, TaskLog, Workspace } from '@agentos/shared';
import { createSseWriter, startSseHeartbeat } from './sse.js';
import { applyFinalReviewDecision, getWorkerEvidenceFailure } from './taskPipeline.js';
import { TaskRunService, type TaskRunServiceDeps } from '../services/TaskRunService.js';

/** Minimal structural surface a Store must expose for Bridge persistence (SqliteStore satisfies it). */
export type PipelineRunner = Pick<AgentRunner, 'runCodexManager' | 'runKimiWorker' | 'runOpenCodeReviewer' | 'runCodexFinalReview'>;

export type RunnerFactory = (
  workspace: Workspace,
  taskId: string,
  taskTitle: string,
  onChunk: (text: string, done: boolean) => void,
  opts: { signal: AbortSignal; onActivity: () => void },
) => PipelineRunner;

export interface TaskRoutesDeps {
  /** Test-only seam; production default constructs the real AgentRunner. */
  createRunner?: RunnerFactory;
  /** Bridge persistence; defaults to a TaskRunService over the given Store when capable. */
  taskRunService?: TaskRunService;
}

const defaultRunnerFactory: RunnerFactory = (workspace, taskId, taskTitle, onChunk, opts) =>
  new AgentRunner(workspace, taskId, taskTitle, onChunk, opts);

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
  ) {
    return candidate as TaskRunServiceDeps;
  }
  return undefined;
}

function errorCode(err: unknown): string | undefined {
  return (err as { code?: unknown } | null)?.code as string | undefined;
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

class BridgeTerminalSyncFailedError extends Error {
  readonly code = 'BRIDGE_TERMINAL_SYNC_FAILED' as const;

  constructor(public readonly cause: unknown) {
    super('BRIDGE_TERMINAL_SYNC_FAILED: bridge persistence failed');
    this.name = 'BridgeTerminalSyncFailedError';
  }
}

function diagnosticText(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
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
    let bridgeRunnerWorkspace: Workspace | undefined;
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
        bridgeRunId = bridge.run.id;
        bridgeRunnerWorkspace = bridge.runnerWorkspace;
      } catch (err) {
        Object.assign(task, taskBeforeClaim);
        const message = legacyBridgeGuardMessage(err);
        if (message) return res.status(409).json({ error: message });
        console.error(`[AgentOS Server] Legacy Run capture failed: ${errorCode(err) ?? 'RUN_SNAPSHOT_FAILED'}`);
        return res.status(500).json({ error: 'Bridge persistence failed' });
      }
    }
    let bridgeTerminalSynced = false;
    let bridgeTerminalSyncAttempted = false;
    const syncBridgeTerminal = (sync: () => unknown): void => {
      bridgeTerminalSyncAttempted = true;
      try {
        sync();
        bridgeTerminalSynced = true;
      } catch (err) {
        throw new BridgeTerminalSyncFailedError(err);
      }
    };
    const syncBridgeTerminalSaveFailure = (jsonErr: unknown): never => {
      if (taskRunService && bridgeRunId) {
        bridgeTerminalSyncAttempted = true;
        try {
          taskRunService.compensateTerminalSaveFailure(workspaceId, bridgeRunId, jsonErr);
          bridgeTerminalSynced = true;
        } catch (compensationErr) {
          const wrapped = new Error('BRIDGE_COMPENSATION_FAILED: bridge terminal compensation failed') as Error & { code: string; originalError: unknown; compensationError: unknown };
          wrapped.code = 'BRIDGE_COMPENSATION_FAILED';
          wrapped.originalError = jsonErr;
          wrapped.compensationError = compensationErr;
          throw wrapped;
        }
      }
      const stable = new Error('BRIDGE_TERMINAL_SAVE_FAILED: legacy terminal JSON save failed') as Error & { code: string; cause?: unknown };
      stable.code = 'BRIDGE_TERMINAL_SAVE_FAILED';
      stable.cause = jsonErr;
      throw stable;
    };

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

    // M2.4 Bridge step 5: JSON claim succeeded → Run queued→running, Task open→in_progress.
    if (taskRunService && bridgeRunId) {
      taskRunService.startRunForBridge(workspaceId, bridgeRunId);
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const sendEvent = createSseWriter(res);
    const stopHeartbeat = startSseHeartbeat(res);

    sendEvent('status', { taskId, status: 'running', currentAgent: null, reviewDecision: 'unknown', reviewBlocked: false });

    const abortController = new AbortController();
    const signal = abortController.signal;
    let responseClosed = false;

    let runner: PipelineRunner;
    const runnerWorkspace = bridgeRunnerWorkspace ?? workspace;
    const runStage = async (stage: AgentStage, fn: () => Promise<TaskLog>) => {
      if (signal.aborted) return;
      task.currentAgent = stage;
      touchTaskActivity(task);
      store.saveTask(workspaceId, task);
      const agentName = getStageAgentName(runnerWorkspace, stage);
      sendEvent('stage', { stage, agent: agentName, status: 'running' });
      const log = await fn();
      if (signal.aborted) return;
      task.outputs.push(log);
      touchTaskActivity(task);
      store.saveTask(workspaceId, task);
      sendEvent('stage', { stage, status: 'completed', log });
    };

    void (async () => {
      runner = (deps.createRunner ?? defaultRunnerFactory)(runnerWorkspace, taskId, task.title, (text, done) => {
        const stage = task.currentAgent;
        sendEvent('thinking', {
          stage: stage ?? 'unknown',
          agentName: stage ? getStageAgentName(runnerWorkspace, stage) : 'unknown',
          text,
          done,
        });
      }, {
        signal,
        onActivity: () => {
          touchTaskActivity(task);
          store.saveTask(workspaceId, task);
        },
      });

      try {
        await runStage('codex_manager', () => runner.runCodexManager());
        if (signal.aborted) throw new Error('Pipeline cancelled');

        await runStage('kimi_worker', () => runner.runKimiWorker());
        if (signal.aborted) throw new Error('Pipeline cancelled');

        await runStage('opencode_reviewer', () => runner.runOpenCodeReviewer());
        if (signal.aborted) throw new Error('Pipeline cancelled');

        const workerLog = task.outputs.find(log => log.stage === 'kimi_worker');
        if (workerLog && getWorkerEvidenceFailure(workerLog)) {
          task.reviewBlocked = true;
          touchTaskActivity(task);
          store.saveTask(workspaceId, task);
          sendEvent('status', {
            taskId,
            status: 'reviewing',
            reviewDecision: task.reviewDecision,
            reviewBlocked: true,
          });
        }

        await runStage('codex_final_review', () => runner.runCodexFinalReview());
        if (signal.aborted) throw new Error('Pipeline cancelled');

        applyFinalReviewDecision(task, task.outputs[task.outputs.length - 1]!);
        try {
          store.saveTask(workspaceId, task);
        } catch (jsonErr) {
          syncBridgeTerminalSaveFailure(jsonErr);
        }
        // M2.4 Bridge step 8 (success): Run running→completed, Task keeps
        // in_progress and gains pending_result_run_id; never auto-done.
        if (taskRunService && bridgeRunId && !bridgeTerminalSynced) {
          syncBridgeTerminal(() => taskRunService.completeRunForBridge(workspaceId, bridgeRunId));
        }

        sendEvent('status', {
          taskId,
          status: task.status,
          reviewDecision: task.reviewDecision,
          reviewBlocked: task.reviewBlocked,
        });
        sendEvent('done', {
          taskId,
          status: task.status,
          reviewDecision: task.reviewDecision,
          reviewBlocked: task.reviewBlocked,
        });
      } catch (err) {
        if (err instanceof BridgeTerminalSyncFailedError) throw err;
        if (signal.aborted) {
          task.status = 'cancelled';
          task.currentAgent = null;
          task.error = '任务的实时连接已关闭，执行已取消。';
          task.updatedAt = new Date().toISOString();
          try {
            store.saveTask(workspaceId, task);
          } catch (jsonErr) {
            syncBridgeTerminalSaveFailure(jsonErr);
          }
          // M2.4 Bridge step 8 (disconnect cancel): faithfully record the cancelled Run.
          if (taskRunService && bridgeRunId && !bridgeTerminalSynced && !bridgeTerminalSyncAttempted) {
            syncBridgeTerminal(() => taskRunService.cancelRunForBridge(workspaceId, bridgeRunId));
          }
          sendEvent('status', {
            taskId,
            status: 'cancelled',
            error: 'Cancelled',
            reviewDecision: task.reviewDecision,
            reviewBlocked: task.reviewBlocked,
          });
          sendEvent('done', {
            taskId,
            status: 'cancelled',
            error: 'Cancelled',
            reviewDecision: task.reviewDecision,
            reviewBlocked: task.reviewBlocked,
          });
        } else {
          applyStageFailure(task, err);
          const message = err instanceof Error ? err.message : String(err);
          try {
            store.saveTask(workspaceId, task);
          } catch (jsonErr) {
            syncBridgeTerminalSaveFailure(jsonErr);
          }
          // M2.4 Bridge step 8 (pipeline failure): Run failed with stable failure code.
          if (taskRunService && bridgeRunId && !bridgeTerminalSynced && !bridgeTerminalSyncAttempted) {
            syncBridgeTerminal(() => taskRunService.failRunForBridge(workspaceId, bridgeRunId, message));
          }
          sendEvent('status', {
            taskId,
            status: 'failed',
            error: message,
            reviewDecision: task.reviewDecision,
            reviewBlocked: task.reviewBlocked,
          });
          sendEvent('done', {
            taskId,
            status: 'failed',
            error: message,
            reviewDecision: task.reviewDecision,
            reviewBlocked: task.reviewBlocked,
          });
        }
      }
    })().catch(err => {
      if (err instanceof BridgeTerminalSyncFailedError) {
        console.error(`[AgentOS Server] Bridge terminal sync failed: ${diagnosticText(err.cause)}`);
        if (!responseClosed) {
          sendEvent('error', { taskId, error: 'Bridge persistence failed' });
        }
        return;
      }
      console.error(`[AgentOS Server] Unhandled pipeline rejection: ${diagnosticText(err)}`);
      if (!responseClosed) {
        sendEvent('error', { taskId, error: 'Pipeline failed' });
      }
    }).finally(() => {
      stopHeartbeat();
      responseClosed = true;
      try { res.end(); } catch {}
    });

    res.on('close', () => {
      if (responseClosed) return;
      stopHeartbeat();
      abortController.abort();
    });
  });

  router.get('/:taskId/logs', (req: Request, res: Response) => {
    const { workspaceId, taskId } = req.params as { workspaceId: string; taskId: string };
    const workspace = workspaceManager.get(workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

    const logDir = join(workspace.rootPath, '.agentos', 'logs', taskId);
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
