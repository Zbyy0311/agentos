import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteStore } from './SqliteStore.js';
import {
  M25_LEGACY_WORKFLOW_ID,
  M25_UNBOUND_WORKFLOW_ID,
} from '../migrations/migrations/007-workflow-definitions.js';

describe('SqliteStore M2.5 repository wiring', () => {
  it('exposes the three P2 repository accessors', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-p2-wiring-'));
    const store = new SqliteStore(root);
    try {
      assert.equal(typeof store.workflowDefinitionRepository, 'function');
      assert.equal(typeof store.runSnapshotRepository, 'function');
      assert.equal(typeof store.runStageRepository, 'function');
      const workflowRepository = store.workflowDefinitionRepository();
      const snapshotRepository = store.runSnapshotRepository();
      const stageRepository = store.runStageRepository();
      assert.strictEqual(workflowRepository, store.workflowDefinitionRepository());
      assert.strictEqual(snapshotRepository, store.runSnapshotRepository());
      assert.strictEqual(stageRepository, store.runStageRepository());
      assert.ok(workflowRepository.findById(M25_LEGACY_WORKFLOW_ID));
      assert.ok(workflowRepository.findById(M25_UNBOUND_WORKFLOW_ID));
      assert.equal(snapshotRepository.findByRunId('missing-workspace', 'missing-run'), undefined);
      assert.deepEqual(stageRepository.listByRun('missing-workspace', 'missing-run'), []);
      assert.strictEqual(store.taskRepository(), store.taskRepository());
      assert.strictEqual(store.runRepository(), store.runRepository());
    } finally {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
