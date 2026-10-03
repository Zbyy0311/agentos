import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import type { AgentProfile, Workspace } from '@agentos/shared';
import { createConversationDraftIdentityKey } from '../src/lib/conversationDraftState';

const workspaceId = 'p2-browser-fixture';
const now = '2026-10-03T00:00:00.000Z';

const agent = (id: string): AgentProfile => ({
  id, workspaceId, name: id, role: 'codex', enabled: true, cliCommand: 'fixture', cliArgs: [],
  roleTitle: 'Fixture Agent', systemPrompt: '', permissions: ['read'], createdAt: now, updatedAt: now,
});

function groupConversation(id: string, title: string) {
  return { id, workspaceId, kind: 'group', status: 'active', version: 1, title, createdAt: now, updatedAt: now };
}

function interaction(id: string, conversationId: string, sourceMessageId: string, integrityStatus: 'valid' | 'unusable' = 'valid') {
  return {
    id, conversationId, sourceMessageId, maxAgentsPerTurn: 2, maxRepliesPerAgent: 1,
    maxTotalReplies: 2, maxAgentHops: 2, status: 'active', stopReason: null,
    loopGuardSignal: null, replyCount: 1, hopCount: 0, version: 12,
    integrityStatus, integrityReason: integrityStatus === 'unusable' ? 'execution-owner-interrupted' : null,
  };
}

type FixtureRequest = {
  readonly path: string;
  readonly method: string;
  readonly body: string | null;
  readonly headers: Record<string, string>;
  readonly origin: string;
};

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

type Fixture = {
  workspace: Workspace;
  agents: AgentProfile[];
  conversations: ReturnType<typeof groupConversation>[];
  interactions: Map<string, ReturnType<typeof interaction>[]>;
  details: Map<string, Record<string, unknown>>;
  messages: Map<string, Array<Record<string, unknown>>>;
  recoveries: Map<string, Record<string, unknown>>;
  respondOwners: Map<string, { readonly ownerId: string; readonly ownerEpoch: number; readonly sourceMessageId: string; readonly clientMessageId: string }>;
  requests: FixtureRequest[];
  consoleEvents: Array<{ readonly type: string; readonly text: string; readonly url: string }>;
  failures: string[];
  apiOrigin?: string;
  apiOrigins: string[];
  configuredBaseURL?: string;
  configuredBaseOrigin?: string;
  configuredBaseSource?: 'PLAYWRIGHT_BASE_URL' | 'Playwright project baseURL';
  dropFirstRecoveryResponse: boolean;
  dropFirstRespondResponse: boolean;
  expectedConsoleNetworkFailures: number;
  observedConsoleNetworkFailures: number;
  expectedConsoleOwnerConflicts: number;
  observedConsoleOwnerConflicts: number;
  providerStartCount: number;
  ownerClaimCount: number;
  duplicateOwnerRefusalCount: number;
  deferFirstRecoveryResponse?: Deferred<void>;
  recoveryEntered?: Deferred<void>;
  deferReplayRecoveryResponse?: Deferred<void>;
  replayRecoveryEntered?: Deferred<void>;
};

