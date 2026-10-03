import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net, { type AddressInfo } from 'node:net';
import type { Workspace } from '@agentos/shared';
import { DEFAULT_WORKSPACE_AGENTS } from '@agentos/agent-core';
import { SqliteStore } from './store/SqliteStore.js';
import { CollaborationRepository } from './store/CollaborationRepository.js';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = join(SERVER_DIR, 'index.ts');
const SERVER_CWD = resolve(SERVER_DIR, '..');
const COMPILED_SERVER_ENTRY = join(SERVER_CWD, 'dist', 'index.js');

interface SpawnedServer {
  readonly child: ChildProcess;
  readonly port: number;
  output(): string;
}

function fetchFixture(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(url, { ...init, signal });
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>(resolvePromise => { timer = setTimeout(() => resolvePromise(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function spawnServer(root: string, port: number, receipt: string, worktreeRoot?: string, capabilityReceipt?: string): SpawnedServer {
  let output = '';
  const useCompiledServer = process.env.AGENTOS_P2_RESTART_COMPILED === 'true';
  if (useCompiledServer && !existsSync(COMPILED_SERVER_ENTRY)) {
    throw new Error(`compiled restart fixture requested but server build is missing: ${COMPILED_SERVER_ENTRY}`);
  }
  const child = spawn(process.execPath, useCompiledServer
    ? [COMPILED_SERVER_ENTRY]
    : ['--import', 'tsx', SERVER_ENTRY], {
    cwd: SERVER_CWD,
    env: {
      ...process.env,
      AGENTOS_PROJECT_ROOT: root,
      AGENTOS_FORCE_MOCK: 'false',
      AGENTOS_RUNTIME_DISPATCH_ENABLED: 'true',
      AGENTOS_P2_PROVIDER_RECEIPT: receipt,
      ...(capabilityReceipt === undefined ? {} : { AGENTOS_P2_CAPABILITY_RECEIPT: capabilityReceipt }),
      ...(worktreeRoot === undefined ? {} : { AGENTOS_WORKTREE_ROOT: worktreeRoot }),
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', chunk => { output += String(chunk); });
  child.stderr?.on('data', chunk => { output += String(chunk); });
  return { child, port, output: () => output };
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
  return port;
}

async function waitForHealthy(port: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError = 'not attempted';
  while (Date.now() < deadline) {
    try {
      const response = await fetchFixture(`http://127.0.0.1:${port}/api/health`, {}, 2_000);
      await response.arrayBuffer();
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) { lastError = String(error); }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
  }
  throw new Error(`server health timed out: ${lastError}`);
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolvePromise, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    };
    const onExit = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise();
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('server process exit timed out'));
    }, 20_000);
    child.once('exit', onExit);
    child.once('error', onError);
    if (child.exitCode !== null || child.signalCode !== null) onExit();
  });
}

function killServer(server: SpawnedServer | undefined): void {
  if (server && server.child.exitCode === null && server.child.signalCode === null) server.child.kill('SIGKILL');
}

async function waitForFile(path: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, 'utf8').trim().length > 0) return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error(`provider invocation receipt did not appear: ${path}`);
}

async function waitForLineCount(path: string, count: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, 'utf8').trim().split(/\r?\n/u).length >= count) return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error(`provider receipt did not reach ${count} calls: ${path}`);
}

async function waitForGroupProviderEvidence(
  root: string, conversationId: string, interactionId: string, providerPids: readonly number[],
): Promise<void> {
  const store = new SqliteStore(root);
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const events = store.groupInteractionRepository()
        .listExecutionEvents('workspace-a', conversationId, interactionId, 0)
        .filter(event => event.eventType === 'group.provider.started');
      if (events.length >= providerPids.length) {
        assert.deepEqual(events.map(event => event.payload.pid), providerPids,
          'durable owner evidence must identify the exact Provider calls observed by the fixture');
        return;
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
    }
    throw new Error('the active group Provider did not finish its durable owner binding');
  } finally { store.close(); }
}

function findNamedFile(root: string, name: string): string | undefined {
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const nested = findNamedFile(path, name);
      if (nested) return nested;
    }
  }
  return undefined;
}

async function waitForNamedFile(root: string, name: string, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const path = findNamedFile(root, name);
    if (path) return path;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error(`${name} did not appear under ${root}`);
}

async function waitForRuntimeApproval(port: number, workspaceId: string, timeoutMs = 30_000): Promise<{ id: string; version: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchFixture(`http://127.0.0.1:${port}/api/workspaces/${workspaceId}/runtime-approvals`);
      if (response.ok) {
        const body = await response.json() as { requests?: Array<{ id: string; version: number; status: string }> };
        const pending = body.requests?.find(request => request.status === 'pending');
        if (pending) return pending;
      } else {
        await response.arrayBuffer();
      }
    } catch { /* the app may still be starting its Run */ }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error('runtime approval request did not appear');
}

async function waitForFailedCollaborationRun(root: string, taskId: string, timeoutMs = 45_000): Promise<{
  taskVersion: number; runId: string; runVersion: number; failureCode?: string;
}> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const store = new SqliteStore(root);
    try {
      const task = new CollaborationRepository(store.getDatabase()).findById('workspace-a', taskId);
      const run = task?.canonicalRunId && store.runRepository().findById('workspace-a', task.canonicalRunId);
      if (task && run && ['failed', 'blocked'].includes(task.status) && run.status === 'failed') {
        return {
          taskVersion: task.version, runId: run.id, runVersion: run.version,
          ...(run.failureCode === undefined ? {} : { failureCode: run.failureCode }),
        };
      }
    } finally { store.close(); }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error('collaboration task did not reach a failed Run');
}

