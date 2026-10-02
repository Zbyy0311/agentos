import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  acceptanceCodexArguments, acceptanceWaitBudget, changedPathsFromPatch, createSimulationExecutable, loadOwnedFrozenCandidates, selectOwnedPendingApprovals,
  simulationPlan, validatePlan, validateRealPlanPaths, verifyFrozenCandidatePreview,
  verifyCandidateReviewSequence, frozenCandidateContentHash,
  observeOwnedProviderProcesses, verifyCapturedRunnerOutcome,
} from './verify-existing-project-acceptance.mjs';

test('captured exit binds the receipt actually passed for verification', () => {
  const root = mkdtempSync(join(tmpdir(), 'p4-external-exit-'));
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  try {
    const receiptPath = join(root, 'receipt.json');
    const alternativePath = join(root, 'alternative.json');
    writeFileSync(receiptPath, '{"commit":"original"}');
    writeFileSync(alternativePath, '{"commit":"modified"}');
    const logs = {};
    for (const stream of ['stdout', 'stderr']) {
      const artifactPath = `runner-${stream}.log`;
      writeFileSync(join(root, artifactPath), stream);
      logs[stream] = { artifactPath, sha256: sha256(stream) };
    }
    writeFileSync(join(root, 'runner-outcome.json'), JSON.stringify({
      schemaVersion: 1, source: 'parent-child-process-close', commitSha: 'a'.repeat(40),
      result: { exitCode: 0, signal: null, spawnError: null },
      receiptSha256: sha256('{"commit":"original"}'), logs,
    }));
    assert.doesNotThrow(() => verifyCapturedRunnerOutcome(root, receiptPath, 'a'.repeat(40)));
    assert.throws(() => verifyCapturedRunnerOutcome(root, alternativePath, 'a'.repeat(40)), /exact receipt bytes/u);
    writeFileSync(join(root, 'runner-stdout.log'), 'changed');
    assert.throws(() => verifyCapturedRunnerOutcome(root, receiptPath, 'a'.repeat(40)), /output hash changed/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native observation ignores exited reused PIDs and never certifies a mismatched live birth', { skip: process.platform !== 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'p4-native-observation-'));
  const databasePath = join(root, 'runtime.sqlite');
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`CREATE TABLE runtime_processes (id TEXT, workspace_id TEXT, run_id TEXT, process_type TEXT,
      provider_session_id TEXT, native_pid INTEGER, native_birth_identity TEXT, executable_resolved TEXT, status TEXT)`);
    const insert = db.prepare('INSERT INTO runtime_processes VALUES (?,?,?,?,?,?,?,?,?)');
    insert.run('exited', 'owned', 'run', 'provider', 'session-exited', 10, 'win32:filetime:10', 'codex.exe', 'exited');
    insert.run('matching', 'owned', 'run', 'provider', 'session-matching', 11, 'win32:filetime:11', 'codex.exe', 'running');
    insert.run('race', 'owned', 'run', 'provider', 'session-race', 12, 'win32:filetime:12', 'codex.exe', 'running');
    insert.run('other-workspace', 'other', 'run', 'provider', 'session-other', 13, 'win32:filetime:13', 'codex.exe', 'running');
    const probed = [];
    const server = { databasePath, nativeVerifier: { async verify(pid) {
      probed.push(pid);
      return { kind: 'alive', identity: { nativeBirthIdentity: `win32:filetime:${pid === 12 ? 99 : pid}` } };
    } } };
    await observeOwnedProviderProcesses(server, 'owned', 'run', root, 'defect');
    assert.deepEqual(probed, [11, 12]);
    assert.deepEqual([...server.nativeObservations.keys()], ['matching']);
    assert.equal(server.nativeObservations.get('matching').nativeBirthIdentity, 'win32:filetime:11');
    assert.equal(server.nativeObservations.has('race'), false);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('an independent direct approval is preserved without inventing a revision', () => {
  const candidate = { id: 'candidate-1', round: 0, diffHash: 'a'.repeat(64), canonicalRunId: 'run-1' };
  const review = { candidateId: candidate.id, reviewerAgentId: 'reviewer', conclusion: 'approved', candidateDiffHash: candidate.diffHash };
  assert.equal(verifyCandidateReviewSequence([candidate], [review], 'reviewer').reworked, false);
  assert.throws(() => verifyCandidateReviewSequence([candidate], [{ ...review, reviewerAgentId: 'implementer' }], 'reviewer'), /assigned reviewer/u);
  assert.throws(() => verifyCandidateReviewSequence([candidate], [{ ...review, candidateDiffHash: 'b'.repeat(64) }], 'reviewer'), /review hash/u);
  assert.throws(() => verifyCandidateReviewSequence([candidate], [{ ...review, conclusion: 'changes_requested' }], 'reviewer'), /approval sequence/u);
});

test('review rework must change candidate bytes and create a linked new Run', () => {
  const candidates = [{ id: 'candidate-0', round: 0, diffHash: 'a'.repeat(64), canonicalRunId: 'run-0' },
    { id: 'candidate-1', round: 1, diffHash: 'b'.repeat(64), canonicalRunId: 'run-1' }];
  const reviews = candidates.map((candidate, index) => ({ candidateId: candidate.id, reviewerAgentId: 'reviewer',
    conclusion: index ? 'approved' : 'changes_requested', candidateDiffHash: candidate.diffHash }));
  assert.equal(verifyCandidateReviewSequence(candidates, reviews, 'reviewer').reworked, true);
  assert.throws(() => verifyCandidateReviewSequence([candidates[0], { ...candidates[1], canonicalRunId: 'run-0' }], reviews, 'reviewer'), /linked new Run/u);
});

test('frozen candidate digest independently binds binary classification and sizes', () => {
  const candidate = { manifest_json: JSON.stringify([{ path: 'file', sizeBytes: 5, sha256: 'b'.repeat(64), binary: true }]),
    snapshot_version: 2, manifest_version: 2, diff_hash: 'a'.repeat(64) };
  const digest = frozenCandidateContentHash(candidate);
  assert.notEqual(frozenCandidateContentHash({ ...candidate, manifest_json: candidate.manifest_json.replace('true', 'false') }), digest);
  assert.notEqual(frozenCandidateContentHash({ ...candidate, diff_hash: 'c'.repeat(64) }), digest);
});

test('real multistage acceptance has a bounded total and a separate durable-progress timeout', () => {
  assert.deepEqual(acceptanceWaitBudget('real-windows-acceptance'), { totalMs: 3_600_000, idleMs: 600_000 });
  assert.deepEqual(acceptanceWaitBudget('simulated-provider'), { totalMs: 240_000, idleMs: 120_000 });
  assert.throws(() => acceptanceWaitBudget('unknown'), /unsupported acceptance mode/u);
});

test('real acceptance grants workspace writes only to the implementer role', () => {
  assert.deepEqual(acceptanceCodexArguments('simulated-provider', ['read', 'write']), ['exec']);
  for (const permissions of [['read'], ['read', 'review']]) {
    assert.deepEqual(acceptanceCodexArguments('real-windows-acceptance', permissions),
      ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only']);
  }
  assert.deepEqual(acceptanceCodexArguments('real-windows-acceptance', ['read', 'write']),
    ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'workspace-write']);
  assert.throws(() => acceptanceCodexArguments('unknown', ['write']), /unsupported/u);
});

test('terminal candidate capture reads exact owned bytes while the HTTP response remains a summary', () => {
  const root = mkdtempSync(join(tmpdir(), 'p4-candidate-capture-'));
  const path = join(root, 'runtime.sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE collaboration_candidates (
      id TEXT, workspace_id TEXT, collaboration_task_id TEXT, canonical_run_id TEXT, round INTEGER,
      base_commit TEXT, head_commit TEXT, diff_hash TEXT, content_hash TEXT, diff_text TEXT,
      test_status TEXT, test_command TEXT, test_exit_code INTEGER, test_output TEXT, created_at TEXT)`);
    const patch = 'frozen patch bytes\n';
    const diffHash = createHash('sha256').update(patch).digest('hex');
    const summary = { id: 'candidate-owned', round: 1, diffHash, contentHash: 'b'.repeat(64), testStatus: 'passed', testExitCode: 0 };
    const insert = db.prepare('INSERT INTO collaboration_candidates VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    insert.run(summary.id, 'ws-owned', 'task-owned', 'run-owned', 1,
      'a'.repeat(40), 'c'.repeat(40), diffHash, summary.contentHash, patch, 'passed', 'node --test', 0, 'tests passed', '2026-10-03T00:00:00.000Z');
    insert.run('candidate-other', 'ws-other', 'task-owned', 'run-other', 0,
      'd'.repeat(40), 'e'.repeat(40), diffHash, summary.contentHash, 'other evidence', 'passed', 'node --test', 0, 'other output', '2026-10-03T00:00:00.000Z');
    const captured = loadOwnedFrozenCandidates(path, 'ws-owned', 'task-owned', [summary]);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].diffText, patch);
    assert.equal(captured[0].testOutput, 'tests passed');
    assert.equal(captured[0].canonicalRunId, 'run-owned');
    assert.throws(() => loadOwnedFrozenCandidates(path, 'ws-owned', 'task-other', [summary]), /inventory/u);
    assert.throws(() => loadOwnedFrozenCandidates(path, 'ws-owned', 'task-owned', [{ ...summary, contentHash: 'f'.repeat(64) }]), /identity/u);
    db.prepare('UPDATE collaboration_candidates SET diff_text=? WHERE id=?').run('tampered', summary.id);
    assert.throws(() => loadOwnedFrozenCandidates(path, 'ws-owned', 'task-owned', [summary]), /candidate bytes/u);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('each acceptance scenario requires explicit baseline probes and candidate acceptance commands', () => {
  const plan = { scenarios: ['defect', 'feature'].map(simulationPlan) };
  assert.equal(validatePlan(plan).length, 2);
  delete plan.scenarios[1].baselineCommands;
  assert.throws(() => validatePlan(plan), /feature baseline commands are required/u);
});

test('flattened P2 preview response binds the exact workspace, candidate, base, content hash, and patch hash', () => {
  const preview = {
    workspaceId: 'workspace-1', collaborationTaskId: 'task-1', candidateId: 'candidate-1',
    baseCommit: 'a'.repeat(40), contentHash: 'b'.repeat(64), diffHash: 'c'.repeat(64),
  };
  assert.deepEqual(verifyFrozenCandidatePreview(preview, preview), {
    candidateId: 'candidate-1', candidateBaseCommit: 'a'.repeat(40),
    candidateContentHash: 'b'.repeat(64), candidateDiffHash: 'c'.repeat(64),
  });
  assert.throws(() => verifyFrozenCandidatePreview({ candidate: preview }, preview), /exact frozen candidate identity/u);
  assert.throws(() => verifyFrozenCandidatePreview({ ...preview, contentHash: 'd'.repeat(64) }, preview), /exact frozen candidate identity/u);
});

function realPlans(root) {
  const source = join(root, 'agentos', 'apps', 'server', 'src', 'routes', 'collaborations.ts');
  mkdirSync(join(root, 'agentos', 'apps', 'server', 'src', 'routes'), { recursive: true });
  writeFileSync(source, 'export {}\n');
  const fixtureRoot = join(root, 'agentos', 'scripts', 'fixtures', 'p4-memory-source-probes');
  mkdirSync(fixtureRoot, { recursive: true });
  for (const kind of ['defect', 'feature']) {
    const fixtureSource = fileURLToPath(new URL(`./fixtures/p4-memory-source-probes/${kind}-baseline.mjs`, import.meta.url));
    writeFileSync(join(fixtureRoot, `${kind}-baseline.mjs`), readFileSync(fixtureSource));
  }
  const runGit = args => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, shell: false });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  runGit(['init', '-q']);
  runGit(['config', 'user.name', 'P4 plan binding test']);
  runGit(['config', 'user.email', 'p4-plan-binding@example.invalid']);
  runGit(['config', 'core.autocrlf', 'false']);
  runGit(['add', '--', 'agentos']);
  runGit(['commit', '-q', '-m', 'tracked probe sources']);
  const sourceCommit = runGit(['rev-parse', 'HEAD']);
  const plans = ['defect', 'feature'].map(kind => {
    const sourcePath = `agentos/scripts/fixtures/p4-memory-source-probes/${kind}-baseline.mjs`;
    const sourceBytes = readFileSync(join(root, sourcePath));
    const argv = ['node', '--test', sourcePath];
    const argvSha256 = createHash('sha256').update(JSON.stringify(argv)).digest('hex');
    const command = argv.join(' ');
    const fixtureName = kind === 'defect' ? 'defect' : 'feature';
    const baselineProbe = {
      sourcePath,
      sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
      sourceBlobSha: runGit(['rev-parse', `${sourceCommit}:${sourcePath}`]),
      sourceCommitSha: sourceCommit,
      argv,
      argvSha256,
      command,
      argvFileBindings: [],
      passMarker: kind === 'defect'
        ? 'P4_MEMORY_PROBE_PASS:constructor-term'
        : 'P4_MEMORY_PROBE_PASS:language-terms',
    };
    const agentTest = `node --test agentos/apps/server/src/${kind}.test.mjs`;
    const expectedBaselineFailure = kind === 'defect'
      ? 'LEXICAL_CONSTRUCTOR_TERM_MUST_REMAIN_TEXT'
      : 'LEXICAL_LANGUAGE_TERMS_MUST_REMAIN_DISTINCT';
    return {
    ...simulationPlan(kind),
    scope: ['agentos/apps/server/src/routes/collaborations.ts'],
    expectedBaselineFailure,
    baselineProbe,
    baselineCommands: [command],
    acceptanceCommands: [command, agentTest],
    title: `P4 ${fixtureName} source probe plan`,
  };
  });
  return { plans, sourceCommit };
}

function removeRealPlanFixture(root) {
  try { rmSync(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }); }
  catch (error) {
    if (process.platform !== 'win32' || error.code !== 'ENOTEMPTY') throw error;
  }
}

test('real plan accepts existing AgentOS production paths with exact repository-relative scopes', () => {
  const root = mkdtempSync(join(tmpdir(), 'p4-real-plan-'));
  try {
    const { plans, sourceCommit } = realPlans(root);
    assert.equal(validateRealPlanPaths(plans, root, sourceCommit), plans);
  } finally { removeRealPlanFixture(root); }
});

test('real plan rejects an arbitrary throw command as baseline instead of the bound assertion probe', () => {
  const root = mkdtempSync(join(tmpdir(), 'p4-real-plan-'));
  try {
    const { plans, sourceCommit } = realPlans(root);
    plans[0].baselineCommands = ['node --input-type=module -e "throw new Error(\'LEXICAL_CONSTRUCTOR_TERM_MUST_REMAIN_TEXT\')"'];
    assert.throws(() => validateRealPlanPaths(plans, root, sourceCommit), /exact baselineProbe command must occur once/u);
  } finally { removeRealPlanFixture(root); }
});

test('real plans may append candidate acceptance tests while retaining the exact probe in both command lists', () => {
  const root = mkdtempSync(join(tmpdir(), 'p4-real-plan-'));
  try {
    const { plans, sourceCommit } = realPlans(root);
    assert.equal(validateRealPlanPaths(plans, root, sourceCommit), plans);
    assert.equal(plans[0].acceptanceCommands[0], plans[0].baselineCommands[0]);
    assert.equal(plans[0].acceptanceCommands.length, 2);
  } finally { removeRealPlanFixture(root); }
});

test('real plan rejects deterministic fixture paths and commands even when receipts can be hashed', () => {
  const root = mkdtempSync(join(tmpdir(), 'p4-real-plan-'));
  try {
    const { plans, sourceCommit } = realPlans(root);
    plans[0].scope = ['agentos/scripts/fixtures/p4-existing-project-acceptance/defect.mjs'];
    plans[0].acceptanceCommands = ['node --test agentos/scripts/fixtures/p4-existing-project-acceptance/defect.test.mjs'];
    assert.throws(() => validateRealPlanPaths(plans, root, sourceCommit), /actual AgentOS application\/package files/u);
  } finally { removeRealPlanFixture(root); }
});

test('real plan rejects traversal and a wholly nonexistent source scope', () => {
  const root = mkdtempSync(join(tmpdir(), 'p4-real-plan-'));
  try {
    const { plans, sourceCommit } = realPlans(root);
    plans[1].scope = ['agentos/apps/server/src/../../../../outside.ts'];
    assert.throws(() => validateRealPlanPaths(plans, root, sourceCommit), /safe repository-relative paths/u);
    plans[1].scope = ['agentos/apps/server/src/new-feature.ts'];
    assert.throws(() => validateRealPlanPaths(plans, root, sourceCommit), /at least one existing frozen AgentOS source path/u);
  } finally { removeRealPlanFixture(root); }
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
