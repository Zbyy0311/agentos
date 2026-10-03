import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  verifyPlanProbeSource, verifyProbeBaselineRecord, verifyProbeCandidateOutput,
  verifyProbeCandidateRecord, verifyRealPlanReceiptBinding,
  resolveProjectSnapshot, verifyProjectPath, verifyProjectRepositoryBinding,
} from './p4-plan-bindings.mjs';

const sourceFixtureRoot = fileURLToPath(new URL('./fixtures/p4-memory-source-probes/', import.meta.url));
const memoryModulePath = 'agentos/apps/server/src/services/MemoryLexicalIndex.ts';

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8', windowsHide: true, shell: false,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function planFixture() {
  const root = mkdtempSync(join(tmpdir(), 'p4-source-bound-probe-'));
  try {
    const appSource = join(root, memoryModulePath);
    const probeRoot = join(root, 'agentos/scripts/fixtures/p4-memory-source-probes');
    mkdirSync(join(root, 'agentos/apps/server/src/services'), { recursive: true });
    mkdirSync(probeRoot, { recursive: true });
    writeFileSync(appSource, 'export function memoryLexicalTerms() { return []; }\n');
    for (const kind of ['defect', 'feature']) {
      const original = readFileSync(join(sourceFixtureRoot, `${kind}-baseline.mjs`));
      writeFileSync(join(probeRoot, `${kind}-baseline.mjs`), original);
    }
    git(root, ['init', '-q']);
    git(root, ['config', 'user.name', 'P4 source probe test']);
    git(root, ['config', 'user.email', 'p4-source-probe@example.invalid']);
    git(root, ['config', 'core.autocrlf', 'false']);
    git(root, ['add', '--', 'agentos']);
    git(root, ['commit', '-q', '-m', 'commit real source probes']);
    const sourceCommit = git(root, ['rev-parse', 'HEAD']);
    const plans = ['defect', 'feature'].map(kind => {
      const sourcePath = `agentos/scripts/fixtures/p4-memory-source-probes/${kind}-baseline.mjs`;
      const sourceBytes = readFileSync(join(root, sourcePath));
      const argv = ['node', '--test', sourcePath];
      const command = argv.join(' ');
      return {
        kind,
        title: `Memory ${kind} baseline probe`,
        objective: `Read the actual memory lexical module and preserve the concrete ${kind} behavior with a regression test.`,
        scope: [memoryModulePath],
        expectedBaselineFailure: kind === 'defect'
          ? 'LEXICAL_CONSTRUCTOR_TERM_MUST_REMAIN_TEXT'
          : 'LEXICAL_LANGUAGE_TERMS_MUST_REMAIN_DISTINCT',
        baselineCommands: [command],
        acceptanceCommands: [command, `node --test agentos/apps/server/src/${kind}.test.ts`],
        baselineProbe: {
          sourcePath,
          sourceSha256: hash(sourceBytes),
          sourceBlobSha: git(root, ['rev-parse', `${sourceCommit}:${sourcePath}`]),
          sourceCommitSha: sourceCommit,
          argv,
          argvSha256: hash(Buffer.from(JSON.stringify(argv), 'utf8')),
          command,
          argvFileBindings: [],
          passMarker: kind === 'defect'
            ? 'P4_MEMORY_PROBE_PASS:constructor-term'
            : 'P4_MEMORY_PROBE_PASS:language-terms',
        },
      };
    });
    return { root, sourceCommit, plans };
  } catch (error) {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }); }
    catch (cleanupError) {
      if (process.platform !== 'win32' || cleanupError.code !== 'ENOTEMPTY') throw cleanupError;
    }
    throw error;
  }
}

function withPlanFixture(run) {
  const fixture = planFixture();
  try { run(fixture); }
  finally {
    try { rmSync(fixture.root, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }); }
    catch (error) {
      if (process.platform !== 'win32' || error.code !== 'ENOTEMPTY') throw error;
    }
  }
}

