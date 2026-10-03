import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  captureCandidateProbeOverlayIdentity, createCandidateProbeCheckout,
  verifyCandidateReviewSequence, frozenCandidateContentHash,
  observeOwnedProviderProcesses, verifyCapturedRunnerOutcome,
  setupWorkspaceClone, parseAcceptanceArguments, verifyRuntimeDatabaseEvidence,
} from './verify-existing-project-acceptance.mjs';

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

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

test('project-sha is explicit when supplied, defaults only to expected-sha, and rejects malformed or repeated values', () => {
  const runtimeSha = 'a'.repeat(40);
  const projectSha = 'b'.repeat(40);
  const args = ['--mode', 'simulated-provider', '--expected-sha', runtimeSha];
  assert.equal(parseAcceptanceArguments(args).projectSha, runtimeSha);
  assert.equal(parseAcceptanceArguments([...args, '--project-sha', projectSha]).projectSha, projectSha);
  assert.throws(() => parseAcceptanceArguments([...args, '--project-sha', 'main']), /full commit SHA/u);
  assert.throws(() => parseAcceptanceArguments([...args, '--project-sha']), /requires a value/u);
  assert.throws(() => parseAcceptanceArguments([...args, '--project-sha', projectSha, '--project-sha', projectSha]),
    /repeated/u);
});

test('execution cannot bind a foreign repository snapshot while building the current runtime runner', () => {
  const root = mkdtempSync(join(tmpdir(), 'p4-foreign-runtime-root-'));
  try {
    const { sourceCommit } = realPlans(root);
    const runner = fileURLToPath(new URL('./verify-existing-project-acceptance.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [runner, '--mode', 'simulated-provider',
      '--expected-sha', sourceCommit, '--repository-root', root], {
      encoding: 'utf8', windowsHide: true, timeout: 15_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /execution --repository-root must be the runtime runner checkout/u);
  } finally { removeRealPlanFixture(root); }
});

test('real historical plans and isolated workspaces use project blobs while source HEAD, index and config stay at runtime', () => {
  const root = mkdtempSync(join(tmpdir(), 'p4-historical-workspace-'));
  const runRoot = mkdtempSync(join(tmpdir(), 'p4-historical-run-'));
  try {
    const { plans, sourceCommit } = realPlans(root);
    const sourcePath = plans[0].scope[0];
    const projectTree = git(root, ['rev-parse', `${sourceCommit}^{tree}`]);
    const projectProbe = readFileSync(join(root, plans[0].baselineProbe.sourcePath));
    git(root, ['rm', '--', sourcePath, plans[0].baselineProbe.sourcePath]);
    git(root, ['commit', '-q', '-m', 'runtime no longer has the historical source path']);
    git(root, ['config', 'core.longpaths', 'false']);
    const runtimeSha = git(root, ['rev-parse', 'HEAD']);
    const runtimeIndex = readFileSync(join(root, '.git', 'index'));
    const runtimeConfig = readFileSync(join(root, '.git', 'config'));
    const planBytes = JSON.stringify(plans);
    assert.equal(validateRealPlanPaths(plans, root, sourceCommit), plans);
    const workspace = setupWorkspaceClone(root, runRoot, 'defect', sourceCommit, 'real-windows-acceptance');
    assert.equal(workspace.sourceCommitSha, sourceCommit);
    assert.equal(workspace.baseCommit, sourceCommit);
    assert.equal(workspace.baseParentCommitSha, sourceCommit);
    assert.equal(workspace.baseTreeSha, projectTree);
    assert.equal(git(workspace.root, ['rev-parse', 'HEAD']), sourceCommit);
    assert.equal(readFileSync(join(workspace.root, sourcePath), 'utf8'), 'export {}\n');
    assert.deepEqual(readFileSync(join(workspace.root, plans[0].baselineProbe.sourcePath)), projectProbe);
    assert.equal(JSON.stringify(plans), planBytes);
    assert.equal(git(root, ['rev-parse', 'HEAD']), runtimeSha);
    assert.deepEqual(readFileSync(join(root, '.git', 'index')), runtimeIndex);
    assert.deepEqual(readFileSync(join(root, '.git', 'config')), runtimeConfig);
    assert.equal(git(root, ['config', '--get', 'core.longpaths']), 'false');
    assert.equal(git(root, ['status', '--porcelain=v1']), '');
    const wrongPlan = structuredClone(plans);
    wrongPlan[0].baselineProbe.sourceCommitSha = runtimeSha;
    assert.throws(() => validateRealPlanPaths(wrongPlan, root, sourceCommit), /sourceCommitSha must equal/u);
    const runtimeOnlyScope = structuredClone(plans);
    runtimeOnlyScope[0].scope = ['agentos/apps/server/src/not-in-project.ts'];
    assert.throws(() => validateRealPlanPaths(runtimeOnlyScope, root, sourceCommit), /existing frozen AgentOS source path/u);
  } finally { removeRealPlanFixture(runRoot); removeRealPlanFixture(root); }
});

test('runtime database verifier independently requires an explicit project commit/tree before trusting database evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'p4-database-project-binding-'));
  try {
    const { sourceCommit } = realPlans(root);
    const projectTree = git(root, ['rev-parse', `${sourceCommit}^{tree}`]);
    writeFileSync(join(root, 'agentos/apps/server/src/routes/collaborations.ts'), 'export const newRuntime = true;\n');
    git(root, ['add', '--', 'agentos']);
    git(root, ['commit', '-q', '-m', 'later runtime']);
    const runtimeSha = git(root, ['rev-parse', 'HEAD']);
    const receipt = { repository: { commitSha: runtimeSha, treeSha: git(root, ['rev-parse', 'HEAD^{tree}']) },
      projectRepository: { commitSha: sourceCommit, treeSha: projectTree } };
    assert.throws(() => verifyRuntimeDatabaseEvidence(root, receipt, { repositoryRoot: root }),
      /projectRepository commit\/tree do not match --project-sha/u);
    assert.throws(() => verifyRuntimeDatabaseEvidence(root, receipt, { repositoryRoot: root, projectSha: sourceCommit }),
      /runtime database evidence reference is required/u);
    receipt.projectRepository.treeSha = receipt.repository.treeSha;
    assert.throws(() => verifyRuntimeDatabaseEvidence(root, receipt, { repositoryRoot: root, projectSha: sourceCommit }),
      /projectRepository commit\/tree/u);
    delete receipt.projectRepository;
    assert.throws(() => verifyRuntimeDatabaseEvidence(root, receipt, { repositoryRoot: root, projectSha: sourceCommit }),
      /requires receipt.projectRepository/u);
    assert.throws(() => verifyRuntimeDatabaseEvidence(root, receipt, { repositoryRoot: root }),
      /runtime database evidence reference is required/u);
  } finally { removeRealPlanFixture(root); }
});

