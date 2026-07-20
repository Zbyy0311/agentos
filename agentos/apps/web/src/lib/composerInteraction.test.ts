import test from 'node:test';
import assert from 'node:assert/strict';
import { getComposerSendIntent, preserveDraftAfterSendFailure } from './composerInteraction.ts';

test('queues non-empty input while an execution is active', () => {
  assert.equal(getComposerSendIntent({ sending: true, content: '补充说明', hasAttachments: false }), 'queue');
});

test('sends input immediately when no execution is active', () => {
  assert.equal(getComposerSendIntent({ sending: false, content: '开始任务', hasAttachments: false }), 'send');
});

test('keeps an input typed during execution when the active run is interrupted', () => {
  assert.equal(preserveDraftAfterSendFailure('新的补充指示', '原始任务'), '新的补充指示');
  assert.equal(preserveDraftAfterSendFailure('', '原始任务'), '原始任务');
});