function compileFakeCodexExecutable(root: string, structuredOutput = true): string {
  const sourcePath = join(root, 'p2-fake-codex.cs');
  const scriptPath = join(root, 'p2-compile-fake-codex.ps1');
  const executablePath = join(root, 'p2-fake-codex.exe');
  const helpOutput = structuredOutput ? 'codex exec --json --sandbox --skip-git-repo-check' : 'codex exec --sandbox --skip-git-repo-check';
  writeFileSync(sourcePath, [
    'using System;',
    'using System.Diagnostics;',
    'using System.IO;',
    'using System.Threading;',
    'public static class P2FakeCodex {',
    '  public static int Main(string[] args) {',
    '    string joined = String.Join(" ", args);',
    '    if (args.Length == 1 && args[0] == "--version") { Console.WriteLine("codex 1.0.0"); return 0; }',
    '    if (joined.Contains("exec") && joined.Contains("--help")) {',
    '      string capabilityReceipt = Environment.GetEnvironmentVariable("AGENTOS_P2_CAPABILITY_RECEIPT");',
    '      if (!String.IsNullOrWhiteSpace(capabilityReceipt)) File.AppendAllText(capabilityReceipt, Process.GetCurrentProcess().Id + "\\n");',
    `      Console.WriteLine(${JSON.stringify(helpOutput)});`,
    '      return 0;',
    '    }',
    '    if (joined.Contains("exec") && joined.Contains("--json")) {',
    '      string cwd = Directory.GetCurrentDirectory();',
    '      string receipt = "{\\"pid\\":" + Process.GetCurrentProcess().Id + ",\\"cwd\\":\\"" + cwd.Replace("\\\\", "\\\\\\\\") + "\\"}\\n";',
    '      File.AppendAllText(Path.Combine(cwd, "p2-provider-invocation.jsonl"), receipt);',
    '      File.WriteAllText(Path.Combine(cwd, "p2-unknown-side-effect.txt"), "provider wrote before restart\\n");',
    '      Console.Error.WriteLine("P2_FAKE_PROVIDER_STARTED");',
    '      Thread.Sleep(Timeout.Infinite);',
    '      return 0;',
    '    }',
    '    Console.Error.WriteLine("P2_FAKE_CODEX_UNEXPECTED_ARGS " + joined);',
    '    return 2;',
    '  }',
    '}',
  ].join('\n'), 'utf8');
  const psLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
  writeFileSync(scriptPath,
    `$ErrorActionPreference = 'Stop'\nAdd-Type -Path ${psLiteral(sourcePath)} -OutputAssembly ${psLiteral(executablePath)} -OutputType ConsoleApplication\nWrite-Output ${psLiteral(executablePath)}\n`,
    'utf8');
  const powershell = join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', scriptPath], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
  assert.equal(result.status, 0, `fake Codex compilation failed: ${result.stderr}`);
  assert.ok(existsSync(executablePath), 'the controlled provider executable must exist');
  return executablePath;
}

async function waitForPidsToExit(pids: readonly number[], timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const stillAlive = (): number[] => pids.filter(pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  });
  while (Date.now() < deadline) {
    if (stillAlive().length === 0) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.deepEqual(stillAlive(), [], 'server-owned Windows Job must reap the old Provider without a test-side kill');
}

async function postJson(url: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const response = await fetchFixture(url, { method: 'POST', headers: { 'content-type': 'application/json', ...extraHeaders }, body: JSON.stringify(body) });
  return { status: response.status, json: await response.json() };
}

