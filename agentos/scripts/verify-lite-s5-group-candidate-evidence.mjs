/**
 * LITE S5 / LITE-09-010 group-execution candidate evidence harness.
 *
 * Drives the production GroupTurnDriver with the production bounded-group service over a
 * real group Conversation: mention precedence, the full-member mention expansion that '@all'
 * denotes on this path, serialization, the D3-off (no parallel-read-only) classification and
 * the budget/loop terminators, then the admission refusal that must fire before any Provider
 * call. The runner records what each speaker's Turn would have sent to a Provider.
 *
 * Usage (from apps/server, with tsx resolvable):
 *   node --import tsx ../../scripts/verify-lite-s5-group-candidate-evidence.mjs --out <dir>
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { SqliteStore } from '../apps/server/src/store/SqliteStore.ts';
import { MemoryEntryRepository } from '../apps/server/src/store/MemoryEntryRepository.ts';
import { MemoryRetrievalService } from '../apps/server/src/services/MemoryRetrievalService.ts';
import { createChatMemorySelectionPort } from '../apps/server/src/services/ChatMemorySelectionPort.ts';
import { ConversationRepository } from '../apps/server/src/store/ConversationRepository.ts';
import { AgentTurnRepository } from '../apps/server/src/store/AgentTurnRepository.ts';
import { ConversationStreamService } from '../apps/server/src/services/ConversationStreamService.ts';
import { createDurableTurnContextSnapshotPort } from '../apps/server/src/services/ConversationTurnDriver.ts';
import { GroupTurnDriver } from '../apps/server/src/services/GroupTurnDriver.ts';

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const OUT = resolve(argValue('--out', '.'));
mkdirSync(OUT, { recursive: true });

const receipts = [];
const phases = {};
let phase = 'setup';
class ReceiptFailure extends Error {}

function expect(requirementId, id, step, actual, expected) {
  let passed = true;
  let detail;
  try { assert.deepEqual(actual, expected); }
  catch (error) { passed = false; detail = String(error.message).split(String.fromCharCode(10))[0]; }
  receipts.push({ id, requirementId, phase, step, actual, expected,
    outcome: passed ? 'passed' : 'failed',
    ...(detail === undefined ? {} : { detail }) });
  if (!passed) throw new ReceiptFailure(id);
  return actual;
}

function catchPhase(error) {
  if (!(error instanceof ReceiptFailure)) throw error;
  phases[phase] = { ...(phases[phase] ?? {}), failedReceipt: error.message };
}

const root = mkdtempSync(join(tmpdir(), 'agentos-s5-group-'));
const workspaceRoot = join(root, 'workspace');
mkdirSync(workspaceRoot, { recursive: true });
const store = new SqliteStore(root);
const db = store.getDatabase();
const NOW = new Date().toISOString();
const WS = 'ws_s5_group';
const CONV = 'conv_' + 'g'.repeat(26);
const SOURCE = 'msg_' + 'v'.repeat(26);
const AGENT_IDS = ['agent_lead', 'agent_worker', 'agent_reviewer'];

db.prepare('INSERT INTO workspaces (id,name,root_path,canonical_root_path,last_opened_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
  .run(WS, WS, workspaceRoot, workspaceRoot, NOW, NOW, NOW);

const entries = new MemoryEntryRepository(db);
entries.createEntry({
  id: 'mem_group_shared', workspaceId: WS, scope: 'conversation',
  ownerConversationId: CONV, category: 'knowledge', authority: 'system-verified',
  confidence: 0.9, importance: 0.6, title: 'shared rule', summary: 'shared',
  content: 'the group shares this bounded context', tags: [], status: 'active',
  sources: [{ kind: 'conversation', id: CONV }], createdAt: NOW,
});
for (const [agentId, label] of [['agent_lead', 'lead'], ['agent_worker', 'worker'], ['agent_reviewer', 'reviewer']]) {
  entries.createEntry({
    id: 'mem_group_' + label, workspaceId: WS, scope: 'agent', ownerAgentId: agentId,
    category: 'knowledge', authority: 'system-verified', confidence: 0.9, importance: 0.6,
    title: label + ' private rule', summary: label + ' only',
    content: 'private context for ' + agentId, tags: [], status: 'active',
    sources: [{ kind: 'conversation', id: CONV }], createdAt: NOW,
  });
}

const conversations = new ConversationRepository(db);
const agents = Object.fromEntries(AGENT_IDS.map((id, index) => [id, {
  id, name: id, role: index === 0 ? 'codex_manager' : 'kimi_worker', enabled: true,
  cliCommand: 'codex', cliArgs: [], model: 'gpt-5.6-luna', thinkingEffort: 'low',
  systemPrompt: id, workspaceId: WS,
}]));
const getAgent = (_workspaceId, agentId) => agents[agentId];
const selection = createChatMemorySelectionPort({ retrieval: new MemoryRetrievalService(entries) });
const snapshots = createDurableTurnContextSnapshotPort(store);

/** One recorded observation per speaker Turn the driver actually started. */
const observations = [];
let concurrent = 0;
let maxConcurrent = 0;
const authorityHolder = { current: undefined };
const runnerFactory = options => ({
  run: async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise(resolve => setTimeout(resolve, 1));
    const snapshotRow = db.prepare('SELECT selected_entry_ids_json AS idsJson, interaction_id AS interactionId FROM cr_turn_context_snapshots WHERE turn_id = ?')
      .get(options.executionId);
    observations.push({
      agentId: options.agent.id, turnId: options.executionId,
      memoryContext: options.memoryContext ?? null,
      interactionOnSnapshot: snapshotRow === undefined ? null : snapshotRow.interactionId,
      selectedIds: snapshotRow === undefined ? null : JSON.parse(snapshotRow.idsJson),
    });
    concurrent -= 1;
    return { status: 'completed', content: 'reply from ' + options.agent.id, mode: 'mock', startedAt: NOW, completedAt: NOW };
  },
});

