import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import type { Store } from '../store/Store.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { AgentRunner } from '@agentos/agent-core';
import type { AgentStage, TaskItem, TaskLog } from '@agentos/shared';

export function createTaskRoutes(store: Store, workspaceManager: WorkspaceManager): Router {
  const router = Router({ mergeParams: true });

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

    const tasks = store.loadTasks(workspaceId);
    const task: TaskItem = {
      id: randomUUID().slice(0, 8),
      workspaceId,
      title,
      status: 'pending',
      currentAgent: null,
      outputs: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    tasks.push(task);
    store.saveTasks(workspaceId, tasks);

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

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const sendEvent = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    sendEvent('status', { taskId, status: 'running', currentAgent: null });
    task.status = 'running';
    task.outputs = [];
    task.updatedAt = new Date().toISOString();
    store.saveTasks(workspaceId, tasks);

    (async () => {
      const runner = new AgentRunner(workspace, taskId, task.title, (text, done) => {
        const stage = task.currentAgent || 'unknown';
        const agentMap: Record<string, string> = {
          codex_manager: 'Codex',
          kimi_worker: 'KimiCode',
          opencode_reviewer: 'OpenCode',
          codex_final_review: 'Codex',
        };
        sendEvent('thinking', { stage, agentName: agentMap[stage] || stage, text, done });
      });

      try {
        const setCurrentAgent = (stage: AgentStage) => {
          task.currentAgent = stage;
          task.updatedAt = new Date().toISOString();
          store.saveTasks(workspaceId, tasks);
        };

        const runStage = async (stage: AgentStage, label: string, fn: () => Promise<TaskLog>) => {
          setCurrentAgent(stage);
          sendEvent('stage', { stage, agent: label, status: 'running' });
          const log = await fn();
          task.outputs.push(log);
          task.updatedAt = new Date().toISOString();
          store.saveTasks(workspaceId, tasks);
          sendEvent('stage', { stage, status: 'completed', log });
          return log;
        };

        await runStage('codex_manager', 'Codex', () => runner.runCodexManager());
        await runStage('kimi_worker', 'KimiCode', () => runner.runKimiWorker());
        await runStage('opencode_reviewer', 'OpenCode', () => runner.runOpenCodeReviewer());
        await runStage('codex_final_review', 'Codex', () => runner.runCodexFinalReview());

        task.status = 'completed';
        task.currentAgent = null;
        task.updatedAt = new Date().toISOString();
        store.saveTasks(workspaceId, tasks);

        sendEvent('status', { taskId, status: 'completed' });
        sendEvent('done', { taskId, status: 'completed' });
      } catch (err) {
        task.status = 'failed';
        task.currentAgent = null;
        task.updatedAt = new Date().toISOString();
        store.saveTasks(workspaceId, tasks);

        const message = err instanceof Error ? err.message : String(err);
        sendEvent('status', { taskId, status: 'failed', error: message });
        sendEvent('done', { taskId, status: 'failed', error: message });
      } finally {
        res.end();
      }
    })();

    req.on('close', () => {
      // Allow current stage to finish but don't send more events
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
  } catch { /* ignore */ }
}
