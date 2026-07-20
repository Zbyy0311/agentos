import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyUiError, getComposerValidationError, getSendButtonState } from './uiFeedback.ts';

test('classifies connection failures separately from execution failures', () => {
  assert.equal(classifyUiError(Object.assign(new Error('stream ended'), { name: 'UnexpectedStreamEndError' })), 'connection');
  assert.equal(classifyUiError(new Error('agent execution failed')), 'execution');
});

test('returns a field validation message only when the composer is empty', () => {
  assert.equal(getComposerValidationError('  ', 0), '请输入消息或添加图片');
  assert.equal(getComposerValidationError('', 1), '');
  assert.equal(getComposerValidationError('开始执行', 0), '');
});

test('keeps a queueable send button interactive while sending', () => {
  assert.deepEqual(getSendButtonState({ canSend: true, sending: true }), { disabled: false, showSpinner: true, ariaBusy: true, label: '加入队列' });
  assert.deepEqual(getSendButtonState({ canSend: false, sending: true }), { disabled: true, showSpinner: true, ariaBusy: true, label: '加入队列' });
});