const createGroup = (replyMode, budget) => {
  // A Conversation may declare no reply mode at all, so the option is omitted rather than
  // passed as null.
  conversations.createConversation({
    id: CONV, workspaceId: WS, kind: 'group', title: 'G', createdAt: NOW,
    ...(replyMode === null ? {} : { replyMode }),
  });
  conversations.addMember({ id: 'member_user', conversationId: CONV, workspaceId: WS, subjectType: 'user',
    subjectId: 'user_self', displayNameSnapshot: 'You', role: 'owner', replyMode: 'always', joinedAt: NOW });
  AGENT_IDS.forEach((agentId, index) => conversations.addMember({
    id: 'member_' + String(index), conversationId: CONV, workspaceId: WS, subjectType: 'agent',
    subjectId: agentId, displayNameSnapshot: agentId,
    role: index === 0 ? 'orchestrator' : 'participant',
    replyMode: index === 1 ? 'always' : 'mentioned',
    joinedAt: '2026-09-14T00:00:0' + String(index + 1) + '.000Z',
  }));
  conversations.appendMessage({ id: SOURCE, conversationId: CONV, workspaceId: WS, senderType: 'user',
    kind: 'text', status: 'final', content: 'please review the design', createdAt: NOW });
  return store.boundedGroupService().createInteraction({ workspaceId: WS, conversationId: CONV, budget, createdAt: NOW });
};

const makeDriver = () => new GroupTurnDriver(
  store.boundedGroupService(), store.groupInteractionRepository(), conversations,
  store.conversationStreamService(), getAgent,
  { selection, snapshots, workspaceAuthority: { findModifyingHolder: () => authorityHolder.current }, contextTokenBudget: null },
);
const walk = (interaction, extra = {}) => makeDriver().run({
  workspaceId: WS, workspaceRoot, conversationId: CONV, interactionId: interaction.id,
  sourceMessageId: SOURCE, createdAt: NOW, ...extra,
  // The speaker Turns are driven by the production turn driver, so the recording runner is
  // handed over through the driver's own options (a real CLI is not available in evidence runs).
}, { runnerFactory });
const repliesOf = interactionId => store.groupInteractionRepository().listReplies(interactionId);

