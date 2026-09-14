/**
 * LITE S5 execution-boundary candidate evidence harness.
 *
 * Drives the production ConversationTurnDriver with the production composition the chat
 * route builds (real Memory selection port, durable CR-5 snapshot port, Workspace modifying
 * authority port) and a recording runner, so the receipts show what the Provider would
 * actually receive and in what order it was frozen. The model itself is not exercised here:
 * these rows are about persistence, scope and authority, not about model output.
 *
 * Usage (from apps/server, with tsx resolvable):
 *   node --import tsx ../../scripts/verify-lite-s5-execution-candidate-evidence.mjs --out <dir>
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { SqliteStore } from '../apps/server/src/store/SqliteStore.ts';
import { MemoryEntryRepository } from '../apps/server/src/store/MemoryEntryRepository.ts';
import { MemoryRetrievalService } from '../apps/server/src/services/MemoryRetrievalService.ts';
import { createChatMemorySelectionPort, CHAT_MEMORY_STRATEGY_VERSION } from '../apps/server/src/services/ChatMemorySelectionPort.ts';
import { injectedEntryText } from '../apps/server/src/services/MemoryContextBudgetSelector.ts';
import { ConversationRepository } from '../apps/server/src/store/ConversationRepository.ts';
import { AgentTurnRepository } from '../apps/server/src/store/AgentTurnRepository.ts';
import { ConversationStreamService } from '../apps/server/src/services/ConversationStreamService.ts';
import { WorkspaceAdmissionRepository } from '../apps/server/src/store/WorkspaceAdmissionRepository.ts';
import {
  ConversationTurnDriver,
  createDurableTurnContextSnapshotPort,
} from '../apps/server/src/services/ConversationTurnDriver.ts';

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

const root = mkdtempSync(join(tmpdir(), 'agentos-s5-evidence-'));
const workspaceRoot = join(root, 'workspace');
mkdirSync(workspaceRoot, { recursive: true });
const store = new SqliteStore(root);
const db = store.getDatabase();
const NOW = new Date().toISOString();
const WS = 'ws_s5_evidence';
const CONV = 'conv_' + 's'.repeat(26);
const SOURCE = 'msg_' + 'u'.repeat(26);

db.prepare('INSERT INTO workspaces (id,name,root_path,canonical_root_path,last_opened_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
  .run(WS, WS, workspaceRoot, workspaceRoot, NOW, NOW, NOW);

const entries = new MemoryEntryRepository(db);
let seq = 0;
const addEntry = overrides => {
  seq += 1;
  const id = 'mem_s5_' + String(seq).padStart(2, '0');
  entries.createEntry({
    id, workspaceId: WS, scope: 'workspace', category: 'knowledge',
    authority: 'system-verified', confidence: 0.9, importance: 0.6,
    title: 'entry ' + String(seq), summary: 'summary ' + String(seq),
    content: 'detail for entry ' + String(seq),
    tags: [], status: 'active', sources: [{ kind: 'user', id: 'evidence-' + String(seq) }], createdAt: NOW,
    ...overrides,
  });
  return id;
};
const workspaceEntry = addEntry({ title: 'workspace rule', content: 'chat reaches workspace scope' });
const agentAEntry = addEntry({ scope: 'agent', ownerAgentId: 'agent_a', title: 'agent A rule', content: 'only agent A may read this' });
const agentBEntry = addEntry({ scope: 'agent', ownerAgentId: 'agent_b', title: 'agent B rule', content: 'only agent B may read this' });
const taskEntry = addEntry({ scope: 'task', ownerTaskId: 'task_out_of_reach', title: 'task rule', content: 'the chat path must not reach this' });

const conversations = new ConversationRepository(db);
conversations.createConversation({ id: CONV, workspaceId: WS, kind: 'direct', title: 'S5 evidence', createdAt: NOW });
conversations.appendMessage({ id: SOURCE, conversationId: CONV, workspaceId: WS, senderType: 'user',
  kind: 'text', status: 'final', content: 'answer with the frozen context only', createdAt: NOW });
const turns = new AgentTurnRepository(db);
const stream = new ConversationStreamService(db, conversations, turns);

const agents = {
  agent_a: { id: 'agent_a', name: 'Agent A', role: 'codex_manager', enabled: true, cliCommand: 'codex',
    cliArgs: [], model: 'gpt-5.6-luna', thinkingEffort: 'low', systemPrompt: 'A', workspaceId: WS },
  agent_b: { id: 'agent_b', name: 'Agent B', role: 'kimi_worker', enabled: true, cliCommand: 'kimi',
    cliArgs: [], model: 'kimi-k2', thinkingEffort: 'low', systemPrompt: 'B', workspaceId: WS },
};
const getAgent = (_workspaceId, agentId) => agents[agentId];
const selection = createChatMemorySelectionPort({
  retrieval: new MemoryRetrievalService(entries),
});
const snapshots = createDurableTurnContextSnapshotPort(store);

/** What the runner observed, per turn, and what the durable rows said at that moment. */
const observations = [];
const authorityHolder = { current: undefined };
const workspaceAuthority = {
  findModifyingHolder: () => authorityHolder.current,
};
const makeRunnerFactory = () => options => ({
  run: async () => {
    const snapshotRow = db.prepare('SELECT id, selected_entry_ids_json AS idsJson, total_tokens AS totalTokens, retrieval_strategy_version AS strategyVersion FROM cr_turn_context_snapshots WHERE conversation_id = ? AND turn_id = ?')
      .get(CONV, options.executionId);
    observations.push({
      turnId: options.executionId, agentId: options.agent.id,
      memoryContext: options.memoryContext ?? null,
      historyIds: options.history.map(message => message.id),
      snapshotAtRunTime: snapshotRow === undefined ? null : {
        id: snapshotRow.id, ids: JSON.parse(snapshotRow.idsJson),
        totalTokens: Number(snapshotRow.totalTokens), strategyVersion: snapshotRow.strategyVersion,
      },
    });
    return { status: 'completed', content: 'ok', mode: 'mock', startedAt: NOW, completedAt: NOW };
  },
});
const driverFor = () => new ConversationTurnDriver(conversations, stream, getAgent, makeRunnerFactory(),
  { selection, snapshots, workspaceAuthority, contextTokenBudget: null });