function realPlanReceipt(plans) {
  const planBytes = Buffer.from(JSON.stringify({ scenarios: plans }), 'utf8');
  const planSha256 = hash(planBytes);
  return {
    planBytes,
    receipt: {
      realPlanEvidence: {
        kind: 'real-plan', sha256: planSha256,
        artifact: { artifactPath: 'plan/real-plan.json', sha256: planSha256 },
      },
      scenarios: plans.map(plan => Object.fromEntries([
        'kind', 'title', 'objective', 'scope', 'expectedBaselineFailure',
        'baselineCommands', 'acceptanceCommands', 'baselineProbe',
      ].map(key => [key, plan[key]]))),
    },
  };
}

test('frozen probes are concrete assertions over MemoryLexicalIndex, not throw-only programs', () => {
  const defect = readFileSync(join(sourceFixtureRoot, 'defect-baseline.mjs'), 'utf8');
  const feature = readFileSync(join(sourceFixtureRoot, 'feature-baseline.mjs'), 'utf8');
  for (const source of [defect, feature]) {
    assert.match(source, /MemoryLexicalIndex\.ts/u);
    assert.match(source, /assert\.deepEqual\(memoryLexicalTerms\(/u);
    assert.doesNotMatch(source, /throw\s+new\s+Error/u);
  }
  assert.match(defect, /constructor constructor API/u);
  assert.match(defect, /LEXICAL_CONSTRUCTOR_TERM_MUST_REMAIN_TEXT/u);
  assert.match(feature, /C\+\+ C# \.NET/u);
  assert.match(feature, /LEXICAL_LANGUAGE_TERMS_MUST_REMAIN_DISTINCT/u);
});

test('real source binding requires the reviewed tracked probe at the exact clean source commit', () => withPlanFixture(fixture => {
  const result = verifyPlanProbeSource(fixture.plans[0], fixture.root, fixture.sourceCommit);
  assert.equal(result.sourceCommitSha, fixture.sourceCommit);
  assert.equal(result.sourcePath, fixture.plans[0].baselineProbe.sourcePath);

  const wrongSha = structuredClone(fixture.plans[0]);
  wrongSha.baselineProbe.sourceSha256 = 'f'.repeat(64);
  assert.throws(() => verifyPlanProbeSource(wrongSha, fixture.root, fixture.sourceCommit), /reviewed concrete module assertion fixture/u);

  const wrongCommit = structuredClone(fixture.plans[0]);
  wrongCommit.baselineProbe.sourceCommitSha = '0'.repeat(40);
  assert.throws(() => verifyPlanProbeSource(wrongCommit, fixture.root, fixture.sourceCommit), /sourceCommitSha must equal/u);

  const outside = structuredClone(fixture.plans[0]);
  outside.baselineProbe.sourcePath = 'C:/outside/baseline.mjs';
  assert.throws(() => verifyPlanProbeSource(outside, fixture.root, fixture.sourceCommit), /safe repository-relative path/u);

  writeFileSync(join(fixture.root, fixture.plans[0].baselineProbe.sourcePath), `${readFileSync(join(fixture.root, fixture.plans[0].baselineProbe.sourcePath), 'utf8')}\n// changed after commit\n`);
  assert.throws(() => verifyPlanProbeSource(fixture.plans[0], fixture.root, fixture.sourceCommit), /source file changed from its committed SHA/u);
}));

test('an external TypeScript loader is allowed only when its exact argv path and bytes are hash-bound', () => withPlanFixture(fixture => {
  const loaderPath = join(dirname(fixture.root), `p4-test-loader-${process.pid}.mjs`);
  const loaderBytes = Buffer.from('export {};\n');
  try {
    writeFileSync(loaderPath, loaderBytes);
    const plan = structuredClone(fixture.plans[0]);
    const argv = ['node', '--import', pathToFileURL(loaderPath).href, '--test', plan.baselineProbe.sourcePath];
    plan.baselineProbe.argv = argv;
    plan.baselineProbe.argvSha256 = hash(Buffer.from(JSON.stringify(argv), 'utf8'));
    plan.baselineProbe.command = argv.join(' ');
    plan.baselineProbe.argvFileBindings = [{ argumentIndex: 2, path: loaderPath, sha256: hash(loaderBytes) }];
    plan.baselineCommands = [plan.baselineProbe.command];
    plan.acceptanceCommands = [plan.baselineProbe.command, 'node --test agentos/apps/server/src/defect.test.ts'];
    assert.doesNotThrow(() => verifyPlanProbeSource(plan, fixture.root, fixture.sourceCommit));
    writeFileSync(loaderPath, 'export const changed = true;\n');
    assert.throws(() => verifyPlanProbeSource(plan, fixture.root, fixture.sourceCommit), /argv file SHA-256 changed/u);
  } finally { rmSync(loaderPath, { force: true }); }
}));

test('historical project probes are verified from their committed blobs without rewriting the runtime checkout', () => withPlanFixture(fixture => {
  const plan = fixture.plans[0];
  const frozenPlanBytes = JSON.stringify(plan);
  git(fixture.root, ['rm', '--', memoryModulePath, plan.baselineProbe.sourcePath]);
  git(fixture.root, ['commit', '-q', '-m', 'runtime moves beyond the frozen project']);
  const runtimeSha = git(fixture.root, ['rev-parse', 'HEAD']);
  const runtimeIndex = readFileSync(join(fixture.root, '.git', 'index'));
  assert.throws(() => verifyPlanProbeSource(plan, fixture.root, fixture.sourceCommit),
    /not the current frozen checkout/u);
  const binding = verifyPlanProbeSource(plan, fixture.root, fixture.sourceCommit, { allowHistoricalCommit: true });
  assert.equal(binding.sourceBlobSha, plan.baselineProbe.sourceBlobSha);
  assert.equal(JSON.stringify(plan), frozenPlanBytes, 'historical plan/probe bindings remain unchanged');
  assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), runtimeSha);
  assert.deepEqual(readFileSync(join(fixture.root, '.git', 'index')), runtimeIndex);
  assert.equal(git(fixture.root, ['status', '--porcelain=v1']), '');

  const wrongBlob = structuredClone(plan);
  wrongBlob.baselineProbe.sourceBlobSha = 'f'.repeat(40);
  assert.throws(() => verifyPlanProbeSource(wrongBlob, fixture.root, fixture.sourceCommit,
    { allowHistoricalCommit: true }), /Git blob SHA differs/u);
  assert.throws(() => verifyPlanProbeSource(plan, fixture.root, runtimeSha,
    { allowHistoricalCommit: true }), /sourceCommitSha must equal/u);
}));

test('project receipt binding requires an explicit actual commit/tree and preserves the same-SHA legacy contract', () => withPlanFixture(fixture => {
  const project = resolveProjectSnapshot(fixture.root, fixture.sourceCommit);
  const legacy = { repository: { commitSha: project.commitSha, treeSha: project.treeSha } };
  assert.deepEqual(verifyProjectRepositoryBinding(legacy, fixture.root, fixture.sourceCommit), project);
  writeFileSync(join(fixture.root, memoryModulePath), 'export function memoryLexicalTerms() { return ["fixed"]; }\n');
  git(fixture.root, ['add', '--', memoryModulePath]);
  git(fixture.root, ['commit', '-q', '-m', 'new runtime source']);
  const runtime = resolveProjectSnapshot(fixture.root, git(fixture.root, ['rev-parse', 'HEAD']));
  const receipt = {
    repository: { commitSha: runtime.commitSha, treeSha: runtime.treeSha },
    projectRepository: { commitSha: project.commitSha, treeSha: project.treeSha },
  };
  assert.deepEqual(verifyProjectRepositoryBinding(receipt, fixture.root, project.commitSha), project);
  assert.throws(() => verifyProjectRepositoryBinding(receipt, fixture.root, runtime.commitSha),
    /projectRepository commit\/tree do not match --project-sha/u);
  const missing = structuredClone(receipt);
  delete missing.projectRepository;
  assert.throws(() => verifyProjectRepositoryBinding(missing, fixture.root, project.commitSha),
    /requires receipt.projectRepository/u);
  for (const replacement of [null, [], { commitSha: project.commitSha },
    { commitSha: project.commitSha, treeSha: runtime.treeSha }]) {
    assert.throws(() => verifyProjectRepositoryBinding({ ...receipt, projectRepository: replacement },
      fixture.root, project.commitSha), /projectRepository commit\/tree/u);
  }
  assert.throws(() => resolveProjectSnapshot(fixture.root, project.treeSha), /actual Git commit/u);
  assert.throws(() => resolveProjectSnapshot(fixture.root, project.commitSha.slice(0, 8)), /full 40-character/u);
  assert.throws(() => resolveProjectSnapshot(fixture.root, '0'.repeat(40)), /git cat-file failed/u);
  git(fixture.root, ['tag', '-a', 'project-tag', '-m', 'tag is not a project commit', project.commitSha]);
  assert.throws(() => resolveProjectSnapshot(fixture.root, git(fixture.root, ['rev-parse', 'project-tag'])),
    /actual Git commit/u);
}));

test('Git replacements cannot rewrite the historical project tree or its reviewed probe blobs', () => withPlanFixture(fixture => {
  const project = resolveProjectSnapshot(fixture.root, fixture.sourceCommit);
  const probePath = fixture.plans[0].baselineProbe.sourcePath;
  writeFileSync(join(fixture.root, probePath), '// rewritten probe in a later runtime commit\n');
  git(fixture.root, ['add', '--', probePath]);
  git(fixture.root, ['commit', '-q', '-m', 'replacement has different probe bytes']);
  const runtimeSha = git(fixture.root, ['rev-parse', 'HEAD']);
  const runtimeTree = git(fixture.root, ['rev-parse', 'HEAD^{tree}']);
  git(fixture.root, ['replace', fixture.sourceCommit, runtimeSha]);
  assert.equal(git(fixture.root, ['rev-parse', `${fixture.sourceCommit}^{tree}`]), runtimeTree);
  assert.equal(resolveProjectSnapshot(fixture.root, fixture.sourceCommit).treeSha, project.treeSha);
  assert.doesNotThrow(() => verifyPlanProbeSource(fixture.plans[0], fixture.root, fixture.sourceCommit,
    { allowHistoricalCommit: true }));
  const receipt = { repository: { commitSha: runtimeSha, treeSha: runtimeTree },
    projectRepository: { commitSha: fixture.sourceCommit, treeSha: runtimeTree } };
  assert.throws(() => verifyProjectRepositoryBinding(receipt, fixture.root, fixture.sourceCommit),
    /projectRepository commit\/tree/u);
}));

test('historical source anchors reject committed symbolic links and Gitlinks, including missing child paths', () => withPlanFixture(fixture => {
  assert.equal(verifyProjectPath(fixture.root, fixture.sourceCommit, memoryModulePath).type, 'blob');
  const blob = fixture.plans[0].baselineProbe.sourceBlobSha;
  const sourceRoot = 'agentos/apps/server/src/unsafe';
  git(fixture.root, ['update-index', '--add', '--cacheinfo', `120000,${blob},${sourceRoot}`]);
  git(fixture.root, ['commit', '-q', '-m', 'symbolic source anchor']);
  const linkedCommit = git(fixture.root, ['rev-parse', 'HEAD']);
  assert.throws(() => verifyProjectPath(fixture.root, linkedCommit, `${sourceRoot}/new.ts`),
    /symbolic link or Gitlink/u);
  git(fixture.root, ['update-index', '--add', '--cacheinfo', `160000,${fixture.sourceCommit},${sourceRoot}`]);
  git(fixture.root, ['commit', '-q', '-m', 'Gitlink source anchor']);
  assert.throws(() => verifyProjectPath(fixture.root, git(fixture.root, ['rev-parse', 'HEAD']), sourceRoot),
    /symbolic link or Gitlink/u);
}));

test('raw plan hash and every consumed scenario field are replay-bound', () => withPlanFixture(fixture => {
  const { planBytes, receipt } = realPlanReceipt(fixture.plans);
  assert.doesNotThrow(() => verifyRealPlanReceiptBinding(receipt, planBytes));
  const changedPlanBytes = Buffer.from(`${planBytes.toString('utf8')} `, 'utf8');
  assert.throws(() => verifyRealPlanReceiptBinding(receipt, planBytes, changedPlanBytes), /supplied --plan bytes differ/u);

  receipt.scenarios[0].acceptanceCommands = ['node -e "throw 1"'];
  assert.throws(() => verifyRealPlanReceiptBinding(receipt, planBytes), /acceptanceCommands differs from the captured real plan/u);
}));

test('a baseline only counts when the exact fixed source argv fails with its assertion marker', () => withPlanFixture(fixture => {
  const plan = fixture.plans[0];
  const forged = {
    command: 'node --input-type=module -e "throw new Error(\'LEXICAL_CONSTRUCTOR_TERM_MUST_REMAIN_TEXT\')"',
    argv: ['node', '--input-type=module', '-e', 'throw new Error(...)'],
    argvSha256: plan.baselineProbe.argvSha256,
    sourcePath: plan.baselineProbe.sourcePath,
    sourceSha256: plan.baselineProbe.sourceSha256,
    sourceBlobSha: plan.baselineProbe.sourceBlobSha,
    sourceCommitSha: plan.baselineProbe.sourceCommitSha,
    rawExitCode: 1,
  };
  assert.throws(() => verifyProbeBaselineRecord(plan, forged,
    'LEXICAL_CONSTRUCTOR_TERM_MUST_REMAIN_TEXT', ''), /exact frozen probe argv and source/u);

  const proven = {
    ...forged,
    command: plan.baselineProbe.command,
    argv: plan.baselineProbe.argv,
    argvSha256: plan.baselineProbe.argvSha256,
  };
  assert.doesNotThrow(() => verifyProbeBaselineRecord(plan, proven,
    'AssertionError: LEXICAL_CONSTRUCTOR_TERM_MUST_REMAIN_TEXT', ''));
  assert.throws(() => verifyProbeBaselineRecord(plan, { ...proven, rawExitCode: 0 },
    'AssertionError: LEXICAL_CONSTRUCTOR_TERM_MUST_REMAIN_TEXT', ''), /did not fail with its expected assertion marker/u);
}));

test('candidate must retain and pass the same probe command used for the baseline', () => withPlanFixture(fixture => {
  const plan = fixture.plans[1];
  assert.doesNotThrow(() => verifyProbeCandidateOutput(plan,
    'TAP version 13\nP4_MEMORY_PROBE_PASS:language-terms\n'));
  const missingProbe = { ...plan, acceptanceCommands: ['node --test agentos/apps/server/src/feature.test.ts'] };
  assert.throws(() => verifyProbeCandidateOutput(missingProbe,
    'P4_MEMORY_PROBE_PASS:language-terms'), /exact baselineProbe command must occur once/u);
  assert.throws(() => verifyProbeCandidateOutput(plan, 'agent tests passed'), /did not run the exact bound baseline probe/u);

  const candidateRecord = {
    command: plan.baselineProbe.command,
    argv: plan.baselineProbe.argv,
    argvSha256: plan.baselineProbe.argvSha256,
    sourcePath: plan.baselineProbe.sourcePath,
    sourceSha256: plan.baselineProbe.sourceSha256,
    sourceBlobSha: plan.baselineProbe.sourceBlobSha,
    sourceCommitSha: plan.baselineProbe.sourceCommitSha,
    rawExitCode: 0,
    candidateSha256: 'a'.repeat(64),
    workspaceKind: 'frozen-candidate-overlay',
  };
  assert.doesNotThrow(() => verifyProbeCandidateRecord(plan, candidateRecord,
    'P4_MEMORY_PROBE_PASS:language-terms', 'a'.repeat(64)));
  assert.throws(() => verifyProbeCandidateRecord(plan, { ...candidateRecord, argv: ['node', '-e', '0'] },
    'P4_MEMORY_PROBE_PASS:language-terms', 'a'.repeat(64)), /exact frozen probe against the final candidate/u);
}));