// -------------------------------------------------------------------- plan phase
phase = 'plan';
try {
const interaction = createGroup(null, { maxAgentsPerTurn: 3, maxRepliesPerAgent: 1, maxTotalReplies: 3, maxAgentHops: 3 });
const mentionWalk = await walk(interaction, { mentionedAgentIds: ['agent_reviewer', 'agent_lead'] });
expect('LITE-09-010', 'S5G-MENTION-01', 'a mention selects exactly the mentioned Agents, in mention order, and reports the rest as skipped',
  { speakers: mentionWalk.plan.speakers.map(speaker => ({ agentId: speaker.agentId, source: speaker.source })),
    skipped: mentionWalk.plan.skipped.map(item => ({ agentId: item.agentId, reason: item.reason })),
    repliesRecorded: mentionWalk.speakers.map(outcome => ({ agentId: outcome.agentId, status: outcome.status, hasReply: outcome.replyId !== null })) },
  { speakers: [{ agentId: 'agent_reviewer', source: 'mention' }, { agentId: 'agent_lead', source: 'mention' }],
    skipped: [{ agentId: null, reason: 'member-not-active' }, { agentId: 'agent_worker', reason: 'not-selected-manually' }],
    repliesRecorded: [{ agentId: 'agent_reviewer', status: 'final', hasReply: true },
      { agentId: 'agent_lead', status: 'final', hasReply: true }] });
const replies = repliesOf(interaction.id);
expect('LITE-09-010', 'S5G-MENTION-02', 'the durable replies carry the serialized speaker order and the hop chain',
  { replyAgents: replies.map(reply => reply.agentId), hopOrders: replies.map(reply => reply.hopOrder),
    hopChain: replies.map(reply => reply.hopFromAgentId ?? null),
    agentsSawTheirOwnSnapshot: observations.map(observation => ({
      agentId: observation.agentId,
      sawSharedConversationEntry: (observation.selectedIds ?? []).includes('mem_group_shared'),
      contextIsFrozenEntry: (observation.memoryContext ?? '').includes('the group shares this bounded context'),
    })),
    // The reply must reference the same execution snapshot that the Provider Turn used;
    // a second after-the-fact CR-5 selection would not be canonical evidence.
    replySnapshotTags: replies.map(reply => {
      const row = db.prepare('SELECT interaction_id AS interactionId, agent_id AS agentId, turn_id AS turnId, selected_entry_ids_json AS idsJson FROM cr_turn_context_snapshots WHERE id = ?').get(reply.contextSnapshotId);
      return {
        agentId: row?.agentId ?? null,
        taggedWithInteraction: row?.interactionId === interaction.id,
        turnMatchesReply: row?.turnId === reply.turnId,
        idsIsArray: Array.isArray(JSON.parse(row?.idsJson ?? 'null')),
      };
    }),
    endedBy: mentionWalk.endedBy, maxConcurrent },
  { replyAgents: ['agent_reviewer', 'agent_lead'], hopOrders: [0, 1], hopChain: [null, 'agent_reviewer'],
    agentsSawTheirOwnSnapshot: [
      { agentId: 'agent_reviewer', sawSharedConversationEntry: true, contextIsFrozenEntry: true },
      { agentId: 'agent_lead', sawSharedConversationEntry: true, contextIsFrozenEntry: true },
    ],
    replySnapshotTags: [
      { agentId: 'agent_reviewer', taggedWithInteraction: true, turnMatchesReply: true, idsIsArray: true },
      { agentId: 'agent_lead', taggedWithInteraction: true, turnMatchesReply: true, idsIsArray: true },
    ],
    endedBy: 'completed', maxConcurrent: 1 });
expect('LITE-09-101', 'S5G-CONTEXT-01', 'every group speaker sees a durable context snapshot before its Provider call and receives the frozen shared context',
  { speakers: observations.slice(0, 2).map(observation => observation.agentId),
    snapshotPersistedBeforeProvider: observations.slice(0, 2).every(observation => observation.interactionOnSnapshot === interaction.id),
    sharedContextInjected: observations.slice(0, 2).every(observation => (observation.memoryContext ?? '').includes('the group shares this bounded context')),
    providerSelectionMatchesSnapshot: observations.slice(0, 2).every(observation => (observation.selectedIds ?? []).includes('mem_group_shared')) },
  { speakers: ['agent_reviewer', 'agent_lead'], snapshotPersistedBeforeProvider: true,
    sharedContextInjected: true, providerSelectionMatchesSnapshot: true });
const privateEntryId = { agent_lead: 'mem_group_lead', agent_worker: 'mem_group_worker', agent_reviewer: 'mem_group_reviewer' };
expect('LITE-09-013', 'S5G-CONTEXT-ISOLATION-01', 'group speakers receive their own Agent-scoped context without seeing another Agent private rule',
  { isolation: observations.slice(0, 2).map(observation => ({
      agentId: observation.agentId,
      seesOwn: (observation.memoryContext ?? '').includes('private context for ' + observation.agentId),
      seesOther: AGENT_IDS.filter(agentId => agentId !== observation.agentId)
        .some(agentId => (observation.memoryContext ?? '').includes('private context for ' + agentId)),
      selectedOwn: (observation.selectedIds ?? []).includes(privateEntryId[observation.agentId]),
      selectedOther: (observation.selectedIds ?? []).some(id => id.startsWith('mem_group_')
        && id !== 'mem_group_shared' && id !== privateEntryId[observation.agentId]),
    })) },
  { isolation: [
      { agentId: 'agent_reviewer', seesOwn: true, seesOther: false, selectedOwn: true, selectedOther: false },
      { agentId: 'agent_lead', seesOwn: true, seesOther: false, selectedOwn: true, selectedOther: false },
    ] });
// The other direction of the same gate: with no mention at all, mention-only members are
// reported as not-mentioned and only an always-mode member speaks.
const noMentionInteraction = store.boundedGroupService().createInteraction({
  workspaceId: WS, conversationId: CONV,
  budget: { maxAgentsPerTurn: 3, maxRepliesPerAgent: 1, maxTotalReplies: 3, maxAgentHops: 3 },
  createdAt: NOW,
});
const noMentionWalk = await walk(noMentionInteraction);
expect('LITE-09-010', 'S5G-MENTION-03', 'without a mention only the always-mode member speaks and the mention-only members are reported as not-mentioned',
  { speakers: noMentionWalk.plan.speakers.map(speaker => ({ agentId: speaker.agentId, source: speaker.source })),
    skipped: noMentionWalk.plan.skipped.map(item => ({ agentId: item.agentId, reason: item.reason })),
    replies: repliesOf(noMentionInteraction.id).map(reply => reply.agentId) },
  { speakers: [{ agentId: 'agent_worker', source: 'mode' }],
    skipped: [{ agentId: 'agent_lead', reason: 'not-mentioned' },
      { agentId: 'agent_reviewer', reason: 'not-mentioned' },
      { agentId: null, reason: 'member-not-active' }],
    replies: ['agent_worker'] });
phases.plan = { interactionId: interaction.id, speakers: mentionWalk.plan.speakers.map(speaker => speaker.agentId),
  replies: replies.map(reply => ({ agentId: reply.agentId, hopOrder: reply.hopOrder })) };
} catch (error) { catchPhase(error); }