function fixture(owner: { status: string; ownerEpoch: number } | null = { status: 'interrupted', ownerEpoch: 7 }): Fixture {
  const agents = [agent('agent-a'), agent('agent-b')];
  const workspace: Workspace = {
    id: workspaceId, name: 'P2 Group Recovery Fixture', rootPath: 'fixture-only', gitEnabled: false,
    memoryEnabled: false, agents, lastOpenedAt: now, createdAt: now, updatedAt: now,
  };
  const prior = interaction('prior-a', 'group-a', 'message-old-source', 'unusable');
  const priorDetail = {
    interaction: prior,
    replies: [{ id: 'reply-old', agentId: 'agent-a', messageId: 'message-old-reply', hopFromAgentId: null, hopOrder: 0 }],
    budget: { repliesUsed: 1, repliesRemaining: 1, hopsUsed: 0, hopsRemaining: 2, distinctAgents: 1, agentsRemaining: 1 },
    executionOwner: owner,
  };
  const messages = new Map<string, Array<Record<string, unknown>>>([
    ['group-a', [
      { id: 'message-old-source', conversationId: 'group-a', senderType: 'user', senderAgentId: null, content: '旧轮次原始问题', runId: null, createdAt: now },
      { id: 'message-old-reply', conversationId: 'group-a', senderType: 'agent', senderAgentId: 'agent-a', content: '旧轮次已完成回复：方案甲', runId: null, createdAt: now },
    ]],
    ['group-b', [
      { id: 'message-private-b', conversationId: 'group-b', senderType: 'user', senderAgentId: null, content: '仅属于 B 群聊的历史', runId: null, createdAt: now },
    ]],
  ]);
  return {
    workspace,
    agents,
    conversations: [groupConversation('group-a', 'Group A'), groupConversation('group-b', 'Group B')],
    interactions: new Map([['group-a', [prior]], ['group-b', []]]),
    details: new Map([['prior-a', priorDetail]]),
    messages,
    recoveries: new Map(),
    respondOwners: new Map(),
    requests: [],
    consoleEvents: [],
    failures: [],
    apiOrigins: [],
    dropFirstRecoveryResponse: false,
    dropFirstRespondResponse: false,
    expectedConsoleNetworkFailures: 0,
    observedConsoleNetworkFailures: 0,
    expectedConsoleOwnerConflicts: 0,
    observedConsoleOwnerConflicts: 0,
    providerStartCount: 0,
    ownerClaimCount: 0,
    duplicateOwnerRefusalCount: 0,
  };
}

const json = (route: Route, body: unknown, status = 200) => route.fulfill({
  status,
  json: body,
  headers: { 'Access-Control-Allow-Origin': '*' },
});

function makeRecoveryResult(model: Fixture, instruction: string, idempotencyKey: string, replayed: boolean) {
  const sourceMessage = {
    id: 'message-recovery-a', conversationId: 'group-a', senderType: 'user', senderAgentId: null,
    content: instruction, runId: null, createdAt: now,
    clientMessageId: `p2-recovery-${createHash('sha256').update(`${workspaceId}:${idempotencyKey}`).digest('hex').slice(0, 40)}`,
  };
  const next = { ...interaction('interaction-recovered-a', 'group-a', sourceMessage.id), version: 1 };
  model.messages.get('group-a')!.push(sourceMessage);
  model.interactions.set('group-a', [model.interactions.get('group-a')![0]!, next]);
  const result = {
    interaction: next,
    message: sourceMessage,
    participantAgentIds: ['agent-a'],
    replayed,
  };
  model.recoveries.set('prior-a', result);
  model.details.set(next.id, {
    interaction: next,
    replies: [],
    budget: { repliesUsed: 0, repliesRemaining: 2, hopsUsed: 0, hopsRemaining: 2, distinctAgents: 0, agentsRemaining: 2 },
    executionOwner: null,
  });
  return result;
}

const pageFixtures = new WeakMap<Page, Fixture>();

function resolveBaseURL(testInfo: TestInfo): { readonly url: string; readonly source: NonNullable<Fixture['configuredBaseSource']> } {
  const envBaseURL = process.env.PLAYWRIGHT_BASE_URL;
  const projectBaseURL = testInfo.project.use.baseURL;
  const url = envBaseURL || (typeof projectBaseURL === 'string' ? projectBaseURL : undefined);
  if (!url) throw new Error('P2 recovery browser test requires PLAYWRIGHT_BASE_URL or the Playwright project baseURL.');
  return { url, source: envBaseURL ? 'PLAYWRIGHT_BASE_URL' : 'Playwright project baseURL' };
}

