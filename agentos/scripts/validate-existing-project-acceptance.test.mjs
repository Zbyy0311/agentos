import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateManifest, validateReceipt } from './validate-existing-project-acceptance.mjs';

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
function fixture(mode = 'simulated-provider') {
  const temporaryRoot = process.platform === 'win32' ? realpathSync.native(tmpdir()) : tmpdir();
  const root = mkdtempSync(resolve(temporaryRoot, 'agentos-p4-acceptance-'));
  const templateRoot = resolve(root, '.fixture-template');
  mkdirSync(templateRoot);
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
    const priorCandidate = addArtifact(`candidates/${kind}-prior.patch`, `prior ${kind} candidate\n`);
    const roles = {
      planner: `${kind}-planner`,
      implementer: `${kind}-implementer`,
      reviewer: `${kind}-reviewer`,
    };
    const requestedChanges = [`${kind}: address the review finding with a concrete change`];
    const changedPaths = [`src/${kind}-change.ts`];
    const acceptanceCommands = [`pnpm acceptance:existing-project --scenario ${kind}`];
    const baselineCommands = [`node --test agentos/apps/server/src/${kind}.baseline-probe.test.mjs`];
    const requestId = `${kind}-review-request`;
    const revisionId = `${kind}-revision`;
    const approvalId = `${kind}-approval`;
    const reviews = [
      {
        id: requestId,
        transition: 'changes-requested',
        actorRole: 'reviewer',
        actorId: roles.reviewer,
        timestamp: '2026-10-01T10:00:00.000Z',
        candidateSha256: priorCandidate.sha256,
        requestedChanges,
      },
      {
        id: revisionId,
        transition: 'revision-submitted',
        actorRole: 'implementer',
        actorId: roles.implementer,
        timestamp: '2026-10-01T10:05:00.000Z',
        fromCandidateSha256: priorCandidate.sha256,
        toCandidateSha256: candidate.sha256,
        addressedReviewEventId: requestId,
        changedPaths,
      },
      {
        id: approvalId,
        transition: 'approved',
        actorRole: 'reviewer',
        actorId: roles.reviewer,
        timestamp: '2026-10-01T10:10:00.000Z',
        candidateSha256: candidate.sha256,
        decision: 'approved',
      },
    ].map(event => {
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
      priorCandidate,
      reviewHistory: reviews,
      commands,
    };
  });

  git(root, ['init', '--template', templateRoot, '-q']);
  git(root, ['config', 'user.email', 'acceptance-fixture@example.invalid']);
  git(root, ['config', 'user.name', 'Acceptance Fixture']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['add', 'candidates']);
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
    processExitCode: 0,
    acceptanceExitCode: 0,
    scenarios,
  };
  return { root, receipt, addArtifact, commitSha, treeSha };
}

function withFixture(run, mode) {
  const item = fixture(mode);
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

test('fully structured defect and feature evidence is reported as structural verification only', () => withFixture(item => {
  const result = validate(item);
  assert.equal(result.structuralStatus, 'structurally-verified');
  assert.equal(result.status, 'structurally-verified');
  assert.equal(result.acceptanceStatus, 'runtime-database-verification-required');
  assert.equal(result.runtimeEvidenceStatus, 'not-checked');
  assert.deepEqual(result.scenarioKinds, ['defect', 'feature']);
  assert.match(result.verificationBoundary, /run the local verifier for runtime acceptance/);
}));

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