// ------------------------------------------------------------- full-member phase
phase = 'members';
const CONV_ALL = 'conv_' + 'a'.repeat(26);
try {
// '@all' on this path is the full member set passed as the mention list: there is no
// separate server-side token, so the expansion is exercised exactly as the route delivers it.
const interaction = (() => {
  conversations.createConversation({ id: CONV_ALL, workspaceId: WS, kind: 'group', title: 'G all', replyMode: 'orchestrated', createdAt: NOW });
  AGENT_IDS.forEach((agentId, index) => conversations.addMember({
    id: 'all_member_' + String(index), conversationId: CONV_ALL, workspaceId: WS, subjectType: 'agent',
    subjectId: agentId, displayNameSnapshot: agentId, role: index === 0 ? 'orchestrator' : 'participant',
    replyMode: 'mentioned', joinedAt: '2026-09-14T00:00:1' + String(index) + '.000Z',
  }));
  conversations.appendMessage({ id: 'msg_' + 'w'.repeat(26), conversationId: CONV_ALL, workspaceId: WS,
    senderType: 'user', kind: 'text', status: 'final', content: 'everyone please weigh in', createdAt: NOW });
  return store.boundedGroupService().createInteraction({ workspaceId: WS, conversationId: CONV_ALL,
    budget: { maxAgentsPerTurn: 3, maxRepliesPerAgent: 1, maxTotalReplies: 3, maxAgentHops: 4 }, createdAt: NOW });
})();
const allWalk = await makeDriver().run({ workspaceId: WS, workspaceRoot, conversationId: CONV_ALL,
  interactionId: interaction.id, sourceMessageId: 'msg_' + 'w'.repeat(26), createdAt: NOW,
  mentionedAgentIds: [...AGENT_IDS], orchestratedOrder: [...AGENT_IDS] }, { runnerFactory });
expect('LITE-09-010', 'S5G-ALL-01', 'the full member set speaks in the delivered order and the walk is serialized end to end',
  { speakerOrder: allWalk.plan.speakers.map(speaker => speaker.agentId),
    declaredReadOnly: [...new Set(allWalk.plan.speakers.map(speaker => speaker.declaredReadOnly))],
    effectiveMutationClass: [...new Set(allWalk.plan.speakers.map(speaker => speaker.effectiveMutationClass))],
    repliesRecorded: allWalk.speakers.map(outcome => outcome.agentId),
    budgetAfter: store.boundedGroupService().budgetStatus(store.boundedGroupService().findInteraction(WS, interaction.id)),
    maxConcurrent, endedBy: allWalk.endedBy },
  { speakerOrder: [...AGENT_IDS], declaredReadOnly: [false], effectiveMutationClass: ['modifying'],
    repliesRecorded: [...AGENT_IDS],
    budgetAfter: { repliesUsed: 3, repliesRemaining: 0, hopsUsed: 2, hopsRemaining: 2, distinctAgents: 3, agentsRemaining: 0 },
    maxConcurrent: 1, endedBy: 'budget-total-replies' });
phases.members = { interactionId: interaction.id, speakers: allWalk.plan.speakers.length };
} catch (error) { catchPhase(error); }

