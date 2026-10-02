import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateManifest, validateReceipt } from './validate-existing-project-acceptance.mjs';

const manifestPath = new URL('./p4-existing-project-acceptance.manifest.json', import.meta.url);
const agentosRoot = fileURLToPath(new URL('../', import.meta.url));
const validatorPath = fileURLToPath(new URL('./validate-existing-project-acceptance.mjs', import.meta.url));
const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));

// These are in-memory synthetic fixtures only; no acceptance command or provider is run.
function fixture(mode = 'simulated-provider') {
  const root = mkdtempSync(resolve(tmpdir(), 'agentos-p4-acceptance-'));
  mkdirSync(resolve(root, 'candidate'), { recursive: true });
  const artifactPath = 'candidate/change.patch';
  const bytes = Buffer.from('deterministic candidate artifact\n');
  writeFileSync(resolve(root, artifactPath), bytes);
  const modeRequirements = manifest.modes[mode];
  const receipt = {
    schemaVersion: 1,
    manifestId: manifest.manifestId,
    mode,
    platform: modeRequirements.platform === 'any' ? 'win32' : modeRequirements.platform,
    providerExecution: modeRequirements.providerExecution,
    credentialBoundary: modeRequirements.credentialBoundary,
    repository: {
      commitSha: '079214567bdfa302249da9d38a33ea54957ad5c4',
      treeSha: '5719ac9b498c9dfaac68c34a9bd53a6f3ce1e662',
      commitShaAtStart: '079214567bdfa302249da9d38a33ea54957ad5c4',
      commitShaAtEnd: '079214567bdfa302249da9d38a33ea54957ad5c4',
      treeShaAtStart: '5719ac9b498c9dfaac68c34a9bd53a6f3ce1e662',
      treeShaAtEnd: '5719ac9b498c9dfaac68c34a9bd53a6f3ce1e662',
    },
    model: { provider: mode === 'simulated-provider' ? 'fixture' : 'local-provider', id: mode === 'simulated-provider' ? 'fake-model-v1' : 'operator-model-v1' },
    ids: { projectId: 'project-a', taskId: 'task-a', runId: 'run-a', candidateId: 'candidate-a' },
    commands: [{ id: 'acceptance', argv: ['pnpm', 'test:acceptance'], cwd: 'agentos', rawExitCode: 0, expectedExitCode: 0 }],
    processExitCode: 0,
    acceptanceExitCode: 0,
    scenarios: [{
      id: 'existing-project-task',
      status: 'passed',
      roles: { planner: 'agent-planner', implementer: 'agent-implementer', reviewer: 'agent-reviewer' },
    }],
    candidate: { artifactPath, sha256: createHash('sha256').update(bytes).digest('hex') },
  };
  return { root, receipt };
}

test('accepts a complete simulated-provider receipt with a matching candidate hash', () => {
  const item = fixture();
  try {
    assert.equal(validateReceipt(manifest, item.receipt, {
      repositoryRoot: item.root,
      expectedSha: item.receipt.repository.commitSha,
    }).mode, 'simulated-provider');
  } finally { rmSync(item.root, { recursive: true, force: true }); }
});

test('requires the declared Windows platform for real acceptance and blocks that mode in CI', () => {
  const item = fixture('real-windows-acceptance');
  const originalCI = process.env.CI;
  try {
    item.receipt.platform = 'linux';
    assert.throws(() => validateReceipt(manifest, item.receipt, {
      repositoryRoot: item.root,
      expectedSha: item.receipt.repository.commitSha,
    }), /requires platform win32/);

    item.receipt.platform = 'win32';
    process.env.CI = 'true';
    assert.throws(() => validateReceipt(manifest, item.receipt, {
      repositoryRoot: item.root,
      expectedSha: item.receipt.repository.commitSha,
    }), /cannot be captured or validated inside CI/);
  } finally {
    if (originalCI === undefined) delete process.env.CI;
    else process.env.CI = originalCI;
    rmSync(item.root, { recursive: true, force: true });
  }
});

test('rejects inherited or unsupported acceptance mode names', () => {
  const item = fixture();
  try {
    item.receipt.mode = '__proto__';
    assert.throws(() => validateReceipt(manifest, item.receipt, {
      repositoryRoot: item.root,
      expectedSha: item.receipt.repository.commitSha,
    }), /unsupported acceptance mode/);
  } finally { rmSync(item.root, { recursive: true, force: true }); }
});

