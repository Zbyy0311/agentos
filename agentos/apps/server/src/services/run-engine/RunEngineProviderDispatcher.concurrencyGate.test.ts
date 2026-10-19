import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  RunEngineProviderDispatcher,
  type RunConcurrencyGate,
  type RunEngineProviderDispatcherOptions,
} from './RunEngineProviderDispatcher.js';

/**
 * §8.4 gate unit coverage: the concurrency gate runs before the workspace
 * admission gate; a denial keeps the Run queued (noop result + observable
 * defer report) and never reaches the engine/admission layers.
 */
function buildDispatcher(gate: RunConcurrencyGate | undefined, deferred: unknown[]): RunEngineProviderDispatcher {
  const options = {
    engine: { tick: () => ({ outcome: 'noop', reason: 'unreachable' }) },
    coordinator: {},
    admissionGate: {
      authorizeCanonicalRun: async () => {
        throw new Error('admission gate must not be reached when the concurrency gate denies');
      },
    },
    concurrencyGate: gate,
    onConcurrencyDeferred: (report: unknown) => deferred.push(report),
    runRepository: { findById: () => undefined },
    runStageRepository: { listByRun: () => [] },
    runSnapshotRepository: { findByRunId: () => undefined },
    operationService: { listByRun: () => [] },
    lifecycleTransactionService: {},
    workspaceRootFor: () => '/tmp',
  } as unknown as RunEngineProviderDispatcherOptions;
  return new RunEngineProviderDispatcher(options);
}

describe('RunEngineProviderDispatcher §8.4 concurrency gate', () => {
  it('denied gate: noop reason names the dimension, defer report is emitted, run stays queued', async () => {
    const deferred: unknown[] = [];
    const gate: RunConcurrencyGate = {
      authorizeRun: () => ({ allowed: false, dimension: 'global', current: 4, limit: 4, reason: 'global concurrency limit reached (4/4)' }),
    };
    const dispatcher = buildDispatcher(gate, deferred);
    const result = await dispatcher.drive('ws_1', 'run_1');
    assert.deepEqual(result, { outcome: 'noop', reason: 'concurrency-limited:global' });
    assert.equal(deferred.length, 1);
    assert.deepEqual(deferred[0], {
      workspaceId: 'ws_1',
      runId: 'run_1',
      dimension: 'global',
      current: 4,
      limit: 4,
      reason: 'global concurrency limit reached (4/4)',
    });
  });

  it('allowed gate: flow continues to the admission gate', async () => {
    const deferred: unknown[] = [];
    let admissionCalls = 0;
    const dispatcher = new RunEngineProviderDispatcher({
      engine: { tick: () => ({ outcome: 'noop', reason: 'run-not-queued' }) },
      coordinator: {},
      admissionGate: {
        authorizeCanonicalRun: async () => {
          admissionCalls += 1;
          return { authorized: false, reason: 'ADMISSION_NOT_GRANTED' };
        },
      },
      concurrencyGate: { authorizeRun: async () => ({ allowed: true }) },
      onConcurrencyDeferred: (report: unknown) => deferred.push(report),
      runRepository: { findById: () => ({ status: 'queued' }) },
      runStageRepository: { listByRun: () => [] },
      runSnapshotRepository: { findByRunId: () => undefined },
      operationService: { listByRun: () => [] },
      lifecycleTransactionService: {},
      workspaceRootFor: () => '/tmp',
    } as unknown as RunEngineProviderDispatcherOptions);
    const result = await dispatcher.drive('ws_1', 'run_1');
    assert.equal(admissionCalls, 1);
    assert.equal(deferred.length, 0);
    assert.deepEqual(result, { outcome: 'noop', reason: 'WORKSPACE_ADMISSION_NOT_GRANTED' });
  });

  it('absent gate preserves the legacy dispatch path', async () => {
    const deferred: unknown[] = [];
    let admissionCalls = 0;
    const dispatcher = new RunEngineProviderDispatcher({
      engine: { tick: () => ({ outcome: 'noop', reason: 'run-not-queued' }) },
      coordinator: {},
      admissionGate: {
        authorizeCanonicalRun: async () => {
          admissionCalls += 1;
          return { authorized: false, reason: 'ADMISSION_NOT_GRANTED' };
        },
      },
      onConcurrencyDeferred: (report: unknown) => deferred.push(report),
      runRepository: { findById: () => ({ status: 'queued' }) },
      runStageRepository: { listByRun: () => [] },
      runSnapshotRepository: { findByRunId: () => undefined },
      operationService: { listByRun: () => [] },
      lifecycleTransactionService: {},
      workspaceRootFor: () => '/tmp',
    } as unknown as RunEngineProviderDispatcherOptions);
    const result = await dispatcher.drive('ws_1', 'run_1');
    assert.equal(admissionCalls, 1);
    assert.equal(deferred.length, 0);
    assert.deepEqual(result, { outcome: 'noop', reason: 'WORKSPACE_ADMISSION_NOT_GRANTED' });
  });
});
