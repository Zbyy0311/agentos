import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/SqliteStore.js';
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';
import { MemoryExecutionContextRepository } from '../store/MemoryExecutionContextRepository.js';
import { ConversationService } from './ConversationService.js';
import { MemoryRetrievalService } from './MemoryRetrievalService.js';

const WORKSPACE = 'workspace-a';
const GROUP = 'group-waiting';
const AGENT = 'codex';
const NOW = '2026-10-01T00:00:00.000Z';
const QUERY = 'resumecontext';

function fixture(waitingAgentId?: string) {
  const root = mkdtempSync(join(tmpdir(), 'agentos-group-resume-memory-'));
  const promptPath = join(root, 'captured-prompt.txt');
  // A local Node CLI captures the final runner prompt without an external Provider.
  const cliArgs = ['-e', `require('node:fs').writeFileSync(${JSON.stringify(promptPath)}, process.argv.at(-1), 'utf8'); console.log('group resume completed');`];
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({
    workspaces: [{
      id: WORKSPACE, name: 'Workspace A', rootPath: root, gitEnabled: false, memoryEnabled: true,
      agents: [
        { id: AGENT, name: 'Codex', role: 'codex', enabled: true, cliCommand: process.execPath, cliArgs },
        { id: 'kimi', name: 'KimiCode', role: 'kimi', enabled: true, cliCommand: 'kimi', cliArgs: ['-p'] },
      ],
      createdAt: NOW, updatedAt: NOW, lastOpenedAt: NOW,
    }],
  }));
  const store = new SqliteStore(root);
  store.updateAgentProfile(WORKSPACE, AGENT, {
    roleTitle: '群主', systemPrompt: '完成群聊请求。', permissions: ['read', 'write'], enabled: true,
  });
  store.createGroupConversation({
    id: GROUP, workspaceId: WORKSPACE, type: 'group', title: '等待恢复', createdAt: NOW, updatedAt: NOW,
  }, [
    { conversationId: GROUP, agentId: AGENT, roleTitle: '群主', isLeader: true, createdAt: NOW },
    { conversationId: GROUP, agentId: 'kimi', roleTitle: '执行工程师', isLeader: false, createdAt: NOW },
  ]);
  store.createMessage({
    id: 'waiting-source', workspaceId: WORKSPACE, conversationId: GROUP, senderType: 'user',
    content: '请继续群聊请求', createdAt: NOW,
  });
  // Persist a historical waiting Run: new group sends currently reject waiting.
  const run = store.createRun({
    id: 'waiting-run', workspaceId: WORKSPACE, conversationId: GROUP, sourceMessageId: 'waiting-source',
    objective: '请继续群聊请求', status: 'waiting_user', waitingQuestion: '请提供补充信息',
    ...(waitingAgentId === undefined ? {} : { waitingAgentId }), createdAt: NOW, updatedAt: NOW,
  });
  const entries = new MemoryEntryRepository(store.getDatabase());
  const common = {
    workspaceId: WORKSPACE, category: 'decision' as const, authority: 'user-explicit' as const,
    status: 'active' as const, confidence: 1, importance: 1, pinned: true, sources: [], createdAt: NOW,
  };
  const workspaceEntry = entries.createEntry({
    ...common, id: 'workspace-entry', scope: 'workspace', title: QUERY,
    content: 'WORKSPACE_CANONICAL_MARKER',
  });
  const conversationEntry = entries.createEntry({
    ...common, id: 'conversation-entry', scope: 'conversation', ownerConversationId: GROUP,
    title: QUERY, content: 'GROUP_CONVERSATION_CANONICAL_MARKER',
  });
  const privateEntry = entries.createEntry({
    ...common, id: 'private-agent-entry', scope: 'agent', ownerAgentId: AGENT,
    title: QUERY, content: 'AGENT_PRIVATE_CANONICAL_MARKER',
  });
  const otherConversationEntry = entries.createEntry({
    ...common, id: 'other-conversation-entry', scope: 'conversation', ownerConversationId: 'other-group',
    title: QUERY, content: 'OTHER_CONVERSATION_CANONICAL_MARKER',
  });
  return { root, promptPath, store, entries, run, workspaceEntry, conversationEntry, privateEntry, otherConversationEntry };
}

