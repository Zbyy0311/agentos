import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

type CoverageCheck = Readonly<{
  file: string;
  markers: readonly string[];
}>;

type CoverageEntry = Readonly<{
  area: string;
  checks: readonly CoverageCheck[];
}>;

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const EXISTING_COVERAGE: readonly CoverageEntry[] = [
  {
    area: 'Workspace SQLite Authority',
    checks: [
      {
        file: 'apps/server/src/store/SqliteStore.test.ts',
        markers: ['keeps existing SQLite CLI configuration authoritative over later JSON edits', 'removes all SQLite workspace data when the workspace is removed'],
      },
      {
        file: 'apps/server/src/store/__tests__/WorkspaceRepository.test.ts',
        markers: ['version conflict detected with concurrent update', 'deleteById removes workspace and agent profiles'],
      },
      {
        file: 'apps/server/src/store/__tests__/WorkspaceCompatibilityRepository.test.ts',
        markers: ['SQLite-only Workspace is preserved and never receives a synthetic source Attempt'],
      },
    ],
  },
  {
    area: 'Agent/Profile/Provider references and versions',
    checks: [
      {
        file: 'apps/server/src/store/SqliteStore.test.ts',
        markers: ['Workspace.agents projected fields match Provider Configuration after update', 'legacy Agent migration creates and binds a Provider Configuration'],
      },
      {
        file: 'apps/server/src/store/__tests__/ProviderConfigurationRepository.test.ts',
        markers: ['version conflict detected via assertVersionedMutation', 'requires expectedVersion for update and archive'],
      },
      {
        file: 'apps/server/src/routes/providerConfigs.test.ts',
        markers: ['provider routes enforce workspace isolation, versioned updates, and versioned archive'],
      },
    ],
  },
  {
    area: 'Task/Run aggregate isolation',
    checks: [
      {
        file: 'apps/server/src/routes/runs.test.ts',
        markers: ['Task-domain Runs remain isolated from Conversation agent_runs'],
      },
      {
        file: 'apps/server/src/services/TaskRunService.test.ts',
        markers: ['P3 compatibility rows never become canonical Task or Task-domain Run records', 'Legacy, Bridge and Recovery paths never create idempotency records'],
      },
    ],
  },
  {
    area: 'Snapshot/Stage immutability',
    checks: [
      {
        file: 'apps/server/src/store/RunSnapshotRepository.test.ts',
        markers: ['does not expose update/delete/upsert/backfill or find-all APIs', 'insert/read round-trip stores canonical JSON and the correct hash'],
      },
      {
        file: 'apps/server/src/store/RunStageRepository.test.ts',
        markers: ['does not expose lifecycle mutation APIs or access Conversation run_steps'],
      },
      {
        file: 'apps/server/src/migrations/__tests__/m2-5-workflow-snapshot-stage-schema.test.ts',
        markers: ['snapshot UPDATE is rejected by the trigger', 'deleting a Run cascades to Snapshot and Stages'],
      },
    ],
  },
  {
    area: 'Idempotency',
    checks: [
      {
        file: 'apps/server/src/services/TaskRunService.test.ts',
        markers: ['S02 same key and same request replays the same task id', 'S19 an idempotency insert failure rolls back the domain mutation in the same transaction'],
      },
      {
        file: 'apps/server/src/store/IdempotencyRepository.test.ts',
        markers: ['UPDATE is rejected by the immutability trigger', 'workspace cascade delete removes records'],
      },
      {
        file: 'apps/server/src/routes/v2Idempotency.test.ts',
        markers: ['a valid header returns the normalized key'],
      },
    ],
  },
  {
    area: 'Optimistic version and deterministic concurrency',
    checks: [
      {
        file: 'apps/server/src/store/Version.test.ts',
        markers: ['VersionConflictError has stable fields'],
      },
      {
        file: 'apps/server/src/store/__tests__/RunRepository.test.ts',
        markers: ['concurrent transitions produce exactly one winner'],
      },
      {
        file: 'apps/server/src/services/TaskRunService.test.ts',
        markers: ['P402 run.cancel with a stale expectedVersion throws VERSION_CONFLICT', 'P410 a matching mutation increments the version exactly once'],
      },
    ],
  },
  {
    area: 'Migration Registry 001–011',
    checks: [
      {
        file: 'apps/server/src/migrations/__tests__/integration.test.ts',
        markers: ['Fresh database applies the complete 001-012 registry exactly once', 'The complete 001-012 schema passes integrity and foreign-key checks'],
      },
      {
        file: 'apps/server/src/migrations/__tests__/migration.test.ts',
        markers: ['sorts by numeric ID', 'Closing and reopening a fully migrated database keeps 001-012 idempotent'],
      },
      {
        file: 'apps/server/src/migrations/__tests__/m2-5-workflow-snapshot-stage-schema.test.ts',
        markers: ['REG-03 migration records are exactly 001-012'],
      },
    ],
  },
  {
    area: 'Legacy Bridge boundary',
    checks: [
      {
        file: 'apps/server/src/routes/taskPipelineBridge.test.ts',
        markers: ['A first Bridge execution still creates one canonical initial Task and Run', 'Bridge-created Task and Runs are readable through the v2 GET APIs'],
      },
      {
        file: 'apps/server/src/services/TaskRunService.test.ts',
        markers: ['Legacy, Bridge and Recovery paths never create idempotency records', 'Bridge retry and failure stay isolated from P3 compatibility rows and Registry evidence'],
      },
      {
        file: 'apps/server/src/taskRecovery.test.ts',
        markers: ['startup recovery is workspace-scoped and returns precise evidence'],
      },
    ],
  },
] as const;

