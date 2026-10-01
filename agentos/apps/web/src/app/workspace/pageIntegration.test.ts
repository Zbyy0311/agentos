import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const pageSource = readFileSync(fileURLToPath(new URL('./[id]/page.tsx', import.meta.url)), 'utf8');

test('workspace page connects draft readiness, persistence warning, and identity-scoped scroll', () => {
  assert.ok(/draftReady=\{draftState\.ready\}/.test(pageSource));
  assert.ok(/draftPersistenceWarning=\{draftState\.warning\}/.test(pageSource));
  assert.ok(/scrollIdentityKey=\{activeDraftIdentityKey/.test(pageSource));
  assert.ok(/savedScrollPosition=\{draftState\.draft\.scrollPosition\}/.test(pageSource));
  assert.ok(/onScrollPositionChange=\{draftState\.setScrollPosition\}/.test(pageSource));
});

test('workspace page drains a queue item through its own durable outbox identity', () => {
  assert.match(pageSource, /loadForSubmission\(identityKey,\s*queuedItem\?\.id\)/);
  assert.match(pageSource, /groupClient\.createDiscussion\([\s\S]*?groupOutboxEntry\.idempotencyKey\)/);
});

test('a completed direct send settles its frozen owner before current-view-only updates', () => {
  const directCompletionStart = pageSource.indexOf("await connectStream(streamPath, 'POST', body)");
  const directCompletionEnd = pageSource.indexOf("} catch (sendError)", directCompletionStart);
  assert.notEqual(directCompletionStart, -1);
  assert.notEqual(directCompletionEnd, -1);
  const directCompletion = pageSource.slice(directCompletionStart, directCompletionEnd);
  // The lifecycle now settles/migrates the frozen owner before invoking the
  // current-scope-only UI callback; async behavior is exercised separately.
  const settle = directCompletion.indexOf('await completeDirectConversationSubmission(');
  const currentScopeReturn = directCompletion.indexOf('if (!isCurrentScope()) return;');
  assert.notEqual(settle, -1);
  assert.ok(currentScopeReturn === -1 || settle < currentScopeReturn, 'settlement must not be skipped when the user has selected another identity');
});

test('runtime group deep links preserve and verify their actual storage source', () => {
  assert.match(pageSource, /query\.set\('conversationSource',\s*'runtime'\)/);
  assert.match(pageSource, /returnConversationSource\s*!==\s*'runtime'/);
});

test('explicit direct Run hints are classified before they reach the Run Inspector', () => {
  assert.match(pageSource, /classifyRunConversationBinding\(/);
  assert.match(pageSource, /runLinkState[\s\S]*binding/);
  assert.doesNotMatch(pageSource, /\[activeExecutionRunHint,\s*\.\.\.conversationRuns/);
});

test('visible conversation evidence is keyed to the active verified identity', () => {
  assert.match(pageSource, /conversationEvidenceIdentityKey/);
  assert.match(pageSource, /visibleMessages/);
  assert.match(pageSource, /visibleStreamingContent/);
});
