import { expect, test, type Page, type Route } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgentProfile, AgentRunDetails, CollaborationProgress, CollaborationTask, Conversation, ConversationMessage, Workspace } from '@agentos/shared';
import { conversationDraftStorageKey, createConversationDraftIdentityKey, createEmptyConversationDraft, serializeConversationDraft, type ConversationDraftIdentity } from '../src/lib/conversationDraftState';

const ws = 'phase-e-fixture';
const now = '2026-09-30T00:00:00.000Z';
const identity = (id: string, source: 'workspace' | 'runtime' = 'workspace'): ConversationDraftIdentity => ({ workspaceId: ws, storageSource: source, conversationId: id });
const agent = (id: string): AgentProfile => ({ id, workspaceId: ws, name: id, role: 'codex', enabled: true, cliCommand: 'fixture', cliArgs: [], roleTitle: 'Fixture', systemPrompt: '', permissions: ['read'], createdAt: now, updatedAt: now });
const direct = (id: string, agentId = 'agent-a'): Conversation => ({ id, workspaceId: ws, agentId, type: 'direct', title: id, createdAt: now, updatedAt: now });
const task = (n: number): CollaborationTask => ({ id: `task-${n}`, workspaceId: ws, conversationId: 'same-id', title: `Task ${n}`, objective: 'Isolated fixture', scope: ['src/'], acceptanceCommands: ['fixture'], plannerAgentId: 'agent-a', implementerAgentId: 'agent-b', reviewerAgentId: 'agent-c', status: 'cancelled', version: 1, planHash: 'fixture', baseCommit: 'fixture', maxReworkRounds: 2, reworkRound: 0, createdAt: now, updatedAt: now });
function barrier<T>() {
  let release: (value: T) => void = () => { throw new Error('barrier not initialized'); };
  const promise = new Promise<T>(resolve => { release = resolve; });
  return { promise, release };
}

function fixture() {
  const agents = [agent('agent-a'), agent('agent-b'), agent('agent-c')];
  const workspace: Workspace = { id: ws, name: 'Isolated fixture', rootPath: 'fixture-only', gitEnabled: false, memoryEnabled: false, agents, lastOpenedAt: now, createdAt: now, updatedAt: now };
  const conversations = [direct('private-a'), direct('private-b'), direct('first-b', 'agent-b'), direct('same-id', 'agent-b')];
  const messages = new Map<string, ConversationMessage[]>();
  const tasks = Array.from({ length: 101 }, (_, n) => task(n + 1));
  return { workspace, agents, conversations, messages, tasks, requests: [] as { path: string; method: string; body: string | null; key: string | undefined }[], failures: [] as string[] };
}
type Model = ReturnType<typeof fixture>;
type Override = (route: Route, model: Model) => Promise<boolean>;
const json = (route: Route, body: unknown) => route.fulfill({ json: body, headers: { 'Access-Control-Allow-Origin': '*' } });
const pageEvidence = new WeakMap<Page, {
  model: Model;
  consoleMessages: { type: string; text: string; url: string }[];
  failedRequests: { url: string; error: string }[];
}>();

async function install(page: Page, model: Model, override?: Override) {
  page.on('pageerror', error => model.failures.push(error.message));
  const consoleMessages: { type: string; text: string; url: string }[] = [];
  const failedRequests: { url: string; error: string }[] = [];
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') consoleMessages.push({ type: message.type(), text: message.text(), url: message.location().url });
  });
  page.on('requestfailed', request => failedRequests.push({ url: request.url(), error: request.failure()?.errorText ?? '' }));
  pageEvidence.set(page, { model, consoleMessages, failedRequests });
  // Catch all API hosts, not just the current Web origin. No request can reach a
  // user's business database, including unexpected writes and preflights.
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    model.requests.push({ path: path + url.search, method: request.method(), body: request.postData(), key: request.headers()['idempotency-key'] });
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } }); return; }
    if (override && await override(route, model)) return;
    if (request.method() !== 'GET') { model.failures.push(`Unexpected write: ${path}`); await json(route, { error: 'fixture rejects unexpected write' }); return; }
    if (path === `/api/workspaces/${ws}`) { await json(route, { workspace: model.workspace }); return; }
    if (path.endsWith('/agents/presence')) { await json(route, { presence: [] }); return; }
    if (path.endsWith('/agents')) { await json(route, { agents: model.agents }); return; }
    if (path.endsWith('/runtime/conversations')) { await json(route, { conversations: [{ id: 'same-id', workspaceId: ws, kind: 'group', status: 'active', version: 1, title: 'Runtime same-id', createdAt: now, updatedAt: now }] }); return; }
    if (path.endsWith('/conversations') && url.searchParams.has('agentId')) { await json(route, { conversations: model.conversations.filter(item => item.agentId === url.searchParams.get('agentId')) }); return; }
    if (path.endsWith('/messages')) { const id = path.split('/').at(-2) ?? ''; await json(route, { messages: model.messages.get(id) ?? [] }); return; }
    if (path.endsWith('/executions')) { await json(route, { executions: [] }); return; }
    if (path.endsWith('/runs')) { await json(route, { runs: [] }); return; }
    if (path.endsWith('/interactions')) { await json(route, { interactions: [] }); return; }
    if (path.endsWith('/collaboration/tasks')) { const offset = Number(url.searchParams.get('offset') ?? 0); await json(route, { tasks: model.tasks.slice(offset, offset + 100) }); return; }
    if (path.endsWith('/progress')) {
      const id = path.split('/').at(-2);
      const target = model.tasks.find(item => item.id === id);
      if (!target) { await route.fulfill({ status: 404, json: { error: 'missing fixture task' } }); return; }
      const progress: CollaborationProgress = { task: target, runs: [], events: [], eventCursor: 0, candidates: [], reviews: [] };
      await json(route, { progress }); return;
    }
    model.failures.push(`Unexpected read: ${path}`);
    await route.fulfill({ status: 404, json: { error: 'missing fixture endpoint' } });
  });
}

