import { expect, test, type Page, type Route } from '@playwright/test';
import type { AgentProfile, CollaborationProgress, CollaborationTask, Conversation, ConversationMessage, Workspace } from '@agentos/shared';

const workspaceId = 'p4-browser-fixture';
const now = '2026-10-02T00:00:00.000Z';
const agent = (id: string): AgentProfile => ({
  id, workspaceId, name: id, role: 'codex', enabled: true, cliCommand: 'fixture', cliArgs: [],
  roleTitle: 'Fixture', systemPrompt: '', permissions: ['read'], createdAt: now, updatedAt: now,
});
const directConversation = (id: string, agentId: string): Conversation => ({
  id, workspaceId, agentId, type: 'direct', title: id, createdAt: now, updatedAt: now,
});
const task = (number: number): CollaborationTask => ({
  id: `task-${number}`, workspaceId, conversationId: 'same-id', title: `Task ${number}`,
  objective: 'Deterministic P4 browser fixture', scope: ['src/'], acceptanceCommands: ['fixture'],
  plannerAgentId: 'agent-a', implementerAgentId: 'agent-b', reviewerAgentId: 'agent-c',
  status: 'cancelled', version: 1, planHash: 'fixture', baseCommit: 'fixture', maxReworkRounds: 2,
  reworkRound: 0, createdAt: now, updatedAt: now,
});

const contexts = [
  { id: 'context-a', ownerId: 'run-owner-a', memoryId: 'memory-a', memoryVersion: 3 },
  { id: 'context-b', ownerId: 'run-owner-b', memoryId: 'memory-b', memoryVersion: 4 },
].map(({ id, ownerId, memoryId, memoryVersion }) => ({
  id, kind: 'run', ownerId, runId: ownerId, createdAt: now, queryHash: `hash-${id}`,
  retrievalStrategyVersion: 'p4-fixture-v1', contextText: `Snapshot ${id}`, payloadAvailable: true,
  totalTokens: 12, truncated: false,
  selected: [{ memoryId, memoryVersion, rank: 1, reasons: [`selected for ${id}`], tokenCost: 12, store: 'canonical' }],
  exclusions: [],
}));

const candidates = [
  { id: 'candidate-a', title: 'Candidate A', version: 3 },
  { id: 'candidate-b', title: 'Candidate B', version: 7 },
].map(({ id, title, version }) => ({
  id, scope: 'workspace', category: 'fact', authority: 'observed', confidence: 0.9,
  importance: 0.8, title, summary: `${title} summary`, content: `${title} content`, tags: [],
  outcome: 'review-required', decision: null, version, createdAt: now, sources: [],
}));

type RequestRecord = { path: string; method: string; body: string | null; key?: string };
type Fixture = {
  workspace: Workspace;
  agents: AgentProfile[];
  conversations: Conversation[];
  tasks: CollaborationTask[];
  requests: RequestRecord[];
  failures: string[];
};

function createFixture(): Fixture {
  const agents = [agent('agent-a'), agent('agent-b'), agent('agent-c')];
  const workspace: Workspace = {
    id: workspaceId, name: 'P4 Browser Fixture', rootPath: 'fixture-only', gitEnabled: false,
    memoryEnabled: true, agents, lastOpenedAt: now, createdAt: now, updatedAt: now,
  };
  return {
    workspace,
    agents,
    conversations: [directConversation('private-a', 'agent-a'), directConversation('same-id', 'agent-b')],
    tasks: Array.from({ length: 101 }, (_, index) => task(index + 1)),
    requests: [],
    failures: [],
  };
}

const json = (route: Route, body: unknown) => route.fulfill({
  json: body,
  headers: { 'Access-Control-Allow-Origin': '*' },
});