test('rejects incomplete IDs, command failures, and altered candidate bytes', () => {
  const missingId = fixture();
  try {
    delete missingId.receipt.ids.runId;
    assert.throws(() => validateReceipt(manifest, missingId.receipt, { repositoryRoot: missingId.root, expectedSha: missingId.receipt.repository.commitSha }), /ids.runId is required/);
  } finally { rmSync(missingId.root, { recursive: true, force: true }); }

  const failedCommand = fixture();
  try {
    failedCommand.receipt.commands[0].rawExitCode = 1;
    assert.throws(() => validateReceipt(manifest, failedCommand.receipt, { repositoryRoot: failedCommand.root, expectedSha: failedCommand.receipt.repository.commitSha }), /did not exit as expected/);
  } finally { rmSync(failedCommand.root, { recursive: true, force: true }); }

  const alteredCandidate = fixture();
  try {
    writeFileSync(resolve(alteredCandidate.root, alteredCandidate.receipt.candidate.artifactPath), 'changed after receipt\n');
    assert.throws(() => validateReceipt(manifest, alteredCandidate.receipt, { repositoryRoot: alteredCandidate.root, expectedSha: alteredCandidate.receipt.repository.commitSha }), /SHA-256 does not match/);
  } finally { rmSync(alteredCandidate.root, { recursive: true, force: true }); }
});

test('requires an exact expected commit SHA and rejects a changed repository snapshot', () => {
  const item = fixture();
  try {
    assert.throws(() => validateReceipt(manifest, item.receipt, { repositoryRoot: item.root }), /--expected-sha must be/);
    assert.throws(() => validateReceipt(manifest, item.receipt, {
      repositoryRoot: item.root,
      expectedSha: '0'.repeat(40),
    }), /does not match --expected-sha/);
    item.receipt.repository.treeShaAtEnd = '0'.repeat(40);
    assert.throws(() => validateReceipt(manifest, item.receipt, {
      repositoryRoot: item.root,
      expectedSha: item.receipt.repository.commitSha,
    }), /unchanged for the entire run/);
  } finally { rmSync(item.root, { recursive: true, force: true }); }
});

test('rejects candidate artifacts that resolve outside the repository', () => {
  const item = fixture();
  const outsidePath = resolve(item.root, '..', `${basename(item.root)}-outside.txt`);
  try {
    const bytes = Buffer.from('outside candidate\n');
    writeFileSync(outsidePath, bytes);
    item.receipt.candidate.artifactPath = relative(item.root, outsidePath);
    item.receipt.candidate.sha256 = createHash('sha256').update(bytes).digest('hex');
    assert.throws(() => validateReceipt(manifest, item.receipt, {
      repositoryRoot: item.root,
      expectedSha: item.receipt.repository.commitSha,
    }), /escapes the repository/);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
    rmSync(outsidePath, { force: true });
  }
});

test('requires passing scenarios with distinct planner, implementer, and reviewer identities', () => {
  const missingRole = fixture();
  try {
    delete missingRole.receipt.scenarios[0].roles.reviewer;
    assert.throws(() => validateReceipt(manifest, missingRole.receipt, {
      repositoryRoot: missingRole.root,
      expectedSha: missingRole.receipt.repository.commitSha,
    }), /roles.reviewer is required/);
  } finally { rmSync(missingRole.root, { recursive: true, force: true }); }

  const duplicateRole = fixture();
  try {
    duplicateRole.receipt.scenarios[0].roles.reviewer = 'agent-planner';
    assert.throws(() => validateReceipt(manifest, duplicateRole.receipt, {
      repositoryRoot: duplicateRole.root,
      expectedSha: duplicateRole.receipt.repository.commitSha,
    }), /distinct agent ids/);
  } finally { rmSync(duplicateRole.root, { recursive: true, force: true }); }

  const failedScenario = fixture();
  try {
    failedScenario.receipt.scenarios[0].status = 'failed';
    assert.throws(() => validateReceipt(manifest, failedScenario.receipt, {
      repositoryRoot: failedScenario.root,
      expectedSha: failedScenario.receipt.repository.commitSha,
    }), /did not pass/);
  } finally { rmSync(failedScenario.root, { recursive: true, force: true }); }
});

test('manifest-only CLI check states that no acceptance run occurred', () => {
  const output = execFileSync(process.execPath, [validatorPath, '--check-manifest'], {
    cwd: agentosRoot,
    encoding: 'utf8',
  });
  assert.match(output, /acceptanceStatus=contract-only/);
  assert.match(output, /no acceptance run is claimed/);
});

test('omitting the acceptance receipt is a failing result, not an implicit pass', () => {
  assert.throws(() => execFileSync(process.execPath, [validatorPath], {
    cwd: agentosRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  }), error => String(error.stderr).includes('ACCEPTANCE_RECEIPT_MISSING'));
});

test('CLI rejects options without values', () => {
  assert.throws(() => execFileSync(process.execPath, [validatorPath, '--expected-sha'], {
    cwd: agentosRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  }), error => String(error.stderr).includes('--expected-sha requires a value'));
});
