import assert from 'node:assert/strict';
import test from 'node:test';

import { handleComposerKeyDown, resolveComposerKeyAction, submitComposer } from './composerKeyboard.js';

test('LITE-12-014 Enter sends and restores composer focus', () => {
  const calls: string[] = [];
  let prevented = false;
  handleComposerKeyDown({
    key: 'Enter', shiftKey: false, isComposing: false,
    preventDefault: () => { prevented = true; },
  }, {
    canSend: true,
    onSend: () => calls.push('send'),
    focus: () => calls.push('focus'),
  });
  assert.deepEqual(calls, ['send', 'focus']);
  assert.equal(prevented, true);
});

test('LITE-12-014 Shift+Enter remains the native newline path', () => {
  const calls: string[] = [];
  let prevented = false;
  handleComposerKeyDown({
    key: 'Enter', shiftKey: true, isComposing: false,
    preventDefault: () => { prevented = true; },
  }, {
    canSend: true,
    onSend: () => calls.push('send'),
    focus: () => calls.push('focus'),
  });
  assert.equal(resolveComposerKeyAction({ key: 'Enter', shiftKey: true, canSend: true }), 'newline');
  assert.deepEqual(calls, []);
  assert.equal(prevented, false);
});

test('LITE-12-014 composing or empty Enter never dispatches a message', () => {
  const calls: string[] = [];
  submitComposer({ canSend: false, onSend: () => calls.push('send'), focus: () => calls.push('focus') });
  handleComposerKeyDown({
    key: 'Enter', shiftKey: false, isComposing: true,
    preventDefault: () => { calls.push('prevent'); },
  }, {
    canSend: true,
    onSend: () => calls.push('send'),
    focus: () => calls.push('focus'),
  });
  assert.deepEqual(calls, []);
});