async function ready(page: Page, scope: ConversationDraftIdentity) {
  await expect(page).toHaveTitle('AgentOS');
  await expect(page.locator('[data-signal-workspace]')).toBeVisible();
  await expect(page.locator('[data-visible-conversation-identity]')).toHaveAttribute('data-visible-conversation-identity', createConversationDraftIdentityKey(scope));
  await expect(page.getByRole('textbox', { name: '消息输入框' })).toBeEnabled();
  await expect(page.locator('nextjs-portal')).toHaveCount(0);
}

async function selectPrivateHistory(page: Page, conversationId: string) {
  const entry = page.locator('.signal-history-button').filter({ hasText: conversationId });
  if (!await entry.isVisible()) {
    // Compact viewports do not mount the history until its real control opens
    // the overlay. Exercise navigation instead of forcing a hidden locator.
    await page.getByRole('button', { name: '打开会话列表', exact: true }).click();
  }
  await expect(entry).toBeVisible();
  await entry.click();
}

async function waitForChatSafeArea(page: Page) {
  await expect(page.locator('.signal-chat-scroll')).toHaveAttribute('data-scroll-restoration', 'ready');
  let previous = '';
  let stable = 0;
  await expect.poll(async () => {
    const layout = await page.locator('.signal-chat-scroll').evaluate(element => {
      const host = element.closest('[data-signal-chat]');
      const header = host?.querySelector('.signal-chat-header');
      const composer = host?.querySelector('.signal-chat-chrome');
      if (!host || !header || !composer) return null;
      const padding = getComputedStyle(element);
      const top = header.getBoundingClientRect().bottom - host.getBoundingClientRect().top + 28;
      const bottom = host.getBoundingClientRect().bottom - composer.getBoundingClientRect().top + 28;
      if (Math.abs(parseFloat(padding.paddingTop) - top) >= 1 || Math.abs(parseFloat(padding.paddingBottom) - bottom) >= 1) return null;
      return JSON.stringify([top, bottom, element.scrollHeight, element.clientHeight]);
    });
    stable = layout !== null && layout === previous ? stable + 1 : 0;
    previous = layout ?? '';
    return stable;
  }, { intervals: [100] }).toBeGreaterThanOrEqual(3);
}

test.afterEach(async ({ page }, testInfo) => {
  const evidence = pageEvidence.get(page);
  if (evidence) {
    // Keep raw fixture traffic and console evidence, including the deliberately
    // lost creation response. This is not evidence from the business API.
    const evidencePath = testInfo.outputPath('fixture-network-and-console.json');
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, JSON.stringify({ requests: evidence.model.requests, failures: evidence.model.failures, consoleMessages: evidence.consoleMessages, failedRequests: evidence.failedRequests }, null, 2));
    await testInfo.attach('fixture-network-and-console', { path: evidencePath, contentType: 'application/json' });
    const unexpectedConsoleErrors = evidence.consoleMessages.filter(message => message.type === 'error' && !(
      message.text === 'Failed to load resource: net::ERR_FAILED'
      && message.url.endsWith('/same-id/discussions')
      && evidence.failedRequests.some(request => request.url === message.url && request.error === 'net::ERR_FAILED')
    ));
    expect(unexpectedConsoleErrors).toEqual([]);
  }
  await expect(page).toHaveTitle('AgentOS');
  await expect(page.locator('[data-signal-workspace]')).toBeVisible();
  await expect(page.locator('nextjs-portal')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('page.png'), fullPage: false });
});