function readRepositoryFile(relativePath: string): string {
  return readFileSync(join(REPOSITORY_ROOT, relativePath), 'utf8');
}

test('P2 Existing Coverage Inventory maps every core acceptance area to executable evidence', () => {
  assert.equal(EXISTING_COVERAGE.length, 8);
  const areas = EXISTING_COVERAGE.map(entry => entry.area);
  assert.equal(new Set(areas).size, areas.length);
  for (const entry of EXISTING_COVERAGE) {
    assert.ok(entry.checks.length >= 2, entry.area);
    for (const check of entry.checks) {
      const source = readRepositoryFile(check.file);
      for (const marker of check.markers) {
        assert.ok(source.includes(marker), `${entry.area}: missing executable coverage marker ${check.file} :: ${marker}`);
      }
    }
  }
});

test('P2 status closure is reflected consistently and contains no stale review state', () => {
  const p1 = readRepositoryFile('docs/implementation/milestones/M2.8-p1-read-only-parity-inventory.md');
  const p2 = readRepositoryFile('docs/implementation/milestones/M2.8-p2-core-acceptance-verification.md');
  const plan = readRepositoryFile('docs/implementation/milestones/M2.8-verification-cutover-readiness-plan.md');
  assert.match(p1, /P1 VERIFIED — LOCAL GATES PASSED — INDEPENDENT REVIEW PASSED/);
  assert.match(p2, /P2 VERIFIED — CORE M2 ACCEPTANCE VERIFIED LOCALLY — INDEPENDENT REVIEW PASSED/);
  assert.match(plan, /P1: VERIFIED — LOCAL GATES PASSED — INDEPENDENT REVIEW PASSED/);
  assert.match(plan, /P2: VERIFIED — CORE M2 ACCEPTANCE VERIFIED LOCALLY — INDEPENDENT REVIEW PASSED/);
  for (const source of [p1, p2, plan]) {
    assert.doesNotMatch(source, /PENDING(?: FINAL)? INDEPENDENT(?: FINAL)? RE-?REVIEW|PENDING INDEPENDENT REVIEW/);
    assert.doesNotMatch(source, /P2:\s*NOT AUTHORIZED/i);
    assert.doesNotMatch(source, /P2 started:\s*NO/i);
  }
  assert.match(plan, /P3: NOT AUTHORIZED/);
  assert.match(plan, /Production Cutover: OUT OF SCOPE/);
  assert.match(plan, /P3 \| Migration and Restore Rehearsal/);
  assert.match(plan, /P4 \| Runtime and API Compatibility/);
});
