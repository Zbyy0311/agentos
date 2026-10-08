import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const runEngine = readFileSync(new URL('./RunEngine.ts', import.meta.url), 'utf8');
const stageExecutor = readFileSync(new URL('./StageExecutor.ts', import.meta.url), 'utf8');
const coordinator = readFileSync(new URL('./StageExecutionCoordinator.ts', import.meta.url), 'utf8');
const dispatcher = readFileSync(new URL('./RunEngineProviderDispatcher.ts', import.meta.url), 'utf8');

describe('M4-P4 architecture-negative', () => {
  for (const [name, source] of Object.entries({ runEngine, stageExecutor, dispatcher })) {
    it(name + ' never spawns or executes natively (Process Runtime owns native processes)', () => {
      assert.doesNotMatch(source, /node:child_process|\bspawn\s*\(|\bexec(?:File)?\s*\(/);
    });
  }
  it('coordinator never imports node:child_process and delegates spawn to the injected driver', () => {
    assert.doesNotMatch(coordinator, /node:child_process|\bexec(?:File)?\s*\(/);
    assert.match(coordinator, /this\.driver\.spawn\(/);
  });
});