async function installFixture(page: Page, model: Fixture, configuredBase: ReturnType<typeof resolveBaseURL>) {
  page.on('pageerror', error => model.failures.push(error.message));
  page.on('console', message => {
    const text = message.text();
    model.consoleEvents.push({ type: message.type(), text, url: message.location().url });
    if (message.type() !== 'error') return;
    if (text.includes('net::ERR_FAILED') && model.observedConsoleNetworkFailures < model.expectedConsoleNetworkFailures) {
      model.observedConsoleNetworkFailures += 1;
      return;
    }
    if (text.includes('409 (Conflict)') && model.observedConsoleOwnerConflicts < model.expectedConsoleOwnerConflicts) {
      model.observedConsoleOwnerConflicts += 1;
      return;
    }
    model.failures.push(`console: ${text}`);
  });
  model.configuredBaseURL = configuredBase.url;
  model.configuredBaseOrigin = new URL(configuredBase.url).origin;
  model.configuredBaseSource = configuredBase.source;
  pageFixtures.set(page, model);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const requestHeaders = request.headers();
    model.requests.push({
      path: path + url.search,
      method: request.method(),
      body: request.postData(),
      headers: Object.fromEntries(['content-type', 'idempotency-key']
        .filter(name => requestHeaders[name] !== undefined)
        .map(name => [name, requestHeaders[name]!])),
      origin: url.origin,
    });
    if (!model.apiOrigins.includes(url.origin)) model.apiOrigins.push(url.origin);
    model.apiOrigin ??= url.origin;
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      } });
      return;
    }
    if (request.method() === 'GET' && path === `/api/workspaces/${workspaceId}`) { await json(route, { workspace: model.workspace }); return; }
    if (request.method() === 'GET' && path.endsWith('/agents/presence')) { await json(route, { presence: [] }); return; }
    if (request.method() === 'GET' && path === `/api/workspaces/${workspaceId}/agents`) { await json(route, { agents: model.agents }); return; }
    if (request.method() === 'GET' && path === `/api/workspaces/${workspaceId}/runtime/conversations`) { await json(route, { conversations: model.conversations }); return; }
    if (request.method() === 'GET' && path === `/api/workspaces/${workspaceId}/conversations`) { await json(route, { conversations: [] }); return; }
    if (request.method() === 'GET' && path.endsWith('/collaboration/tasks')) { await json(route, { tasks: [] }); return; }
    if (request.method() === 'GET' && path.endsWith('/progress')) { await route.fulfill({ status: 404, json: { error: 'no collaboration task in fixture' } }); return; }

    const interactionDetail = path.match(new RegExp(`^/api/workspaces/${workspaceId}/runtime/interactions/([^/]+)$`, 'u'));
    if (request.method() === 'GET' && interactionDetail) {
      const detail = model.details.get(decodeURIComponent(interactionDetail[1]!));
      if (!detail) { await route.fulfill({ status: 404, json: { error: 'fixture interaction missing' } }); return; }
      if (decodeURIComponent(interactionDetail[1]!) === 'interaction-recovered-a'
        && model.recoveredDetailEntered && model.deferRecoveredDetail) {
        model.recoveredDetailEntered.resolve();
        await model.deferRecoveredDetail.promise;
      }
      await json(route, detail); return;
    }
    const conversationInteractions = path.match(new RegExp(`^/api/workspaces/${workspaceId}/runtime/conversations/([^/]+)/interactions$`, 'u'));
    if (request.method() === 'GET' && conversationInteractions) {
      await json(route, { interactions: model.interactions.get(decodeURIComponent(conversationInteractions[1]!)) ?? [] }); return;
    }
    const messages = path.match(new RegExp(`^/api/workspaces/${workspaceId}/runtime/conversations/([^/]+)/messages$`, 'u'));
    if (request.method() === 'GET' && messages) {
      await json(route, { messages: model.messages.get(decodeURIComponent(messages[1]!)) ?? [] }); return;
    }
    const events = path.match(new RegExp(`^/api/workspaces/${workspaceId}/runtime/conversations/([^/]+)/interactions/([^/]+)/events$`, 'u'));
    if (request.method() === 'GET' && events) {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'id: 1\nevent: group.done\ndata: {"interactionId":"interaction-recovered-a","cursor":1,"ownerEpoch":1}\n\n' });
      return;
    }
    const recoverPath = path.match(new RegExp(`^/api/workspaces/${workspaceId}/runtime/interactions/([^/]+)/recover$`, 'u'));
    if (request.method() === 'POST' && recoverPath) {
      const oldInteractionId = decodeURIComponent(recoverPath[1]!);
      if (oldInteractionId !== 'prior-a') model.failures.push(`Recovery targeted unexpected interaction ${oldInteractionId}`);
      const previous = model.recoveries.get(oldInteractionId);
      if (previous) {
        if (model.replayRecoveryEntered && model.deferReplayRecoveryResponse) {
          model.replayRecoveryEntered.resolve();
          await model.deferReplayRecoveryResponse.promise;
        }
        await json(route, { ...previous, replayed: true });
        return;
      }
      const body = request.postDataJSON() as { expectedVersion: number; expectedOwnerEpoch: number; content: string };
      if (body.expectedVersion !== 12 || body.expectedOwnerEpoch !== 7) model.failures.push('Recovery CAS used a stale or missing version/owner epoch');
      const idempotencyKey = requestHeaders['idempotency-key'];
      if (!idempotencyKey) model.failures.push('Recovery request omitted Idempotency-Key');
      const created = makeRecoveryResult(model, body.content, idempotencyKey ?? '', false);
      if (model.recoveryEntered && model.deferFirstRecoveryResponse) {
        model.recoveryEntered.resolve();
        await model.deferFirstRecoveryResponse.promise;
      }
      if (model.dropFirstRecoveryResponse) {
        model.dropFirstRecoveryResponse = false;
        model.expectedConsoleNetworkFailures += 1;
        await route.abort('failed');
        return;
      }
      await json(route, created, 201);
      return;
    }
    const respondPath = path.match(new RegExp(`^/api/workspaces/${workspaceId}/runtime/conversations/([^/]+)/interactions/([^/]+)/respond$`, 'u'));
    if (request.method() === 'POST' && respondPath) {
      const conversationId = decodeURIComponent(respondPath[1]!);
      const newInteractionId = decodeURIComponent(respondPath[2]!);
      if (conversationId !== 'group-a' || newInteractionId !== 'interaction-recovered-a') {
        model.failures.push(`Respond was started under the wrong identity: ${conversationId}/${newInteractionId}`);
      }
      const body = request.postDataJSON() as { sourceMessageId?: string; clientMessageId?: string };
      if (body.sourceMessageId !== 'message-recovery-a') model.failures.push('Respond did not use the recovery response sourceMessageId');
      const sourceMessage = model.recoveries.get('prior-a')?.message as { clientMessageId?: string } | undefined;
      if (body.clientMessageId !== sourceMessage?.clientMessageId) model.failures.push('Respond did not preserve the server-derived recovery clientMessageId');
      const currentOwner = model.respondOwners.get(newInteractionId);
      if (currentOwner) {
        if (currentOwner.sourceMessageId !== body.sourceMessageId || currentOwner.clientMessageId !== body.clientMessageId) {
          model.failures.push('A duplicate respond attempted to change the claimed owner source identity');
        }
        model.duplicateOwnerRefusalCount += 1;
        model.expectedConsoleOwnerConflicts += 1;
        await json(route, { error: 'GROUP_EXECUTION_ALREADY_OWNED', interactionId: newInteractionId }, 409);
        return;
      }
      // This synchronous map claim models the route's durable owner CAS. Only
      // the winning owner enters the mock Provider; HTTP duplicates are counted
      // separately from actual fixture Provider starts.
      model.respondOwners.set(newInteractionId, {
        ownerId: `fixture-owner-${newInteractionId}`, ownerEpoch: 1,
        sourceMessageId: body.sourceMessageId ?? '', clientMessageId: body.clientMessageId ?? '',
      });
      model.ownerClaimCount += 1;
      model.providerStartCount += 1;
      const detail = model.details.get(newInteractionId)!;
      detail.executionOwner = { status: 'completed', ownerEpoch: 1 };
      detail.interaction = { ...interaction('interaction-recovered-a', 'group-a', 'message-recovery-a'), status: 'completed', version: 2 };
      if (model.dropFirstRespondResponse) {
        model.dropFirstRespondResponse = false;
        model.expectedConsoleNetworkFailures += 1;
        await route.abort('failed');
        return;
      }
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
      return;
    }

    if (request.method() === 'GET' && /\/runs(?:\?|$)/u.test(path + url.search)) { await json(route, { runs: [] }); return; }
    model.failures.push(`Unexpected fixture request: ${request.method()} ${path}`);
    await route.fulfill({ status: 404, json: { error: 'unhandled P2 recovery browser fixture request' } });
  });
}

