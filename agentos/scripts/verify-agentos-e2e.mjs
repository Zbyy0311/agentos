import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const baseUrl = (process.env.AGENTOS_E2E_BASE_URL ?? 'http://127.0.0.1:3200').replace(/\/$/, '');
const projectRoot = process.env.AGENTOS_PROJECT_ROOT;
const phase = process.env.AGENTOS_E2E_PHASE ?? 'pre-recovery';
const gates = { REAL_EXTERNAL_AGENT: false, DETERMINISTIC_LIFECYCLE: false, RECOVERY: phase === 'recovery' ? false : null, MEMORY_CANDIDATE: false };

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = { raw: text.slice(0, 200) }; }
  return { response, body };
}

function parseSse(text) {
  const events = [];
  let name = 'message';
  let data = [];
  const flush = () => {
    if (!data.length) return;
    const raw = data.join('\n');
    let value = raw;
    try { value = JSON.parse(raw); } catch {}
    events.push({ event: name, data: value });
    name = 'message'; data = [];
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line) { flush(); continue; }
    if (line.startsWith('event:')) name = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  flush();
  return events;
}

async function streamRequest(path, body, { abortOnRunningCli = false } = {}) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal,
  });
  assert.equal(response.status, 200, `SSE request returned HTTP ${response.status}`);
  if (!abortOnRunningCli) return { events: parseSse(await response.text()), aborted: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  let aborted = false;
  const consume = chunk => {
    buffer += chunk;
    const pieces = buffer.split(/\r?\n\r?\n/);
    buffer = pieces.pop() ?? '';
    for (const event of parseSse(pieces.join('\n\n'))) {
      events.push(event);
      if (!aborted && event.event === 'execution' && event.data?.status === 'running_cli') {
        aborted = true; controller.abort();
      }
    }
  };
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      consume(decoder.decode(next.value, { stream: true }));
    }
  } catch (error) {
    if (!aborted && error?.name !== 'AbortError') throw error;
  }
  return { events, aborted };
}

async function createConversation(workspaceId, agentId, title, type = 'direct') {
  const body = type === 'group'
    ? { type, title, memberAgentIds: ['codex', 'kimi', 'opencode'], leaderAgentId: 'codex' }
    : { agentId, title };
  const result = await jsonRequest(`/api/workspaces/${workspaceId}/conversations`, { method: 'POST', body: JSON.stringify(body) });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body.conversation;
}

async function latestRun(workspaceId, conversationId) {
  const result = await jsonRequest(`/api/workspaces/${workspaceId}/runs?conversationId=${encodeURIComponent(conversationId)}&limit=20`);
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body.runs[0];
}

