import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const probePathPrefix = 'agentos/scripts/fixtures/p4-memory-source-probes/';
const sha256Pattern = /^[0-9a-f]{64}$/u;
const gitShaPattern = /^[0-9a-f]{40}$/iu;
const trustedProbeSpecs = {
  defect: {
    sourcePath: `${probePathPrefix}defect-baseline.mjs`,
    sourceSha256: 'c0d6fa3a273ac7f8192365f0f23c54afe23c062e130134817717ef267bb98605',
    failureMarker: 'LEXICAL_CONSTRUCTOR_TERM_MUST_REMAIN_TEXT',
    passMarker: 'P4_MEMORY_PROBE_PASS:constructor-term',
  },
  feature: {
    sourcePath: `${probePathPrefix}feature-baseline.mjs`,
    sourceSha256: '53aee310b72a1510b8b099e509312e9afa6101ffab88eaf879a50e16cbbd44d6',
    failureMarker: 'LEXICAL_LANGUAGE_TERMS_MUST_REMAIN_DISTINCT',
    passMarker: 'P4_MEMORY_PROBE_PASS:language-terms',
  },
};

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitText(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    env: frozenGitEnvironment(), encoding: 'utf8', windowsHide: true, shell: false, timeout: 15_000,
  });
  requireCondition(!result.error && result.status === 0,
    `git ${args[0]} failed (${result.status}): ${String(result.stderr || result.stdout).slice(0, 2000)}`);
  return result.stdout.trim();
}