async function openGroup(page: Page, id: string, baseURL: string) {
  await page.goto(new URL(`/workspace/${workspaceId}?conversationSource=runtime&conversationId=${id}&view=chat`, baseURL).toString());
  const model = pageFixtures.get(page);
  if (model && new URL(page.url()).origin !== model.configuredBaseOrigin) {
    model.failures.push(`Rendered page origin ${new URL(page.url()).origin} differs from configured base origin ${model.configuredBaseOrigin}`);
  }
  await expect(page).toHaveTitle('AgentOS');
  await expect(page.locator('[data-signal-workspace]')).toBeVisible();
  await expect(page.locator('[data-visible-conversation-identity]')).toHaveAttribute(
    'data-visible-conversation-identity',
    createConversationDraftIdentityKey({ workspaceId, storageSource: 'runtime', conversationId: id }),
  );
  await expect(page.locator('nextjs-portal')).toHaveCount(0);
}

test.afterEach(async ({ page }, testInfo) => {
  const model = pageFixtures.get(page);
  if (!model) return;
  const evidencePath = testInfo.outputPath('fixture-api-and-console.json');
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, JSON.stringify({
    configuredBaseURL: model.configuredBaseURL ?? null,
    configuredBaseOrigin: model.configuredBaseOrigin ?? null,
    configuredBaseSource: model.configuredBaseSource ?? null,
    pageBaseURL: page.url(),
    apiOrigin: model.apiOrigin ?? null,
    apiOrigins: model.apiOrigins,
    requests: model.requests,
    consoleEvents: model.consoleEvents,
    expectedConsoleNetworkFailures: model.expectedConsoleNetworkFailures,
    observedConsoleNetworkFailures: model.observedConsoleNetworkFailures,
    expectedConsoleOwnerConflicts: model.expectedConsoleOwnerConflicts,
    observedConsoleOwnerConflicts: model.observedConsoleOwnerConflicts,
    recoveryCallCount: model.requests.filter(item => item.method === 'POST' && item.path.endsWith('/recover')).length,
    respondCallCount: model.requests.filter(item => item.method === 'POST' && item.path.endsWith('/respond')).length,
    providerStartCount: model.providerStartCount,
    ownerClaimCount: model.ownerClaimCount,
    duplicateOwnerRefusalCount: model.duplicateOwnerRefusalCount,
    respondOwners: [...model.respondOwners.entries()],
    failures: model.failures,
  }, null, 2));
  await testInfo.attach('fixture-api-and-console', { path: evidencePath, contentType: 'application/json' });
  expect(model.apiOrigin, 'observed API origin from actual browser requests').toBeTruthy();
  expect(model.observedConsoleNetworkFailures, 'expected injected network failure console events').toBe(model.expectedConsoleNetworkFailures);
  expect(model.observedConsoleOwnerConflicts, 'expected duplicate-owner conflict console events').toBe(model.expectedConsoleOwnerConflicts);
  expect(model.providerStartCount, 'mock Provider starts must equal durable fixture owner claims').toBe(model.ownerClaimCount);
  expect(model.failures, 'fixture API and browser diagnostics').toEqual([]);
});

