import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  deriveCandidateProbeOverlayTreeSha, validateManifest, validateReceipt, verifyCandidateProbeExecutionBinding,
  verifyFinalCandidateScope, verifySourceSnapshot,
} from './validate-existing-project-acceptance.mjs';
import {
  OFFICIAL_CODEX_PROVIDER_KIND,
  OFFICIAL_CODEX_TRUST_BOUNDARY,
  SIMULATED_CODEX_PROVIDER_KIND,
} from './acceptance-provider-identity.mjs';

const manifestPath = new URL('./p4-existing-project-acceptance.manifest.json', import.meta.url);
const agentosRoot = fileURLToPath(new URL('../', import.meta.url));
const validatorPath = fileURLToPath(new URL('./validate-existing-project-acceptance.mjs', import.meta.url));
const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function git(root, args) {
  return execFileSync('git', ['-C', root, '-c', 'core.symlinks=false', ...args], { encoding: 'utf8' }).trim();
}

// Build a temporary committed checkout so the tests exercise actual HEAD/tree
// and Git blob verification instead of accepting a self-reported snapshot.
function fixture(mode = 'simulated-provider', options = {}) {
  const temporaryRoot = process.platform === 'win32' ? realpathSync.native(tmpdir()) : tmpdir();
  const root = mkdtempSync(resolve(temporaryRoot, 'agentos-p4-acceptance-'));
  const templateRoot = resolve(root, '.fixture-template');
  mkdirSync(templateRoot);
  const trackedSourceRoot = options.sourceLayout === 'agentos' ? 'agentos/apps' : 'apps';
  const trackedSourcePath = `${trackedSourceRoot}/server/src/tracked-build-input.ts`;
  mkdirSync(dirname(resolve(root, trackedSourcePath)), { recursive: true });
  writeFileSync(resolve(root, trackedSourcePath), 'export const trackedBuildInput = true;\n');
  const addArtifact = (artifactPath, bytes) => {
    const filePath = resolve(root, artifactPath);
    mkdirSync(dirname(filePath), { recursive: true });
    const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    writeFileSync(filePath, content);
    const ref = { artifactPath, sha256: hash(content) };
    return ref;
  };
  const scenarios = ['defect', 'feature'].map(kind => {
    const id = `${kind}-scenario`;
    const candidate = addArtifact(`candidates/${kind}-frozen.patch`, `frozen ${kind} candidate\n`);
    const directApproval = options.directApprovalKinds?.includes(kind) === true;
    const priorCandidate = directApproval
      ? undefined
      : addArtifact(`candidates/${kind}-prior.patch`, `prior ${kind} candidate\n`);
    const roles = {
      planner: `${kind}-planner`,
      implementer: `${kind}-implementer`,
      reviewer: `${kind}-reviewer`,
    };
    const requestedChanges = [`${kind}: address the review finding with a concrete change`];
    const changedPaths = [`src/${kind}-change.ts`];
    const acceptanceCommands = [`pnpm acceptance:existing-project --scenario ${kind}`];
    const baselineCommands = [`node --test agentos/apps/server/src/${kind}.baseline-probe.test.mjs`];
    const approvalId = `${kind}-approval`;
    const changesRequested = {
      id: `${kind}-review-request`,
      transition: 'changes-requested',
      actorRole: 'reviewer',
      actorId: roles.reviewer,
      timestamp: '2026-10-01T10:00:00.000Z',
      candidateSha256: priorCandidate?.sha256,
      requestedChanges,
    };
    const revision = {
      id: `${kind}-revision`,
      transition: 'revision-submitted',
      actorRole: 'implementer',
      actorId: roles.implementer,
      timestamp: '2026-10-01T10:05:00.000Z',
      fromCandidateSha256: priorCandidate?.sha256,
      toCandidateSha256: candidate.sha256,
      addressedReviewEventId: changesRequested.id,
      changedPaths,
    };
    const approval = {
      id: approvalId,
      transition: 'approved',
      actorRole: 'reviewer',
      actorId: roles.reviewer,
      timestamp: directApproval ? '2026-10-01T10:00:00.000Z' : '2026-10-01T10:10:00.000Z',
      candidateSha256: candidate.sha256,
      decision: 'approved',
    };
    const reviews = (directApproval ? [approval] : [
      changesRequested,
      revision,
      approval,
    ]).map(event => {
      const evidence = {
        schemaVersion: 1,
        kind: 'review-history-event',
        scenarioId: id,
        eventId: event.id,
        ...event,
      };
      const evidenceRef = addArtifact(`evidence/${kind}/${event.id}.json`, JSON.stringify(evidence));
      return { ...event, evidence: evidenceRef };
    });

    const commands = ['retest', 'preview', 'apply'].map((stage, stageIndex) => {
      const commandId = `${kind}-${stage}-command`;
      const argv = stage === 'retest' ? acceptanceCommands : ['agentos-acceptance', '--stage', stage, '--scenario', kind];
      const finishedAt = `2026-10-01T10:${String(21 + stageIndex).padStart(2, '0')}:00.000Z`;
      const stdout = addArtifact(`evidence/${kind}/${stage}.stdout.txt`,
        `${commandId} completed for frozen candidate ${candidate.sha256}\n`);
      const stderr = addArtifact(`evidence/${kind}/${stage}.stderr.txt`, '');
      const stageResult = stage === 'retest'
        ? { status: 'passed', testRunId: `${kind}-test-run`, commandCount: 1, rawExitCode: 0 }
        : stage === 'preview'
          ? { status: 'ready', previewId: `${kind}-preview`, candidateSha256: candidate.sha256 }
          : { status: 'applied', applicationId: `${kind}-application`, candidateSha256: candidate.sha256 };
      const record = {
        schemaVersion: 1,
        kind: 'acceptance-command',
        scenarioId: id,
        stage,
        commandId,
        argv,
        cwd: 'C:/fixture/agentos',
        rawExitCode: 0,
        expectedExitCode: 0,
        frozenCandidateSha256: candidate.sha256,
        stdout,
        stderr,
        stageResult,
        observedAt: finishedAt,
      };
      const artifact = addArtifact(`evidence/${kind}/${stage}.command.json`, JSON.stringify(record));
      return {
        id: commandId,
        stage,
        argv,
        cwd: record.cwd,
        rawExitCode: 0,
        expectedExitCode: 0,
        frozenCandidateSha256: candidate.sha256,
        artifact,
      };
    });

    return {
      id,
      kind,
      status: 'passed',
      ids: {
        projectId: `project-${kind}`,
        taskId: `task-${kind}`,
        runId: `run-${kind}`,
        candidateId: `candidate-${kind}`,
      },
      roles,
      baselineCommands,
      acceptanceCommands,
      frozenCandidate: candidate,
      ...(priorCandidate ? { priorCandidate } : {}),
      reviewHistory: reviews,
      commands,
    };
  });

  git(root, ['init', '--template', templateRoot, '-q']);
  git(root, ['config', 'user.email', 'acceptance-fixture@example.invalid']);
  git(root, ['config', 'user.name', 'Acceptance Fixture']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['add', 'candidates', trackedSourcePath]);
  git(root, ['commit', '-q', '-m', 'fixture evidence']);
  const commitSha = git(root, ['rev-parse', 'HEAD']);
  const treeSha = git(root, ['rev-parse', 'HEAD^{tree}']);
  for (const scenario of scenarios) {
    scenario.frozenCandidate.commitSha = commitSha;
    scenario.frozenCandidate.treeSha = treeSha;
    const expectedFailurePattern = scenario.kind === 'defect'
      ? 'baseline exposes the whitespace defect'
      : 'baseline lacks slug normalization';
    const stdout = addArtifact(`evidence/${scenario.kind}/baseline.stdout.txt`, `not ok 1 - ${expectedFailurePattern}\n`);
    const stderr = addArtifact(`evidence/${scenario.kind}/baseline.stderr.txt`, '');
    const command = scenario.baselineCommands[0];
    const commandId = `${scenario.kind}-baseline-command`;
    const baselineRecord = {
      schemaVersion: 1, kind: 'baseline-command', scenarioKind: scenario.kind, commandId, command,
      cwd: 'C:/fixture/agentos', rawExitCode: 1, expectedOutcome: 'nonzero-reproduction', expectedFailurePattern,
      workspaceBaseCommit: commitSha, workspaceBaseTreeSha: treeSha, sourceCommitSha: commitSha, baseParentCommitSha: commitSha,
      observedAt: '2026-10-01T10:00:00.000Z', stdout, stderr,
    };
    const baselineArtifact = addArtifact(`evidence/${scenario.kind}/baseline.command.json`, JSON.stringify(baselineRecord));
    scenario.baselineReproduction = {
      status: 'reproduced', expectedFailurePattern, baseCommit: commitSha, baseTreeSha: treeSha,
      sourceCommitSha: commitSha, baseParentCommitSha: commitSha,
      commands: [{ id: commandId, command, rawExitCode: 1, artifact: baselineArtifact }],
    };
  }

  const modeRequirements = manifest.modes[mode];
  const receipt = {
    schemaVersion: 2,
    manifestId: manifest.manifestId,
    mode,
    platform: modeRequirements.platform === 'any' ? process.platform : modeRequirements.platform,
    providerExecution: modeRequirements.providerExecution,
    credentialBoundary: modeRequirements.credentialBoundary,
    repository: {
      commitSha,
      treeSha,
      commitShaAtStart: commitSha,
      commitShaAtEnd: commitSha,
      treeShaAtStart: treeSha,
      treeShaAtEnd: treeSha,
    },
    model: {
      provider: mode === 'simulated-provider' ? 'fixture-provider' : 'operator-provider',
      id: mode === 'simulated-provider' ? 'synthetic-model-v1' : 'operator-model-v1',
    },
    providerEvidence: mode === 'simulated-provider'
      ? { kind: SIMULATED_CODEX_PROVIDER_KIND }
      : { kind: OFFICIAL_CODEX_PROVIDER_KIND, trustBoundary: OFFICIAL_CODEX_TRUST_BOUNDARY },
    processExitCode: 0,
    acceptanceExitCode: 0,
    scenarios,
  };
  return { root, receipt, addArtifact, commitSha, treeSha };
}