// -------------------------------------------------------------- d3-off phase
phase = 'd3off';
const CONV_RO = 'conv_' + 'r'.repeat(26);
try {
const interaction = (() => {
  conversations.createConversation({ id: CONV_RO, workspaceId: WS, kind: 'group', title: 'G ro', replyMode: 'parallel-read-only', createdAt: NOW });
  AGENT_IDS.slice(0, 2).forEach((agentId, index) => conversations.addMember({
    id: 'ro_member_' + String(index), conversationId: CONV_RO, workspaceId: WS, subjectType: 'agent',
    subjectId: agentId, displayNameSnapshot: agentId, role: index === 0 ? 'orchestrator' : 'participant',
    replyMode: 'always', joinedAt: '2026-09-14T00:00:2' + String(index) + '.000Z',
  }));
  conversations.appendMessage({ id: 'msg_' + 'x'.repeat(26), conversationId: CONV_RO, workspaceId: WS,
    senderType: 'user', kind: 'text', status: 'final', content: 'read-only round', createdAt: NOW });
  return store.boundedGroupService().createInteraction({ workspaceId: WS, conversationId: CONV_RO,
    budget: { maxAgentsPerTurn: 2, maxRepliesPerAgent: 1, maxTotalReplies: 2, maxAgentHops: 2 }, createdAt: NOW });
})();
const before = observations.length;
const readOnlyWalk = await makeDriver().run({ workspaceId: WS, workspaceRoot, conversationId: CONV_RO,
  interactionId: interaction.id, sourceMessageId: 'msg_' + 'x'.repeat(26), createdAt: NOW }, { runnerFactory });
const replies = repliesOf(interaction.id);
expect('LITE-09-010', 'S5G-D3OFF-01', 'a parallel-read-only request is recorded as declared but still classified modifying and stays serialized (D3 off)',
  { declaredReadOnly: [...new Set(readOnlyWalk.plan.speakers.map(speaker => speaker.declaredReadOnly))],
    effectiveMutationClass: [...new Set(readOnlyWalk.plan.speakers.map(speaker => speaker.effectiveMutationClass))],
    turnsStarted: observations.length - before, repliesRecorded: replies.length,
    maxConcurrent, endedBy: readOnlyWalk.endedBy },
  { declaredReadOnly: [true], effectiveMutationClass: ['modifying'],
    turnsStarted: 2, repliesRecorded: 2, maxConcurrent: 1, endedBy: 'budget-total-replies' });
phases.d3off = { interactionId: interaction.id, speakers: readOnlyWalk.plan.speakers.length };
} catch (error) { catchPhase(error); }