test('default workspace exposes recovery and starts one response from the returned new identity', async ({ page }, testInfo) => {
  const model = fixture();
  const base = resolveBaseURL(testInfo);
  await installFixture(page, model, base);
  await openGroup(page, 'group-a', base.url);

  await expect(page.getByRole('heading', { name: '从新一轮继续' })).toBeVisible();
  await expect(page.getByRole('button', { name: '建立关联新一轮' })).toBeDisabled();
  await expect(page.getByText('旧轮次已完成回复：方案甲')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('p2-recovery-entry.png') });

  await page.getByLabel('新一轮指令').fill('请基于旧回复补充风险检查');
  await page.getByRole('button', { name: '建立关联新一轮' }).click();
  await expect.poll(() => model.requests.filter(item => item.method === 'POST' && item.path.endsWith('/recover')).length).toBe(1);
  await expect.poll(() => model.requests.filter(item => item.method === 'POST' && item.path.endsWith('/respond')).length).toBe(1);
  await expect(page.getByText('请基于旧回复补充风险检查')).toBeVisible();
  await expect(page.getByText('旧轮次已完成回复：方案甲')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('p2-recovery-new-round.png') });

  const recoveryRequest = model.requests.find(item => item.method === 'POST' && item.path.endsWith('/recover'))!;
  expect(recoveryRequest.path).toBe(`/api/workspaces/${workspaceId}/runtime/interactions/prior-a/recover`);
  expect(JSON.parse(recoveryRequest.body ?? '{}')).toEqual({
    expectedVersion: 12,
    expectedOwnerEpoch: 7,
    content: '请基于旧回复补充风险检查',
  });
  expect(recoveryRequest.headers['idempotency-key']).toMatch(/^p2-group-recovery-[a-f0-9]{8}$/u);
  const respondRequests = model.requests.filter(item => item.method === 'POST' && item.path.endsWith('/respond'));
  expect(respondRequests).toHaveLength(1);
  expect(model.providerStartCount).toBe(1);
  expect(respondRequests[0]!.path).toBe(`/api/workspaces/${workspaceId}/runtime/conversations/group-a/interactions/interaction-recovered-a/respond`);
  const recoverySource = model.recoveries.get('prior-a')!.message as { clientMessageId: string };
  expect(JSON.parse(respondRequests[0]!.body ?? '{}')).toEqual({
    sourceMessageId: 'message-recovery-a', clientMessageId: recoverySource.clientMessageId, mentionedAgentIds: ['agent-a'],
  });
  expect(model.requests.some(item => item.method === 'POST' && item.path.endsWith('/interactions/prior-a/respond'))).toBe(false);
});