function withFixture(run, mode, options) {
  const item = fixture(mode, options);
  try { return run(item); }
  finally {
    rmSync(item.root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

function validate(item) {
  return validateReceipt(manifest, item.receipt, {
    repositoryRoot: item.root,
    expectedSha: item.commitSha,
  });
}

test('offline candidate probe independently derives overlay tree and rejects matching forged tree claims', () => withFixture(item => {
  const sourcePath = 'agentos/apps/server/src/tracked-build-input.ts';
  const sourceFile = resolve(item.root, sourcePath);
  const frozenBytes = readFileSync(sourceFile);
  const indexPath = resolve(item.root, git(item.root, ['rev-parse', '--git-path', 'index']));
  const frozenIndex = readFileSync(indexPath);
  writeFileSync(sourceFile, 'export const trackedBuildInput = false;\n');
  const candidateBytes = readFileSync(sourceFile);
  const patch = Buffer.from(execFileSync('git', ['-C', item.root, 'diff', '--binary', '--', sourcePath]));
  const scenario = {
    kind: 'defect',
    workspaceBaseCommit: item.commitSha,
    workspaceBaseTreeSha: item.treeSha,
    baselineReproduction: {
      sourceCommitSha: item.commitSha,
      baseParentCommitSha: item.commitSha,
      baseCommit: item.commitSha,
      baseTreeSha: item.treeSha,
      excludedGitlinkPaths: [],
    },
    candidateProbe: {
      executionRoot: realpathSync(item.root),
      workspaceBaseCommit: item.commitSha,
      workspaceBaseTreeSha: item.treeSha,
    },
  };
  const derivedTreeSha = deriveCandidateProbeOverlayTreeSha(item.root, scenario, patch);
  scenario.candidateProbe.candidateOverlayTreeSha = derivedTreeSha;
  const record = {
    executionRoot: realpathSync(item.root), cwd: realpathSync(item.root),
    workspaceBaseCommit: item.commitSha,
    workspaceBaseTreeSha: item.treeSha,
    candidateOverlayTreeSha: derivedTreeSha,
  };
  assert.match(derivedTreeSha, /^[0-9a-f]{40}$/u);
  assert.doesNotThrow(() => verifyCandidateProbeExecutionBinding(scenario, record, item.root, patch));
  assert.throws(() => verifyCandidateProbeExecutionBinding(scenario, {
    ...record, cwd: resolve(item.root, '..', 'wrong-root'),
  }, item.root, patch), /execution root differs from its captured cwd/u);
  assert.throws(() => verifyCandidateProbeExecutionBinding(scenario, {
    ...record, candidateOverlayTreeSha: 'e'.repeat(40),
  }, item.root, patch), /overlay tree differs from its captured execution/u);
  assert.throws(() => deriveCandidateProbeOverlayTreeSha(item.root, scenario, Buffer.alloc(0)), /empty patch/u);

  const forgedTreeSha = 'f'.repeat(40);
  scenario.candidateProbe.candidateOverlayTreeSha = forgedTreeSha;
  record.candidateOverlayTreeSha = forgedTreeSha;
  assert.throws(() => verifyCandidateProbeExecutionBinding(scenario, record, item.root, patch),
    /independently derived frozen candidate/u);
  assert.deepEqual(readFileSync(sourceFile), candidateBytes,
    'overlay verification must not alter the candidate checkout worktree');
  assert.deepEqual(readFileSync(indexPath), frozenIndex,
    'overlay verification must never rewrite the source checkout index');
  writeFileSync(sourceFile, frozenBytes);
  assert.deepEqual(readFileSync(sourceFile), frozenBytes,
    'test fixture restores its source file after deriving the candidate overlay');
}, 'simulated-provider', { sourceLayout: 'agentos' }));

test('offline final candidate scope rejects empty and out-of-scope patches and accepts an in-scope patch', () => withFixture(item => {
  const changedPath = 'agentos/apps/server/src/tracked-build-input.ts';
  const allowedPath = 'agentos/apps/server/src/allowed.ts';
  const allowedAbsolute = resolve(item.root, allowedPath);
  mkdirSync(dirname(allowedAbsolute), { recursive: true });
  writeFileSync(allowedAbsolute, 'export const allowed = true;\n');
  git(item.root, ['add', '--', allowedPath]);
  git(item.root, ['-c', 'user.name=Acceptance Fixture', '-c', 'user.email=acceptance-fixture@example.invalid',
    'commit', '-q', '-m', 'add independent allowed scope anchor']);

  writeFileSync(resolve(item.root, changedPath), 'export const trackedBuildInput = false;\n');
  const patch = execFileSync('git', ['-C', item.root, 'diff', '--binary', '--', changedPath], { encoding: 'utf8' });
  assert.deepEqual(verifyFinalCandidateScope(item.root, [changedPath], Buffer.from(patch)), [changedPath]);
  assert.throws(() => verifyFinalCandidateScope(item.root, [changedPath], Buffer.alloc(0)),
    /nonempty unique changed-path set/u);
  assert.throws(() => verifyFinalCandidateScope(item.root, [changedPath], Buffer.from(`${patch}\n${patch}`)),
    /final candidate patch/u);
  assert.throws(() => verifyFinalCandidateScope(item.root, [allowedPath], Buffer.from(patch)),
    /outside the frozen plan scope/u);
  assert.throws(() => verifyFinalCandidateScope(item.root,
    ['agentos/apps/server/src/../allowed.ts'], Buffer.from(patch)), /safe repository-relative/u);
}, 'simulated-provider', { sourceLayout: 'agentos' }));

test('offline overlay derivation handles a Gitlink-filtered base absent from the frozen source object store', () => withFixture(item => {
  const gitlinkPath = '.claude/worktrees/p4-offline-fixture';
  const gitlinkObject = '1'.repeat(40);
  git(item.root, ['update-index', '--add', '--cacheinfo', `160000,${gitlinkObject},${gitlinkPath}`]);
  git(item.root, ['-c', 'user.name=Acceptance Fixture', '-c', 'user.email=acceptance-fixture@example.invalid',
    'commit', '-q', '-m', 'fixture frozen source with worktree Gitlink']);
  const sourceCommitSha = git(item.root, ['rev-parse', 'HEAD']);

  const temporaryRoot = process.platform === 'win32' ? realpathSync.native(tmpdir()) : tmpdir();
  const indexRoot = mkdtempSync(resolve(temporaryRoot, 'p4-gitlink-base-index-'));
  const indexPath = resolve(indexRoot, 'index');
  const runIsolatedGit = args => {
    const result = spawnSync('git', ['-C', item.root, ...args], {
      env: { ...process.env, GIT_INDEX_FILE: indexPath, GIT_NO_REPLACE_OBJECTS: '1' },
      encoding: 'utf8', windowsHide: true, timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  let workspaceBaseTreeSha;
  try {
    runIsolatedGit(['read-tree', sourceCommitSha]);
    runIsolatedGit(['update-index', '--force-remove', '--', gitlinkPath]);
    workspaceBaseTreeSha = runIsolatedGit(['write-tree']);
  } finally {
    rmSync(indexRoot, { recursive: true, force: true, maxRetries: 32, retryDelay: 200 });
  }

  const sourcePath = 'agentos/apps/server/src/tracked-build-input.ts';
  writeFileSync(resolve(item.root, sourcePath), 'export const trackedBuildInput = false;\n');
  const patch = Buffer.from(execFileSync('git', ['-C', item.root, 'diff', '--binary', '--', sourcePath]));
  const syntheticWorkspaceBaseCommit = 'f'.repeat(40);
  const scenario = {
    kind: 'defect',
    workspaceBaseCommit: syntheticWorkspaceBaseCommit,
    workspaceBaseTreeSha,
    baselineReproduction: {
      sourceCommitSha,
      baseParentCommitSha: sourceCommitSha,
      baseCommit: syntheticWorkspaceBaseCommit,
      baseTreeSha: workspaceBaseTreeSha,
      excludedGitlinkPaths: [gitlinkPath],
    },
  };
  const treeSha = deriveCandidateProbeOverlayTreeSha(item.root, scenario, patch);
  assert.match(treeSha, /^[0-9a-f]{40}$/u);
  assert.notEqual(treeSha, workspaceBaseTreeSha);
}, 'simulated-provider', { sourceLayout: 'agentos' }));

test('fully structured defect and feature evidence is reported as structural verification only', () => withFixture(item => {
  const result = validate(item);
  assert.equal(result.structuralStatus, 'structurally-verified');
  assert.equal(result.status, 'structurally-verified');
  assert.equal(result.acceptanceStatus, 'runtime-database-verification-required');
  assert.equal(result.runtimeEvidenceStatus, 'not-checked');
  assert.deepEqual(result.scenarioKinds, ['defect', 'feature']);
  assert.match(result.verificationBoundary, /run the local verifier for runtime acceptance/);
}));

test('simulated-provider evidence cannot claim a captured real plan or source-bound probe', () => withFixture(item => {
  item.receipt.realPlanEvidence = { kind: 'real-plan', sha256: 'a'.repeat(64), artifact: { sha256: 'a'.repeat(64) } };
  assert.throws(() => validate(item), /simulated-provider receipts cannot claim real plan/u);
  delete item.receipt.realPlanEvidence;
  item.receipt.scenarios[0].baselineProbe = {};
  assert.throws(() => validate(item), /simulated-provider scenarios cannot claim real source-probe evidence/u);
}));

test('accepts one directly approved candidate and one complete rework history with committed approval evidence', () => withFixture(item => {
  const directScenario = item.receipt.scenarios.find(scenario => scenario.kind === 'defect');
  assert.equal(directScenario.reviewHistory.length, 1);
  assert.equal(directScenario.reviewHistory[0].transition, 'approved');
  assert.equal(Object.hasOwn(directScenario, 'priorCandidate'), false);
  const result = validate(item);
  assert.equal(result.structuralStatus, 'structurally-verified');
}, 'simulated-provider', { directApprovalKinds: ['defect'] }));

test('rejects a group where both scenarios only have direct approvals', () => withFixture(item => {
  assert.throws(() => validate(item), /at least 1 scenario with the complete three-step rework history/);
}, 'simulated-provider', { directApprovalKinds: ['defect', 'feature'] }));

test('rejects direct approval evidence whose candidate hash was forged and rehashed', () => withFixture(item => {
  const approval = item.receipt.scenarios.find(scenario => scenario.kind === 'defect').reviewHistory[0];
  const evidencePath = resolve(item.root, approval.evidence.artifactPath);
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  evidence.candidateSha256 = 'f'.repeat(64);
  const bytes = Buffer.from(JSON.stringify(evidence));
  writeFileSync(evidencePath, bytes);
  approval.evidence.sha256 = hash(bytes);
  assert.throws(() => validate(item), /approval evidence is inconsistent/);
}, 'simulated-provider', { directApprovalKinds: ['defect'] }));

test('source snapshot handles both package-root layouts, ignores exact generated outputs, and rejects ignored source inputs', () => {
  for (const sourceLayout of ['apps', 'agentos']) withFixture(item => {
    const prefix = sourceLayout === 'agentos' ? 'agentos/' : '';
    const generatedFiles = [
      `${prefix}apps/server/dist/index.js`,
      `${prefix}packages/agent-core/dist/index.js`,
      `${prefix}packages/process-runtime/dist/index.js`,
      `${prefix}packages/shared/dist/index.js`,
      `${prefix}packages/agent-core/.agentos/logs/diagnostics/executor.log`,
      `${prefix}apps/web/next-env.d.ts`,
      `${prefix}apps/web/tsconfig.tsbuildinfo`,
      `${prefix}apps/web/.next-p4-preview-test/cache.bin`,
      `${prefix}apps/web/test-results/results.json`,
    ];
    for (const path of generatedFiles) {
      const absolutePath = resolve(item.root, path);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, 'generated');
    }
    // The fixture commits a source file under the selected layout. Passing
    // proves git ls-files results are compared using that layout's root paths.
    assert.doesNotThrow(() => verifySourceSnapshot(item.root));

    const hiddenIgnoredSource = resolve(item.root, `${prefix}apps/server/src/.hidden/ignored-untracked.ts`);
    const arbitraryDistSource = resolve(item.root, `${prefix}apps/server/src/dist/ignored-untracked.ts`);
    const arbitraryLogsSource = resolve(item.root, `${prefix}apps/web/logs/ignored-untracked.ts`);
    for (const sourcePath of [hiddenIgnoredSource, arbitraryDistSource, arbitraryLogsSource]) {
      mkdirSync(dirname(sourcePath), { recursive: true });
    }
    mkdirSync(resolve(item.root, '.git', 'info'), { recursive: true });
    writeFileSync(resolve(item.root, '.git', 'info', 'exclude'), [
      `${prefix}apps/server/src/.hidden/ignored-untracked.ts`,
      `${prefix}apps/server/src/dist/ignored-untracked.ts`,
      `${prefix}apps/web/logs/ignored-untracked.ts`,
      '',
    ].join('\n'));
    for (const sourcePath of [hiddenIgnoredSource, arbitraryDistSource, arbitraryLogsSource]) {
      writeFileSync(sourcePath, 'export const injectedBuildInput = true;\n');
    }
    const sourcePrefix = `${prefix}apps/server/src/`.replaceAll('/', '\\/');
    assert.throws(() => verifySourceSnapshot(item.root), new RegExp(sourcePrefix));

    rmSync(hiddenIgnoredSource);
    assert.throws(() => verifySourceSnapshot(item.root), new RegExp(
      `${prefix}apps/server/src/dist/ignored-untracked\\.ts`.replaceAll('/', '\\/'),
    ));

    rmSync(arbitraryDistSource);
    assert.throws(() => verifySourceSnapshot(item.root), new RegExp(
      `${prefix}apps/web/logs/ignored-untracked\\.ts`.replaceAll('/', '\\/'),
    ));
  }, 'simulated-provider', { sourceLayout });
});

test('requires both scenario kinds; arbitrary labels and duplicate kinds cannot satisfy the contract', () => withFixture(item => {
  item.receipt.scenarios[1].kind = 'some-success-label';
  assert.throws(() => validate(item), /scenario kind must be exactly one of/);
}));

test('requires distinct per-scenario task, run, and candidate identities', () => withFixture(item => {
  item.receipt.scenarios[1].ids.taskId = item.receipt.scenarios[0].ids.taskId;
  assert.throws(() => validate(item), /taskId must be unique across scenarios/);
}));

test('baseline probes are separately declared and their artifacts cannot be relabeled after execution', () => withFixture(item => {
  const scenario = item.receipt.scenarios[0];
  assert.notDeepEqual(scenario.baselineCommands, scenario.acceptanceCommands);
  scenario.baselineCommands[0] = 'node -e "console.log(0)"';
  assert.throws(() => validate(item), /baseline command identity or exit code is incomplete/);
}));

test('a zero-exit output containing the expected marker is not a reproduced baseline failure', () => withFixture(item => {
  const scenario = item.receipt.scenarios[0];
  const command = scenario.baselineReproduction.commands[0];
  command.rawExitCode = 0;
  const artifactPath = resolve(item.root, command.artifact.artifactPath);
  const record = JSON.parse(readFileSync(artifactPath, 'utf8'));
  record.rawExitCode = 0;
  const bytes = Buffer.from(JSON.stringify(record));
  writeFileSync(artifactPath, bytes);
  command.artifact.sha256 = hash(bytes);
  assert.throws(() => validate(item), /must capture its expected baseline failure with a nonzero exit/);
}));

test('rejects a self-reported commit/tree that does not match the actual frozen checkout', () => withFixture(item => {
  assert.throws(() => validateReceipt(manifest, item.receipt, {
    repositoryRoot: item.root,
    expectedSha: '0'.repeat(40),
  }), /does not match --expected-sha/);

  item.receipt.repository.treeSha = '0'.repeat(40);
  item.receipt.repository.treeShaAtStart = '0'.repeat(40);
  item.receipt.repository.treeShaAtEnd = '0'.repeat(40);
  assert.throws(() => validate(item), /do not match the actual frozen Git checkout/);
}));

test('rejects candidate and receipt hashes changed together after the frozen Git commit', () => withFixture(item => {
  const candidate = item.receipt.scenarios[0].frozenCandidate;
  const changed = Buffer.from('attacker rewrote candidate and recomputed the receipt hash\n');
  writeFileSync(resolve(item.root, candidate.artifactPath), changed);
  candidate.sha256 = hash(changed);
  assert.throws(() => validate(item), /tracked checkout files differ from the frozen Git tree/);
}));

test('a successful exit code and one passing label cannot replace review history or command artifacts', () => withFixture(item => {
  item.receipt.scenarios = [{
    id: 'arbitrary-label',
    kind: 'defect',
    status: 'passed',
    ids: { projectId: 'p', taskId: 't', runId: 'r', candidateId: 'c' },
    roles: { planner: 'p1', implementer: 'i1', reviewer: 'r1' },
    commands: [{ id: 'all-green', rawExitCode: 0, expectedExitCode: 0 }],
  }];
  assert.equal(item.receipt.processExitCode, 0);
  assert.equal(item.receipt.acceptanceExitCode, 0);
  assert.throws(() => validate(item), /exactly one defect and one feature scenario/);
}));

test('requires concrete change request, implementation revision, and approval for the frozen hash', () => withFixture(item => {
  const scenario = item.receipt.scenarios[0];
  scenario.reviewHistory[0].requestedChanges = ['looks good'];
  assert.throws(() => validate(item), /change-request evidence is inconsistent/);
}));

test('review request, revision, and approval must have separate event identities', () => withFixture(item => {
  const scenario = item.receipt.scenarios[0];
  scenario.reviewHistory[2].id = scenario.reviewHistory[0].id;
  assert.throws(() => validate(item), /review history event ids must be present and unique/);
}));

test('requires a retest, preview, and apply command bound to the same frozen candidate', () => withFixture(item => {
  const scenario = item.receipt.scenarios[0];
  scenario.commands[2].frozenCandidateSha256 = 'f'.repeat(64);
  assert.throws(() => validate(item), /not bound to the final frozen candidate hash/);
}));

test('rejects evidence artifacts altered after their receipt hash was recorded', () => withFixture(item => {
  const command = item.receipt.scenarios[0].commands[0];
  writeFileSync(resolve(item.root, command.artifact.artifactPath), '{"rawExitCode":0}');
  assert.throws(() => validate(item), /command artifact SHA-256 does not match its bytes/);
}));

test('real Windows acceptance is blocked in CI even when the receipt claims success', () => withFixture(item => {
  const originalCI = process.env.CI;
  item.receipt.mode = 'real-windows-acceptance';
  item.receipt.platform = 'win32';
  item.receipt.providerExecution = 'real';
  item.receipt.credentialBoundary = 'operator-managed-outside-ci';
  item.receipt.model.provider = 'codex';
  item.receipt.providerEvidence = {
    kind: OFFICIAL_CODEX_PROVIDER_KIND,
    trustBoundary: OFFICIAL_CODEX_TRUST_BOUNDARY,
  };
  try {
    process.env.CI = 'true';
    assert.throws(() => validate(item), /cannot be captured or validated inside CI/);
  } finally {
    if (originalCI === undefined) delete process.env.CI;
    else process.env.CI = originalCI;
  }
}, 'real-windows-acceptance'));

test('manifest-only CLI check describes structural and runtime verification separately', () => {
  const result = spawnSync(process.execPath, [validatorPath, '--check-manifest'], {
    cwd: agentosRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /structuralStatus=structurally-verified/);
  assert.match(result.stdout, /runtime evidence is checked by the local verifier/);
});

test('receipt CLI exits successfully for structure and does not claim runtime acceptance', () => withFixture(item => {
  const receiptPath = resolve(item.root, 'receipt.json');
  writeFileSync(receiptPath, JSON.stringify(item.receipt));
  const result = spawnSync(process.execPath, [
    validatorPath,
    '--receipt', receiptPath,
    '--expected-sha', item.commitSha,
    '--repository-root', item.root,
  ], { cwd: agentosRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"status": "structurally-verified"/);
  assert.match(result.stdout, /"acceptanceStatus": "runtime-database-verification-required"/);
}));

test('receipt CLI rejects omitted receipts and expected SHA instead of inferring success', () => {
  const missingReceipt = spawnSync(process.execPath, [validatorPath], { cwd: agentosRoot, encoding: 'utf8' });
  assert.equal(missingReceipt.status, 1);
  assert.match(missingReceipt.stderr, /ACCEPTANCE_RECEIPT_MISSING/);

  const missingSha = spawnSync(process.execPath, [validatorPath, '--receipt', 'receipt.json'], {
    cwd: agentosRoot,
    encoding: 'utf8',
  });
  assert.equal(missingSha.status, 1);
  assert.match(missingSha.stderr, /EXPECTED_SHA_MISSING/);
});
