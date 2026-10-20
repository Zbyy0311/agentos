import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  DurableProcessCoordinator,
  FileArtifactSink,
  NodeProcessDriver,
  SecretScanner,
} from '@agentos/process-runtime';
import type { ProcessStopResult } from '@agentos/process-runtime';
import { SqliteStore } from '../store/SqliteStore.js';
import {
  DurableOutputReferenceRepositoryAdapter,
  DurableProcessRepositoryAdapter,
  DurableSessionRepositoryAdapter,
} from '../store/process-runtime-adapters.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';

import { createProcessRoutes } from './processes.js';

const NOW = '2026-10-20T00:00:00.000Z';

interface Harness {
  baseUrl: string;
  store: SqliteStore;
  root: string;
  artifactRoot: string;
  stopCalls: Array<{ workspaceId: string; processId: string; reason?: string }>;
}

async function withServer(
  run: (harness: Harness) => Promise<void>,
  options: { memoryOutputReader?: NonNullable<Parameters<typeof createProcessRoutes>[2]['memoryOutputReader']> } = {},
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'agentos-process-routes-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({
    workspaces: [{
      id: 'workspace-a', name: 'Workspace A', rootPath: root, gitEnabled: true, memoryEnabled: true,
      agents: [{ id: 'codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [] }],
      lastOpenedAt: NOW, createdAt: NOW, updatedAt: NOW,
    }],
  }), 'utf-8');
  const artifactRoot = join(root, 'artifacts');
  const store = new SqliteStore(root);
  const stopCalls: Harness['stopCalls'] = [];
  const app = express();
  const server = app.listen(0);
  try {
    app.use(express.json());
    app.use('/api/workspaces/:workspaceId', createProcessRoutes(store, new WorkspaceManager(store), {
      artifactRoot,
      stopProcess: async (input) => {
        stopCalls.push(input);
        const process = store.processRepository().findById(input.workspaceId, input.processId);
        return {
          process: process as never,
          cleanup: null,
          proven: true,
          stopAccepted: true,
          authority: 'active-stop',
          cleanupRequired: false,
          reason: input.reason ?? 'api-stop',
          stopOrigin: 'EXPLICIT_CANCEL',
        } as ProcessStopResult;
      },
      ...(options.memoryOutputReader === undefined ? {} : { memoryOutputReader: options.memoryOutputReader }),
    }));
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    await run({
      baseUrl: `http://127.0.0.1:${address.port}/api/workspaces/workspace-a`,
      store,
      root,
      artifactRoot,
      stopCalls,
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

let seedSeq = 0;
let stageSequence = 0;

interface RunSeed {
  taskId: string;
  runId: string;
  snapshotId: string;
  agentId: string;
  pcfgId: string;
}

function nextId(prefix: string): string {
  seedSeq += 1;
  return prefix + '_' + String(seedSeq).padStart(26, '0');
}

function seedRun(store: SqliteStore): RunSeed {
  const task = store.taskRepository().insert({ workspaceId: 'workspace-a', title: 'T', createdBy: 'user' });
  const run = store.runRepository().insert({ workspaceId: 'workspace-a', taskId: task.id, origin: 'v2_api', createdBy: 'user' });
  const snapshotId = nextId('snapshot');
  const pcfgId = nextId('pcfg');
  const agentId = nextId('agent');
  const db = store.getDatabase();
  db.prepare(`
    INSERT INTO run_snapshots (id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version, snapshot_json, content_hash, captured_at)
    VALUES (?, 'workspace-a', ?, 'workflow_00000000000000000000000002', 1, '{}', ?, ?)
  `).run(snapshotId, run.id, 'a'.repeat(64), NOW);
  db.prepare(`
    INSERT INTO provider_configurations (id, workspace_id, name, provider_type, adapter_id, runtime_mode, executable, capabilities_json, timeout_policy_json, approval_mode, output_mode, enabled, version, created_at, updated_at)
    VALUES (?, 'workspace-a', 'Test Provider', 'kimicode', 'builtin.kimicode', 'cli', 'kimicode.exe', '{}', '{}', 'disabled', 'structured', 1, 1, ?, ?)
  `).run(pcfgId, NOW, NOW);
  db.prepare(`
    INSERT INTO agent_profiles (workspace_id, id, name, agent_role, role_title, system_prompt, permissions_json, enabled, cli_command, cli_args_json, created_at, updated_at)
    VALUES ('workspace-a', ?, 'Codex', 'codex', 'Manager', 'prompt', '[]', 1, 'codex', '[]', ?, ?)
  `).run(agentId, NOW, NOW);
  return { taskId: task.id, runId: run.id, snapshotId, agentId, pcfgId };
}

function seedProcess(store: SqliteStore, seed: RunSeed, overrides: Record<string, unknown> = {}) {
  const stageId = nextId('stage');
  const sessionId = nextId('psess');
  const db = store.getDatabase();
  db.prepare(`
    INSERT INTO run_stages (id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name, sequence, attempt, status, created_at, updated_at, version)
    VALUES (?, 'workspace-a', ?, ?, ?, 'build', ?, 1, 'running', ?, ?, 1)
  `).run(stageId, seed.runId, seed.snapshotId, 'stage-key-' + stageId.slice(-12), ++stageSequence, NOW, NOW);
  db.prepare(`
    INSERT INTO provider_sessions (id, workspace_id, task_id, run_id, stage_id, stage_attempt, authority_role, agent_id, provider_config_id, provider_config_version, provider_type, adapter_id, adapter_version, config_schema_version, runtime_mode, status, started_at, claim_epoch, capabilities_json, created_at, updated_at, version)
    VALUES (?, 'workspace-a', ?, ?, ?, 1, 'primary-provider', ?, ?, 1, 'codex', 'builtin.codex', '1.0.0', 1, 'cli', 'active', ?, 1, '{}', ?, ?, 1)
  `).run(sessionId, seed.taskId, seed.runId, stageId, seed.agentId, seed.pcfgId, NOW, NOW, NOW);
  return store.processRepository().createProcess({
    workspaceId: 'workspace-a',
    taskId: seed.taskId,
    runId: seed.runId,
    stageId,
    stageAttempt: 1,
    providerSessionId: sessionId,
    authorityRole: 'primary-provider',
    claimEpoch: 1,
    processType: 'provider',
    platform: process.platform,
    executableResolved: process.execPath,
    argsRedacted: ['[REDACTED]'],
    cwdResolved: process.cwd(),
    shell: 0,
    detached: 0,
    stdinMode: 'closed',
    stdoutMode: 'capture',
    stderrMode: 'capture',
    timeoutPolicy: { graceMs: 5000 },
    securityProfileRef: 'secprofile_default',
    createdAt: NOW,
    eventContext: { correlationId: 'corr_test', causationId: 'cause_test' },
    ...overrides,
  }).process;
}

async function json(response: Awaited<ReturnType<typeof fetch>>): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

test('GET /runs/:runId/processes lists run processes and enforces workspace bounds', async () => {
  await withServer(async ({ baseUrl, store }) => {
    const seed = seedRun(store);
    const process = seedProcess(store, seed);
    const other = seedProcess(store, seed, { authorityRole: undefined, providerSessionId: undefined, stageId: undefined, stageAttempt: undefined, parentProcessId: process.id });

    const ok = await json(await fetch(`${baseUrl}/runs/${seed.runId}/processes`));
    assert.equal(ok.status, 200);
    const processes = (ok.body.processes as Array<{ id: string }>).map((entry) => entry.id);
    assert.ok(processes.includes(process.id));
    assert.ok(processes.includes(other.id));

    const missingRun = await json(await fetch(`${baseUrl}/runs/run_missing/processes`));
    assert.equal(missingRun.status, 404);
    assert.equal(missingRun.body.code, 'RUN_NOT_FOUND');

    const wrongWorkspace = await json(await fetch(`${baseUrl.replace('workspace-a', 'workspace-b')}/runs/${seed.runId}/processes`));
    assert.equal(wrongWorkspace.status, 404);
  });
});

test('GET /processes/:id and /tree return the snapshot and parent/child hierarchy', async () => {
  await withServer(async ({ baseUrl, store }) => {
    const seed = seedRun(store);
    const parent = seedProcess(store, seed);
    const child = seedProcess(store, seed, {
      authorityRole: undefined,
      providerSessionId: undefined,
      stageId: undefined,
      stageAttempt: undefined,
      parentProcessId: parent.id,
    });

    const one = await json(await fetch(`${baseUrl}/processes/${parent.id}`));
    assert.equal(one.status, 200);
    assert.equal((one.body.process as { id: string }).id, parent.id);

    const tree = await json(await fetch(`${baseUrl}/processes/${parent.id}/tree`));
    assert.equal(tree.status, 200);
    const root = tree.body.tree as { process: { id: string }; children: Array<{ process: { id: string }; children: unknown[] }> };
    assert.equal(root.process.id, parent.id);
    assert.equal(root.children.length, 1);
    assert.equal(root.children[0].process.id, child.id);
    assert.deepEqual(root.children[0].children, []);

    const missing = await json(await fetch(`${baseUrl}/processes/proc_missing`));
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'PROCESS_NOT_FOUND');
  });
});

test('GET /processes/:id/events pages durable events bound to the process', async () => {
  await withServer(async ({ baseUrl, store }) => {
    const seed = seedRun(store);
    const process = seedProcess(store, seed);
    // Process creation itself appends a durable fact bound to the process.
    const page = await json(await fetch(`${baseUrl}/processes/${process.id}/events`));
    assert.equal(page.status, 200);
    const events = (page.body.events as Array<{ event: { processId?: string; sequence: number } }>)
      .map((entry) => entry.event);
    assert.ok(events.length >= 1);
    assert.ok(events.every((event) => event.processId === process.id));
    assert.equal(page.body.hasMore, false);

    const pastEnd = await json(await fetch(`${baseUrl}/processes/${process.id}/events?afterSequence=999999`));
    assert.equal(pastEnd.status, 200);
    assert.deepEqual(pastEnd.body.events, []);
    assert.equal(pastEnd.body.hasMore, false);

    const bad = await json(await fetch(`${baseUrl}/processes/${process.id}/events?limit=0`));
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'VALIDATION_FAILED');
  });
});

test('GET /processes/:id/output reads the real subprocess artifact with sha256 and pagination', async () => {
  await withServer(async ({ baseUrl, store, artifactRoot }) => {
    const seed = seedRun(store);
    const secret = 'srv-artifact-secret-998877';
    const process = seedProcess(store, seed);

    // Drive a real child through the durable output pipeline exactly like the
    // stage coordinator drains: scan-mode redaction before every sink append.
    const driver = new NodeProcessDriver();
    const coordinator = new DurableProcessCoordinator({
      sessionRepository: new DurableSessionRepositoryAdapter(store.providerSessionRepository()),
      processRepository: new DurableProcessRepositoryAdapter(store.processRepository()),
      outputReferenceRepository: new DurableOutputReferenceRepositoryAdapter(store.processOutputReferenceRepository()),
      artifactSink: new FileArtifactSink(artifactRoot),
      atomicSeam: store.atomicSeam(),
      driver,
    });
    const writer = await coordinator.beginOutput({
      workspaceId: 'workspace-a',
      runId: seed.runId,
      processId: process.id,
      stream: 'stdout',
      storageKey: 'sink/workspace-a/stdout/' + process.id,
      contentType: 'text/plain',
      encoding: 'utf-8',
      redactionMode: 'scan',
      eventContext: { correlationId: 'corr_test', causationId: 'cause_test' },
    });
    const handle = await driver.spawn({
      executable: globalThis.process.execPath,
      args: ['-e', 'console.log("line one visible");console.log("token srv-artifact-secret-998877 leaked");console.log("line three visible");'],
      cwd: globalThis.process.cwd(),
      env: Object.fromEntries(
        Object.entries(globalThis.process.env).filter(([, value]) => value !== undefined),
      ) as Record<string, string>,
      envDiagnostics: [],
      shell: false,
    });
    const scanner = new SecretScanner([secret]);
    let offset = 0;
    for await (const chunk of handle.streams.stdout) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer);
      const redacted = scanner.push(bytes);
      const outcome = await writer.append({
        stream: 'stdout',
        sequence: offset + 1,
        sourceOffset: offset,
        sourceBytes: bytes.length,
        bytes: redacted,
        text: '',
        binary: false,
      });
      if (outcome.kind !== 'applied' && outcome.kind !== 'duplicate') throw new Error('append failed: ' + outcome.kind);
      offset += bytes.length;
    }
    const tail = scanner.flush();
    if (tail.length > 0) {
      await writer.append({
        stream: 'stdout',
        sequence: offset + 1,
        sourceOffset: offset,
        sourceBytes: scanner.carryLength,
        bytes: tail,
        text: '',
        binary: false,
      });
    }
    const finalized = await writer.finalize();
    assert.match(finalized.sha256, /^[0-9a-f]{64}$/);

    const first = await json(await fetch(`${baseUrl}/processes/${process.id}/output?stream=stdout`));
    assert.equal(first.status, 200);
    assert.equal(first.body.source, 'artifact');
    assert.equal(first.body.stream, 'stdout');
    assert.equal(typeof first.body.text, 'string');
    const text = first.body.text as string;
    assert.ok(text.includes('line one visible'));
    assert.ok(!text.includes(secret), 'secret must be redacted from the artifact');
    assert.ok(text.includes('[REDACTED]'));
    const artifact = first.body.artifact as { sha256: string; finalized: boolean };
    assert.equal(artifact.sha256, finalized.sha256);
    assert.equal(artifact.finalized, true);

    // Pagination: offset/limit paging over the same artifact.
    const page = await json(await fetch(`${baseUrl}/processes/${process.id}/output?stream=stdout&offset=0&limit=10`));
    assert.equal(page.status, 200);
    assert.equal(page.body.offset, 0);
    assert.equal((page.body.text as string).length, 10);
    assert.equal(page.body.nextOffset, 10);
    const page2 = await json(await fetch(`${baseUrl}/processes/${process.id}/output?stream=stdout&offset=${String(page.body.nextOffset)}&limit=100000`));
    assert.equal(page2.status, 200);
    assert.equal(page2.body.offset, 10);
    assert.ok((page2.body.text as string).includes('line three visible'));

    // sha256 in the response matches the artifact bytes on disk.
    const fileBytes = (await import('node:fs/promises')).readFile(join(artifactRoot, 'sink', 'workspace-a', 'stdout', process.id));
    assert.equal(createHash('sha256').update(await fileBytes).digest('hex'), finalized.sha256);

    // 400 shapes.
    const badStream = await json(await fetch(`${baseUrl}/processes/${process.id}/output`));
    assert.equal(badStream.status, 400);
    const badLimit = await json(await fetch(`${baseUrl}/processes/${process.id}/output?stream=stdout&limit=0`));
    assert.equal(badLimit.status, 400);
    const missing = await json(await fetch(`${baseUrl}/processes/proc_missing/output?stream=stdout`));
    assert.equal(missing.status, 404);
  });
});