test('non-first cross-Agent private URL, same-ID runtime source, and history restore the actual owner', async ({ page }) => {
  const model = fixture();
  await install(page, model);
  await page.goto(`/workspace/${ws}?conversationSource=workspace&conversationId=same-id&view=chat`);
  await ready(page, identity('same-id'));
  await expect(page.getByRole('button', { name: 'agent-b · Fixture' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('textbox', { name: '消息输入框' }).fill('private source draft');
  await page.getByRole('button', { name: /Runtime same-id/ }).click();
  await ready(page, identity('same-id', 'runtime'));
  await expect(page).toHaveURL(/conversationSource=runtime/);
  await expect(page.getByRole('textbox', { name: '消息输入框' })).toHaveValue('');
  await page.goBack();
  await ready(page, identity('same-id'));
  await expect(page.getByRole('textbox', { name: '消息输入框' })).toHaveValue('private source draft');
  await page.reload();
  await ready(page, identity('same-id'));
  await page.goto(`/workspace/${ws}?conversationSource=runtime&conversationId=private-a&view=chat`);
  await expect(page.getByText('指定的运行时群聊不存在或已归档；没有切换到其他会话。')).toBeVisible();
  await expect(page.locator('[data-visible-conversation-identity]')).toHaveAttribute('data-visible-conversation-identity', '');
  expect(model.failures).toEqual([]);
});

for (const source of ['', '&conversationSource=workspace']) {
  test(`legacy canonical group URL validates its actual runtime source (${source || 'source omitted'})`, async ({ page }) => {
    const model = fixture();
    await install(page, model, async route => {
      if (!new URL(route.request().url()).pathname.endsWith('/runtime/conversations')) return false;
      await json(route, { conversations: [{ id: 'canonical-only', workspaceId: ws, kind: 'group', status: 'active', version: 1, title: 'Canonical only', createdAt: now, updatedAt: now }] });
      return true;
    });
    await page.goto(`/workspace/${ws}?conversationId=canonical-only${source}&view=chat`);
    await ready(page, identity('canonical-only', 'runtime'));
    await page.getByRole('textbox', { name: '消息输入框' }).fill('canonical draft');
    await page.reload();
    await ready(page, identity('canonical-only', 'runtime'));
    await expect(page.getByRole('textbox', { name: '消息输入框' })).toHaveValue('canonical draft');
    expect(model.requests.filter(item => item.method === 'POST')).toEqual([]);
    expect(model.failures).toEqual([]);
  });
}

test('ambiguous and wrong-workspace legacy links fail closed without first-item fallback', async ({ page }) => {
  const model = fixture();
  await install(page, model, async route => {
    if (!new URL(route.request().url()).pathname.endsWith('/runtime/conversations')) return false;
    await json(route, { conversations: [
      { id: 'same-id', workspaceId: ws, kind: 'group', status: 'active', version: 1, title: 'Runtime same-id', createdAt: now, updatedAt: now },
      { id: 'foreign-group', workspaceId: 'another-workspace', kind: 'group', status: 'active', version: 1, title: 'Foreign group', createdAt: now, updatedAt: now },
      { id: 'archived-group', workspaceId: ws, kind: 'group', status: 'archived', version: 1, title: 'Archived group', createdAt: now, updatedAt: now },
    ] });
    return true;
  });
  await page.goto(`/workspace/${ws}?conversationId=same-id&view=chat`);
  await expect(page.getByText('指定的会话 ID 存在于多个来源；请使用会话列表中的明确链接，没有自动选择。')).toBeVisible();
  await expect(page.locator('[data-visible-conversation-identity]')).toHaveAttribute('data-visible-conversation-identity', '');
  for (const id of ['foreign-group', 'archived-group', 'missing-group']) {
    await page.goto(`/workspace/${ws}?conversationSource=workspace&conversationId=${id}&view=chat`);
    await expect(page.getByText('指定的会话不存在或不属于当前工作区；没有回退到其他会话。')).toBeVisible();
    await expect(page.locator('[data-visible-conversation-identity]')).toHaveAttribute('data-visible-conversation-identity', '');
  }
  expect(model.requests.filter(item => item.method === 'POST')).toEqual([]);
  expect(model.failures).toEqual([]);
});

test('A send completing after switching B settles only the submitted A revision and images', async ({ page }) => {
  const model = fixture();
  const posted = barrier<string>();
  const release = barrier<void>();
  await install(page, model, async route => {
    if (!route.request().url().endsWith('/private-a/messages/stream')) return false;
    posted.release(route.request().postData() ?? '');
    await release.promise;
    await route.fulfill({ contentType: 'text/event-stream', body: 'id: 1\nevent: run\ndata: {"runId":"run-a"}\n\nid: 2\nevent: execution\ndata: {"status":"streaming_response","content":"OLD_A_DELTA"}\n\nid: 3\nevent: done\ndata: {}\n\n' });
    return true;
  });
  await page.goto(`/workspace/${ws}?conversationSource=workspace&conversationId=private-a&view=chat`);
  await ready(page, identity('private-a'));
  await page.getByRole('textbox', { name: '消息输入框' }).fill('submitted A text');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ7sAAAAASUVORK5CYII=', 'base64');
  await page.locator('input[type=file]').setInputFiles({ name: 'submitted.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByRole('button', { name: '放大 submitted.png' })).toBeVisible();
  await page.getByRole('textbox', { name: '消息输入框' }).press('Enter');
  const payload = JSON.parse(await posted.promise) as { content: string; attachments: unknown[] };
  expect(payload.content).toBe('submitted A text'); expect(payload.attachments).toHaveLength(1);
  await page.getByRole('textbox', { name: '消息输入框' }).fill('new A revision');
  await page.locator('input[type=file]').setInputFiles({ name: 'unsent.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByRole('button', { name: '放大 unsent.png' })).toBeVisible();
  await selectPrivateHistory(page, 'private-b');
  await ready(page, identity('private-b'));
  await page.getByRole('textbox', { name: '消息输入框' }).fill('B stays selected');
  release.release(undefined);
  const aKey = conversationDraftStorageKey(identity('private-a'));
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}').attachments?.map((item: { name: string }) => item.name), aKey)).toEqual(['unsent.png']);
  await expect(page).toHaveURL(/conversationId=private-b/);
  await expect(page.getByRole('textbox', { name: '消息输入框' })).toHaveValue('B stays selected');
  await expect(page.getByText('OLD_A_DELTA')).toHaveCount(0);
  await selectPrivateHistory(page, 'private-a');
  await ready(page, identity('private-a'));
  await expect(page.getByRole('textbox', { name: '消息输入框' })).toHaveValue('new A revision');
  await expect(page.getByRole('button', { name: '放大 submitted.png' })).toHaveCount(0);
  expect(model.failures).toEqual([]);
});

test('explicit foreign Run is rejected before Inspector/evidence/action requests', async ({ page }) => {
  const model = fixture();
  const release = barrier<void>();
  const requested = barrier<void>();
  await install(page, model, async route => {
    if (!route.request().url().endsWith('/runs/run-b')) return false;
    requested.release(undefined); await release.promise;
    const details: AgentRunDetails = {
      run: { id: 'run-b', workspaceId: ws, conversationId: 'private-b', sourceMessageId: 'message-b', objective: 'Fixture foreign Run', intent: 'execute', status: 'running', createdAt: now, updatedAt: now },
      sourceMessage: { id: 'message-b', workspaceId: ws, conversationId: 'private-b', senderType: 'user', content: 'FOREIGN_EVIDENCE', createdAt: now },
      executions: [], events: [], cliInvocations: [], fileChanges: [], artifacts: [], usedMemories: [], preferenceApplications: [], steps: [],
    };
    await json(route, details); return true;
  });
  await page.goto(`/workspace/${ws}?conversationSource=workspace&conversationId=private-a&runId=run-b&view=execution`);
  await requested.promise;
  await expect(page.locator('[aria-label="Run Inspector"]')).toHaveCount(0);
  release.release(undefined);
  await expect(page.getByText('指定的 Run 不属于当前会话；未展示其证据或写操作。').first()).toBeVisible();
  await expect(page.locator('[aria-label="Run Inspector"]')).toHaveCount(0);
  await expect(page.getByText('FOREIGN_EVIDENCE')).toHaveCount(0);
  expect(model.requests.filter(item => /inspector|\/cancel|\/retry/.test(item.path))).toEqual([]);
  expect(model.failures).toEqual([]);
});

test('pending private creation finishing on A migrates its draft without taking selection from B', async ({ page }) => {
  const model = fixture();
  model.conversations.splice(0, 2);
  const createRequested = barrier<void>();
  const releaseCreation = barrier<void>();
  await install(page, model, async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path.endsWith('/conversations')) {
      createRequested.release(undefined); await releaseCreation.promise;
      const conversation = direct('created-a'); model.conversations.push(conversation);
      await json(route, { conversation }); return true;
    }
    if (request.method() === 'PATCH' && path.endsWith('/created-a/settings')) {
      await json(route, { conversation: direct('created-a') }); return true;
    }
    if (path.endsWith('/created-a/messages/stream')) {
      await route.fulfill({ contentType: 'text/event-stream', body: 'id: 1\nevent: done\ndata: {}\n\n' }); return true;
    }
    return false;
  });
  await page.goto(`/workspace/${ws}?conversationSource=workspace&view=chat`);
  const pending: ConversationDraftIdentity = { workspaceId: ws, storageSource: 'workspace', pendingAgentId: 'agent-a' };
  await ready(page, pending);
  await page.getByRole('textbox', { name: '消息输入框' }).fill('submitted pending A');
  await page.getByRole('textbox', { name: '消息输入框' }).press('Enter');
  await createRequested.promise;
  await page.getByRole('textbox', { name: '消息输入框' }).fill('new A pending revision');
  await page.getByRole('button', { name: 'agent-b · Fixture' }).click();
  await ready(page, identity('first-b'));
  await page.getByRole('textbox', { name: '消息输入框' }).fill('B unchanged');
  releaseCreation.release(undefined);
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}').text, conversationDraftStorageKey(identity('created-a')))).toBe('new A pending revision');
  await expect(page.getByRole('textbox', { name: '消息输入框' })).toHaveValue('B unchanged');
  await expect(page.locator('[data-visible-conversation-identity]')).toHaveAttribute('data-visible-conversation-identity', createConversationDraftIdentityKey(identity('first-b')));
  expect(await page.evaluate(key => localStorage.getItem(key), conversationDraftStorageKey(pending))).toBeNull();
  expect(model.failures).toEqual([]);
});

test('refresh resumes the original queue key and frozen payload after a lost creation response', async ({ page }) => {
  const model = fixture();
  const scope = identity('same-id', 'runtime');
  const key = createConversationDraftIdentityKey(scope);
  const draft = { ...createEmptyConversationDraft(), revision: 4, textRevision: 2, mentionsRevision: 1, text: 'new manual composer text', queue: [{ id: 'queue-a', identityKey: key, content: 'frozen queued text', mentionedAgentIds: ['agent-a'], runIntent: 'review' as const, thinkingEffort: 'auto' as const, attachments: [] }] };
  const outboxKey = `agentos:group-discussion-outbox:v1:${encodeURIComponent(key)}`;
  const outbox = {
    identityKey: key, idempotencyKey: 'original-queue-key', clientMessageId: 'original-queue-key', phase: 'prepared',
    payload: { content: 'frozen queued text', intent: 'review', mentionedAgentIds: ['agent-a'], attachmentIds: [], budget: { maxAgentsPerTurn: 1, maxRepliesPerAgent: 1, maxTotalReplies: 1, maxAgentHops: 1 } },
    submission: { identityKey: key, revision: 4, textRevision: 2, mentionsRevision: 1, text: 'frozen queued text', mentionedAgentIds: ['agent-a'], attachmentIds: [], queueItemId: 'queue-a' },
  };
  await page.addInitScript(({ draftKey, draftValue, outboxKey, outboxValue }) => {
    if (localStorage.getItem('phase-e-seeded')) return;
    localStorage.setItem(draftKey, draftValue); localStorage.setItem(outboxKey, outboxValue);
    localStorage.setItem('phase-e-seeded', 'true');
  }, { draftKey: conversationDraftStorageKey(scope), draftValue: serializeConversationDraft(draft), outboxKey, outboxValue: JSON.stringify(outbox) });
  let createAttempts = 0;
  let sourceMessages = 0;
  let responds = 0;
  let completed = false;
  const message = { id: 'source-a', conversationId: 'same-id', senderType: 'user', senderAgentId: null, content: 'frozen queued text', runId: null };
  const interaction = () => ({ id: 'interaction-a', conversationId: 'same-id', sourceMessageId: 'source-a', status: completed ? 'completed' : 'active', stopReason: null, loopGuardSignal: null, replyCount: completed ? 1 : 0, hopCount: completed ? 1 : 0, version: completed ? 2 : 1, maxAgentsPerTurn: 1, maxRepliesPerAgent: 1, maxTotalReplies: 1, maxAgentHops: 1 });
  await install(page, model, async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/same-id/discussions')) {
      createAttempts += 1;
      if (sourceMessages === 0) sourceMessages = 1;
      if (createAttempts === 1) { await route.abort('failed'); return true; }
      await json(route, { message, interaction: interaction() }); return true;
    }
    if (path.endsWith('/interactions/interaction-a')) {
      await json(route, { interaction: interaction(), replies: [], budget: { repliesUsed: completed ? 1 : 0, repliesRemaining: completed ? 0 : 1, hopsUsed: completed ? 1 : 0, hopsRemaining: completed ? 0 : 1, distinctAgents: completed ? 1 : 0, agentsRemaining: completed ? 0 : 1 } }); return true;
    }
    if (path.endsWith('/interaction-a/respond')) {
      responds += 1; completed = true;
      await route.fulfill({ contentType: 'text/event-stream', body: 'event: group.done\ndata: {}\n\n' }); return true;
    }
    if (path.endsWith('/interaction-a/events')) {
      await route.fulfill({ contentType: 'text/event-stream', body: 'id: 11\nevent: group.done\ndata: {"cursor":11,"ownerEpoch":1,"interactionId":"interaction-a","interactionVersion":2}\n\n' }); return true;
    }
    return false;
  });
  await page.goto(`/workspace/${ws}?conversationSource=runtime&conversationId=same-id&view=chat`);
  await expect.poll(() => createAttempts).toBe(1);
  await expect(page.getByRole('button', { name: '核对后恢复原发送' })).toBeVisible();
  await page.reload();
  await ready(page, scope);
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), outboxKey)).toBeNull();
  expect(createAttempts).toBe(2); expect(sourceMessages).toBe(1); expect(responds).toBe(1);
  const creates = model.requests.filter(item => item.path.endsWith('/same-id/discussions'));
  expect(creates.map(item => item.key)).toEqual(['original-queue-key', 'original-queue-key']);
  expect(creates[0]?.body).toBe(creates[1]?.body);
  expect(JSON.parse(creates[1]?.body ?? '{}').content).toBe('frozen queued text');
  await expect(page.getByRole('textbox', { name: '消息输入框' })).toHaveValue('new manual composer text');
  expect(model.requests.some(item => item.method === 'GET' && /same-id\/interactions\/interaction-a\/events\?after=0/.test(item.path))).toBe(true);
  await page.reload(); await ready(page, scope); expect(createAttempts).toBe(2);
  expect(model.failures).toEqual([]);
});

