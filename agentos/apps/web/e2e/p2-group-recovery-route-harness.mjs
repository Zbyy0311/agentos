import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { createConversationRuntimeRoutes } from '../../server/src/routes/conversationRuntime.js';
import { WorkspaceManager } from '../../server/src/managers/WorkspaceManager.js';
import { SqliteStore } from '../../server/src/store/SqliteStore.js';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const express = require('express');

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { response, json: await response.json().catch(() => ({})) };
}

const root = mkdtempSync(join(tmpdir(), 'agentos-web-p2-recovery-route-'));
mkdirSync(join(root, 'workspace'), { recursive: true });
writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [{
  id: 'workspace-a', name: 'Workspace A', rootPath: root, gitEnabled: true, memoryEnabled: true,
  agents: [
    { id: 'codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [] },
    { id: 'kimi', name: 'Kimi', role: 'kimi', enabled: true, cliCommand: 'kimi', cliArgs: [] },
  ],
  lastOpenedAt: '2026-10-03T00:00:00.000Z', createdAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z',
}] }), 'utf8');

const store = new SqliteStore(root);
const app = express();
app.use(express.json());
app.use('/api/workspaces/:workspaceId/runtime', createConversationRuntimeRoutes(store, new WorkspaceManager(store)));
const server = app.listen(0, '127.0.0.1');
try {
  await once(server, 'listening');
  const address = server.address();
  const api = `http://127.0.0.1:${address.port}/api/workspaces/workspace-a/runtime`;
  const createdGroup = await postJson(`${api}/conversations`, {
    kind: 'group', replyMode: 'sequential', memberAgentIds: ['codex', 'kimi'],
  });
  assert.equal(createdGroup.response.status, 201, JSON.stringify(createdGroup.json));
  const conversationId = createdGroup.json.conversation.id;
  const oldDiscussion = await postJson(`${api}/conversations/${conversationId}/discussions`, {
    content: 'old prompt', clientMessageId: 'old-source-stable-id',
    budget: { maxAgentsPerTurn: 2, maxRepliesPerAgent: 1, maxTotalReplies: 2, maxAgentHops: 2 },
  });
  assert.equal(oldDiscussion.response.status, 201, JSON.stringify(oldDiscussion.json));
  const prior = oldDiscussion.json.interaction;
  const priorMessage = oldDiscussion.json.message;
  const claimed = store.boundedGroupService().claimExecution({
    workspaceId: 'workspace-a', conversationId, interactionId: prior.id, sourceMessageId: priorMessage.id,
    participantAgentIds: ['codex', 'kimi'], ownerId: 'p2-fixture-interrupted-owner', createdAt: new Date().toISOString(),
  });
  store.runInTransaction(() => {
    store.groupInteractionRepository().transitionExecutionWithinTransaction({
      workspaceId: 'workspace-a', interactionId: prior.id, ownerId: claimed.ownerId, ownerEpoch: claimed.ownerEpoch,
      status: 'running', eventType: 'group.test-provider-running', updatedAt: new Date().toISOString(),
    });
    store.getDatabase().prepare(`UPDATE cr_group_interactions SET integrity_status = 'unusable',
      integrity_reason = 'provider-call-outcome-unknown',version = version + 1 WHERE workspace_id = ? AND id = ?`)
      .run('workspace-a', prior.id);
  });
  store.runInTransaction(() => store.groupInteractionRepository().transitionExecutionWithinTransaction({
    workspaceId: 'workspace-a', interactionId: prior.id, ownerId: claimed.ownerId, ownerEpoch: claimed.ownerEpoch,
    status: 'interrupted', terminalReason: 'mock-test-interrupted-owner', eventType: 'group.interrupted', updatedAt: new Date().toISOString(),
  }));
  const unusable = store.groupInteractionRepository().findInteractionById('workspace-a', prior.id);
  const recoveryRequest = { expectedVersion: unusable.version, expectedOwnerEpoch: claimed.ownerEpoch, content: 'continue in linked round' };
  const idempotencyKey = 'p2-real-route-recovery-concurrent-01';
  const recoveryHeaders = { 'Idempotency-Key': idempotencyKey };
  const [recoveryA, recoveryB] = await Promise.all([
    postJson(`${api}/interactions/${prior.id}/recover`, recoveryRequest, recoveryHeaders),
    postJson(`${api}/interactions/${prior.id}/recover`, recoveryRequest, recoveryHeaders),
  ]);
  assert.deepEqual([recoveryA.response.status, recoveryB.response.status].sort(), [200, 201]);
  assert.equal(recoveryA.json.interaction.id, recoveryB.json.interaction.id);
  assert.equal(recoveryA.json.message.id, recoveryB.json.message.id);
  assert.equal(recoveryA.json.message.clientMessageId, recoveryB.json.message.clientMessageId);
  const recovered = recoveryA.json;
  const recoveredClientMessageId = recovered.message.clientMessageId;
  assert.equal(recoveredClientMessageId,
    `p2-recovery-${createHash('sha256').update(`workspace-a:${idempotencyKey}`).digest('hex').slice(0, 40)}`);

  const respondUrl = `${api}/conversations/${conversationId}/interactions/${recovered.interaction.id}/respond`;
  const respondBody = {
    sourceMessageId: recovered.message.id, clientMessageId: recoveredClientMessageId,
    mentionedAgentIds: ['codex'],
  };
  const concurrent = await Promise.all([
    fetch(respondUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(respondBody) }),
    fetch(respondUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(respondBody) }),
  ]);
  assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 409]);
  const bodies = await Promise.all(concurrent.map(async response => response.status === 200 ? response.text() : response.json()));
  assert.equal(bodies.filter(body => typeof body === 'string').length, 1);
  assert.equal(bodies.filter(body => typeof body !== 'string').length, 1);

  const owner = store.groupInteractionRepository().findExecutionOwner('workspace-a', recovered.interaction.id);
  assert.ok(owner);
  assert.equal(owner.conversationId, conversationId);
  assert.equal(owner.sourceMessageId, recovered.message.id);
  const events = store.boundedGroupService().listExecutionEvents('workspace-a', conversationId, recovered.interaction.id, 0);
  const ownerClaims = events.filter(event => event.eventType === 'group.claimed').length;
  const providerStartEvents = events.filter(event => event.eventType === 'group.provider.started').length;
  const turnStartEvents = events.filter(event => event.eventType === 'group.turn.start').length;
  assert.equal(ownerClaims, 1);
  assert.equal(turnStartEvents, 1, 'only the owner-claim winner may open the one requested mock Agent turn');
  assert.equal(store.agentTurnRepository().listTurnsByConversation('workspace-a', conversationId).length, 1);
  assert.equal(store.getDatabase().prepare(`SELECT COUNT(*) AS n FROM p2_group_recovery_links
    WHERE workspace_id = ? AND prior_interaction_id = ?`).get('workspace-a', prior.id).n, 1);
  console.log(JSON.stringify({
    recoveryStatuses: [recoveryA.response.status, recoveryB.response.status].sort(),
    recoveredInteractionIds: [recoveryA.json.interaction.id, recoveryB.json.interaction.id],
    recoveredSourceMessageIds: [recoveryA.json.message.id, recoveryB.json.message.id],
    clientMessageIds: [recoveryA.json.message.clientMessageId, recoveryB.json.message.clientMessageId],
    respondStatuses: concurrent.map(response => response.status).sort(), ownerClaims, turnStartEvents, providerStartEvents,
    providerMode: process.env.AGENTOS_FORCE_MOCK === 'true' ? 'forced-mock' : 'unexpected',
  }));
} finally {
  await new Promise(resolve => server.close(() => resolve()));
  store.close();
  rmSync(root, { recursive: true, force: true });
}