for (const waitingAgentId of [AGENT, undefined]) {
  test(`group resume excludes private canonical Agent memory (${waitingAgentId ? 'waiting Agent' : 'leader fallback'})`, async () => {
    const originalForceMock = process.env.AGENTOS_FORCE_MOCK;
    // Execute the real runner with the local Node CLI, rather than stubbing build.
    process.env.AGENTOS_FORCE_MOCK = 'false';
    let fx: ReturnType<typeof fixture> | undefined;
    try {
      fx = fixture(waitingAgentId);
      const { store, entries, run, workspaceEntry, conversationEntry, privateEntry, otherConversationEntry } = fx;
      // Positive control: this matching, pinned private Entry is retrievable when
      // the caller grants agent reach. All three are well below the chat budget,
      // so an accidental agentId on resume cannot hide behind ranking or size.
      const withAgentReach = new MemoryRetrievalService(entries).retrieve({
        context: { workspaceId: WORKSPACE, conversationId: GROUP, agentId: AGENT }, query: QUERY,
      });
      assert.deepEqual(withAgentReach.map(result => result.entry.id).sort(),
        [workspaceEntry.id, conversationEntry.id, privateEntry.id].sort());

      const result = await new ConversationService(store).resumeGroupMessage({
        workspaceId: WORKSPACE, workspaceRoot: fx.root, conversationId: GROUP, runId: run.id, content: QUERY,
      });
      assert.equal(result.executions.length, 1);
      assert.equal(result.executions[0].agentId, AGENT);
      assert.equal(result.executions[0].status, 'completed', result.agentMessages[0]?.content);
      assert.equal(store.getRun(WORKSPACE, run.id)?.status, 'completed');
      assert.equal(result.agentMessages[0]?.senderType, 'agent');
      assert.match(result.agentMessages[0]?.content ?? '', /group resume completed/);

      const prompt = readFileSync(fx.promptPath, 'utf8');
      assert.ok(prompt.includes('上次等待问题：请提供补充信息'), 'the real resumed runner receives the waiting question');
      assert.ok(prompt.includes(`用户补充信息：${QUERY}`), 'the captured prompt belongs to this group resume');
      assert.ok(prompt.includes(workspaceEntry.content), 'workspace canonical memory remains available');
      assert.ok(prompt.includes(conversationEntry.content), 'this group conversation memory remains available');
      assert.ok(!prompt.includes(privateEntry.content), 'group resume must not grant reach to the executing Agent private memory');
      assert.ok(!prompt.includes(otherConversationEntry.content), 'another conversation remains out of reach');
    } finally {
      if (originalForceMock === undefined) delete process.env.AGENTOS_FORCE_MOCK;
      else process.env.AGENTOS_FORCE_MOCK = originalForceMock;
      fx?.store.close();
      if (fx) rmSync(fx.root, { recursive: true, force: true });
    }
  });
}

for (const operation of ['direct', 'group-resume'] as const) {
  test(`${operation} uses the persisted workspace switch even if the caller enables memory`, async () => {
    const previousMock = process.env.AGENTOS_FORCE_MOCK;
    process.env.AGENTOS_FORCE_MOCK = 'false';
    let fx: ReturnType<typeof fixture> | undefined;
    try {
      fx = fixture(AGENT);
      const { store, run, workspaceEntry, conversationEntry, privateEntry } = fx;
      const service = new ConversationService(store);
      const contexts = new MemoryExecutionContextRepository(store.getDatabase());
      let earlierExecutionId: string | undefined;
      let earlierBody: string | undefined;
      if (operation === 'direct') {
        store.createConversation({
          id: 'switch-direct', workspaceId: WORKSPACE, type: 'direct', title: 'switch direct',
          agentId: AGENT, createdAt: NOW, updatedAt: NOW,
        });
        const first = await service.sendDirectMessage({
          workspaceId: WORKSPACE, workspaceRoot: fx.root, conversationId: 'switch-direct',
          agentId: AGENT, content: QUERY, memoryEnabled: true,
        });
        assert.equal(first.execution.status, 'completed');
        earlierExecutionId = first.execution.id;
        earlierBody = contexts.findForExecution(WORKSPACE, earlierExecutionId)?.contextText;
        assert.ok(earlierBody?.includes(workspaceEntry.content));
      }

      store.getDatabase().prepare('UPDATE workspaces SET memory_enabled=0 WHERE id=?').run(WORKSPACE);
      const execution = operation === 'direct'
        ? (await service.sendDirectMessage({
          workspaceId: WORKSPACE, workspaceRoot: fx.root, conversationId: 'switch-direct',
          agentId: AGENT, content: `${QUERY} next call`, memoryEnabled: true,
        })).execution
        : (await service.resumeGroupMessage({
          workspaceId: WORKSPACE, workspaceRoot: fx.root, conversationId: GROUP,
          runId: run.id, content: QUERY, memoryEnabled: true,
        })).executions[0];
      assert.equal(execution.status, 'completed');
      const disabled = contexts.findForExecution(WORKSPACE, execution.id);
      assert.ok(disabled);
      assert.equal(disabled.contextText, '');
      assert.deepEqual(disabled.selected, []);
      assert.match(disabled.retrievalStrategyVersion, /memory-disabled/);
      const prompt = readFileSync(fx.promptPath, 'utf8');
      for (const entry of [workspaceEntry, conversationEntry, privateEntry]) {
        assert.equal(prompt.includes(entry.content), false, `disabled prompt contains ${entry.id}`);
      }
      if (earlierExecutionId !== undefined) {
        assert.equal(contexts.findForExecution(WORKSPACE, earlierExecutionId)?.contextText, earlierBody);
      }
    } finally {
      if (previousMock === undefined) delete process.env.AGENTOS_FORCE_MOCK;
      else process.env.AGENTOS_FORCE_MOCK = previousMock;
      fx?.store.close();
      if (fx) rmSync(fx.root, { recursive: true, force: true });
    }
  });
}