test('task 101 deep link loads directly and pagination preserves the selected task', async ({ page }) => {
  const model = fixture();
  await install(page, model);
  await page.goto(`/workspace/${ws}?conversationSource=runtime&conversationId=same-id&collaborationId=task-101&view=execution`);
  await expect(page.getByRole('heading', { name: 'Task 101', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '选择历史协作任务' })).toHaveValue('task-101');
  await page.getByRole('button', { name: '加载更多历史任务' }).click();
  await expect(page.getByRole('combobox', { name: '选择历史协作任务' })).toHaveValue('task-101');
  await expect(page.getByRole('button', { name: '加载更多历史任务' })).toHaveCount(0);
  expect(model.requests.some(item => item.path.includes('/task-101/progress'))).toBe(true);
  expect(model.requests.some(item => /offset=100/.test(item.path))).toBe(true);
  expect(model.failures).toEqual([]);
});

test('frozen candidate preview loads a frozen candidate page and fetches one text diff on demand', async ({ page }, testInfo) => {
  // Browser API replies are fixture-mocked here; persisted-candidate behavior is covered by the server workflow integration test.
  const model = fixture();
  const baseCommit = 'b'.repeat(40);
  const diffHash = 'd'.repeat(64);
  const contentHash = 'e'.repeat(64);
  const target = { ...task(102), id: 'task-preview', title: 'Frozen Preview Task', status: 'awaiting_application' as const,
    baseCommit, currentCandidateId: 'candidate-preview' };
  model.tasks.splice(0, model.tasks.length, target);
  const candidate = { id: 'candidate-preview', round: 0, diffHash, contentHash, testStatus: 'passed', testExitCode: 0,
    testCommand: 'pnpm test', reviewConclusion: 'approved', reviewSummary: 'Frozen candidate reviewed' };
  const frozenPage = { workspaceId: ws, collaborationTaskId: target.id, candidateId: candidate.id, baseCommit,
    headCommit: 'c'.repeat(40), snapshotVersion: 2, manifestVersion: 2, diffHash, contentHash, offset: 0, totalFiles: 1,
    totalAdditions: 1, totalDeletions: 1, files: [{ fileIndex: 0, path: 'src/frozen.ts', status: 'modified',
      additions: 1, deletions: 1, binary: false, withheld: false }], withheldContent: false, withheldReasons: [] };
  const frozenDiff = { workspaceId: ws, collaborationTaskId: target.id, candidateId: candidate.id, baseCommit,
    manifestVersion: 2, diffHash, contentHash, fileIndex: 0, path: 'src/frozen.ts',
    diffText: 'diff --git a/src/frozen.ts b/src/frozen.ts\n@@ -1 +1 @@\n-old\n+new', withheld: false };
  await install(page, model, async (route, current) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/task-preview/progress')) {
      await json(route, { progress: { task: target, runs: [], events: [], eventCursor: 0, candidates: [candidate], reviews: [] } });
      return true;
    }
    if (url.pathname.endsWith('/candidates/candidate-preview/preview/files/0')) { await json(route, frozenDiff); return true; }
    if (url.pathname.endsWith('/candidates/candidate-preview/preview')) {
      await route.fulfill({ json: frozenPage, headers: { 'Cache-Control': 'no-store' } });
      return true;
    }
    return false;
  });

  await page.goto(`/workspace/${ws}?conversationSource=runtime&conversationId=same-id&collaborationId=task-preview&view=execution`);
  await expect(page.getByRole('heading', { name: 'Frozen Preview Task' })).toBeVisible();
  const applyButton = page.getByRole('button', { name: '先查看候选差异' });
  await expect(applyButton).toBeDisabled();
  await page.getByRole('button', { name: '查看冻结文件与差异' }).click();
  await expect(page.getByText('src/frozen.ts', { exact: true })).toBeVisible();
  await expect(page.locator('[data-candidate-preview] code').filter({ hasText: contentHash })).toBeVisible();
  await expect(applyButton).toHaveCount(0);
  await expect(page.getByRole('button', { name: '确认应用已预览候选' })).toBeEnabled();
  expect(model.requests.some(item => item.path.includes('/candidates/candidate-preview/preview?')
    && item.path.includes(`candidateBaseCommit=${baseCommit}`) && item.path.includes(`candidateContentHash=${contentHash}`))).toBe(true);
  expect(model.requests.some(item => item.path.includes('/preview/files/0'))).toBe(false,
    'the text body remains lazy until the user expands its file');

  await page.getByRole('button', { name: '按需加载文本差异' }).click();
  await expect(page.locator('pre')).toContainText('+new');
  await page.locator('[data-candidate-preview]').screenshot({ path: testInfo.outputPath('candidate-preview.png') });
  expect(model.requests.some(item => item.path.includes('/preview/files/0')
    && item.path.includes(`candidateContentHash=${contentHash}`))).toBe(true);
  expect(model.failures).toEqual([]);
});