test('offline database checks bind persisted candidate bases and baseline artifacts to project rather than runtime SHA', () => {
  const root = mkdtempSync(join(tmpdir(), 'p4-project-database-records-'));
  try {
    const { sourceCommit, plans } = realPlans(root);
    const projectTree = git(root, ['rev-parse', `${sourceCommit}^{tree}`]);
    writeFileSync(join(root, 'agentos/apps/server/src/routes/collaborations.ts'), 'export const newRuntime = true;\n');
    git(root, ['add', '--', 'agentos']);
    git(root, ['commit', '-q', '-m', 'new runtime for historical project']);
    const runtimeSha = git(root, ['rev-parse', 'HEAD']);
    const runtimeTree = git(root, ['rev-parse', 'HEAD^{tree}']);
    const digest = bytes => createHash('sha256').update(bytes).digest('hex');
    const artifact = (artifactPath, value) => {
      const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
      writeFileSync(join(root, artifactPath), bytes);
      return { artifactPath, sha256: digest(bytes) };
    };
    const dbPath = join(root, 'database.sqlite');
    const db = new DatabaseSync(dbPath);
    const acceptanceCommands = ['node --test project.test.mjs'];
    const candidate = { id: 'candidate', canonical_run_id: 'run', round: 0, base_commit: sourceCommit,
      head_commit: sourceCommit, diff_text: 'project frozen patch\n', test_status: 'passed',
      test_command: acceptanceCommands[0], test_exit_code: 0, test_output: 'passed', status: 'applied',
      review_conclusion: 'approved', review_summary: 'review', created_at: '2026-10-03T00:00:00.000Z',
      manifest_json: '[]', snapshot_version: 1, manifest_version: 1 };
    candidate.diff_hash = digest(candidate.diff_text);
    candidate.content_hash = frozenCandidateContentHash(candidate);
    try {
      db.exec(`CREATE TABLE collaboration_tasks (
        id TEXT, workspace_id TEXT, status TEXT, planner_agent_id TEXT, implementer_agent_id TEXT,
        reviewer_agent_id TEXT, current_candidate_id TEXT, canonical_run_id TEXT, canonical_task_id TEXT,
        base_commit TEXT, applied_at TEXT, acceptance_commands_json TEXT, title TEXT, objective TEXT, scope_json TEXT);
        CREATE TABLE workspaces (id TEXT, root_path TEXT);
        CREATE TABLE collaboration_candidates (
        collaboration_task_id TEXT, workspace_id TEXT, id TEXT, canonical_run_id TEXT, round INTEGER,
        base_commit TEXT, head_commit TEXT, diff_hash TEXT, content_hash TEXT, diff_text TEXT,
        test_status TEXT, test_command TEXT, test_exit_code INTEGER, test_output TEXT, status TEXT,
        review_conclusion TEXT, review_summary TEXT, created_at TEXT, manifest_json TEXT,
        snapshot_version INTEGER, manifest_version INTEGER);`);
      db.prepare('INSERT INTO collaboration_tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        'task', 'workspace', 'applied', 'planner', 'implementer', 'reviewer', 'candidate', 'run', 'canonical-task',
        sourceCommit, '2026-10-03T00:00:00.000Z', JSON.stringify(acceptanceCommands), 'title', 'objective', '[]');
      db.prepare('INSERT INTO workspaces VALUES (?,?)').run('workspace', root);
      const fields = Object.keys(candidate);
      db.prepare(`INSERT INTO collaboration_candidates (collaboration_task_id,workspace_id,${fields.join(',')})
        VALUES (${Array(fields.length + 2).fill('?').join(',')})`).run('task', 'workspace', ...Object.values(candidate));
    } finally { db.close(); }
    const command = 'node --test project.test.mjs';
    const record = { command, cwd: root, expectedFailurePattern: 'project baseline failure',
      workspaceBaseCommit: sourceCommit, workspaceBaseTreeSha: projectTree, sourceCommitSha: sourceCommit,
      baseParentCommitSha: sourceCommit, rawExitCode: 1,
      stdout: artifact('baseline.stdout.txt', 'project baseline failure\n'), stderr: artifact('baseline.stderr.txt', '') };
    const baselineCommand = { command, artifact: artifact('baseline.json', record) };
    const scenario = { kind: 'defect', ids: { projectId: 'workspace', taskId: 'task', candidateId: 'candidate' },
      runtimeEvidence: { workspaceId: 'workspace', collaborationTaskId: 'task' },
      roles: { planner: 'planner', implementer: 'implementer', reviewer: 'reviewer' },
      acceptanceCommands, baselineCommands: [command], workspaceBaseCommit: sourceCommit, workspaceBaseTreeSha: projectTree,
      commands: [{ argv: acceptanceCommands, cwd: root }],
      baselineReproduction: { status: 'reproduced', baseCommit: sourceCommit, baseTreeSha: projectTree,
        sourceCommitSha: sourceCommit, baseParentCommitSha: sourceCommit, expectedFailurePattern: record.expectedFailurePattern,
        commands: [baselineCommand] } };
    const receipt = { mode: 'simulated-provider', repository: { commitSha: runtimeSha, treeSha: runtimeTree },
      projectRepository: { commitSha: sourceCommit, treeSha: projectTree }, scenarios: [scenario],
      runtimeEvidence: { database: { artifactPath: 'database.sqlite', sha256: digest(readFileSync(dbPath)) },
        serverPid: 1, port: 8080, readinessPath: '/api/runtime/ready',
        serverProcess: { pid: 1, stopped: true, exitCode: 0, signalCode: null } } };
    const options = { repositoryRoot: root, projectSha: sourceCommit };
    // Deliberately incomplete review evidence must fail only after the real DB base/baseline checks pass.
    assert.throws(() => verifyRuntimeDatabaseEvidence(root, receipt, options), /no such table: collaboration_reviews/u);
    receipt.mode = 'real-windows-acceptance';
    scenario.baselineProbe = plans[0].baselineProbe;
    Object.assign(scenario, { title: 'altered title', objective: 'objective', scope: [] });
    assert.throws(() => verifyRuntimeDatabaseEvidence(root, receipt, options), /real plan fields differ from the persisted project task/u);
    Object.assign(scenario, { title: 'title', scope: ['agentos/apps/server/src/other-project.ts'] });
    assert.throws(() => verifyRuntimeDatabaseEvidence(root, receipt, options), /real plan fields differ from the persisted project task/u);
    receipt.mode = 'simulated-provider';
    delete scenario.baselineProbe;
    scenario.baselineReproduction.sourceCommitSha = runtimeSha;
    assert.throws(() => verifyRuntimeDatabaseEvidence(root, receipt, options), /baseline failure evidence is incomplete/u);
    scenario.baselineReproduction.sourceCommitSha = sourceCommit;
    baselineCommand.artifact = artifact('baseline.json', { ...record, sourceCommitSha: runtimeSha });
    assert.throws(() => verifyRuntimeDatabaseEvidence(root, receipt, options), /baseline command is not bound to its frozen workspace/u);
    baselineCommand.artifact = artifact('baseline.json', record);
    scenario.workspaceBaseCommit = runtimeSha;
    assert.throws(() => verifyRuntimeDatabaseEvidence(root, receipt, options), /candidate base does not match the frozen workspace/u);
    scenario.workspaceBaseCommit = sourceCommit;
    git(root, ['checkout', '--detach', sourceCommit]);
    receipt.repository = { commitSha: sourceCommit, treeSha: projectTree };
    delete receipt.projectRepository;
    assert.throws(() => verifyRuntimeDatabaseEvidence(root, receipt, { repositoryRoot: root }),
      /no such table: collaboration_reviews/u);
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

test('candidate probe checkout includes deep tracked files without changing source configuration', () => {
  const temporaryRoot = process.platform === 'win32' ? realpathSync.native(tmpdir()) : tmpdir();
  const root = mkdtempSync(join(temporaryRoot, 'p4-deep-probe-'));
  const source = join(root, 'source');
  const target = join(root, 'candidate-probes', 'defect');
  const git = args => spawnSync('git', ['-C', source, '-c', 'core.longpaths=true', ...args], {
    encoding: 'utf8', windowsHide: true, shell: false,
  });
  try {
    mkdirSync(source);
    assert.equal(git(['init', '-q']).status, 0);
    assert.equal(git(['config', '--local', 'user.name', 'P4 deep probe']).status, 0);
    assert.equal(git(['config', '--local', 'user.email', 'p4-probe@example.invalid']).status, 0);
    assert.equal(git(['config', '--local', 'core.longpaths', 'false']).status, 0);
    assert.equal(git(['config', '--local', 'core.autocrlf', 'false']).status, 0);
    const pathSegments = ['agentos', 'docs', ...Array.from({ length: 8 }, (_, index) => `frozen-evidence-directory-${index}`), 'assertions.json'];
    const sourcePath = join(source, ...pathSegments);
    const targetPath = join(target, ...pathSegments);
    assert.ok(targetPath.length > 260);
    mkdirSync(join(source, ...pathSegments.slice(0, -1)), { recursive: true });
    const bytes = '{"receipt":"frozen deep file"}\n';
    writeFileSync(sourcePath, bytes);
    assert.equal(git(['add', '--all']).status, 0);
    assert.equal(git(['commit', '-m', 'deep tracked source', '-q']).status, 0);
    const baseCommit = git(['rev-parse', 'HEAD']).stdout.trim();
    const sourceConfig = readFileSync(join(source, '.git', 'config'));

    createCandidateProbeCheckout(source, target, baseCommit);

    assert.equal(readFileSync(targetPath, 'utf8'), bytes);
    const actualHead = spawnSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
    assert.equal(actualHead.status, 0, actualHead.stderr);
    assert.equal(actualHead.stdout.trim(), baseCommit);
    assert.deepEqual(readFileSync(join(source, '.git', 'config')), sourceConfig);
    if (process.platform === 'win32') {
      const targetConfig = spawnSync('git', ['-C', target, 'config', '--local', '--get', 'core.longpaths'], {
        encoding: 'utf8', windowsHide: true,
      });
      assert.equal(targetConfig.status, 0, targetConfig.stderr);
      assert.equal(targetConfig.stdout.trim(), 'true');
    }
  } finally { removeCandidateOverlayFixture(root); }
});

test('candidate probe overlay identity captures its exact root, frozen base tree, and staged overlay tree', () => {
  const temporaryRoot = process.platform === 'win32' ? realpathSync.native(tmpdir()) : tmpdir();
  const root = mkdtempSync(join(temporaryRoot, 'p4-candidate-overlay-'));
  const git = args => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  try {
    assert.equal(git(['init', '-q']).status, 0);
    assert.equal(git(['config', 'user.name', 'P4 overlay test']).status, 0);
    assert.equal(git(['config', 'user.email', 'p4-overlay@example.invalid']).status, 0);
    assert.equal(git(['config', 'gc.auto', '0']).status, 0);
    assert.equal(git(['config', 'maintenance.auto', 'false']).status, 0);
    mkdirSync(join(root, 'agentos', 'apps', 'server', 'src'), { recursive: true });
    const sourcePath = join(root, 'agentos', 'apps', 'server', 'src', 'probe-target.ts');
    writeFileSync(sourcePath, 'export const value = 1;\n');
    assert.equal(git(['add', '--all']).status, 0);
    assert.equal(git(['commit', '-m', 'candidate probe base', '-q']).status, 0);
    const baseCommit = git(['rev-parse', 'HEAD']).stdout.trim();
    const baseTreeSha = git(['rev-parse', 'HEAD^{tree}']).stdout.trim();
    writeFileSync(sourcePath, 'export const value = 2;\n');
    assert.equal(git(['add', '--all']).status, 0);
    const patchResult = git(['diff', '--binary', 'HEAD', '--', sourcePath]);
    assert.equal(patchResult.status, 0, patchResult.stderr);
    const diffText = Buffer.from(patchResult.stdout, 'utf8');
    const diffHash = createHash('sha256').update(diffText).digest('hex');
    const indexPath = join(root, git(['rev-parse', '--git-path', 'index']).stdout.trim());
    const originalWorktree = readFileSync(sourcePath);
    const stagedOverlayTreeSha = git(['write-tree']).stdout.trim();
    const originalIndex = readFileSync(indexPath);

    const identity = captureCandidateProbeOverlayIdentity(root, { baseTreeSha }, {
      baseCommit, diffText, diffHash,
    });
    assert.equal(identity.executionRoot, root);
    assert.equal(identity.workspaceBaseCommit, baseCommit);
    assert.equal(identity.workspaceBaseTreeSha, baseTreeSha);
    assert.match(identity.candidateOverlayTreeSha, /^[0-9a-f]{40}$/u);
    assert.notEqual(identity.candidateOverlayTreeSha, baseTreeSha);
    assert.equal(identity.candidateOverlayTreeSha, stagedOverlayTreeSha,
      'isolated-index replay must produce the tree represented by the frozen patch');
    assert.deepEqual(readFileSync(indexPath), originalIndex,
      'candidate identity capture must leave the checkout index unchanged');
    assert.deepEqual(readFileSync(sourcePath), originalWorktree,
      'candidate identity capture must leave the checkout worktree unchanged');
  } finally { removeCandidateOverlayFixture(root); }
});

function removeCandidateOverlayFixture(root) {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 32, retryDelay: 200 });
  } catch (error) {
    // Git for Windows can leave a transient reparse-point temp entry in .git;
    // follow the suite's existing Windows cleanup rule after bounded retries.
    if (process.platform !== 'win32' || error.code !== 'ENOTEMPTY') throw error;
  }
}
