import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { createRuntimeInspectorRoutes } from './runtimeInspector.js';
import { ProcessRepository, type ProcessType } from '../store/ProcessRepository.js';

/**
 * Bounded, redacted Runtime Inspector DTO (13-Runtime-Inspector.md).
 *
 * These assertions own the negative half of the Inspector contract: what the DTO
 * must NOT carry. They live beside the projection tests so a new field has to face
 * both the positive and the negative question at review time.
 */

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-inspector-redaction-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({
    workspaces: [{
      id: 'workspace-a', name: 'Workspace A', rootPath: root, gitEnabled: true, memoryEnabled: true,
      agents: [{ id: 'codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [] }],
      lastOpenedAt: '2026-07-12T00:00:00.000Z', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z',
    }],
  }), 'utf-8');
  return root;
}

async function withServer(run: (baseUrl: string, store: SqliteStore) => Promise<void>): Promise<void> {
  const root = createProjectRoot();
  const store = new SqliteStore(root);
  const app = express();
  const server = app.listen(0);
  try {
    app.use(express.json());
    app.use('/api/workspaces/:workspaceId/runtime', createRuntimeInspectorRoutes(store, new WorkspaceManager(store)));
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}/api/workspaces/workspace-a/runtime`, store);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function seedRun(store: SqliteStore): { taskId: string; runId: string } {
  const task = store.taskRepository().insert({ workspaceId: 'workspace-a', title: 'T', createdBy: 'user' });
  const run = store.runRepository().insert({ workspaceId: 'workspace-a', taskId: task.id, origin: 'v2_api', createdBy: 'user' });
  return { taskId: task.id, runId: run.id };
}

interface ProcessSeed {
  readonly processType: string;
  readonly args: readonly string[];
  /** Planted ONLY for a provider process, in a column the DTO must not project. */
  readonly canaries?: {
    readonly recoveryTokenHash: string;
    readonly platformHandleId: string;
  };
}

/** Seeds one observed Process through the real repository and returns its id. */
function seedProcess(store: SqliteStore, ids: { taskId: string; runId: string }, process: ProcessSeed): string {
  const db = store.getDatabase();
  const created = new ProcessRepository(db).createProcess({
    workspaceId: 'workspace-a', taskId: ids.taskId, runId: ids.runId,
    processType: process.processType as ProcessType,
    platform: 'windows', executableResolved: 'codex',
    argsRedacted: process.args, cwdResolved: 'C:\\workspace',
    shell: 0, detached: 0, stdinMode: 'closed', stdoutMode: 'capture', stderrMode: 'capture',
    timeoutPolicy: { timeoutMs: 60000 }, securityProfileRef: 'default',
  });
  assert.equal(created.kind, 'created');
  const processId = created.process.id;
  if (process.canaries !== undefined) {
    // The recovery/identity columns are written by later lifecycle steps, not by
    // create. They are exactly the columns the Inspector must never project, so the
    // canaries are planted there and the absence proof below becomes meaningful.
    db.prepare('UPDATE runtime_processes SET recovery_token_hash = ?, platform_handle_id = ? WHERE id = ?')
      .run(process.canaries.recoveryTokenHash, process.canaries.platformHandleId, processId);
  }
  return processId;
}

/**
 * LITE-13-013: the Inspector DTO carries no secret material.
 *
 * Two independent proofs. First, canaries planted in runtime_processes columns the
 * projection does not read (the recovery token hash, the claim owner and the native
 * platform handle) must not appear anywhere in the serialized response. Second, the
 * exact key set of every DTO level is asserted, so a new field cannot start leaking
 * values silently - adding one has to be a deliberate, reviewed change to that list.
 */
test('LITE-13-013 the Inspector projection exposes no secret material and a frozen key set', async () => {
  await withServer(async (baseUrl, store) => {
    const ids = seedRun(store);
    const canaryRecoveryToken = 'CANARY-RECOVERY-TOKEN-4f9a2c';
    const canaryClaimOwner = 'CANARY-CLAIM-OWNER-91be07';
    const canaryHandle = 'CANARY-PLATFORM-HANDLE-77d1';
    seedProcess(store, ids, {
      processType: 'provider',
      args: ['exec', '--model', '[redacted]'],
      canaries: { recoveryTokenHash: canaryRecoveryToken, platformHandleId: canaryHandle },
    });

    const response = await fetch(`${baseUrl}/runs/${ids.runId}/inspector`);
    assert.equal(response.status, 200);
    const raw = await response.text();
    for (const canary of [canaryRecoveryToken, canaryClaimOwner, canaryHandle]) {
      assert.equal(raw.includes(canary), false, `secret canary leaked into the DTO: ${canary}`);
    }

    const body = JSON.parse(raw) as { projection: Record<string, unknown> };
    assert.deepEqual(Object.keys(body.projection).sort(), [
      'compaction', 'events', 'highWatermark', 'memoryContext', 'overview',
      'operations', 'processes', 'providerSessions', 'stages', 'truncated',
    ].sort(), 'the projection key set changed - review whether the new field can leak');
    const processes = body.projection.processes as Array<Record<string, unknown>>;
    assert.equal(processes.length, 1);
    const processKeys = Object.keys(processes[0]!).sort();
    for (const forbidden of ['recoveryTokenHash', 'claimOwnerId', 'platformHandleId']) {
      assert.equal(processKeys.includes(forbidden), false,
        `the process summary must not expose ${forbidden}`);
    }
    // The projected facts are the redacted/resolved columns by construction, which is
    // what makes the canary absence above meaningful rather than accidental.
    assert.equal(processes[0]!.argsRedacted, JSON.stringify(['exec', '--model', '[redacted]']));
    assert.equal(processes[0]!.processType, 'provider');
  });
});

/**
 * LITE-13-009: the Inspector offers no reattach, takeover or direct-kill control.
 *
 * The Inspector is a read surface, so the proof is two-sided: the route answers reads
 * and rejects every mutating method, and the projection carries no control-shaped
 * field a client could use to steer a Process.
 */
test('LITE-13-009 the Inspector is read-only and carries no process control field', async () => {
  await withServer(async (baseUrl, store) => {
    const ids = seedRun(store);
    const inspectorUrl = `${baseUrl}/runs/${ids.runId}/inspector`;

    assert.equal((await fetch(inspectorUrl)).status, 200, 'the read is served');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await fetch(inspectorUrl, { method, headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 404,
        `${method} must not be routed: the Inspector exposes no reattach, takeover or direct-kill control`);
    }

    const body = await fetch(inspectorUrl).then(r => r.json()) as { projection: Record<string, unknown> };
    const controlKeys: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) { for (const item of value) walk(item); return; }
      if (typeof value !== 'object' || value === null) return;
      for (const [key, child] of Object.entries(value)) {
        if (/reattach|takeover|kill|signal|attach|force_?stop|terminateNow/i.test(key)) controlKeys.push(key);
        walk(child);
      }
    };
    walk(body.projection);
    assert.deepEqual(controlKeys, [], 'the Inspector DTO exposes no control field');
  });
});

/**
 * LITE-13-007: the Inspector's Git wording never implies ownership.
 *
 * A Git process is projected with observation vocabulary only: the DTO names the
 * process type, platform and status facts, and it never offers a Git mutation or a
 * claim that AgentOS owns the workflow.
 */
test('LITE-13-007 the Inspector describes Git work as observation and offers no Git mutation', async () => {
  await withServer(async (baseUrl, store) => {
    const ids = seedRun(store);
    seedProcess(store, ids, {
      processType: 'git',
      args: ['status', '--porcelain=v2'],
    });

    const body = await fetch(`${baseUrl}/runs/${ids.runId}/inspector`).then(r => r.json()) as {
      projection: { processes: Array<{ processType: string; argsRedacted: string }> };
    };
    const gitProcess = body.projection.processes.find(process => process.processType === 'git');
    assert.ok(gitProcess, 'the Git process is projected as its own observed process');
    assert.equal(JSON.parse(gitProcess!.argsRedacted)[0], 'status',
      'the recorded arguments are a read-only Git command, which is what observation records');
    const serialized = JSON.stringify(body.projection);
    for (const mutation of ['commit', 'push', 'merge', 'rebase', 'checkout', 'stash', 'reset', 'branch']) {
      assert.equal(new RegExp('\\b' + mutation + '\\b', 'i').test(serialized), false,
        `the Inspector must not offer the Git mutation '${mutation}'`);
    }
    assert.equal(/ownership of git|agentos-owned git|agentos owns/i.test(serialized), false,
      'no wording may imply AgentOS owns the Git workflow');
  });
});