const runTurn = async (turnId, responseMessageId, agentId) => driverFor().replyWithTurn({
  workspaceId: WS, workspaceRoot, conversationId: CONV, agentId,
  sourceMessageId: SOURCE, content: 'answer with the frozen context only',
  turnId, responseMessageId, createdAt: NOW,
});

const expectedTextFor = ids => ids.length === 0 ? null : ids.map(id => {
  const row = db.prepare('SELECT title, content FROM memory_entries WHERE id = ?').get(id);
  return injectedEntryText({ title: row.title, content: row.content });
}).join(String.fromCharCode(10) + String.fromCharCode(10));

// ------------------------------------------------------------------ direct phase
phase = 'direct';
const TURN_A = 'turn_' + 'a'.repeat(20);
try {
const result = await runTurn(TURN_A, 'msg_' + 'a'.repeat(21), 'agent_a');
const observation = observations[observations.length - 1];
const turnRow = db.prepare('SELECT id, status, context_snapshot_id AS snapshotId FROM cr_agent_turns WHERE id = ?').get(TURN_A);
const snapshotIds = observation.snapshotAtRunTime === null ? [] : observation.snapshotAtRunTime.ids;
expect('LITE-09-101', 'S5E-DIRECT-01', 'the frozen selection is persisted before the Provider call and names the real Memory entries',
  { runnerSawSnapshot: observation.snapshotAtRunTime !== null,
    selectedIds: snapshotIds, totalTokens: observation.snapshotAtRunTime?.totalTokens ?? null,
    strategyVersion: observation.snapshotAtRunTime?.strategyVersion ?? null,
    turnStatus: result.turn.status, messageStatus: result.message.status,
    turnReferencesThatSnapshot: turnRow.snapshotId === observation.snapshotAtRunTime?.id,
    expectsWorkspaceEntry: snapshotIds.includes(workspaceEntry),
    expectsAgentEntry: snapshotIds.includes(agentAEntry) },
  { runnerSawSnapshot: true, selectedIds: snapshotIds, totalTokens: observation.snapshotAtRunTime?.totalTokens ?? null,
    strategyVersion: CHAT_MEMORY_STRATEGY_VERSION, turnStatus: 'final', messageStatus: 'final',
    turnReferencesThatSnapshot: true, expectsWorkspaceEntry: true, expectsAgentEntry: true });
expect('LITE-09-101', 'S5E-DIRECT-02', 'the Provider receives exactly the frozen selection text and the out-of-scope entry never enters it',
  { memoryContextMatchesSnapshotEntries: observation.memoryContext === expectedTextFor(snapshotIds),
    injectedEntryCount: snapshotIds.length,
    contextMentionsWorkspaceEntry: (observation.memoryContext ?? '').includes('chat reaches workspace scope'),
    contextMentionsAgentEntry: (observation.memoryContext ?? '').includes('only agent A may read this'),
    taskScopedEntrySelected: snapshotIds.includes(taskEntry),
    contextMentionsTaskEntry: (observation.memoryContext ?? '').includes('the chat path must not reach this'),
    otherAgentEntrySelected: snapshotIds.includes(agentBEntry) },
  { memoryContextMatchesSnapshotEntries: true, injectedEntryCount: snapshotIds.length,
    contextMentionsWorkspaceEntry: true, contextMentionsAgentEntry: true,
    taskScopedEntrySelected: false, contextMentionsTaskEntry: false, otherAgentEntrySelected: false });
phases.direct = { turnId: TURN_A, snapshotId: observation.snapshotAtRunTime?.id ?? null,
  selectedIds: snapshotIds, totalTokens: observation.snapshotAtRunTime?.totalTokens ?? null };
} catch (error) { catchPhase(error); }