async function installDeterministicApi(page: Page, fixture: Fixture) {
  page.on('pageerror', error => fixture.failures.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    fixture.requests.push({ path: path + url.search, method: request.method(), body: request.postData(), key: request.headers()['idempotency-key'] });

    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
      return;
    }
    if (request.method() === 'GET' && path === `/api/workspaces/${workspaceId}`) { await json(route, { workspace: fixture.workspace }); return; }
    if (request.method() === 'GET' && path.endsWith('/agents/presence')) { await json(route, { presence: [] }); return; }
    if (request.method() === 'GET' && path.endsWith('/agents')) { await json(route, { agents: fixture.agents }); return; }
    if (request.method() === 'GET' && path.endsWith('/runtime/conversations')) {
      await json(route, { conversations: [{ id: 'same-id', workspaceId, kind: 'group', status: 'active', version: 1, title: 'Runtime same-id', createdAt: now, updatedAt: now }] });
      return;
    }
    if (request.method() === 'GET' && path.endsWith('/conversations') && url.searchParams.has('agentId')) {
      const agentId = url.searchParams.get('agentId');
      await json(route, { conversations: fixture.conversations.filter(item => item.agentId === agentId) });
      return;
    }
    if (request.method() === 'GET' && path.endsWith('/messages')) { await json(route, { messages: [] as ConversationMessage[] }); return; }
    if (request.method() === 'GET' && path.endsWith('/executions')) { await json(route, { executions: [] }); return; }
    if (request.method() === 'GET' && path.endsWith('/runs')) { await json(route, { runs: [] }); return; }
    if (request.method() === 'GET' && path.endsWith('/interactions')) { await json(route, { interactions: [] }); return; }
    if (request.method() === 'GET' && path.endsWith('/collaboration/tasks')) {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      await json(route, { tasks: fixture.tasks.slice(offset, offset + 100) });
      return;
    }
    if (request.method() === 'GET' && path.endsWith('/progress')) {
      const targetId = path.split('/').at(-2);
      const selectedTask = fixture.tasks.find(item => item.id === targetId);
      if (!selectedTask) { await route.fulfill({ status: 404, json: { error: 'fixture task not found' } }); return; }
      const progress: CollaborationProgress = { task: selectedTask, runs: [], events: [], eventCursor: 0, candidates: [], reviews: [] };
      await json(route, { progress });
      return;
    }
    if (request.method() === 'GET' && path.endsWith('/memory/entries')) { await json(route, { entries: [] }); return; }
    if (request.method() === 'GET' && path.endsWith('/memory/contexts')) { await json(route, { contexts }); return; }
    if (request.method() === 'GET' && path.endsWith('/memory/entries/memory-b')) {
      await json(route, { entry: { id: 'memory-b', workspaceId, scope: 'workspace', version: 9 } });
      return;
    }
    if (request.method() === 'POST' && path.endsWith('/memory/feedback')) {
      const body = request.postDataJSON();
      if (body.memoryId !== 'memory-b' || body.contextId !== 'context-b') fixture.failures.push('Feedback was posted for a different stable context or memory key');
      await json(route, { feedback: {
        id: 'feedback-b', workspaceId, memoryId: 'memory-b', memoryVersion: 4, currentEntryVersion: 9,
        contextKind: 'run', contextId: 'context-b', contextHash: 'b'.repeat(64), kind: 'helpful',
        comment: body.comment ?? '', createdAt: now, action: null,
      } });
      return;
    }
    if (request.method() === 'GET' && path.endsWith('/memory/candidates')) { await json(route, { candidates }); return; }
    if (request.method() === 'POST' && /\/memory\/candidates\/[^/]+\/review$/.test(path)) {
      const body = request.postDataJSON();
      fixture.requests[fixture.requests.length - 1]!.body = JSON.stringify(body);
      await json(route, { reviewed: true });
      return;
    }

    fixture.failures.push(`Unexpected fixture request: ${request.method()} ${path}`);
    await route.fulfill({ status: 404, json: { error: 'unhandled deterministic P4 fixture request' } });
  });
}

test.beforeAll(async ({ request }) => {
  // Next's first Windows compilation took 21.7s in CI. Compile the route in
  // bounded setup so each regression keeps the ordinary interaction timeout.
  test.setTimeout(120_000);
  const response = await request.get(`/workspace/${workspaceId}`, { timeout: 120_000 });
  expect(response.ok()).toBe(true);
});