test('scroll restore follows the conversation identity after delayed message loading', async ({ page }) => {
  const model = fixture();
  for (const id of ['private-a', 'private-b']) {
    model.messages.set(id, Array.from({ length: 60 }, (_, index) => ({
      id: `${id}-${index}`, workspaceId: ws, conversationId: id, senderType: 'user',
      content: `${id} message ${index}`, createdAt: now,
    })));
  }
  await install(page, model);
  await page.goto(`/workspace/${ws}?conversationSource=workspace&conversationId=private-a&view=chat`);
  await ready(page, identity('private-a'));
  await expect(page.getByText('private-a message 59', { exact: true })).toBeVisible();
  const scroll = page.locator('.signal-chat-scroll');
  await waitForChatSafeArea(page);
  await scroll.evaluate(element => { element.scrollTop = 240; });
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}').scrollPosition, conversationDraftStorageKey(identity('private-a')))).toBe(240);
  await selectPrivateHistory(page, 'private-b');
  await ready(page, identity('private-b'));
  await expect(page.getByText('private-b message 59', { exact: true })).toBeVisible();
  await waitForChatSafeArea(page);
  await scroll.evaluate(element => { element.scrollTop = 480; });
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}').scrollPosition, conversationDraftStorageKey(identity('private-b')))).toBe(480);
  await selectPrivateHistory(page, 'private-a');
  await ready(page, identity('private-a'));
  await expect(page.getByText('private-a message 59', { exact: true })).toBeVisible();
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBe(240);
  expect(model.failures).toEqual([]);
});

