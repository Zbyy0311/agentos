import assert from 'node:assert/strict';
import test from 'node:test';
import {
  handleComposerKeyDown,
  resolveComposerKeyAction,
  submitComposer,
} from './composerKeyboard.js';

test('LITE-12-014 Enter submits while Shift+Enter and IME composition stay local', () => {
  assert.equal(resolveComposerKeyAction({ key: 'Enter', shiftKey: false, canSend: true }), 'send');
  assert.equal(resolveComposerKeyAction({ key: 'Enter', shiftKey: true, canSend: true }), 'newline');
  assert.equal(resolveComposerKeyAction({ key: 'Enter', shiftKey: false, isComposing: true, canSend: true }), 'ignore');
  assert.equal(resolveComposerKeyAction({ key: 'Escape', shiftKey: false, canSend: true }), 'ignore');
});

test('LITE-12-014 keyboard submit prevents the browser newline and restores composer focus', () => {
  let sends = 0;
  let prevented = 0;
  let focused = 0;
  handleComposerKeyDown(
    { key: 'Enter', shiftKey: false, preventDefault: () => { prevented += 1; } },
    { canSend: true, onSend: () => { sends += 1; }, focus: () => { focused += 1; } },
  );
  assert.equal(sends, 1);
  assert.equal(prevented, 1);
  assert.equal(focused, 1);
});

test('LITE-12-014 disabled submit does not invoke the send callback', () => {
  let sends = 0;
  let focused = 0;
  submitComposer({ canSend: false, onSend: () => { sends += 1; }, focus: () => { focused += 1; } });
  assert.equal(sends, 0);
  assert.equal(focused, 0);
});