function initializeGit(root: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'README.md'), 'P2 recovery fixture\n');
  const run = (args: string[]) => {
    const result = spawnSyncGit(args, root);
    assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}`);
  };
  run(['init', '-q']);
  run(['config', 'user.email', 'p2-recovery@example.invalid']);
  run(['config', 'user.name', 'P2 Recovery Fixture']);
  run(['add', 'README.md']);
  run(['commit', '-q', '-m', 'fixture baseline']);
}

function spawnSyncGit(args: string[], cwd: string): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { status: result.status, stderr: result.stderr ?? '', stdout: result.stdout ?? '' };
}

test('P2 reproduction: an active real group Provider is reaped on restart before linked recovery', {
  timeout: 180_000, skip: process.platform !== 'win32',
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-p2-group-restart-'));
  const workspaceRoot = join(root, 'workspace');
  const receipt = join(root, 'provider-invocations.jsonl');
  initializeGit(workspaceRoot);
  const now = new Date().toISOString();
  const speakerScript = [
    "const fs=require('node:fs');",
    "const prior=fs.existsSync(process.env.AGENTOS_P2_PROVIDER_RECEIPT)?fs.readFileSync(process.env.AGENTOS_P2_PROVIDER_RECEIPT,'utf8').trim().split(/\\r?\\n/).filter(Boolean).length:0;",
    "fs.appendFileSync(process.env.AGENTOS_P2_PROVIDER_RECEIPT,JSON.stringify({pid:process.pid,taskId:process.env.AGENTOS_TASK_ID,cwd:process.cwd()})+'\\n');",
    "if(prior===0){process.stdout.write('original reply preserved after recovery\\n');}else{process.stdout.write('speaker invocation started\\n');setInterval(()=>{},1000);}",
  ].join('');
  const workspace: Workspace = {
    id: 'workspace-a', name: 'P2 group recovery', rootPath: workspaceRoot, gitEnabled: true, memoryEnabled: false,
    agents: structuredClone(DEFAULT_WORKSPACE_AGENTS).map(agent => ({
      ...agent, provider: 'custom', cliCommand: process.execPath, cliArgs: ['-e', speakerScript],
    })),
    lastOpenedAt: now, createdAt: now, updatedAt: now,
  };
  const seed = new SqliteStore(root);
  try {
    seed.saveWorkspaces([workspace]);
    seed.getDatabase().prepare('UPDATE agent_profiles SET permissions_json = ? WHERE workspace_id = ?')
      .run(JSON.stringify(['read', 'write']), workspace.id);
  } finally { seed.close(); }

  const port = await freePort();
  let server = spawnServer(root, port, receipt);
  let cliPids: number[] = [];
  let responseDrain: Promise<unknown> | undefined;
  const responseControllers: AbortController[] = [];
  let testFailed = false;
  try {
    await waitForHealthy(port);
    const base = `http://127.0.0.1:${port}/api/workspaces/workspace-a/runtime`;
    const created = await postJson(`${base}/conversations`, {
      kind: 'group', replyMode: 'sequential', memberAgentIds: ['codex', 'kimi'],
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const conversationId = created.json.conversation.id as string;
    const discussion = await postJson(`${base}/conversations/${conversationId}/discussions`, {
      content: 'Speak once and preserve your reply history.', clientMessageId: 'p2-restart-source',
      budget: { maxAgentsPerTurn: 2, maxRepliesPerAgent: 1, maxTotalReplies: 2, maxAgentHops: 2 },
    });
    assert.equal(discussion.status, 201, JSON.stringify(discussion.json));
    const interactionId = discussion.json.interaction.id as string;
    const sourceMessageId = discussion.json.message.id as string;
    const responseUrl = `${base}/conversations/${conversationId}/interactions/${interactionId}/respond`;
    const speakerController = new AbortController();
    responseControllers.push(speakerController);
    const speakerRequest = fetchFixture(responseUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceMessageId }),
      signal: speakerController.signal,
    }, 170_000);
    responseDrain = speakerRequest.then(async response => { await response.arrayBuffer(); }).catch(() => undefined);
    try { await waitForLineCount(receipt, 2); } catch (error) {
      const debug = new SqliteStore(root);
      let durable: unknown;
      try {
        durable = {
          owner: debug.groupInteractionRepository().findExecutionOwner('workspace-a', interactionId),
          interaction: debug.boundedGroupService().findInteraction('workspace-a', interactionId),
          turns: debug.agentTurnRepository().listTurnsByConversation('workspace-a', conversationId),
          messages: debug.conversationRepository().listMessages('workspace-a', conversationId).map(message => ({
            id: message.id, senderType: message.senderType, status: message.status, content: message.content,
          })),
        };
      } finally { debug.close(); }
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(durable)}\n${server.output()}`);
    }
    const receiptRows = readFileSync(receipt, 'utf8').trim().split(/\r?\n/u).map(row => JSON.parse(row) as { pid: number; cwd: string });
    assert.equal(receiptRows.length, 2, 'the first speaker completes and the second real Provider remains active at restart');
    cliPids = receiptRows.map(row => row.pid);
    assert.notEqual(cliPids[0], process.pid, 'the provider receipt must name a child process');
    assert.notEqual(process.env.AGENTOS_FORCE_MOCK, 'true');

    // The native helper resumes a Job-owned child before its spawn promise
    // reaches the durable-binding callback. A child-written receipt proves
    // execution, but this scenario restarts after both owner bindings commit.
    await waitForGroupProviderEvidence(root, conversationId, interactionId, cliPids);

    server.child.kill('SIGKILL');
    speakerController.abort(new Error('server restart intentionally ends the in-flight Provider response'));
    await waitForExit(server.child);
    server = spawnServer(root, port, receipt);
    await waitForHealthy(port);

    const store = new SqliteStore(root);
    let sourceMessageCount: number;
    let priorVersion: number;
    let ownerEpoch: number;
    let participants: string[];
    let originalReplyIds: string[];
    try {
      const owner = store.groupInteractionRepository().findExecutionOwner('workspace-a', interactionId);
      const interaction = store.boundedGroupService().findInteraction('workspace-a', interactionId);
      assert.equal(owner?.status, 'interrupted');
      assert.equal(interaction?.integrityStatus, 'unusable');
      assert.ok(store.agentTurnRepository().listTurnsByConversation('workspace-a', conversationId).length >= 1);
      const originalReplies = store.groupInteractionRepository().listReplies(interactionId);
      assert.equal(originalReplies.length, 1, 'the completed first speaker reply remains attached to the interrupted owner');
      originalReplyIds = originalReplies.map(reply => reply.id);
      const processEvents = store.groupInteractionRepository().listExecutionEvents('workspace-a', conversationId, interactionId, 0)
        .filter(event => event.eventType === 'group.provider.started');
      assert.equal(processEvents.length, 2, 'each real Provider Turn has durable native process evidence');
      assert.ok(processEvents.every(event => event.ownerEpoch === owner!.ownerEpoch
        && Number.isSafeInteger(event.payload.pid)
        && typeof event.payload.nativeBirthIdentity === 'string'
        && event.payload.nativeBirthIdentity.startsWith('win32:filetime:')));
      assert.equal(processEvents.at(-1)?.payload.turnId, owner!.currentTurnId,
        'the active native process identity is bound to the interrupted owner current Turn');
      const sourceMessages = store.conversationRepository().listMessages('workspace-a', conversationId);
      sourceMessageCount = sourceMessages.length;
      priorVersion = interaction!.version;
      ownerEpoch = owner!.ownerEpoch;
      participants = [...owner!.participantAgentIds];
      const rejectedReplay = await postJson(responseUrl, { sourceMessageId });
      assert.equal(rejectedReplay.status, 409);
      assert.equal(rejectedReplay.json.error, 'GROUP_EXECUTION_INTERRUPTED');
      assert.equal(readFileSync(receipt, 'utf8').trim().split(/\r?\n/u).length, 2, 'restart and old-request replay must not spawn another CLI');
      assert.deepEqual(store.groupInteractionRepository().listReplies(interactionId).map(reply => reply.id), originalReplyIds,
        'restart reconciliation retains the prior owner replies');
    } finally { store.close(); }

    await waitForPidsToExit(cliPids);
    const recoveryUrl = `${base}/interactions/${interactionId}/recover`;
    const recoveryBody = {
      expectedVersion: priorVersion!, expectedOwnerEpoch: ownerEpoch!,
      content: 'Continue from the preserved discussion history in a new round. Do not replay the interrupted provider call.',
    };
    const staleCas = await postJson(recoveryUrl, { ...recoveryBody, expectedVersion: priorVersion! + 1 }, { 'Idempotency-Key': 'p2-group-stale-version' });
    assert.equal(staleCas.status, 409);
    assert.equal(staleCas.json.error, 'GROUP_RECOVERY_STALE');
    const staleOwner = await postJson(recoveryUrl, { ...recoveryBody, expectedOwnerEpoch: ownerEpoch! + 1 }, { 'Idempotency-Key': 'p2-group-stale-owner' });
    assert.equal(staleOwner.status, 409);
    assert.equal(staleOwner.json.error, 'GROUP_RECOVERY_STALE');
    const foreignScope = await postJson(`http://127.0.0.1:${port}/api/workspaces/foreign-workspace/runtime/interactions/${interactionId}/recover`, recoveryBody, { 'Idempotency-Key': 'p2-group-foreign-scope' });
    assert.equal(foreignScope.status, 404);

    const [firstClick, secondClick] = await Promise.all([
      postJson(recoveryUrl, recoveryBody, { 'Idempotency-Key': 'p2-group-recovery-key' }),
      postJson(recoveryUrl, recoveryBody, { 'Idempotency-Key': 'p2-group-recovery-key' }),
    ]);
    assert.deepEqual([firstClick.status, secondClick.status].sort(), [200, 201],
      `one concurrent request creates the linked round and the other replays it: ${JSON.stringify([firstClick, secondClick])}`);
    const recovered = firstClick.status === 201 ? firstClick : secondClick;
    const duplicateClick = firstClick.status === 200 ? firstClick : secondClick;
    const newInteractionId = recovered.json.interaction.id as string;
    const newSourceMessageId = recovered.json.message.id as string;
    assert.equal(duplicateClick.status, 200, JSON.stringify(duplicateClick.json));
    assert.equal(duplicateClick.json.interaction.id, newInteractionId, 'double-click with one key converges on one new interaction');
    assert.notEqual(newInteractionId, interactionId);
    assert.notEqual(newSourceMessageId, sourceMessageId);
    assert.deepEqual(recovered.json.participantAgentIds, participants!);
    const replayedRecovery = await postJson(recoveryUrl, recoveryBody, { 'Idempotency-Key': 'p2-group-recovery-key' });
    assert.equal(replayedRecovery.status, 200);
    assert.equal(replayedRecovery.json.interaction.id, newInteractionId);
    const changedRecovery = await postJson(recoveryUrl, { ...recoveryBody, content: 'changed body' }, { 'Idempotency-Key': 'p2-group-recovery-key' });
    assert.equal(changedRecovery.status, 409);
    assert.equal(changedRecovery.json.error, 'GROUP_RECOVERY_IDEMPOTENCY_CONFLICT');
    const resumedOwner = new SqliteStore(root);
    try {
      assert.equal(resumedOwner.groupInteractionRepository().findExecutionOwner('workspace-a', interactionId)?.status, 'abandoned');
      assert.equal(resumedOwner.conversationRepository().listMessages('workspace-a', conversationId).length, sourceMessageCount! + 1);
      const link = resumedOwner.getDatabase().prepare('SELECT prior_interaction_id,new_interaction_id,source_message_id FROM p2_group_recovery_links WHERE workspace_id = ? AND prior_interaction_id = ?')
        .get('workspace-a', interactionId) as { prior_interaction_id: string; new_interaction_id: string; source_message_id: string };
      assert.equal(link.prior_interaction_id, interactionId);
      assert.equal(link.new_interaction_id, newInteractionId);
      assert.equal(link.source_message_id, newSourceMessageId);
    } finally { resumedOwner.close(); }
    const nextResponseUrl = `${base}/conversations/${conversationId}/interactions/${newInteractionId}/respond`;
    const nextSpeakerController = new AbortController();
    responseControllers.push(nextSpeakerController);
    const nextSpeakerRequest = fetchFixture(nextResponseUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceMessageId: newSourceMessageId, namedAgentIds: participants }),
      signal: nextSpeakerController.signal,
    }, 170_000);
    responseDrain = Promise.all([
      responseDrain ?? Promise.resolve(),
      nextSpeakerRequest.then(async response => { await response.arrayBuffer(); }).catch(() => undefined),
    ]);
    await waitForLineCount(receipt, 3);
    const recoveryReceipts = readFileSync(receipt, 'utf8').trim().split(/\r?\n/u).map(row => JSON.parse(row) as { pid: number });
    assert.equal(recoveryReceipts.length, 3, 'only the linked new round may create one additional provider invocation');
    assert.notEqual(recoveryReceipts[0]!.pid, recoveryReceipts[1]!.pid);
    assert.notEqual(recoveryReceipts[1]!.pid, recoveryReceipts[2]!.pid);
    cliPids.push(recoveryReceipts[2]!.pid);
  } catch (error) {
    testFailed = true;
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${server.output()}`);
  } finally {
    for (const controller of responseControllers) controller.abort(new Error('restart fixture teardown'));
    killServer(server);
    for (const pid of cliPids) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone after platform cleanup */ }
    }
    let serverExited = false;
    try { await waitForExit(server.child); serverExited = true; } catch { /* bounded cleanup; preserve earlier assertions */ }
    let providerChildrenExited = true;
    try { await waitForPidsToExit(cliPids, 5_000); } catch { providerChildrenExited = false; }
    const responsesSettled = await settlesWithin(responseDrain ?? Promise.resolve(), 5_000);
    try { rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); } catch { /* test result is more useful than a brief Windows teardown lock */ }
    if (!testFailed && (!serverExited || !providerChildrenExited || !responsesSettled)) {
      throw new Error(`group restart fixture teardown timed out (serverExited=${serverExited}, providerChildrenExited=${providerChildrenExited}, responsesSettled=${responsesSettled})`);
    }
  }
});

test('P2 recovery: a known pre-Provider failure creates exactly one canonical retry Run', {
  timeout: 240_000,
  skip: process.platform !== 'win32',
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-p2-known-failure-'));
  const workspaceRoot = join(root, 'workspace');
  const worktreeRoot = join(root, 'worktrees');
  initializeGit(workspaceRoot);
  const baseline = spawnSyncGit(['rev-parse', 'HEAD'], workspaceRoot).stdout.trim();
  const fakeCodex = compileFakeCodexExecutable(root, false);
  const now = new Date().toISOString();
  const workspace: Workspace = {
    id: 'workspace-a', name: 'P2 known failure recovery', rootPath: workspaceRoot,
    gitEnabled: true, memoryEnabled: false,
    agents: structuredClone(DEFAULT_WORKSPACE_AGENTS).map(agent => ({ ...agent, cliCommand: fakeCodex, cliArgs: [] })),
    lastOpenedAt: now, createdAt: now, updatedAt: now,
  };
  const seed = new SqliteStore(root);
  try {
    seed.saveWorkspaces([workspace]);
    seed.getDatabase().prepare(`UPDATE provider_configurations SET output_mode = 'structured' WHERE workspace_id = ? AND provider_type = 'codex'`)
      .run(workspace.id);
    seed.getDatabase().prepare('UPDATE agent_profiles SET permissions_json = ? WHERE workspace_id = ? AND id = ?')
      .run(JSON.stringify(['read', 'write']), workspace.id, 'codex');
  } finally { seed.close(); }

  const port = await freePort();
  let server = spawnServer(root, port, '', worktreeRoot);
  let testFailed = false;
  try {
    await waitForHealthy(port);
    const base = `http://127.0.0.1:${port}/api/workspaces/workspace-a`;
    const created = await postJson(`${base}/collaboration/tasks`, {
      title: 'Known pre-Provider failure fixture',
      objective: 'Preserve the same goal while creating a canonical retry Run only once.',
      scope: ['README.md'], acceptanceCommands: ['git status --short'],
      plannerAgentId: 'codex', implementerAgentId: 'kimi', reviewerAgentId: 'opencode',
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const task = created.json.task as { id: string; version: number; objective: string };
    const confirmed = await postJson(`${base}/collaboration/tasks/${task.id}/confirm`, { expectedVersion: task.version }, { 'Idempotency-Key': 'p2-known-confirm-key' });
    assert.equal(confirmed.status, 202, JSON.stringify(confirmed.json));
    const failed = await waitForFailedCollaborationRun(root, task.id);
    assert.equal(failed.failureCode, 'PROVIDER_CAPABILITY_UNAVAILABLE');
    assert.equal(findNamedFile(worktreeRoot, 'p2-provider-invocation.jsonl'), undefined,
      'the fixture rejects missing structured-output capability before a Provider invocation');
    const recoveryUrl = `${base}/collaboration/tasks/${task.id}/recovery`;
    const availabilityResponse = await fetchFixture(recoveryUrl);
    const availability = (await availabilityResponse.json() as { recovery: { actions: { retryKnownFailure: boolean; newLinkedTask: boolean }; checkedBaseCommit?: string } }).recovery;
    assert.equal(availabilityResponse.status, 200);
    assert.equal(availability.actions.retryKnownFailure, true);
    assert.equal(availability.actions.newLinkedTask, false);
    assert.equal(availability.checkedBaseCommit, baseline);

    const retryBody = {
      action: 'retry-known-failure', expectedTaskVersion: failed.taskVersion,
      expectedRunId: failed.runId, expectedRunVersion: failed.runVersion,
    };
    const [accepted, concurrentDuplicate] = await Promise.all([
      postJson(`${base}/collaboration/tasks/${task.id}/recover`, retryBody, { 'Idempotency-Key': 'p2-known-retry-once' }),
      postJson(`${base}/collaboration/tasks/${task.id}/recover`, retryBody, { 'Idempotency-Key': 'p2-known-retry-once' }),
    ]);
    assert.ok([200, 202].includes(accepted.status), JSON.stringify(accepted.json));
    assert.ok([200, 202].includes(concurrentDuplicate.status), JSON.stringify(concurrentDuplicate.json));
    const acceptedRunIds = [accepted, concurrentDuplicate]
      .map(response => response.json.recovery.newRunId).filter((runId): runId is string => typeof runId === 'string');
    assert.ok(acceptedRunIds.length >= 1, 'the concurrent recovery claim produces a canonical child Run');
    assert.equal(new Set(acceptedRunIds).size, 1, 'concurrent duplicate recovery requests cannot create different Runs');
    const replay = await postJson(`${base}/collaboration/tasks/${task.id}/recover`, retryBody, { 'Idempotency-Key': 'p2-known-retry-once' });
    assert.equal(replay.status, 200, JSON.stringify(replay.json));
    const newRunId = replay.json.recovery.newRunId as string;
    assert.ok(newRunId);
    assert.notEqual(newRunId, failed.runId);
    assert.equal(acceptedRunIds[0], newRunId, 'double-click replay returns the same child Run');
    const changedIntent = await postJson(`${base}/collaboration/tasks/${task.id}/recover`, {
      ...retryBody, expectedRunVersion: failed.runVersion + 1,
    }, { 'Idempotency-Key': 'p2-known-retry-once' });
    assert.equal(changedIntent.status, 409);
    assert.equal(changedIntent.json.error ?? changedIntent.json.code, 'COLLABORATION_RECOVERY_IDEMPOTENCY_CONFLICT');

    const verified = new SqliteStore(root);
    try {
      const taskAfter = new CollaborationRepository(verified.getDatabase()).findById(workspace.id, task.id)!;
      const retryRun = verified.runRepository().findById(workspace.id, newRunId)!;
      const runCount = verified.getDatabase().prepare('SELECT COUNT(*) AS count FROM runs WHERE workspace_id = ? AND task_id = ?')
        .get(workspace.id, taskAfter.canonicalTaskId) as { count: number | bigint };
      const recovery = verified.getDatabase().prepare('SELECT state,new_run_id FROM p2_collaboration_recoveries WHERE workspace_id = ? AND idempotency_key = ?')
        .get(workspace.id, 'p2-known-retry-once') as { state: string; new_run_id: string };
      assert.equal(taskAfter.objective, task.objective, 'the canonical retry keeps the original task goal');
      assert.equal(taskAfter.canonicalRunId, newRunId);
      assert.equal(retryRun.parentRunId, failed.runId, 'the new Run carries canonical Run history');
      assert.equal(Number(runCount.count), 2, 'one original Run and exactly one retry Run exist');
      assert.deepEqual({ ...recovery }, { state: 'completed', new_run_id: newRunId });
      assert.equal(findNamedFile(worktreeRoot, 'p2-provider-invocation.jsonl'), undefined,
        'neither the known pre-Provider failure nor its retry called the Provider');
      assert.equal(spawnSyncGit(['rev-parse', 'HEAD'], workspaceRoot).stdout.trim(), baseline);
      assert.equal(spawnSyncGit(['status', '--porcelain'], workspaceRoot).stdout, '');
    } finally { verified.close(); }
  } catch (error) {
    testFailed = true;
    const diagnosticStore = new SqliteStore(root);
    let diagnostic: unknown;
    try {
      diagnostic = {
        tasks: diagnosticStore.getDatabase().prepare('SELECT id,status,version,canonical_run_id FROM collaboration_tasks WHERE workspace_id = ?').all(workspace.id),
        runs: diagnosticStore.getDatabase().prepare('SELECT id,status,version,task_id,parent_run_id,failure_code FROM runs WHERE workspace_id = ?').all(workspace.id),
        recoveries: diagnosticStore.getDatabase().prepare('SELECT state,new_run_id,error_code FROM p2_collaboration_recoveries WHERE workspace_id = ?').all(workspace.id),
      };
    } catch (diagnosticError) { diagnostic = String(diagnosticError); }
    finally { diagnosticStore.close(); }
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(diagnostic)}\n${server.output()}`);
  } finally {
    killServer(server);
    let serverExited = false;
    try { await waitForExit(server.child); serverExited = true; } catch { /* bounded cleanup; preserve earlier assertions */ }
    try { rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); } catch { /* preserve the assertion result */ }
    if (!testFailed && !serverExited) throw new Error('known-failure restart fixture server did not exit after teardown');
  }
});

test('P2 reproduction: a collaboration Provider side effect stays fenced after real server restart', {
  timeout: 240_000,
  skip: process.platform !== 'win32',
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-p2-collab-restart-'));
  const workspaceRoot = join(root, 'workspace');
  const worktreeRoot = join(root, 'worktrees');
  initializeGit(workspaceRoot);
  const baseline = spawnSyncGit(['rev-parse', 'HEAD'], workspaceRoot).stdout.trim();
  const fakeCodex = compileFakeCodexExecutable(root);
  const now = new Date().toISOString();
  const workspace: Workspace = {
    id: 'workspace-a', name: 'P2 collaboration recovery', rootPath: workspaceRoot,
    gitEnabled: true, memoryEnabled: false,
    agents: structuredClone(DEFAULT_WORKSPACE_AGENTS).map(agent => ({
      ...agent, cliCommand: fakeCodex, cliArgs: [],
    })),
    lastOpenedAt: now, createdAt: now, updatedAt: now,
  };
  const seed = new SqliteStore(root);
  try {
    seed.saveWorkspaces([workspace]);
    seed.getDatabase().prepare(`UPDATE provider_configurations SET output_mode = 'structured' WHERE workspace_id = ? AND provider_type = 'codex'`)
      .run(workspace.id);
    seed.getDatabase().prepare('UPDATE agent_profiles SET permissions_json = ? WHERE workspace_id = ? AND id = ?')
      .run(JSON.stringify(['read', 'write']), workspace.id, 'codex');
  } finally { seed.close(); }

  const port = await freePort();
  let server = spawnServer(root, port, '', worktreeRoot);
  let providerPid: number | undefined;
  let testFailed = false;
  try {
    await waitForHealthy(port);
    const base = `http://127.0.0.1:${port}/api/workspaces/workspace-a`;
    const created = await postJson(`${base}/collaboration/tasks`, {
      title: 'Unknown side-effect restart fixture',
      objective: 'Write to the isolated worktree once and preserve recovery history.',
      scope: ['README.md'], acceptanceCommands: ['git status --short'],
      plannerAgentId: 'codex', implementerAgentId: 'kimi', reviewerAgentId: 'opencode',
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const task = created.json.task as { id: string; version: number };
    const confirmed = await postJson(`${base}/collaboration/tasks/${task.id}/confirm`, { expectedVersion: task.version }, { 'Idempotency-Key': 'p2-confirm-key' });
    assert.equal(confirmed.status, 202, JSON.stringify(confirmed.json));
    const approval = await waitForRuntimeApproval(port, workspace.id);
    const approvalDecision = await postJson(`http://127.0.0.1:${port}/api/workspaces/${workspace.id}/runtime-approvals/${approval.id}/resolve`, {
      expectedVersion: approval.version, decision: 'approve_once', decidedBy: 'p2-restart-fixture',
    });
    assert.equal(approvalDecision.status, 201, JSON.stringify(approvalDecision.json));

    let receiptPath: string;
    try { receiptPath = await waitForNamedFile(worktreeRoot, 'p2-provider-invocation.jsonl'); }
    catch (error) {
      const debug = new SqliteStore(root);
      let diagnostic: unknown;
      try {
        const db = debug.getDatabase();
        diagnostic = {
          task: db.prepare('SELECT id,status,version,canonical_task_id,canonical_run_id,failure_reason FROM collaboration_tasks').all(),
          runs: db.prepare('SELECT id,status,failure_code,recovery_required FROM runs').all(),
          stages: db.prepare('SELECT run_id,workflow_stage_key,status,failure_code,failure_message FROM run_stages').all(),
          processes: db.prepare('SELECT id,run_id,status,executable_resolved,args_redacted_json,cwd_resolved,native_pid,error_code FROM runtime_processes').all(),
          sourceFiles: readdirSync(root), worktreeFiles: existsSync(worktreeRoot) ? readdirSync(worktreeRoot) : [],
        };
      } finally { debug.close(); }
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(diagnostic)}\n${server.output()}`);
    }
    const worktreePath = dirname(receiptPath);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8').trim()) as { pid: number; cwd: string };
    providerPid = receipt.pid;
    const fixtureRelative = (path: string) => resolve(path).split(/[\\/]/u).slice(-5).join('\\').toLowerCase();
    assert.equal(fixtureRelative(receipt.cwd), fixtureRelative(worktreePath));
    assert.notEqual(providerPid, process.pid, 'the receipt must identify the spawned Provider process');
    assert.equal(readFileSync(join(worktreePath, 'p2-unknown-side-effect.txt'), 'utf8'), 'provider wrote before restart\n');
    assert.notEqual(process.env.AGENTOS_FORCE_MOCK, 'true');

    server.child.kill('SIGKILL');
    await waitForExit(server.child);
    server = spawnServer(root, port, '', worktreeRoot);
    await waitForHealthy(port);

    const store = new SqliteStore(root);
    let recoveryRunId = '';
    try {
      const taskRow = new CollaborationRepository(store.getDatabase()).findById('workspace-a', task.id);
      assert.ok(taskRow);
      assert.ok(['blocked', 'failed'].includes(taskRow.status), `unexpected recovered task state: ${taskRow.status}`);
      assert.ok(taskRow.canonicalRunId);
      const run = store.runRepository().findById('workspace-a', taskRow.canonicalRunId!);
      assert.ok(run);
      recoveryRunId = run.id;
      assert.ok(run.recoveryRequired === true || run.failureCode === 'RUN_PROCESS_MISSING',
        `restart must preserve uncertainty or prove the provider missing; saw ${run.failureCode}/${run.recoveryRequired}`);
      assert.equal(readFileSync(join(worktreePath, 'p2-unknown-side-effect.txt'), 'utf8'), 'provider wrote before restart\n');
      assert.equal(findNamedFile(worktreeRoot, 'p2-provider-invocation.jsonl'), receiptPath,
        'restart must not invoke the old Provider call again');
      assert.equal(spawnSyncGit(['rev-parse', 'HEAD'], workspaceRoot).stdout.trim(), baseline);
      assert.equal(spawnSyncGit(['status', '--porcelain'], workspaceRoot).stdout, '', 'the checked source baseline stays clean');
    } finally { store.close(); }

    const taskUrl = `${base}/collaboration/tasks/${task.id}`;
    const recoveryUrl = `${taskUrl}/recovery`;
    const dirtyMarker = join(workspaceRoot, 'dirty-before-recovery.txt');
    writeFileSync(dirtyMarker, 'must block linked recovery until removed\n');
    const dirtyOptionsResponse = await fetchFixture(recoveryUrl);
    const dirtyOptions = await dirtyOptionsResponse.json() as { recovery: { actions: { newLinkedTask: boolean }; reason?: string } };
    assert.equal(dirtyOptionsResponse.status, 200);
    assert.equal(dirtyOptions.recovery.actions.newLinkedTask, false, 'unknown effects cannot create a task from a dirty baseline');
    assert.match(dirtyOptions.recovery.reason ?? '', /干净且可检查/u);
    rmSync(dirtyMarker, { force: true });
    writeFileSync(join(workspaceRoot, 'clean-baseline-update.txt'), 'a clean checked baseline can advance independently of the failed task baseline\n');
    assert.equal(spawnSyncGit(['add', 'clean-baseline-update.txt'], workspaceRoot).status, 0);
    assert.equal(spawnSyncGit(['commit', '-q', '-m', 'advance clean recovery baseline'], workspaceRoot).status, 0);
    const cleanCheckedBaseline = spawnSyncGit(['rev-parse', 'HEAD'], workspaceRoot).stdout.trim();
    assert.notEqual(cleanCheckedBaseline, baseline);
    assert.equal(spawnSyncGit(['status', '--porcelain'], workspaceRoot).stdout, '');
    const cleanOptionsResponse = await fetchFixture(recoveryUrl);
    const cleanOptions = await cleanOptionsResponse.json() as {
      recovery: {
        taskVersion: number; runId?: string; runVersion?: number;
        actions: { newLinkedTask: boolean }; checkedBaseCommit?: string;
      };
    };
    assert.equal(cleanOptionsResponse.status, 200);
    assert.equal(cleanOptions.recovery.actions.newLinkedTask, true);
    assert.equal(cleanOptions.recovery.checkedBaseCommit, cleanCheckedBaseline,
      'availability reports the current clean baseline after the source HEAD advances');
    assert.equal(cleanOptions.recovery.runId, recoveryRunId,
      'the current recovery options remain bound to the prior canonical Run');
    const checkedTaskVersion = cleanOptions.recovery.taskVersion;
    const checkedRunId = cleanOptions.recovery.runId;
    const checkedRunVersion = cleanOptions.recovery.runVersion;
    if (!checkedRunId || checkedRunVersion === undefined) {
      throw new Error('Clean recovery options omitted their task/Run compare-and-swap versions');
    }

    const recoveryBody = {
      action: 'new-linked-task', expectedTaskVersion: checkedTaskVersion,
      expectedRunId: checkedRunId, expectedRunVersion: checkedRunVersion,
    };
    const unsafeRetry = await postJson(`${taskUrl}/recover`, {
      ...recoveryBody, action: 'retry-known-failure',
    }, { 'Idempotency-Key': 'p2-unknown-must-not-retry' });
    assert.equal(unsafeRetry.status, 409);
    assert.equal(unsafeRetry.json.error ?? unsafeRetry.json.code, 'COLLABORATION_RECOVERY_UNRESOLVED');

    const foreignRun = await postJson(`${taskUrl}/recover`, {
      ...recoveryBody, expectedRunId: 'run-from-another-workspace',
    }, { 'Idempotency-Key': 'p2-foreign-run-fence' });
    assert.equal(foreignRun.status, 409, JSON.stringify(foreignRun.json));
    assert.equal(foreignRun.json.error ?? foreignRun.json.code, 'COLLABORATION_RECOVERY_STALE');

    const recoveryKey = 'p2-unknown-linked-task-once';
    const recovered = await postJson(`${taskUrl}/recover`, recoveryBody, { 'Idempotency-Key': recoveryKey });
    assert.equal(recovered.status, 201, JSON.stringify(recovered.json));
    const linkedTask = recovered.json.recovery.task as { id: string; title: string; objective: string; status: string; baseCommit: string; canonicalRunId?: string };
    assert.notEqual(linkedTask.id, task.id);
    assert.equal(linkedTask.status, 'awaiting_confirmation', 'a linked task remains a user-reviewed plan and does not start a Provider');
    assert.equal(linkedTask.baseCommit, cleanCheckedBaseline);
    assert.match(linkedTask.title, /linked recovery/u);
    assert.match(linkedTask.objective, /Write to the isolated worktree once/u);
    assert.match(linkedTask.objective, new RegExp(task.id));
    assert.equal(linkedTask.canonicalRunId, undefined);
    const replayedRecovery = await postJson(`${taskUrl}/recover`, recoveryBody, { 'Idempotency-Key': recoveryKey });
    assert.equal(replayedRecovery.status, 200);
    assert.equal(replayedRecovery.json.recovery.task.id, linkedTask.id, 'same key returns the same linked task');
    const changedRecoveryBody = await postJson(`${taskUrl}/recover`, {
      ...recoveryBody, expectedRunVersion: checkedRunVersion + 1,
    }, { 'Idempotency-Key': recoveryKey });
    assert.equal(changedRecoveryBody.status, 409);
    assert.equal(changedRecoveryBody.json.error ?? changedRecoveryBody.json.code, 'COLLABORATION_RECOVERY_IDEMPOTENCY_CONFLICT');

    const finalStore = new SqliteStore(root);
    try {
      const persistedLink = finalStore.getDatabase().prepare(`SELECT collaboration_task_id,prior_run_id,new_collaboration_task_id,
        checked_base_commit,state FROM p2_collaboration_recoveries WHERE workspace_id = ? AND idempotency_key = ?`)
        .get('workspace-a', recoveryKey) as { collaboration_task_id: string; prior_run_id: string; new_collaboration_task_id: string; checked_base_commit: string; state: string };
      assert.deepEqual({ ...persistedLink }, {
        collaboration_task_id: task.id, prior_run_id: recoveryRunId, new_collaboration_task_id: linkedTask.id,
        checked_base_commit: cleanCheckedBaseline, state: 'completed',
      });
      assert.equal(new CollaborationRepository(finalStore.getDatabase()).findById('workspace-a', task.id)?.canonicalRunId, recoveryRunId,
        'the prior task keeps its old canonical Run');
      assert.equal(findNamedFile(worktreeRoot, 'p2-provider-invocation.jsonl'), receiptPath,
        'creating a linked task never replays the unknown Provider call');
      assert.equal(spawnSyncGit(['status', '--porcelain'], workspaceRoot).stdout, '', 'the linked task was anchored to a clean checked baseline');
    } finally { finalStore.close(); }
  } catch (error) {
    testFailed = true;
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${server.output()}`);
  } finally {
    killServer(server);
    if (providerPid !== undefined) {
      try { process.kill(providerPid, 'SIGKILL'); } catch { /* the Windows job may already have ended it */ }
    }
    let serverExited = false;
    try { await waitForExit(server.child); serverExited = true; } catch { /* bounded cleanup; preserve earlier assertions */ }
    let providerExited = true;
    try { if (providerPid !== undefined) await waitForPidsToExit([providerPid], 5_000); } catch { providerExited = false; }
    try { rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); } catch { /* preserve the assertion result */ }
    if (!testFailed && (!serverExited || !providerExited)) {
      throw new Error(`collaboration restart fixture teardown timed out (serverExited=${serverExited}, providerExited=${providerExited})`);
    }
  }
});
