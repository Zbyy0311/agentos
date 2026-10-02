import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  changedPathsFromPatch, createSimulationExecutable, selectOwnedPendingApprovals,
  simulationPlan, validateRealPlanPaths,
} from './verify-existing-project-acceptance.mjs';

function realPlans(root) {
  const source = join(root, 'agentos', 'apps', 'server', 'src', 'routes', 'collaborations.ts');
  mkdirSync(join(root, 'agentos', 'apps', 'server', 'src', 'routes'), { recursive: true });
  writeFileSync(source, 'export {}\n');
  return ['defect', 'feature'].map(kind => ({
    ...simulationPlan(kind),
    scope: ['agentos/apps/server/src/routes/collaborations.ts'],
    acceptanceCommands: ['node --test agentos/apps/server/src/routes/collaborations.test.ts'],
  }));
}

test('real plan accepts existing AgentOS production paths with exact repository-relative scopes', () => {
  const root = mkdtempSync(join(tmpdir(), 'p4-real-plan-'));
  try {
    const plans = realPlans(root);
    assert.equal(validateRealPlanPaths(plans, root), plans);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real plan rejects deterministic fixture paths and commands even when receipts can be hashed', () => {
  const root = mkdtempSync(join(tmpdir(), 'p4-real-plan-'));
  try {
    const plans = realPlans(root);
    plans[0].scope = ['agentos/scripts/fixtures/p4-existing-project-acceptance/defect.mjs'];
    plans[0].acceptanceCommands = ['node --test agentos/scripts/fixtures/p4-existing-project-acceptance/defect.test.mjs'];
    assert.throws(() => validateRealPlanPaths(plans, root), /actual AgentOS application\/package files/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real plan rejects traversal and a wholly nonexistent source scope', () => {
  const root = mkdtempSync(join(tmpdir(), 'p4-real-plan-'));
  try {
    const plans = realPlans(root);
    plans[1].scope = ['agentos/apps/server/src/../../../../outside.ts'];
    assert.throws(() => validateRealPlanPaths(plans, root), /safe repository-relative paths/u);
    plans[1].scope = ['agentos/apps/server/src/new-feature.ts'];
    assert.throws(() => validateRealPlanPaths(plans, root), /at least one existing frozen AgentOS source path/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('deterministic provider executable satisfies the production Codex version and structured-output probes', () => {
  const root = mkdtempSync(join(tmpdir(), 'p4-provider-fixture-'));
  try {
    const statePath = join(root, 'state.json');
    writeFileSync(statePath, JSON.stringify({ defect: { implementations: 0, reviews: 0 }, feature: { implementations: 0, reviews: 0 } }));
    const executable = createSimulationExecutable(root, statePath);
    const version = spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 10_000 });
    const help = spawnSync(executable, ['exec', '--help'], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 10_000 });
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /codex\s+\d+\.\d+\.\d+/u);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /exec.*--json/isu);
    const execution = spawnSync(executable, [
      'exec', '--json', '--skip-git-repo-check', '--model', 'fixture-v1',
      'P4_ACCEPTANCE_SIM_ROLE=planner\nP4_ACCEPTANCE_SCENARIO=defect',
    ], { cwd: root, encoding: 'utf8', windowsHide: true, shell: false, timeout: 10_000 });
    assert.equal(execution.status, 0, execution.stderr);
    assert.match(execution.stdout, /"type":"item\.completed"/u);
    assert.match(execution.stdout, /Bounded plan/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('one-time provider approval is restricted to the exact isolated Run, implementer, Codex executable, and worktree', () => {
  const root = mkdtempSync(join(tmpdir(), 'p4-approval-ownership-'));
  try {
    const worktreeRoot = join(root, 'runtime-worktrees');
    const cwd = join(worktreeRoot, 'lease-123');
    const executable = join(root, 'codex.exe');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(executable, 'fixture executable');
    const context = { workspaceId: 'ws-owned', runId: 'run-owned', implementerAgentId: 'agent-implementer', executable, worktreeRoot };
    const request = {
      id: 'approval-owned', workspaceId: context.workspaceId, runId: context.runId, status: 'pending',
      version: 2, category: 'command', riskLevel: 'high', title: 'Approve provider stage execution',
      requestSnapshotJson: JSON.stringify({
        schemaVersion: 1, workspaceId: context.workspaceId, runId: context.runId,
        agent: { agentId: context.implementerAgentId },
        provider: { adapterId: 'builtin.codex' },
        launch: { executable, cwd },
      }),
    };
    const unrelated = { ...request, id: 'approval-other-run', runId: 'run-other' };
    assert.deepEqual(selectOwnedPendingApprovals([unrelated, request], context), [request]);
    assert.throws(() => selectOwnedPendingApprovals([{
      ...request,
      requestSnapshotJson: JSON.stringify({
        schemaVersion: 1, workspaceId: context.workspaceId, runId: context.runId,
        agent: { agentId: 'agent-reviewer' }, provider: { adapterId: 'builtin.codex' }, launch: { executable, cwd },
      }),
    }], context), /exact isolated acceptance workspace, Run, and implementer/u);
    assert.throws(() => selectOwnedPendingApprovals([{
      ...request,
      requestSnapshotJson: JSON.stringify({
        schemaVersion: 1, workspaceId: context.workspaceId, runId: context.runId,
        agent: { agentId: context.implementerAgentId }, provider: { adapterId: 'builtin.codex' },
        launch: { executable, cwd: root },
      }),
    }], context), /outside the isolated AgentOS worktree root/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('revision changed paths come from the frozen Git patch bytes rather than the untracked-only manifest', () => {
  const patch = [
    'diff --git a/agentos/apps/server/src/health.ts b/agentos/apps/server/src/health.ts',
    'index 1111111..2222222 100644',
    '--- a/agentos/apps/server/src/health.ts',
    '+++ b/agentos/apps/server/src/health.ts',
    '@@ -1 +1 @@',
    '-export const healthy = false;',
    '+export const healthy = true;',
    '',
  ].join('\n');
  assert.deepEqual(changedPathsFromPatch(patch), ['agentos/apps/server/src/health.ts']);
  assert.throws(() => changedPathsFromPatch(''), /does not identify a unique changed-path set/u);
});