function gitBlob(root, ref) {
  try {
    return execFileSync('git', ['-C', root, 'cat-file', 'blob', ref], {
      env: frozenGitEnvironment(), windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`probe source is not a committed Git blob: ${String(error?.message || error).slice(0, 2000)}`);
  }
}

export function frozenGitEnvironment() {
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX', 'GIT_NAMESPACE']) delete env[key];
  return env;
}

/** Resolve a project commit in this repository without peeling tags or replacing history. */
export function resolveProjectSnapshot(repositoryRoot, projectSha) {
  requireCondition(typeof projectSha === 'string' && gitShaPattern.test(projectSha),
    '--project-sha must be a full 40-character Git commit SHA');
  const root = realpathSync(repositoryRoot);
  const commitSha = projectSha.toLowerCase();
  requireCondition(gitText(root, ['cat-file', '-t', commitSha]) === 'commit',
    '--project-sha must identify an actual Git commit in the runtime repository');
  const treeSha = gitText(root, ['rev-parse', '--verify', `${commitSha}^{tree}`]);
  requireCondition(gitShaPattern.test(treeSha), 'could not resolve the frozen project tree');
  return { root, commitSha, treeSha };
}

/** Missing projectRepository is supported only for legacy receipts using the runtime commit. */
export function verifyProjectRepositoryBinding(receipt, repositoryRoot, projectSha) {
  const snapshot = resolveProjectSnapshot(repositoryRoot, projectSha);
  const project = receipt?.projectRepository;
  if (project === undefined) {
    requireCondition(snapshot.commitSha === receipt?.repository?.commitSha?.toLowerCase()
      && snapshot.treeSha === receipt?.repository?.treeSha?.toLowerCase(),
      'a distinct --project-sha requires receipt.projectRepository');
  } else {
    requireCondition(project && typeof project === 'object' && !Array.isArray(project)
      && typeof project.commitSha === 'string' && gitShaPattern.test(project.commitSha)
      && typeof project.treeSha === 'string' && gitShaPattern.test(project.treeSha)
      && project.commitSha.toLowerCase() === snapshot.commitSha
      && project.treeSha.toLowerCase() === snapshot.treeSha.toLowerCase(),
    'receipt.projectRepository commit/tree do not match --project-sha in the runtime repository');
  }
  return snapshot;
}

/** Inspect committed path ancestors; historical scope never depends on runtime checkout files. */
export function verifyProjectPath(repositoryRoot, projectSha, sourcePath) {
  requireCondition(typeof sourcePath === 'string' && sourcePath.length > 0
    && !isAbsolute(sourcePath) && !/^[a-z]:/iu.test(sourcePath) && !sourcePath.includes('\\')
    && !/[\u0000-\u001f\u007f]/u.test(sourcePath)
    && !sourcePath.split('/').some(part => !part || part === '.' || part === '..'),
  'project source must be a safe repository-relative path');
  const parts = sourcePath.split('/');
  let entry;
  for (let index = 1; index <= parts.length; index++) {
    const prefix = parts.slice(0, index).join('/');
    const text = gitText(repositoryRoot, ['ls-tree', '-z', projectSha, '--', prefix]);
    if (!text) return undefined;
    const entries = text.split('\0').filter(Boolean);
    requireCondition(entries.length === 1, 'project source path is ambiguous in its frozen tree');
    const match = /^([0-9]{6}) (blob|tree|commit) ([0-9a-f]{40})\t(.+)$/u.exec(entries[0]);
    requireCondition(match && match[4] === prefix, 'project source path differs from its frozen tree');
    entry = { mode: match[1], type: match[2], objectSha: match[3] };
    requireCondition(['100644', '100755', '040000'].includes(entry.mode),
      'project source cannot traverse a symbolic link or Gitlink');
    requireCondition(index === parts.length || entry.type === 'tree',
      'project source cannot traverse a committed regular file');
  }
  return entry;
}

function pathInside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function safeProbePath(sourcePath) {
  requireCondition(typeof sourcePath === 'string' && sourcePath.startsWith(probePathPrefix)
    && !sourcePath.includes('\\') && !sourcePath.split('/').some(part => !part || part === '.' || part === '..')
    && !isAbsolute(sourcePath) && !/^[a-z]:/iu.test(sourcePath),
  'baseline probe source must be a safe repository-relative path under scripts/fixtures/p4-memory-source-probes');
}

function assertProbeCommandShape(probe, scenario) {
  requireCondition(probe && typeof probe === 'object' && !Array.isArray(probe),
    `${scenario.kind} requires a source-bound baselineProbe`);
  safeProbePath(probe.sourcePath);
  const trusted = trustedProbeSpecs[scenario.kind];
  requireCondition(trusted && probe.sourcePath === trusted.sourcePath
    && probe.sourceSha256 === trusted.sourceSha256
    && scenario.expectedBaselineFailure === trusted.failureMarker
    && probe.passMarker === trusted.passMarker,
  `${scenario.kind} baselineProbe must use the reviewed concrete module assertion fixture and markers`);
  requireCondition(sha256Pattern.test(probe.sourceSha256 ?? '')
    && gitShaPattern.test(probe.sourceBlobSha ?? '')
    && gitShaPattern.test(probe.sourceCommitSha ?? ''),
  `${scenario.kind} baselineProbe source SHA, Git blob SHA, and source commit are required`);
  requireCondition(Array.isArray(probe.argv) && probe.argv.every(value => typeof value === 'string' && value.length > 0)
    && probe.argv[0]?.toLowerCase() === 'node',
  `${scenario.kind} baselineProbe argv must invoke node with the frozen source file`);
  const argv = probe.argv;
  let sourceIndex = 2;
  if (argv[1] === '--import') {
    requireCondition(argv.length === 5 && argv[3] === '--test',
      `${scenario.kind} baselineProbe may only use one explicitly bound --import loader before --test`);
    sourceIndex = 4;
    requireCondition(Array.isArray(probe.argvFileBindings) && probe.argvFileBindings.length === 1
      && probe.argvFileBindings[0].argumentIndex === 2
      && typeof probe.argvFileBindings[0].path === 'string'
      && isAbsolute(probe.argvFileBindings[0].path)
      && pathToFileURL(resolve(probe.argvFileBindings[0].path)).href === argv[2]
      && sha256Pattern.test(probe.argvFileBindings[0].sha256 ?? ''),
    `${scenario.kind} baselineProbe loader path and SHA must be bound to argv[2]`);
  } else {
    requireCondition(argv.length === 3 && argv[1] === '--test'
      && Array.isArray(probe.argvFileBindings) && probe.argvFileBindings.length === 0,
    `${scenario.kind} baselineProbe argv must be node --test <sourcePath> or bind one explicit --import loader`);
  }
  requireCondition(argv[sourceIndex] === probe.sourcePath,
    `${scenario.kind} baselineProbe argv must execute its bound sourcePath`);
  requireCondition(argv.every(value => /^[-A-Za-z0-9_./:@+%]+$/u.test(value)),
    `${scenario.kind} baselineProbe argv contains an unsupported shell-sensitive argument`);
  const argvSha256 = sha256Hex(Buffer.from(JSON.stringify(argv), 'utf8'));
  requireCondition(probe.argvSha256 === argvSha256,
    `${scenario.kind} baselineProbe argv SHA-256 does not match its arguments`);
  requireCondition(probe.command === argv.join(' '),
    `${scenario.kind} baselineProbe command must be the canonical argv joined by spaces`);
  requireCondition(typeof scenario.expectedBaselineFailure === 'string'
    && scenario.expectedBaselineFailure.trim().length >= 8,
  `${scenario.kind} expectedBaselineFailure must be a concrete probe assertion marker`);
  requireCondition(typeof probe.passMarker === 'string' && probe.passMarker.trim().length >= 8
    && probe.passMarker !== scenario.expectedBaselineFailure,
  `${scenario.kind} baselineProbe requires a distinct candidate pass marker`);
  requireCondition(Array.isArray(scenario.baselineCommands) && scenario.baselineCommands.filter(value => value === probe.command).length === 1
    && Array.isArray(scenario.acceptanceCommands) && scenario.acceptanceCommands.filter(value => value === probe.command).length === 1,
  `${scenario.kind} exact baselineProbe command must occur once in both baselineCommands and acceptanceCommands`);
  return probe;
}

function assertAbsoluteFile(value, message) {
  requireCondition(typeof value === 'string' && isAbsolute(value), message);
  const absolute = resolve(value);
  const actual = realpathSync(absolute);
  requireCondition(!lstatSync(absolute).isSymbolicLink(), message);
  return actual;
}

/** Verify the reviewed probe blob at the project commit; current-checkout probes must also be clean. */
export function verifyPlanProbeSource(plan, repositoryRoot, sourceCommitSha, { allowHistoricalCommit = false } = {}) {
  const root = realpathSync(repositoryRoot);
  const probe = assertProbeCommandShape(plan.baselineProbe, plan);
  requireCondition(gitShaPattern.test(sourceCommitSha ?? '')
    && probe.sourceCommitSha.toLowerCase() === sourceCommitSha.toLowerCase(),
  `${plan.kind} baselineProbe sourceCommitSha must equal the frozen source commit`);
  resolveProjectSnapshot(root, sourceCommitSha);
  const isCurrentCheckout = gitText(root, ['rev-parse', 'HEAD']).toLowerCase() === sourceCommitSha.toLowerCase();
  requireCondition(isCurrentCheckout || allowHistoricalCommit,
    `${plan.kind} baselineProbe source commit is not the current frozen checkout`);
  const committedPath = verifyProjectPath(root, sourceCommitSha, probe.sourcePath);
  requireCondition(committedPath?.type === 'blob' && ['100644', '100755'].includes(committedPath.mode),
    `${plan.kind} baselineProbe must be a committed regular file in the project tree`);
  const sourceRef = `${sourceCommitSha}:${probe.sourcePath}`;
  const committedBytes = gitBlob(root, sourceRef);
  const committedBlobSha = gitText(root, ['rev-parse', sourceRef]);
  requireCondition(committedBlobSha === probe.sourceBlobSha,
    `${plan.kind} baselineProbe Git blob SHA differs from its committed source`);
  requireCondition(sha256Hex(committedBytes) === probe.sourceSha256,
    `${plan.kind} baselineProbe source SHA-256 differs from the committed source`);
  if (isCurrentCheckout) {
    const absoluteSource = resolve(root, probe.sourcePath);
    requireCondition(pathInside(root, absoluteSource), `${plan.kind} baselineProbe source path escapes the repository`);
    const realSource = realpathSync(absoluteSource);
    requireCondition(pathInside(root, realSource) && resolve(realSource).toLowerCase() === resolve(absoluteSource).toLowerCase()
      && !lstatSync(absoluteSource).isSymbolicLink(),
    `${plan.kind} baselineProbe source cannot be outside the repository or traverse a symbolic link`);
    gitText(root, ['ls-files', '--error-unmatch', '--', probe.sourcePath]);
    requireCondition(sha256Hex(readFileSync(absoluteSource)) === probe.sourceSha256,
      `${plan.kind} baselineProbe source file changed from its committed SHA-256`);
    requireCondition(gitText(root, ['status', '--porcelain=v1', '--untracked-files=all', '--', probe.sourcePath]) === '',
      `${plan.kind} baselineProbe source file is dirty`);
  }

  for (const binding of probe.argvFileBindings) {
    const actual = assertAbsoluteFile(binding.path,
      `${plan.kind} baselineProbe argv file must resolve to an existing absolute path`);
    requireCondition(sha256Hex(readFileSync(actual)) === binding.sha256,
      `${plan.kind} baselineProbe argv file SHA-256 changed`);
  }
  return { sourcePath: probe.sourcePath, sourceSha256: probe.sourceSha256,
    sourceBlobSha: probe.sourceBlobSha, sourceCommitSha: probe.sourceCommitSha,
    argvSha256: probe.argvSha256 };
}

/** Ensure disposable baseline/candidate workspaces contain the same frozen probe bytes. */
export function verifyProbeWorkspaceSource(plan, workspaceRoot) {
  const probe = assertProbeCommandShape(plan.baselineProbe, plan);
  const root = realpathSync(workspaceRoot);
  const absolute = resolve(root, probe.sourcePath);
  requireCondition(pathInside(root, absolute) && !lstatSync(absolute).isSymbolicLink(),
    `${plan.kind} isolated workspace baseline probe is outside the workspace or a symbolic link`);
  const actual = realpathSync(absolute);
  requireCondition(pathInside(root, actual) && resolve(actual).toLowerCase() === resolve(absolute).toLowerCase(),
    `${plan.kind} isolated workspace baseline probe resolves outside its checkout`);
  requireCondition(gitText(root, ['rev-parse', `HEAD:${probe.sourcePath}`]) === probe.sourceBlobSha,
    `${plan.kind} isolated workspace probe blob differs from the frozen source commit`);
  requireCondition(sha256Hex(readFileSync(absolute)) === probe.sourceSha256,
    `${plan.kind} isolated workspace baseline probe bytes differ from the frozen source`);
  requireCondition(gitText(root, ['status', '--porcelain=v1', '--untracked-files=all', '--', probe.sourcePath]) === '',
    `${plan.kind} isolated workspace probe source is dirty`);
  return absolute;
}

/** Bind receipt claims to the exact raw plan bytes saved in the evidence directory. */
export function verifyRealPlanReceiptBinding(receipt, capturedPlanBytes, expectedPlanBytes) {
  const evidence = receipt?.realPlanEvidence;
  requireCondition(evidence?.kind === 'real-plan' && sha256Pattern.test(evidence.sha256 ?? '')
    && evidence.artifact?.sha256 === evidence.sha256,
  'real acceptance receipt requires a hash-bound realPlanEvidence artifact');
  const captured = Buffer.isBuffer(capturedPlanBytes) ? capturedPlanBytes : Buffer.from(capturedPlanBytes ?? '');
  const capturedHash = sha256Hex(captured);
  requireCondition(capturedHash === evidence.sha256,
    'captured real plan SHA-256 does not match receipt realPlanEvidence');
  if (expectedPlanBytes !== undefined) {
    const expected = Buffer.isBuffer(expectedPlanBytes) ? expectedPlanBytes : Buffer.from(expectedPlanBytes);
    requireCondition(sha256Hex(expected) === capturedHash,
      'supplied --plan bytes differ from the captured real plan SHA-256');
  }
  let plan;
  try { plan = JSON.parse(captured.toString('utf8')); }
  catch { throw new Error('captured real plan artifact must contain valid JSON'); }
  requireCondition(Array.isArray(plan?.scenarios), 'captured real plan must contain scenarios');
  for (const scenario of receipt.scenarios ?? []) {
    const planned = plan.scenarios.find(item => item?.kind === scenario.kind);
    requireCondition(planned, `${scenario.kind} receipt is missing from its captured real plan`);
    for (const field of ['title', 'objective', 'scope', 'expectedBaselineFailure',
      'baselineCommands', 'acceptanceCommands', 'baselineProbe']) {
      requireCondition(JSON.stringify(scenario[field]) === JSON.stringify(planned[field]),
        `${scenario.kind} receipt ${field} differs from the captured real plan`);
    }
  }
  return plan;
}

export function verifyProbeBaselineRecord(scenario, record, stdout, stderr) {
  const probe = assertProbeCommandShape(scenario.baselineProbe, scenario);
  requireCondition(record.command === probe.command && JSON.stringify(record.argv) === JSON.stringify(probe.argv)
    && record.argvSha256 === probe.argvSha256
    && record.sourcePath === probe.sourcePath && record.sourceSha256 === probe.sourceSha256
    && record.sourceBlobSha === probe.sourceBlobSha && record.sourceCommitSha === probe.sourceCommitSha,
  `${scenario.kind} baseline evidence did not execute the exact frozen probe argv and source`);
  requireCondition(Number.isInteger(record.rawExitCode) && record.rawExitCode !== 0
    && `${stdout}\n${stderr}`.includes(scenario.expectedBaselineFailure),
  `${scenario.kind} frozen baseline probe did not fail with its expected assertion marker`);
}

export function verifyProbeCandidateOutput(scenario, output) {
  const probe = assertProbeCommandShape(scenario.baselineProbe, scenario);
  requireCondition(typeof output === 'string' && output.includes(probe.passMarker),
    `${scenario.kind} candidate retest did not run the exact bound baseline probe successfully`);
}

export function verifyProbeCandidateRecord(scenario, record, stdout, expectedCandidateSha256) {
  const probe = assertProbeCommandShape(scenario.baselineProbe, scenario);
  requireCondition(record.command === probe.command && JSON.stringify(record.argv) === JSON.stringify(probe.argv)
    && record.argvSha256 === probe.argvSha256
    && record.sourcePath === probe.sourcePath && record.sourceSha256 === probe.sourceSha256
    && record.sourceBlobSha === probe.sourceBlobSha && record.sourceCommitSha === probe.sourceCommitSha
    && record.rawExitCode === 0 && record.candidateSha256 === expectedCandidateSha256
    && record.workspaceKind === 'frozen-candidate-overlay',
  `${scenario.kind} candidate probe did not execute the exact frozen probe against the final candidate`);
  verifyProbeCandidateOutput(scenario, stdout);
}
