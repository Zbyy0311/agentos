import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentModelOption, ModelDiscoveryResult } from '@agentos/shared';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import type { ModelDiscoveryInput, ModelDiscoveryService } from '../services/CliModelDiscovery.js';
import { createConversationRoutes } from './conversations.js';

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-model-routes-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({
    workspaces: [{
      id: 'workspace-a', name: 'Workspace A', rootPath: root, gitEnabled: true, memoryEnabled: true,
      agents: [{ id: 'codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [] }],
      lastOpenedAt: '2026-07-12T00:00:00.000Z', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z',
    }],
  }), 'utf8');
  return root;
}

function model(id: string): AgentModelOption {
  return { id, label: id.toUpperCase(), thinkingEfforts: ['auto', 'medium'], defaultThinkingEffort: 'medium' };
}

test('returns discovered models and refreshes them through the Agent API', async () => {
  const root = createProjectRoot();
  const store = new SqliteStore(root);
  const calls: ModelDiscoveryInput[] = [];
  const discovery: ModelDiscoveryService = {
    async discover(input) {
      calls.push(input);
      const refreshed = Boolean(input.forceRefresh);
      const models = [model(refreshed ? 'gpt-new' : 'gpt-cached')];
      const result: ModelDiscoveryResult = {
        cliKind: 'codex', models, source: refreshed ? 'live' : 'cache', stale: false,
        discoveredAt: new Date().toISOString(),
      };
      return result;
    },
  };
  const app = express();
  const server = app.listen(0);
  try {
    app.use(express.json());
    app.use('/api/workspaces/:workspaceId', createConversationRoutes(store, new WorkspaceManager(store), discovery));
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind a port');
    const baseUrl = `http://127.0.0.1:${address.port}/api/workspaces/workspace-a`;

    const listed = await fetch(`${baseUrl}/agents`).then(response => response.json()) as {
      agents: Array<{ capability: { models: string[]; modelOptions: AgentModelOption[]; modelSource: string } }>;
    };
    assert.deepEqual(listed.agents[0].capability.models, ['gpt-cached']);
    assert.equal(listed.agents[0].capability.modelOptions[0].label, 'GPT-CACHED');
    assert.equal(listed.agents[0].capability.modelSource, 'cache');

    const refreshed = await fetch(`${baseUrl}/agents/codex/models/refresh`, { method: 'POST' })
      .then(response => response.json()) as { agent: { capability: { models: string[]; modelSource: string } } };
    assert.deepEqual(refreshed.agent.capability.models, ['gpt-new']);
    assert.equal(refreshed.agent.capability.modelSource, 'live');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].forceRefresh, true);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