async function waitForRunStatus(workspaceId, conversationId, expectedStatus, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let run;
  do {
    run = await latestRun(workspaceId, conversationId);
    if (run?.status === expectedStatus) return run;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  return run;
}

async function waitForMemoryUsage(workspaceId, runId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let details;
  do {
    details = await runDetails(workspaceId, { id: runId });
    if (details.usedMemories?.length) return details;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  return details;
}

async function runDetails(workspaceId, run) {
  const result = await jsonRequest(`/api/workspaces/${workspaceId}/runs/${run.id}`);
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body;
}

async function runDirect(workspaceId, conversation, content, options) {
  const stream = await streamRequest(`/api/workspaces/${workspaceId}/conversations/${conversation.id}/messages/stream`, { content }, options);
  const run = await latestRun(workspaceId, conversation.id);
  assert.ok(run, 'run was not persisted');
  return { ...stream, run, details: await runDetails(workspaceId, run) };
}

async function createAndRunFixture(workspaceId, agentId, title, content) {
  const conversation = await createConversation(workspaceId, agentId, title);
  return runDirect(workspaceId, conversation, content);
}

async function deterministicLifecycle(workspaceId) {
  const waiting = await createAndRunFixture(workspaceId, 'e2e-waiting', 'deterministic waiting', '请等待用户补充信息。');
  assert.equal(waiting.run.status, 'waiting_user');
  assert.ok(waiting.run.waitingQuestion);
  assert.equal(waiting.details.events.some(event => event.type === 'run.completed'), false);
  const waitingCandidates = await jsonRequest(`/api/workspaces/${workspaceId}/runs/${waiting.run.id}/memory-candidates/generate`, { method: 'POST' });
  assert.equal(waitingCandidates.response.status, 409);
  const conversation = (await jsonRequest(`/api/workspaces/${workspaceId}/conversations`)).body.conversations.find(item => item.title === 'deterministic waiting');
  const resumed = await streamRequest(`/api/workspaces/${workspaceId}/conversations/${conversation.id}/runs/${waiting.run.id}/resume/stream`, { content: 'AGENTOS_RESUME_OK' });
  assert.ok(resumed.events.some(event => event.event === 'done'));
  const resumedRun = await latestRun(workspaceId, conversation.id);
  assert.equal(resumedRun.id, waiting.run.id);
  assert.equal(resumedRun.status, 'completed');
  const resumedDetails = await runDetails(workspaceId, resumedRun);
  assert.equal(resumedDetails.executions.length, 2);

  const failed = await createAndRunFixture(workspaceId, 'e2e-failing', 'deterministic failure', '触发确定性失败。');
  assert.equal(failed.run.status, 'failed');
  const failedCandidates = await jsonRequest(`/api/workspaces/${workspaceId}/runs/${failed.run.id}/memory-candidates/generate`, { method: 'POST' });
  assert.equal(failedCandidates.response.status, 409);
}

async function attempt(label, operation, failures) {
  try {
    await operation();
    console.log(`${label}: passed`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`${label}: failed - ${message.slice(0, 300)}`);
    failures.push(label);
    return false;
  }
}

async function realExternalMatrix(workspaceId, profiles) {
  const realIds = ['codex', 'kimi', 'opencode'];
  const failures = [];
  const successfulIds = [];
  for (const id of realIds) {
    const passed = await attempt(`REAL_DIRECT_${id.toUpperCase()}`, async () => {
      assert.ok(profiles.has(id), `${id} profile is missing`);
      const conversation = await createConversation(workspaceId, id, `real direct ${id}`);
      const result = await runDirect(workspaceId, conversation, `AgentOS 真实单聊验收。请只返回公开短语 AGENTOS_REAL_${id.toUpperCase()}_OK，不修改文件。`);
      assert.equal(result.run.status, 'completed', `${id} status=${result.run.status}; failure=${result.details.run.failureReason ?? 'none'}`);
      assert.ok(result.details.cliInvocations.length > 0, `${id} has no CLI invocation`);
    }, failures);
    if (passed) successfulIds.push(id);
  }

  await attempt('REAL_GROUP', async () => {
    const group = await createConversation(workspaceId, 'codex', 'real group', 'group');
    const result = await runDirect(workspaceId, group, 'REAL_GROUP_SCOPE REAL_GROUP_NO_WAIT：这是一次无需用户补充的三 Agent 群聊验收。验收对象是 AgentOS；目标是验证 Codex、Kimi、OpenCode 的并行执行和可追溯总结；范围是只读，不修改文件；所有完成任务所需信息已在本消息中提供。不要请求用户补充信息，不要输出 waiting-user 标记；请直接返回公开群聊总结。');
    assert.equal(result.run.status, 'completed');
    assert.ok(result.details.executions.length >= 3);
    assert.equal(new Set(result.details.executions.map(execution => execution.runId)).size, 1);
  }, failures);

  let memoryCandidatePassed = false;
  const candidateAgent = successfulIds[0];
  if (candidateAgent) {
    await attempt('REAL_MEMORY_INJECTION', async () => {
      const token = `AGENTOS_MEMORY_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const memory = await jsonRequest(`/api/workspaces/${workspaceId}/memories`, { method: 'POST', body: JSON.stringify({
        type: 'experience', title: `真实验收记忆 ${token}`, summary: `包含唯一检索 token ${token}`,
        content: `下一次 Agent 任务必须能够检索到 ${token}。`, tags: ['e2e'], sourceRunIds: [], importance: 80, confidence: 90,
      }) });
      assert.equal(memory.response.status, 201, JSON.stringify(memory.body));
      const conversation = await createConversation(workspaceId, candidateAgent, 'real memory injection');
      const result = await runDirect(workspaceId, conversation, `请验证你能看到项目记忆 ${token}，只给出公开验证结论。`);
      assert.equal(result.run.status, 'completed');
      const expectedMemoryId = memory.body.memory?.id;
      assert.ok(expectedMemoryId, 'memory create response did not contain an id');
      const detailsWithUsage = await waitForMemoryUsage(workspaceId, result.run.id);
      assert.ok(detailsWithUsage.usedMemories.some(usage => usage.memoryId === expectedMemoryId), `memory usage ids=${JSON.stringify(detailsWithUsage.usedMemories.map(usage => usage.memoryId))}`);
    }, failures);

    memoryCandidatePassed = await attempt('REAL_MEMORY_CANDIDATE', async () => {
      const conversation = await createConversation(workspaceId, candidateAgent, 'real candidate');
      const result = await runDirect(workspaceId, conversation, '请完成 AGENTOS_CANDIDATE_SCOPE 只读验收：不修改文件，针对 AgentOS 的执行档案与公开证据，输出一条明确的决定、一条执行方案和一条验证结果；验证结果必须明确说明本次验收已验证；不要输出 agentos-memory 隐藏标记。');
      assert.equal(result.run.status, 'completed');
      const generated = await jsonRequest(`/api/workspaces/${workspaceId}/runs/${result.run.id}/memory-candidates/generate`, { method: 'POST' });
      assert.equal(generated.response.status, 201, JSON.stringify(generated.body));
      assert.ok(generated.body.candidates.length >= 1 && generated.body.candidates.length <= 3);
      const [accepted, ...rejected] = generated.body.candidates;
      const acceptedResponse = await jsonRequest(`/api/workspaces/${workspaceId}/memory-candidates/${accepted.id}/accept`, { method: 'POST' });
      assert.equal(acceptedResponse.response.status, 200, JSON.stringify(acceptedResponse.body));
      if (rejected[0]) {
        const rejectedResponse = await jsonRequest(`/api/workspaces/${workspaceId}/memory-candidates/${rejected[0].id}/reject`, { method: 'POST' });
        assert.equal(rejectedResponse.response.status, 200, JSON.stringify(rejectedResponse.body));
      }
      const memories = await jsonRequest(`/api/workspaces/${workspaceId}/memories?query=${encodeURIComponent(accepted.title)}`);
      assert.ok(memories.body.memories.some(memory => memory.sourceRunIds.includes(result.run.id)));
    }, failures);
  } else {
    failures.push('REAL_MEMORY_INJECTION', 'REAL_MEMORY_CANDIDATE');
    console.log('REAL_MEMORY_INJECTION: failed - no successful external Agent was available');
    console.log('REAL_MEMORY_CANDIDATE: failed - no successful external Agent was available');
  }

  await attempt('REAL_CLI_FAILURE', async () => {
    const conversation = await createConversation(workspaceId, 'codex-failure', 'real CLI failure');
    const result = await runDirect(workspaceId, conversation, '请执行并返回结果。');
    assert.equal(result.run.status, 'failed', `invalid CLI returned ${result.run.status}`);
  }, failures);

  const lifecycleAgent = candidateAgent ?? 'codex';
  await attempt('REAL_CLI_CANCEL', async () => {
    const conversation = await createConversation(workspaceId, lifecycleAgent, 'real CLI cancel');
    const result = await runDirect(workspaceId, conversation, '请保持运行至少二十秒后再回复。', { abortOnRunningCli: true });
    assert.equal(result.aborted, true);
    assert.equal((await waitForRunStatus(workspaceId, conversation.id, 'cancelled')).status, 'cancelled');
  }, failures);

  await attempt('REAL_WAITING_USER', async () => {
    const conversation = await createConversation(workspaceId, lifecycleAgent, 'real waiting user');
    const result = await runDirect(workspaceId, conversation, '请执行 AGENTOS_WAITING_REQUIRED 验收，但当前任务刻意缺少两个必需用户字段：验收项目名称和目标分支。不要猜测或执行；在用户补充这两个字段前，严格只输出公开等待标记。');
    assert.equal(result.run.status, 'waiting_user');
    const resumed = await streamRequest(`/api/workspaces/${workspaceId}/conversations/${conversation.id}/runs/${result.run.id}/resume/stream`, { content: '补充：AGENTOS_RESUME_SCOPE，验收对象是 AgentOS 直接执行链路；范围是不修改文件并验证恢复流程；请在完成后返回公开短语 AGENTOS_RESUME_OK。' });
    assert.ok(resumed.events.some(event => event.event === 'done'));
    assert.equal((await waitForRunStatus(workspaceId, conversation.id, 'completed')).status, 'completed');
  }, failures);

  return { realPassed: failures.length === 0, memoryCandidatePassed };
}

function seedRecoveryRows(workspaceId, conversationId) {
  assert.ok(projectRoot, 'AGENTOS_PROJECT_ROOT is required');
  const dbPath = join(projectRoot, '.agentos', 'agentos.sqlite');
  assert.ok(existsSync(dbPath), `database missing: ${dbPath}`);
  const db = new DatabaseSync(dbPath);
  const now = new Date().toISOString();
  for (const status of ['queued', 'running', 'waiting_user']) {
    const messageId = `recovery-message-${status}-${randomUUID()}`;
    const runId = `recovery-run-${status}-${randomUUID()}`;
    db.prepare('INSERT INTO messages (id, conversation_id, workspace_id, sender_type, sender_agent_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(messageId, conversationId, workspaceId, 'user', null, `recovery ${status}`, now);
    db.prepare('INSERT INTO agent_runs (id, workspace_id, conversation_id, source_message_id, objective, status, result_summary, failure_reason, started_at, completed_at, created_at, updated_at, waiting_question, waiting_execution_id, waiting_agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(runId, workspaceId, conversationId, messageId, `recovery ${status}`, status, null, null, status === 'running' ? now : null, null, now, now, status === 'waiting_user' ? '保留等待状态' : null, null, status === 'waiting_user' ? 'codex' : null);
  }
  db.close();
}

async function verifyRecovery(workspaceId, conversationId) {
  let byObjective = new Map();
  const deadline = Date.now() + 10000;
  do {
    const result = await jsonRequest(`/api/workspaces/${workspaceId}/runs?conversationId=${encodeURIComponent(conversationId)}&limit=100`);
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    byObjective = new Map(result.body.runs.map(run => [run.objective, run]));
    if (byObjective.get('recovery queued')?.status === 'failed' && byObjective.get('recovery running')?.status === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  assert.equal(byObjective.get('recovery queued')?.status, 'failed');
  assert.equal(byObjective.get('recovery running')?.status, 'failed');
  assert.equal(byObjective.get('recovery waiting_user')?.status, 'waiting_user');
}

try {
  const workspacesResult = await jsonRequest('/api/workspaces');
  assert.equal(workspacesResult.response.status, 200);
  const workspaces = workspacesResult.body.workspaces;
  assert.ok(workspaces.length > 0);
  const workspace = workspaces.find(item => item.agents?.some(agent => agent.id === 'e2e-waiting')) ?? workspaces[0];
  const profiles = new Map((workspace.agents ?? []).map(agent => [agent.id, agent]));
  if (phase === 'recovery') {
    const conversations = (await jsonRequest(`/api/workspaces/${workspace.id}/conversations`)).body.conversations;
    const seed = conversations.find(item => item.title === 'recovery seed');
    assert.ok(seed, 'recovery seed conversation missing');
    await verifyRecovery(workspace.id, seed.id);
    gates.RECOVERY = true;
  } else {
    await deterministicLifecycle(workspace.id);
    gates.DETERMINISTIC_LIFECYCLE = true;
    const recoverySeed = await createConversation(workspace.id, 'codex', 'recovery seed');
    seedRecoveryRows(workspace.id, recoverySeed.id);
    const matrix = await realExternalMatrix(workspace.id, profiles);
    gates.REAL_EXTERNAL_AGENT = matrix.realPassed;
    gates.MEMORY_CANDIDATE = matrix.memoryCandidatePassed;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const gate = phase === 'recovery' ? 'RECOVERY' : gates.DETERMINISTIC_LIFECYCLE ? 'REAL_EXTERNAL_AGENT' : 'DETERMINISTIC_LIFECYCLE';
  console.log(`${gate}: failed - ${message.slice(0, 300)}`);
  gates[gate] = false;
}

for (const [name, passed] of Object.entries(gates)) {
  console.log(`${name}: ${passed === null ? 'not_run' : passed ? 'passed' : 'failed'}`);
}
const requiredGates = phase === 'recovery'
  ? ['RECOVERY']
  : ['REAL_EXTERNAL_AGENT', 'DETERMINISTIC_LIFECYCLE', 'MEMORY_CANDIDATE'];
if (requiredGates.some(name => !gates[name])) process.exitCode = 1;
