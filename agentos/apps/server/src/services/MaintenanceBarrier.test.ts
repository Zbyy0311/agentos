import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MaintenanceBarrier } from './MaintenanceBarrier.js';

test('maintenance barrier rejects later writes and dispatcher starts and waits for earlier owners', async () => {
  const barrier = new MaintenanceBarrier();
  const releaseWrite = barrier.enterMutation();
  const releaseDispatch = barrier.enterDispatcherStart();
  assert.ok(releaseWrite);
  assert.ok(releaseDispatch);
  assert.equal(barrier.begin(), true);
  assert.equal(barrier.enterMutation(), undefined);
  assert.equal(barrier.enterDispatcherStart(), undefined);

  let activity = { counts: { canonicalRuns: 1 } };
  const wait = barrier.waitForDrain(() => activity, 1_000, 5);
  releaseWrite();
  releaseDispatch();
  activity = { counts: { canonicalRuns: 0 } };
  const drained = await wait;
  assert.deepEqual(drained, {
    activeMutatingRequests: 0,
    activeDispatcherStarts: 0,
    activity: { counts: { canonicalRuns: 0 } },
  });
  barrier.end();
  assert.ok(barrier.enterMutation());
});

test('unknown owner state never drains', async () => {
  const barrier = new MaintenanceBarrier();
  barrier.begin();
  const result = await barrier.waitForDrain(() => ({ counts: {}, unknown: true }), 10, 2);
  assert.equal(result.activity.unknown, true);
});

test('production entry installs write fence before routes and guards canonical, collaboration and recovery dispatch', () => {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  const fence = source.indexOf('app.use(createMaintenanceWriteBarrier(maintenanceBarrier))');
  const firstApiWriteRoute = source.indexOf("app.use('/api', createRunLifecycleRoutes");
  assert.ok(fence >= 0 && firstApiWriteRoute > fence, 'the global mutation fence must precede production API route mounts');
  const handlerTracking = source.indexOf('installMaintenanceRequestDrain(app)');
  const lastMiddleware = source.indexOf('app.use(createProblemErrorHandler())');
  const listen = source.indexOf("phase = 'listen'");
  assert.ok(handlerTracking > lastMiddleware && handlerTracking < listen, 'all production router handlers must be tracked before accepting requests');
  assert.match(source, /dispatchRun:\s*async\s*\([^)]*\)\s*=>\s*\{\s*await withDispatchPermit\(\(\) => providerExecutionChain\.dispatcher\.driveSafely/u);
  assert.match(source, /runtimeDispatch:\s*\{\s*enabled: runtimeDispatchEnabled,\s*drive: async\s*\([^)]*\)\s*=>\s*\{\s*await withDispatchPermit\(\(\) => providerExecutionChain\.dispatcher\.driveSafely/u);
  assert.match(source, /if \(!input\.runtimeDispatchEnabled \|\| input\.barrier\.snapshot\.quiescing\) return;[\s\S]*?await input\.withDispatchPermit\(async \(\) => \{\s*await input\.collaborationService\.resumeGrantedQueuedRuns/u);
  assert.match(source, /resumeBackgroundQueueWorkers = resumeQueueWorkers/u);
  assert.match(source, /if \(runtimeDispatchEnabled && !maintenanceBarrier\.snapshot\.quiescing\) \{\s*void withDispatchPermit\(async \(\) => \{\s*await collaborationService\.resumeGrantedQueuedRuns/u);
});
