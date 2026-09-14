import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildRunInspectorUrl } from './RunInspectorPanel.js';

test('LITE-13-101 Run Inspector uses the forward runtime route', () => {
  assert.equal(
    buildRunInspectorUrl('http://127.0.0.1:38471', 'browser fixture', 'run/one'),
    'http://127.0.0.1:38471/api/workspaces/browser%20fixture/runtime/runs/run%2Fone/inspector',
  );
});
