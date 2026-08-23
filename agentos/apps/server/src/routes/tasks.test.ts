import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskItem, TaskLog } from '@agentos/shared';
import { CLIError } from '@agentos/agent-core';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import {
  applyStageFailure,
  claimTaskRun,
  createTaskRoutes,
  getStageAgentName,
  isContainedPath,
  isValidLegacyTaskId,
  resolveLegacyTaskLogDir,
  touchTaskActivity,
} from './tasks.js';

function makeTask(): TaskItem {
  return {
    id: 'task-1',
    workspaceId: 'ws-1',
    title: 'check project',
    status: 'running',
    currentAgent: 'kimi_worker',
    outputs: [],
    reviewDecision: 'unknown',
    reviewBlocked: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeLog(): TaskLog {
  return {
    stage: 'kimi_worker',
    agentName: 'KimiCode',
    stdout: '1. Checks Run',
    stderr: 'network error',
    exitCode: 1,
    timestamp: '2026-01-01T00:00:00.000Z',
    duration: 42,
    mode: 'real',
  };
}

test('applyStageFailure appends failed stage log when CLIError carries one', () => {
  const task = makeTask();
  const log = makeLog();
  const err = new CLIError('Kimi failed', 'kimi_worker', 1, 'network error', log);

  applyStageFailure(task, err);

  assert.equal(task.status, 'failed');
  assert.equal(task.currentAgent, null);
  assert.equal(task.error, 'Kimi failed');
  assert.deepEqual(task.outputs, [log]);
});

test('applyStageFailure does not append output for generic errors', () => {
  const task = makeTask();

  applyStageFailure(task, new Error('plain failure'));

  assert.equal(task.status, 'failed');
  assert.equal(task.currentAgent, null);
  assert.equal(task.error, 'plain failure');
  assert.deepEqual(task.outputs, []);
});

test('touchTaskActivity records the most recent task activity time', () => {
  const task = makeTask();

  touchTaskActivity(task, '2026-07-11T05:00:00.000Z');

  assert.equal(task.lastActivityAt, '2026-07-11T05:00:00.000Z');
  assert.equal(task.updatedAt, '2026-07-11T05:00:00.000Z');
});

test('claims a task for one run and rejects a second claim while it is running', () => {
  const task = makeTask();
  task.status = 'pending';

  assert.equal(claimTaskRun(task), true);
  assert.equal(task.status, 'running');
  assert.equal(claimTaskRun(task), false);
  assert.equal(task.status, 'running');
});

test('uses custom workspace Agent names before default stage names', () => {
  const workspace = {
    agents: [{ id: 'custom-codex', name: '我的架构师', role: 'codex' as const, enabled: true, cliCommand: 'codex', cliArgs: [] }],
  };

  assert.equal(getStageAgentName(workspace, 'codex_manager'), '我的架构师');
  assert.equal(getStageAgentName({ agents: [] }, 'opencode_reviewer'), 'OpenCode');
});

test('[M27-P4-T001] Legacy TaskItem JSON round-trip preserves the frozen field shape', () => {
  const source = makeTask();
  const roundTripped = JSON.parse(JSON.stringify(source)) as TaskItem;

  assert.deepEqual(roundTripped, source);
  assert.deepEqual(Object.keys(roundTripped).sort(), [
    'createdAt', 'currentAgent', 'id', 'outputs', 'reviewBlocked',
    'reviewDecision', 'status', 'title', 'updatedAt', 'workspaceId',
  ].sort());
});

test('SEC-PATH-01/02 accepts generated-shape and legacy-compatible task IDs', () => {
  for (const taskId of ['a1b2c3d4', 'task-1', 'task_1', 'ABC123']) {
    assert.equal(isValidLegacyTaskId(taskId), true, taskId);
  }
});

test('SEC-PATH-03 rejects traversal and separator-bearing task IDs', () => {
  for (const taskId of ['..', '../outside', '../../outside', '..\\outside', '..\\..\\outside', 'foo/bar', 'foo\\bar', '.']) {
    assert.equal(isValidLegacyTaskId(taskId), false, taskId);
    assert.equal(resolveLegacyTaskLogDir('C:\\workspace', taskId), null, taskId);
  }
});

test('SEC-PATH-04/05 enforces canonical separator-aware log containment', () => {
  const logsRoot = join('C:\\workspace', '.agentos', 'logs');

  assert.equal(isContainedPath(logsRoot, join(logsRoot, 'task-1')), true);
  assert.equal(isContainedPath(logsRoot, join(logsRoot, '..', 'outside')), false);
  assert.equal(isContainedPath(logsRoot, `${logsRoot}-evil`), false);
});

test('SEC-PATH-06 accepts safe logs and rejects decoded traversal without reading outside logs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-task-log-security-'));
  const safeLogDir = join(root, '.agentos', 'logs', 'a1b2c3d4');
  mkdirSync(safeLogDir, { recursive: true });
  writeFileSync(join(safeLogDir, 'stdout.log'), 'safe-log', 'utf8');
  writeFileSync(join(root, '.agentos', 'outside.log'), 'outside-secret', 'utf8');

  const manager = {
    get: (workspaceId: string) => workspaceId === 'workspace-a' ? { rootPath: root } : undefined,
  } as WorkspaceManager;
  const app = express();
  app.use('/api/workspaces/:workspaceId/tasks', createTaskRoutes({} as never, manager));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  try {
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}/api/workspaces/workspace-a/tasks`;
    const safeResponse = await fetch(`${base}/a1b2c3d4/logs`);
    assert.equal(safeResponse.status, 200);
    assert.deepEqual(await safeResponse.json(), { logs: { stdout: 'safe-log' } });

    const traversalResponse = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = http.request({
        hostname: '127.0.0.1',
        port: address.port,
        path: '/api/workspaces/workspace-a/tasks/%2e%2e/logs',
        method: 'GET',
      }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(traversalResponse.status, 400);
    assert.deepEqual(JSON.parse(traversalResponse.body), { error: 'Invalid taskId' });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