test('an uncertain CAS retry keeps the same request intent and does not repeat Provider start', async ({ page }, testInfo) => {
  const model = fixture();
  model.dropFirstRecoveryResponse = true;
  const base = resolveBaseURL(testInfo);
  await installFixture(page, model, base);
  await openGroup(page, 'group-a', base.url);
  await page.getByLabel('新一轮指令').fill('网络中断后沿用原指令');
  await page.getByRole('button', { name: '建立关联新一轮' }).click();
  await expect(page.getByRole('region', { name: '恢复中断的群组讨论' }).getByRole('alert')).toContainText('恢复意图已保留');
  await expect(page.getByLabel('新一轮指令')).toHaveValue('网络中断后沿用原指令');
  await expect(page.getByRole('button', { name: '建立关联新一轮' })).toBeEnabled();
  expect(model.requests.filter(item => item.method === 'POST' && item.path.endsWith('/recover'))).toHaveLength(1);
  expect(model.requests.filter(item => item.method === 'POST' && item.path.endsWith('/respond'))).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath('p2-recovery-network-uncertain.png') });

  await page.getByRole('button', { name: '建立关联新一轮' }).click();
  await expect.poll(() => model.requests.filter(item => item.method === 'POST' && item.path.endsWith('/respond')).length).toBe(1);
  const recoveries = model.requests.filter(item => item.method === 'POST' && item.path.endsWith('/recover'));
  expect(recoveries).toHaveLength(2);
  expect(recoveries[1]!.headers['idempotency-key']).toBe(recoveries[0]!.headers['idempotency-key']);
  expect(recoveries[1]!.body).toBe(recoveries[0]!.body);
  expect(model.requests.filter(item => item.method === 'POST' && item.path.endsWith('/respond'))).toHaveLength(1);
  expect(model.providerStartCount).toBe(1);
  await expect(page.getByText('旧轮次已完成回复：方案甲')).toBeVisible();
});