// -------------------------------------------------------------- isolation phase
phase = 'isolation';
const TURN_B = 'turn_' + 'b'.repeat(20);
try {
const before = observations.length;
const result = await runTurn(TURN_B, 'msg_' + 'b'.repeat(21), 'agent_b');
const observation = observations[observations.length - 1];
const snapshotIds = observation.snapshotAtRunTime === null ? [] : observation.snapshotAtRunTime.ids;
const snapshotOfA = observation.snapshotAtRunTime === null
  ? undefined
  : db.prepare('SELECT id FROM cr_turn_context_snapshots WHERE conversation_id = ? AND turn_id = ?').get(CONV, TURN_A);
const snapshotOfB = db.prepare('SELECT id FROM cr_turn_context_snapshots WHERE conversation_id = ? AND turn_id = ?').get(CONV, TURN_B);
expect('LITE-09-013', 'S5E-ISOLATION-01', 'each Agent receives only its own reachable Memory and its own frozen snapshot',
  { turnsObserved: observations.length - before, selectedIds: snapshotIds,
    seesOwnAgentEntry: snapshotIds.includes(agentBEntry),
    seesOtherAgentEntry: snapshotIds.includes(agentAEntry),
    seesWorkspaceEntry: snapshotIds.includes(workspaceEntry),
    contextMentionsOwnEntry: (observation.memoryContext ?? '').includes('only agent B may read this'),
    contextMentionsOtherAgentEntry: (observation.memoryContext ?? '').includes('only agent A may read this'),
    distinctSnapshots: snapshotOfA !== undefined && snapshotOfB !== undefined && snapshotOfA.id !== snapshotOfB.id,
    turnStatus: result.turn.status },
  { turnsObserved: 1, selectedIds: snapshotIds,
    seesOwnAgentEntry: true, seesOtherAgentEntry: false, seesWorkspaceEntry: true,
    contextMentionsOwnEntry: true, contextMentionsOtherAgentEntry: false,
    distinctSnapshots: true, turnStatus: 'final' });
const turnOfA = db.prepare('SELECT context_snapshot_id AS snapshotId FROM cr_agent_turns WHERE id = ?').get(TURN_A);
expect('LITE-09-013', 'S5E-ISOLATION-02', 'the earlier Agent keeps its own snapshot and history unchanged',
  { turnAPointsAtItsOwnSnapshot: turnOfA.snapshotId === snapshotOfA?.id,
    snapshotsForTheConversation: Number(db.prepare('SELECT COUNT(*) AS n FROM cr_turn_context_snapshots WHERE conversation_id = ?').get(CONV).n),
    snapshotAgents: db.prepare('SELECT agent_id AS agentId, turn_id AS turnId FROM cr_turn_context_snapshots WHERE conversation_id = ? ORDER BY created_at, id').all(CONV).map(row => ({ agentId: row.agentId, turnId: row.turnId })) },
  { turnAPointsAtItsOwnSnapshot: true, snapshotsForTheConversation: 2,
    snapshotAgents: [{ agentId: 'agent_a', turnId: TURN_A }, { agentId: 'agent_b', turnId: TURN_B }] });
phases.isolation = { turnId: TURN_B, snapshotId: snapshotOfB?.id ?? null, selectedIds: snapshotIds };
} catch (error) { catchPhase(error); }