for (const position of ['bottom', 'reading'] as const) {
  test(`chat tab remount waits for dynamic Composer safe area and preserves ${position} position`, async ({ page }) => {
    const model = fixture();
    model.messages.set('same-id', Array.from({ length: 60 }, (_, index) => ({
      id: `group-message-${index}`, workspaceId: ws, conversationId: 'same-id', senderType: 'user',
      content: `Group reading message ${index}\nA second line keeps this real message surface scrollable.`, createdAt: now,
    })));
    await install(page, model);
    const scope = identity('same-id', 'runtime');
    await page.goto(`/workspace/${ws}?conversationSource=runtime&conversationId=same-id&view=chat`);
    await ready(page, scope);
    await expect(page.locator('.signal-message-row')).toHaveCount(60);
    const scroll = page.locator('.signal-chat-scroll');
    const safeAreaReady = () => waitForChatSafeArea(page);
    await safeAreaReady();
    const saved = await scroll.evaluate((element, position) => {
      element.scrollTop = position === 'bottom' ? element.scrollHeight : 420;
      return element.scrollTop;
    }, position);
    const storedPosition = () => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}').scrollPosition, conversationDraftStorageKey(scope));
    await expect.poll(storedPosition).toBe(saved);
    await page.getByRole('tab', { name: '执行详情', exact: true }).click();
    await expect(page.locator('.signal-composer')).toHaveCount(0);
    await page.getByRole('tab', { name: '对话', exact: true }).click();
    await ready(page, scope); await safeAreaReady();
    await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBe(saved);
    await expect.poll(storedPosition).toBe(saved);
    await page.reload(); await ready(page, scope); await safeAreaReady();
    await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBe(saved);
    if (position === 'reading') expect(await scroll.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(96);
    else expect(await scroll.evaluate(element => {
      const last = Array.from(element.querySelectorAll('.signal-message-row')).at(-1);
      const composer = element.closest('[data-signal-chat]')?.querySelector('.signal-composer');
      return last && composer ? composer.getBoundingClientRect().top - last.getBoundingClientRect().bottom : -1;
    })).toBeGreaterThanOrEqual(0);
    expect(model.requests.filter(item => item.method === 'POST')).toEqual([]); expect(model.failures).toEqual([]);
  });
}

