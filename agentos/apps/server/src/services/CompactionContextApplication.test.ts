import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

/**
 * LITE-09-109: a published summary carries the range it covered and the hash of those
 * Messages at publication time, so the consumer can tell whether its source still says
 * what it said. This builds the same `[id, content]` evidence the compaction publishes.
 */
function published(
  overrides: Partial<PublishedCompactionSummary> & { readonly covered?: readonly string[] } = {},
): PublishedCompactionSummary {
  const coveredIds = overrides.covered ?? ['m1', 'm2'];
  const covered = coveredIds.map(id => history.find(item => item.id === id)!);
  return {
    id: 'comp_1',
    summary: 'SUMMARY',
    sourceStartMessageId: coveredIds[0] ?? null,
    sourceEndMessageId: coveredIds[coveredIds.length - 1] ?? null,
    sourceMessageCount: covered.length,
    sourceHash: createHash('sha256')
      .update(JSON.stringify(covered.map(item => [item.id, item.content])))
      .digest('hex'),
    ...overrides,
  };
}

test('S6-C: a published summary replaces exactly the Messages it covers', () => {
  const summary = published();
  const result = applyCompactionSummary(history, summary, { hardBudgetTokens: 10_000 });
  assert.equal(result.kind, 'applied');
  if (result.kind !== 'applied') return;
  assert.equal(result.summarizedMessages, 2);
  assert.deepEqual(result.history.map(item => item.id), ['compaction:comp_1', 'm3', 'm4']);
  assert.equal(result.history[0]!.content, 'SUMMARY');
  assert.equal(result.history[0]!.senderType, 'system');
});

test('S6-C: the uncompressed tail keeps its original order and content', () => {
  const summary = published({ summary: 'S', covered: ['m1'] });
  const result = applyCompactionSummary(history, summary, { hardBudgetTokens: 10_000 });
  assert.equal(result.kind, 'applied');
  if (result.kind !== 'applied') return;
  assert.deepEqual(result.history.slice(1).map(item => [item.id, item.content]), [['m2', 'old two'], ['m3', 'recent three'], ['m4', 'recent four']]);
});

test('S6-C: a missing or unknown source message leaves the history uncompacted', () => {
  assert.deepEqual(applyCompactionSummary(history, undefined, { hardBudgetTokens: 10 }), { kind: 'uncompacted', history });
  // LITE-09-109: a summary whose source Message is gone is a stale source rather than a
  // plain "nothing to do" - the distinction is what lets a reader see why it was refused.
  const unknown = published({ id: 'comp_x', summary: 'S', sourceEndMessageId: 'does-not-exist' });
  const unknownResult = applyCompactionSummary(history, unknown, { hardBudgetTokens: 10 });
  assert.equal(unknownResult.kind, 'stale-source');
  if (unknownResult.kind !== 'stale-source') return;
  assert.equal(unknownResult.reason, 'source-end-missing');
  // A summary with no source range at all summarizes nothing, which is a different
  // statement from "its source changed": it stays `uncompacted`.
  const noRange: PublishedCompactionSummary = {
    id: 'comp_y', summary: 'S', sourceStartMessageId: null, sourceEndMessageId: null,
    sourceMessageCount: 0, sourceHash: '',
  };
  assert.equal(applyCompactionSummary(history, noRange, { hardBudgetTokens: 10 }).kind, 'uncompacted');
});

test('S6-C: summary plus tail beyond the hard budget is refused, never truncated', () => {
  const summary = published({ summary: 'x'.repeat(400) });
  const result = applyCompactionSummary(history, summary, { hardBudgetTokens: 5 });
  assert.equal(result.kind, 'over-budget');
  if (result.kind !== 'over-budget') return;
  assert.equal(result.summaryId, 'comp_1');
  assert.ok(result.estimatedTokens > result.hardBudgetTokens);
  assert.equal(history.length, 4);
});

// LITE-09-109: the source is validated against the evidence the summary was published
// with, so an edited, hidden or re-ordered source cannot be silently replaced by a
// summary that no longer describes it. Historical snapshots are untouched throughout.
test('LITE-09-109: a summary whose covered Message was edited is refused, not applied', () => {
  const summary = published();
  const edited = [history[0]!, message('m2', 'EDITED two'), history[2]!, history[3]!];
  const result = applyCompactionSummary(edited, summary, { hardBudgetTokens: 10_000 });
  assert.equal(result.kind, 'stale-source');
  if (result.kind !== 'stale-source') return;
  assert.equal(result.reason, 'source-content-changed');
  assert.equal(result.summaryId, 'comp_1');
  // The caller keeps the uncompressed window; the Messages themselves are untouched.
  assert.deepEqual(edited.map(item => [item.id, item.content]),
    [['m1', 'old one'], ['m2', 'EDITED two'], ['m3', 'recent three'], ['m4', 'recent four']]);
});

test('LITE-09-109: a hidden covered Message changes the count and is refused', () => {
  const summary = published();
  // m1 is no longer in the visible set, so the covered range is one Message short.
  const hidden = [history[1]!, history[2]!, history[3]!];
  const result = applyCompactionSummary(hidden, summary, { hardBudgetTokens: 10_000 });
  assert.equal(result.kind, 'stale-source');
  if (result.kind !== 'stale-source') return;
  assert.ok(['source-start-missing', 'source-count-changed'].includes(result.reason),
    `unexpected reason ${result.reason}`);
});

test('LITE-09-109: a changed summary source range is refused rather than narrowed', () => {
  const summary = published();
  // The start Message is gone but the end one remains: the range cannot be reconstructed,
  // and narrowing it to what is left would silently drop the summarized prefix.
  const partial = [history[1]!, history[2]!, history[3]!];
  const narrowed = { ...summary, sourceStartMessageId: 'm2' };
  const result = applyCompactionSummary(partial, narrowed, { hardBudgetTokens: 10_000 });
  assert.equal(result.kind, 'stale-source');
  if (result.kind !== 'stale-source') return;
  assert.equal(result.reason, 'source-count-changed');
});

test('LITE-09-109: an unchanged source still applies, so the check is not over-strict', () => {
  const result = applyCompactionSummary(history, published(), { hardBudgetTokens: 10_000 });
  assert.equal(result.kind, 'applied');
  if (result.kind !== 'applied') return;
  assert.deepEqual(result.history.map(item => item.id), ['compaction:comp_1', 'm3', 'm4']);
});