// ---------------------------------------------------------------- authority phase
phase = 'authority';
const TURN_C = 'turn_' + 'c'.repeat(20);
try {
authorityHolder.current = { subjectKind: 'CANONICAL_RUN', subjectId: 'run_foreign_modifier' };
const before = observations.length;
const result = await runTurn(TURN_C, 'msg_' + 'c'.repeat(21), 'agent_a');
const snapshotForTurn = db.prepare('SELECT COUNT(*) AS n FROM cr_turn_context_snapshots WHERE conversation_id = ? AND turn_id = ?').get(CONV, TURN_C);
const events = db.prepare("SELECT COUNT(*) AS n FROM runtime_events WHERE workspace_id = ?").get(WS);
expect('LITE-09-102', 'S5E-AUTHORITY-01', 'a chat Turn refuses instead of running beside another modifying holder, before any Provider call',
  { providerCalls: observations.length - before, turnStatus: result.turn.status,
    failureCode: result.turn.failureCode, messageStatus: result.message.status,
    snapshotCreatedForThatTurn: Number(snapshotForTurn.n),
    refusalNamesTheHolder: String(result.turn.failureMessage ?? '').includes('run_foreign_modifier'),
    runtimeEvents: Number(events.n) },
  { providerCalls: 0, turnStatus: 'failed', failureCode: 'CONVERSATION_WORKSPACE_MODIFYING_BUSY',
    messageStatus: 'failed', snapshotCreatedForThatTurn: 0, refusalNamesTheHolder: true, runtimeEvents: 0 });
const admittedTurn = await (async () => {
  authorityHolder.current = undefined;
  const beforeAdmitted = observations.length;
  const admitted = await runTurn('turn_' + 'd'.repeat(20), 'msg_' + 'd'.repeat(21), 'agent_a');
  return { providerCalls: observations.length - beforeAdmitted, status: admitted.turn.status };
})();
expect('LITE-09-102', 'S5E-AUTHORITY-02', 'the same Turn runs once the modifying holder is released, so the refusal is about authority only',
  admittedTurn, { providerCalls: 1, status: 'final' });
phases.authority = { refusedTurn: TURN_C, admittedTurnStatus: admittedTurn.status };
} catch (error) { catchPhase(error); }

store.close();
rmSync(root, { recursive: true, force: true });

const counts = { total: receipts.length, passed: 0, failed: 0, skipped: 0 };
for (const receipt of receipts) {
  if (receipt.outcome === 'passed') counts.passed += 1;
  else if (receipt.outcome === 'failed') counts.failed += 1;
  else counts.skipped += 1;
}
writeFileSync(join(OUT, 'receipts.json'), JSON.stringify({
  schemaVersion: 1, generatedAt: new Date().toISOString(),
  selectionStrategy: CHAT_MEMORY_STRATEGY_VERSION, phases, counts, receipts,
}, null, 2) + String.fromCharCode(10), 'utf8');

console.log('S5_EXECUTION_CANDIDATE_EVIDENCE: ' + (counts.failed === 0 ? 'passed' : 'failed'));
console.log('  receipts=' + counts.total + ' passed=' + counts.passed + ' failed=' + counts.failed);
for (const receipt of receipts.filter(item => item.outcome !== 'passed')) {
  console.log('  FAILED ' + receipt.id + ' (' + receipt.requirementId + '): ' + (receipt.detail ?? ''));
}
await new Promise(resolve => setTimeout(resolve, 100));
process.exitCode = counts.failed === 0 ? 0 : 1;