test('interrupted unusable raw-active discussion is read-only with an explicit recovery reason', async ({ page }) => {
  const model = fixture();
  const interaction = { id: 'interrupted-a', conversationId: 'same-id', sourceMessageId: 'source-a', status: 'active',
    integrityStatus: 'unusable', integrityReason: 'execution-owner-unknown-after-restart', stopReason: null,
    loopGuardSignal: null, replyCount: 1, hopCount: 0, version: 3,
    maxAgentsPerTurn: 3, maxRepliesPerAgent: 1, maxTotalReplies: 3, maxAgentHops: 3 };
  await install(page, model, async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/same-id/interactions')) { await json(route, { interactions: [interaction] }); return true; }
    if (path.endsWith('/interactions/interrupted-a')) {
      await json(route, { interaction, replies: [], budget: { repliesUsed: 1, repliesRemaining: 2, hopsUsed: 0, hopsRemaining: 3, distinctAgents: 1, agentsRemaining: 2 } }); return true;
    }
    return false;
  });
  await page.goto(`/workspace/${ws}?conversationSource=runtime&conversationId=same-id&view=chat`);
  await ready(page, identity('same-id', 'runtime'));
  await expect(page.getByText('讨论已中断 · 等待处理', { exact: false })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'execution-owner-unknown-after-restart' })).toBeVisible();
  await expect(page.getByText(/正在发言|正在准备下一位 Agent/)).toHaveCount(0);
  const input = page.getByRole('textbox', { name: '消息输入框' });
  await input.fill('Unsent recovery draft'); await input.press('Enter');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  // A read-only discussion still permits local draft editing. With sending
  // disabled, Enter inserts a newline; it must not submit or clear the text.
  await expect(input).toHaveValue('Unsent recovery draft\n');
  await page.getByRole('tab', { name: '执行详情', exact: true }).click();
  await expect(page.locator('[aria-label="协作任务详情"]')).toBeVisible();
  expect(model.requests.filter(item => item.method === 'POST')).toEqual([]); expect(model.failures).toEqual([]);
});