test('GET /processes/:id/output marks the memory fallback and the unavailable marker', async () => {
  const memoryOutputReader = () => ({ text: 'buffered stdout', retainedBytes: 15 });
  await withServer(async ({ baseUrl, store }) => {
    const seed = seedRun(store);
    const process = seedProcess(store, seed);
    const fallback = await json(await fetch(`${baseUrl}/processes/${process.id}/output?stream=stdout`));
    assert.equal(fallback.status, 200);
    assert.equal(fallback.body.source, 'memory');
    assert.equal(fallback.body.text, 'buffered stdout');
    assert.deepEqual(fallback.body.warnings, ['PROCESS_OUTPUT_FALLBACK_MEMORY']);
    assert.equal(fallback.body.artifact, null);
  }, { memoryOutputReader });

  await withServer(async ({ baseUrl, store }) => {
    const seed = seedRun(store);
    const process = seedProcess(store, seed);
    const none = await json(await fetch(`${baseUrl}/processes/${process.id}/output?stream=stderr`));
    assert.equal(none.status, 200);
    assert.equal(none.body.source, 'none');
    assert.deepEqual(none.body.warnings, ['PROCESS_OUTPUT_ARTIFACT_UNAVAILABLE']);
  });
});

test('POST /processes/:id/stop is idempotent-shaped and validates input', async () => {
  await withServer(async ({ baseUrl, store, stopCalls }) => {
    const seed = seedRun(store);
    const process = seedProcess(store, seed);

    const first = await json(await fetch(`${baseUrl}/processes/${process.id}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'operator request' }),
    }));
    assert.equal(first.status, 200);
    assert.equal(first.body.stopAccepted, true);
    assert.equal(first.body.reason, 'operator request');
    assert.equal(stopCalls.length, 1);

    const second = await json(await fetch(`${baseUrl}/processes/${process.id}/stop`, { method: 'POST' }));
    assert.equal(second.status, 200);
    // The route layer remains a stable 200; durable idempotency (single stop
    // ticket per Process) is owned by the ProcessCancelCoordinator.
    assert.equal(second.body.stopAccepted, true);

    const badReason = await json(await fetch(`${baseUrl}/processes/${process.id}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 42 }),
    }));
    assert.equal(badReason.status, 400);

    const missing = await json(await fetch(`${baseUrl}/processes/proc_missing/stop`, { method: 'POST' }));
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'PROCESS_NOT_FOUND');
  });
});