test('a pending recovery CAS cannot dispatch after switching away from Group A', async ({ page }, testInfo) => {
  const model = fixture();
  model.recoveryEntered = deferred<void>();
  model.deferFirstRecoveryResponse = deferred<void>();
  const base = resolveBaseURL(testInfo);
  await installFixture(page, model, base);
  await openGroup(page, 'group-a', base.url);
  await page.getByLabel('新一轮指令').fill('只属于 A 的续办指令');
  const entered = model.recoveryEntered.promise;
  await page.getByRole('button', { name: '建立关联新一轮' }).click();
  await entered;

  await page.getByRole('button', { name: 'Group B' }).click();
  await expect(page.locator('[data-visible-conversation-identity]')).toHaveAttribute(
    'data-visible-conversation-identity',
    createConversationDraftIdentityKey({ workspaceId, storageSource: 'runtime', conversationId: 'group-b' }),
  );
  await expect(page.getByText('仅属于 B 群聊的历史')).toBeVisible();
  model.deferFirstRecoveryResponse.resolve();

  await expect.poll(() => model.recoveries.has('prior-a')).toBe(true);
  await expect.poll(() => model.requests.filter(item => item.method === 'POST' && item.path.endsWith('/respond')).length).toBe(0);
  expect(model.providerStartCount).toBe(0);
  expect(model.ownerClaimCount).toBe(0);
  await expect(page.locator('[data-visible-conversation-identity]')).toHaveAttribute(
    'data-visible-conversation-identity',
    createConversationDraftIdentityKey({ workspaceId, storageSource: 'runtime', conversationId: 'group-b' }),
  );
  await expect(page.getByText('仅属于 B 群聊的历史')).toBeVisible();
  await expect(page.getByText('只属于 A 的续办指令')).toHaveCount(0);
});