test('reader wheel navigation wins over pending restore and remains stable after ready', async ({ page }) => {
  const model = fixture();
  model.messages.set('same-id', Array.from({ length: 60 }, (_, index) => ({
    id: `reader-${index}`, workspaceId: ws, conversationId: 'same-id', senderType: 'user',
    content: `Reader message ${index}\nA real scrollable message.`, createdAt: now,
  })));
  await install(page, model);
  const scope = identity('same-id', 'runtime');
  await page.goto(`/workspace/${ws}?conversationSource=runtime&conversationId=same-id&view=chat`);
  await ready(page, scope); await waitForChatSafeArea(page);
  const scroll = page.locator('.signal-chat-scroll');
  const storedPosition = () => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}').scrollPosition, conversationDraftStorageKey(scope));
  await scroll.evaluate(element => { element.scrollTop = 630; });
  await expect.poll(storedPosition).toBe(630);
  await page.getByRole('tab', { name: '执行详情', exact: true }).click();
  await expect(page).toHaveURL(/view=execution/);
  await expect(page.locator('.signal-composer')).toHaveCount(0);
  // Keep real Composer measurements changing during remount. This exposes the
  // restore window without sleeping or intercepting the component's callbacks.
  const measuring = await page.addStyleTag({ content: '.signal-chat-chrome { animation: fixture-safe-area 1s linear infinite; } @keyframes fixture-safe-area { from { padding-top: 0px; } to { padding-top: 48px; } }' });
  await page.getByRole('tab', { name: '对话', exact: true }).click();
  await expect(page).toHaveURL(/view=chat/);
  await ready(page, scope);
  await test.info().attach('pending-measurement-state', {
    body: JSON.stringify({
      style: await measuring.evaluate(style => ({ connected: style.isConnected, text: style.textContent })),
      geometry: await scroll.evaluate(element => {
        const chrome = element.closest('[data-signal-chat]')?.querySelector('.signal-chat-chrome');
        return { phase: element.getAttribute('data-scroll-restoration'), top: element.scrollTop,
          chromeAnimation: chrome ? getComputedStyle(chrome).animation : null,
          chromePadding: chrome ? getComputedStyle(chrome).paddingTop : null,
          activeAnimations: chrome?.getAnimations().map(animation => ({ state: animation.playState, time: animation.currentTime,
            keyframeEffect: animation.effect instanceof KeyframeEffect,
            keyframes: animation.effect instanceof KeyframeEffect ? animation.effect.getKeyframes() : [] })) };
      }),
    }), contentType: 'application/json',
  });
  await expect(scroll).toHaveAttribute('data-scroll-restoration', 'pending');
  const box = await scroll.boundingBox();
  if (!box) throw new Error('real scroll surface required');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 420);
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBe(420);
  // Release the actual geometry barrier only after reader navigation. A fixed
  // animation duration can end before a slow driver reaches the pending state.
  await measuring.evaluate(style => { style.parentNode?.removeChild(style); });
  await expect(scroll).toHaveAttribute('data-scroll-restoration', 'ready');
  await expect.poll(storedPosition).toBe(420);
  await waitForChatSafeArea(page);
  expect(await scroll.evaluate(element => element.scrollTop)).toBe(420);
  // A later native gesture after explicit readiness must not resurrect 630.
  await page.mouse.wheel(0, 120);
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBe(540);
  await expect.poll(storedPosition).toBe(540);
  expect(model.requests.filter(item => item.method === 'POST')).toEqual([]);
  expect(model.failures).toEqual([]);
});

test('page exposes persistence failure and native composition signals never send or enqueue', async ({ page }) => {
  const model = fixture();
  const releaseLookup = barrier<void>();
  const lookupRequested = barrier<void>();
  let sends = 0;
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('agentos:conversation-draft:')) throw new Error('fixture quota denied');
      original.call(this, key, value);
    };
  });
  await install(page, model, async route => {
    if (new URL(route.request().url()).searchParams.get('agentId') === 'agent-a') {
      lookupRequested.release(undefined); await releaseLookup.promise;
      await json(route, { conversations: model.conversations.filter(item => item.agentId === 'agent-a') }); return true;
    }
    if (!route.request().url().endsWith('/private-a/messages/stream')) return false;
    sends += 1;
    await route.fulfill({ contentType: 'text/event-stream', body: 'id: 1\nevent: done\ndata: {}\n\n' }); return true;
  });
  await page.goto(`/workspace/${ws}?conversationSource=workspace&conversationId=private-a&view=chat`);
  await lookupRequested.promise;
  await expect(page.getByRole('textbox', { name: '消息输入框' })).toBeDisabled();
  releaseLookup.release(undefined);
  await ready(page, identity('private-a'));
  const input = page.getByRole('textbox', { name: '消息输入框' });
  await input.fill('中文输入');
  await expect(page.getByRole('status').filter({ hasText: '刷新可能丢失' })).toBeVisible();
  await input.evaluate(element => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true }));
  });
  expect(sends).toBe(0); await expect(input).toHaveValue('中文输入');
  await input.press('Shift+Enter'); await expect(input).toHaveValue('中文输入\n');
  await input.press('Enter'); await expect.poll(() => sends).toBe(1);
  expect(model.failures).toEqual([]);
});