test('P4 stable-key regression keeps group history, feedback, and candidate actions attached to their IDs', async ({ page }) => {
  const fixture = createFixture();
  await installDeterministicApi(page, fixture);

  await page.goto(`/workspace/${workspaceId}?conversationSource=workspace&conversationId=same-id&view=chat`);
  await expect(page).toHaveTitle('AgentOS');
  await expect(page.locator('[data-signal-workspace]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'agent-b · Fixture' })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: /Runtime same-id/ }).click();
  await expect(page).toHaveURL(/conversationSource=runtime/);
  await expect(page.locator('[data-visible-conversation-identity]')).toHaveAttribute('data-visible-conversation-identity', /.+/);

  await page.goto(`/workspace/${workspaceId}?conversationSource=runtime&conversationId=same-id&collaborationId=task-101&view=execution`);
  await expect(page.getByRole('heading', { name: 'Task 101', exact: true })).toBeVisible();
  const selectedTask = page.getByRole('combobox', { name: '选择历史协作任务' });
  await expect(selectedTask).toHaveValue('task-101');
  await page.getByRole('button', { name: '加载更多历史任务' }).click();
  await expect(selectedTask).toHaveValue('task-101');
  await expect(page.getByRole('button', { name: '加载更多历史任务' })).toHaveCount(0);
  expect(fixture.requests.some(item => item.path.includes('/task-101/progress'))).toBe(true);
  expect(fixture.requests.some(item => /offset=100/.test(item.path))).toBe(true);

  await page.getByRole('button', { name: '打开项目知识' }).click();
  await expect(page.getByRole('tablist', { name: '项目知识来源' })).toBeVisible();
  await page.getByRole('tab', { name: '使用记录', exact: true }).click();
  await page.getByRole('button').filter({ hasText: 'run-owner-b' }).click();
  const feedback = page.locator('[data-agentos="memory-version-feedback"][data-memory-id="memory-b"]');
  await expect(feedback).toBeVisible();
  await feedback.getByLabel('对 memory-b 的补充反馈').fill('Keep feedback on the selected context.');
  await feedback.getByRole('button', { name: '有帮助', exact: true }).click();
  await expect(feedback.getByRole('status')).toContainText('感谢反馈');

  await page.getByRole('tab', { name: '候选审查', exact: true }).click();
  const candidateA = page.locator('[data-candidate-id="candidate-a"]');
  const candidateB = page.locator('[data-candidate-id="candidate-b"]');
  await expect(candidateA).toBeVisible();
  await expect(candidateB).toBeVisible();
  await candidateA.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(candidateA).toHaveCount(0);
  await expect(candidateB.getByRole('heading', { name: 'Candidate B', exact: true })).toBeVisible();
  await candidateB.getByRole('button', { name: '接受', exact: true }).click();
  await expect(candidateB).toHaveCount(0);

  const writes = fixture.requests.filter(item => item.method === 'POST');
  expect(writes.map(item => item.path)).toEqual([
    `/api/workspaces/${workspaceId}/memory/feedback`,
    `/api/workspaces/${workspaceId}/memory/candidates/candidate-a/review`,
    `/api/workspaces/${workspaceId}/memory/candidates/candidate-b/review`,
  ]);
  expect(JSON.parse(writes[0]!.body ?? '{}')).toMatchObject({
    expectedVersion: 9, memoryId: 'memory-b', memoryVersion: 4, contextId: 'context-b', contextKind: 'run', kind: 'helpful',
    comment: 'Keep feedback on the selected context.',
  });
  expect(JSON.parse(writes[1]!.body ?? '{}')).toMatchObject({ expectedVersion: 3, outcome: 'reject' });
  expect(JSON.parse(writes[2]!.body ?? '{}')).toMatchObject({ expectedVersion: 7, outcome: 'accept' });
  expect(fixture.failures).toEqual([]);
});

for (const mode of ['known-failure', 'unknown-side-effects'] as const) {
  test(`P4 collaboration recovery binds ${mode} to the selected task and a stable request key`, async ({ page }, testInfo) => {
    const fixture = createFixture();
    const target = { ...task(102), id: 'task-recovery', title: 'Recovery Target', status: 'failed' as const,
      version: 7, canonicalRunId: 'failed-run', failureReason: 'Fixture failure' };
    const sibling = { ...task(103), id: 'task-sibling', title: 'Unrelated Task' };
    fixture.tasks = [target, sibling];
    let recoveryWrites = 0;
    await installDeterministicApi(page, fixture);
    await page.route('**/api/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const recoveryPath = `/api/workspaces/${workspaceId}/collaboration/tasks/${target.id}`;
      if (request.method() === 'GET' && path === `${recoveryPath}/recovery`) {
        await json(route, { recovery: { taskId: target.id, taskVersion: 7, runId: 'failed-run', runVersion: 3,
          failureCode: mode === 'known-failure' ? 'PROVIDER_NOT_AVAILABLE' : 'OWNER_STATE_UNKNOWN',
          recoveryRequired: mode === 'unknown-side-effects', checkedBaseCommit: 'a'.repeat(40),
          actions: { retryKnownFailure: mode === 'known-failure', newLinkedTask: mode === 'unknown-side-effects' } } });
        return;
      }
      if (request.method() === 'POST' && path === `${recoveryPath}/recover`) {
        fixture.requests.push({ path, method: 'POST', body: request.postData(), key: request.headers()['idempotency-key'] });
        recoveryWrites += 1;
        if (recoveryWrites === 1) {
          // A lost response must keep the exact intent and key on user retry.
          await route.abort('failed');
          return;
        }
        if (mode === 'unknown-side-effects') {
          const linked = { ...target, id: 'linked-task', title: 'Linked Recovery Task', status: 'awaiting_confirmation' as const,
            version: 1, canonicalRunId: undefined };
          fixture.tasks.push(linked);
          await json(route, { recovery: { action: 'new-linked-task', task: linked, priorRunId: 'failed-run',
            checkedBaseCommit: 'a'.repeat(40), replayed: true } });
        } else {
          target.canonicalRunId = 'retry-run';
          await json(route, { recovery: { action: 'retry-known-failure', task: target, priorRunId: 'failed-run',
            newRunId: 'retry-run', checkedBaseCommit: 'a'.repeat(40), replayed: true } });
        }
        return;
      }
      await route.fallback();
    });
    await page.goto(`/workspace/${workspaceId}?conversationSource=runtime&conversationId=same-id&collaborationId=task-recovery&view=execution`);
    await expect(page.getByRole('heading', { name: 'Recovery Target', exact: true })).toBeVisible();
    const panel = page.locator('section[aria-label="协作任务恢复"]');
    await expect(panel).toBeVisible();
    const action = mode === 'known-failure' ? '重试已知启动前失败' : '在干净基线上创建关联任务';
    const forbiddenAction = mode === 'known-failure' ? '在干净基线上创建关联任务' : '重试已知启动前失败';
    await expect(panel.getByRole('button', { name: forbiddenAction })).toHaveCount(0);
    await panel.getByRole('button', { name: action, exact: true }).click();
    await expect(panel.getByRole('alert')).toBeVisible();
    await expect(panel.getByRole('button', { name: action, exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: action, exact: true }).click();
    if (mode === 'unknown-side-effects') {
      await expect(page.getByRole('heading', { name: 'Linked Recovery Task', exact: true })).toBeVisible();
      await expect(page).toHaveURL(/collaborationId=linked-task/u);
      await expect(page.getByRole('button', { name: '确认并启动', exact: true })).toBeEnabled();
    } else {
      await expect(panel.getByRole('status')).toContainText('failed-run');
      await expect(page.getByRole('heading', { name: 'Recovery Target', exact: true })).toBeVisible();
    }
    const writes = fixture.requests.filter(record => record.method === 'POST');
    expect(writes).toHaveLength(2);
    expect(writes[0]!.path).toBe(`/api/workspaces/${workspaceId}/collaboration/tasks/task-recovery/recover`);
    expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]!.key).toMatch(/^p2-recovery-/u);
    expect(JSON.parse(writes[0]!.body!)).toEqual({ action: mode === 'known-failure' ? 'retry-known-failure' : 'new-linked-task',
      expectedTaskVersion: 7, expectedRunId: 'failed-run', expectedRunVersion: 3 });
    expect(writes.some(record => /\/respond$|\/confirm$/u.test(record.path))).toBe(false);
    expect(fixture.failures).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`collaboration-recovery-${mode}.png`) });
  });
}
