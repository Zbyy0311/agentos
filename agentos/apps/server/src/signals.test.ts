import test from 'node:test';
import assert from 'node:assert/strict';
import { getSignalExitCode } from './signals.js';

test('uses shell-compatible exit code 129 for SIGHUP', () => {
  assert.equal(getSignalExitCode('SIGHUP'), 129);
});