// ------------------------------------------------------------ contention phase
phase = 'contention';
const CONV_BUSY = 'conv_' + 'b'.repeat(26);
try {
const interaction = (() => {
  conversations.createConversation({ id: CONV_BUSY, workspaceId: WS, kind: 'group', title: 'G busy', createdAt: NOW });
  AGENT_IDS.slice(0, 2).forEach((agentId, index) => conversations.addMember({
    id: 'busy_member_' + String(index), conversationId: CONV_BUSY, workspaceId: WS, subjectType: 'agent',
    subjectId: agentId, displayNameSnapshot: agentId, role: index === 0 ? 'orchestrator' : 'participant',
    replyMode: 'always', joinedAt: '2026-09-14T00:00:3' + String(index) + '.000Z',
  }));
  conversations.appendMessage({ id: 'msg_' + 'y'.repeat(26), conversationId: CONV_BUSY, workspaceId: WS,
    senderType: 'user', kind: 'text', status: 'final', content: 'contended round', createdAt: NOW });
  return store.boundedGroupService().createInteraction({ workspaceId: WS, conversationId: CONV_BUSY,
    budget: { maxAgentsPerTurn: 2, maxRepliesPerAgent: 1, maxTotalReplies: 2, maxAgentHops: 2 }, createdAt: NOW });
})();
authorityHolder.current = { subjectKind: 'CANONICAL_RUN', subjectId: 'run_group_competitor' };
const beforeBusy = observations.length;
const busyWalk = await makeDriver().run({ workspaceId: WS, workspaceRoot, conversationId: CONV_BUSY,
  interactionId: interaction.id, sourceMessageId: 'msg_' + 'y'.repeat(26), createdAt: NOW }, { runnerFactory });
const busyReplies = repliesOf(interaction.id);
const busyInteraction = store.boundedGroupService().findInteraction(WS, interaction.id);
const failedTurns = db.prepare('SELECT id, status, failure_code AS failureCode, failure_message AS failureMessage FROM cr_agent_turns WHERE conversation_id = ?').all(CONV_BUSY);
expect('LITE-09-010', 'S5G-CONTENTION-01', 'a foreign modifying holder stops the walk before any reply is recorded, with the refusal named on the Turn',
  { providerCalls: observations.length - beforeBusy, repliesRecorded: busyReplies.length,
    endedBy: busyWalk.endedBy,
    interactionStatus: { status: busyInteraction?.status ?? null, stopReason: busyInteraction?.stopReason ?? null },
    budgetUnmoved: store.boundedGroupService().budgetStatus(busyInteraction),
    turnStatuses: failedTurns.map(turn => ({ status: turn.status, failureCode: turn.failureCode })),
    refusalNamesTheHolder: failedTurns.every(turn => String(turn.failureMessage ?? '').includes('run_group_competitor')),
    replayBudgetLimited: busyWalk.plan.speakers.length },
  { providerCalls: 0, repliesRecorded: 0, endedBy: 'provider-failed',
    interactionStatus: { status: 'active', stopReason: null },
    budgetUnmoved: { repliesUsed: 0, repliesRemaining: 2, hopsUsed: 0, hopsRemaining: 2, distinctAgents: 0, agentsRemaining: 2 },
    turnStatuses: [{ status: 'failed', failureCode: 'CONVERSATION_WORKSPACE_MODIFYING_BUSY' }],
    refusalNamesTheHolder: true, replayBudgetLimited: 2 });
authorityHolder.current = undefined;
const retried = await makeDriver().run({ workspaceId: WS, workspaceRoot, conversationId: CONV_BUSY,
  interactionId: interaction.id, sourceMessageId: 'msg_' + 'y'.repeat(26), createdAt: NOW }, { runnerFactory });
expect('LITE-09-010', 'S5G-CONTENTION-02', 'once the holder is released the same interaction completes, so the stop was about authority only',
  { repliesRecorded: repliesOf(interaction.id).length, endedBy: retried.endedBy, replyAgents: retried.speakers.map(outcome => outcome.agentId) },
  { repliesRecorded: 2, endedBy: 'budget-total-replies', replyAgents: ['agent_lead', 'agent_worker'] });
phases.contention = { interactionId: interaction.id };
} catch (error) { catchPhase(error); }

