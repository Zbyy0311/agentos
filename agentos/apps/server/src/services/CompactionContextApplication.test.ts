import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationMessage } from '@agentos/shared';
import { applyCompactionSummary, type PublishedCompactionSummary } from './ConversationTurnDriver.js';

const WS = 'ws_s6c';
const CONV = 'conv';

function message(id: string, content: string): ConversationMessage {
  return { id, conversationId: CONV, workspaceId: WS, senderType: 'user', content, createdAt: '2026-09-12T16:00:00.000Z' };
}

const history: ConversationMessage[] = [
  message('m1', 'old one'),
  message('m2', 'old two'),
  message('m3', 'recent three'),
  message('m4', 'recent four'),
];

test('S6-C: a published summary replaces exactly the Messages it covers', () => {
  const summary: PublishedCompactionSummary = { id: 'comp_1', summary: 'SUMMARY', sourceEndMessageId: 'm2' };
  const result = applyCompactionSummary(history, summary, { hardBudgetTokens: 10_000 });
  assert.equal(result.kind, 'applied');
  if (result.kind !== 'applied') return;
  assert.equal(result.summarizedMessages, 2);
  assert.deepEqual(result.history.map(item => item.id), ['compaction:comp_1', 'm3', 'm4']);
  assert.equal(result.history[0]!.content, 'SUMMARY');
  assert.equal(result.history[0]!.senderType, 'system');
});

test('S6-C: the uncompressed tail keeps its original order and content', () => {
  const summary: PublishedCompactionSummary = { id: 'comp_1', summary: 'S', sourceEndMessageId: 'm1' };
  const result = applyCompactionSummary(history, summary, { hardBudgetTokens: 10_000 });
  assert.equal(result.kind, 'applied');
  if (result.kind !== 'applied') return;
  assert.deepEqual(result.history.slice(1).map(item => [item.id, item.content]), [['m2', 'old two'], ['m3', 'recent three'], ['m4', 'recent four']]);
});

test('S6-C: a missing or unknown source message leaves the history uncompacted', () => {
  assert.deepEqual(applyCompactionSummary(history, undefined, { hardBudgetTokens: 10 }), { kind: 'uncompacted', history });
  const unknown: PublishedCompactionSummary = { id: 'comp_x', summary: 'S', sourceEndMessageId: 'does-not-exist' };
  assert.equal(applyCompactionSummary(history, unknown, { hardBudgetTokens: 10 }).kind, 'uncompacted');
  const noRange: PublishedCompactionSummary = { id: 'comp_y', summary: 'S', sourceEndMessageId: null };
  assert.equal(applyCompactionSummary(history, noRange, { hardBudgetTokens: 10 }).kind, 'uncompacted');
});

test('S6-C: summary plus tail beyond the hard budget is refused, never truncated', () => {
  const summary: PublishedCompactionSummary = { id: 'comp_1', summary: 'x'.repeat(400), sourceEndMessageId: 'm2' };
  const result = applyCompactionSummary(history, summary, { hardBudgetTokens: 5 });
  assert.equal(result.kind, 'over-budget');
  if (result.kind !== 'over-budget') return;
  assert.equal(result.summaryId, 'comp_1');
  assert.ok(result.estimatedTokens > result.hardBudgetTokens);
  assert.equal(history.length, 4);
});

