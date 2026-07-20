import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyToolRisk } from './ToolRiskClassifier.js';

test('classifies destructive commands as critical', () => assert.equal(classifyToolRisk({ toolName: 'shell', commandSummary: 'rm -rf build' }), 'critical'));
test('classifies writes as high and reads as low', () => {
  assert.equal(classifyToolRisk({ toolName: 'edit_file', affectedPaths: ['src/app.ts'] }), 'high');
  assert.equal(classifyToolRisk({ toolName: 'read_file', affectedPaths: ['src/app.ts'] }), 'low');
});