// Recorded for review: every failed speaker Turn in this run, with its stable code.
phases.turnFailures = db.prepare("SELECT conversation_id AS conversationId, status, failure_code AS failureCode, substr(failure_message, 1, 300) AS failureMessage FROM cr_agent_turns WHERE status <> 'final' ORDER BY created_at").all()
  .map(row => ({ conversationId: row.conversationId, status: row.status, failureCode: row.failureCode, failureMessage: row.failureMessage }));

store.close();
rmSync(root, { recursive: true, force: true });

const counts = { total: receipts.length, passed: 0, failed: 0, skipped: 0 };
for (const receipt of receipts) {
  if (receipt.outcome === 'passed') counts.passed += 1;
  else if (receipt.outcome === 'failed') counts.failed += 1;
  else counts.skipped += 1;
}
writeFileSync(join(OUT, 'receipts.json'), JSON.stringify({
  schemaVersion: 1, generatedAt: new Date().toISOString(), maxConcurrent, phases, counts, receipts,
}, null, 2) + String.fromCharCode(10), 'utf8');

console.log('S5_GROUP_CANDIDATE_EVIDENCE: ' + (counts.failed === 0 ? 'passed' : 'failed'));
console.log('  receipts=' + counts.total + ' passed=' + counts.passed + ' failed=' + counts.failed);
for (const receipt of receipts.filter(item => item.outcome !== 'passed')) {
  console.log('  FAILED ' + receipt.id + ' (' + receipt.requirementId + '): ' + (receipt.detail ?? ''));
}
await new Promise(resolve => setTimeout(resolve, 100));
process.exitCode = counts.failed === 0 ? 0 : 1;