test('two open tabs for the same recovery intent create only one respond call', async ({ page }, testInfo) => {
  const model = fixture();
  model.recoveryEntered = deferred<void>();
  model.deferFirstRecoveryResponse = deferred<void>();
  model.replayRecoveryEntered = deferred<void>();
  model.deferReplayRecoveryResponse = deferred<void>();
  const base = resolveBaseURL(testInfo);
  await installFixture(page, model, base);
  await openGroup(page, 'group-a', base.url);
  await page.getByLabel('新一轮指令').fill('跨标签页同一恢复意图');

  const secondTab = await page.context().newPage();
  await installFixture(secondTab, model, base);
  await openGroup(secondTab, 'group-a', base.url);
  await secondTab.getByLabel('新一轮指令').fill('跨标签页同一恢复意图');
  const firstEntered = model.recoveryEntered.promise;
  const replayEntered = model.replayRecoveryEntered.promise;
  await Promise.all([
    page.getByRole('button', { name: '建立关联新一轮' }).click(),
    secondTab.getByRole('button', { name: '建立关联新一轮' }).click(),
  ]);
  await firstEntered;
  await replayEntered;
  await expect.poll(() => model.requests.filter(item => item.method === 'POST' && item.path.endsWith('/recover')).length).toBe(2);
  expect(model.requests.filter(item => item.method === 'POST' && item.path.endsWith('/respond'))).toHaveLength(0);

  model.deferFirstRecoveryResponse.resolve();
  model.deferReplayRecoveryResponse.resolve();
  await expect.poll(() => model.requests.filter(item => item.method === 'POST' && item.path.endsWith('/respond')).length).toBe(1);
  expect(model.providerStartCount).toBe(1);
  const recoveries = model.requests.filter(item => item.method === 'POST' && item.path.endsWith('/recover'));
  expect(recoveries[0]!.headers['idempotency-key']).toBe(recoveries[1]!.headers['idempotency-key']);
  expect(recoveries[0]!.body).toBe(recoveries[1]!.body);
  const recovered = model.recoveries.get('prior-a')!.message as { clientMessageId: string };
  const repeatedResponds = await Promise.all([page, secondTab].map(tab => tab.evaluate(async ({ workspaceId, clientMessageId }) => {
    const response = await fetch(`/api/workspaces/${workspaceId}/runtime/conversations/group-a/interactions/interaction-recovered-a/respond`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceMessageId: 'message-recovery-a', clientMessageId }),
    });
    return response.status;
  }, { workspaceId, clientMessageId: recovered.clientMessageId })));
  expect(repeatedResponds).toEqual([409, 409]);
  expect(model.requests.filter(item => item.method === 'POST' && item.path.endsWith('/respond'))).toHaveLength(3);
  expect(model.ownerClaimCount).toBe(1);
  expect(model.providerStartCount).toBe(1);
  expect(model.duplicateOwnerRefusalCount).toBe(2);
  await secondTab.close();
});

test('an uncertain respond stays locked after reload and is never blindly repeated', async ({ page }, testInfo) => {
  const model = fixture();
  model.dropFirstRespondResponse = true;
  const base = resolveBaseURL(testInfo);
  await installFixture(page, model, base);
  await openGroup(page, 'group-a', base.url);
  await page.getByLabel('新一轮指令').fill('Provider 响应丢失时保留单次启动意图');
  await page.getByRole('button', { name: '建立关联新一轮' }).click();
  await expect(page.getByRole('region', { name: '恢复中断的群组讨论' }).getByRole('alert')).toContainText('新轮次启动结果未确认');
  expect(model.requests.filter(item => item.method === 'POST' && item.path.endsWith('/respond'))).toHaveLength(1);
  expect(model.providerStartCount).toBe(1);
  expect(model.ownerClaimCount).toBe(1);
  const storedPhase = await page.evaluate(() => {
    const item = Object.entries(localStorage).find(([key]) => key.startsWith('agentos:group-recovery:v1:'))?.[1];
    return item ? (JSON.parse(item) as { phase?: string }).phase : null;
  });
  expect(storedPhase).toBe('responding');

  await page.reload();
  await expect(page).toHaveTitle('AgentOS');
  expect(model.requests.filter(item => item.method === 'POST' && item.path.endsWith('/recover'))).toHaveLength(1);
  expect(model.requests.filter(item => item.method === 'POST' && item.path.endsWith('/respond'))).toHaveLength(1);
  expect(model.providerStartCount).toBe(1);
  const restoredPhase = await page.evaluate(() => {
    const item = Object.entries(localStorage).find(([key]) => key.startsWith('agentos:group-recovery:v1:'))?.[1];
    return item ? (JSON.parse(item) as { phase?: string }).phase : null;
  });
  expect(restoredPhase).toBe('responding');
});

test('unknown execution owner shows why recovery is unavailable and never offers an action', async ({ page }, testInfo) => {
  const model = fixture(null);
  const base = resolveBaseURL(testInfo);
  await installFixture(page, model, base);
  await openGroup(page, 'group-a', base.url);
  await expect(page.getByText(/执行 owner 状态未知/)).toBeVisible();
  await expect(page.getByRole('region', { name: '恢复中断的群组讨论' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '建立关联新一轮' })).toHaveCount(0);
  expect(model.requests.some(item => item.method === 'POST' && /\/recover$/u.test(item.path))).toBe(false);
});
