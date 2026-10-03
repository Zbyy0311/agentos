// Validate receipt structure and frozen source/candidate bindings. A receipt
// is structurally verified here; runtime acceptance is checked separately by
// verify-existing-project-acceptance.mjs against the local AgentOS database.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { delimiter as pathDelimiter, isAbsolute, join, relative, sep, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  OFFICIAL_CODEX_PROVIDER_KIND,
  OFFICIAL_CODEX_TRUST_BOUNDARY,
  SIMULATED_CODEX_PROVIDER_KIND,
  verifyOfficialCodexIdentity,
} from './acceptance-provider-identity.mjs';
import {
  verifyPlanProbeSource, verifyProbeBaselineRecord, verifyProbeCandidateRecord,
  verifyProbeCandidateOutput, verifyRealPlanReceiptBinding,
} from './p4-plan-bindings.mjs';

const agentosRoot = fileURLToPath(new URL('../', import.meta.url));
const repositoryRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: agentosRoot,
  encoding: 'utf8',
}).trim();
const defaultManifestPath = resolve(agentosRoot, 'scripts/p4-existing-project-acceptance.manifest.json');
const shaPattern = /^[0-9a-f]{40}$/i;
const hashPattern = /^[0-9a-f]{64}$/;
const scenarioKinds = ['defect', 'feature'];
const reviewTransitions = ['changes-requested', 'revision-submitted', 'approved'];
const commandStages = ['retest', 'preview', 'apply'];
const identityFields = ['projectId', 'taskId', 'runId', 'candidateId'];
const roleNames = ['planner', 'implementer', 'reviewer'];

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
    && !/^(?:todo|tbd|unknown|placeholder|n\/a)$/i.test(value.trim());
}

function isIsoDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function sameArray(actual, expected) {
  return Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function git(root, args, encoding = 'utf8') {
  return execFileSync('git', args, {
    cwd: root,
    encoding,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function frozenAcceptanceGitlinkPaths(root, sourceCommitSha) {
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_NAMESPACE']) delete env[key];
  const entries = execFileSync('git', ['-C', root, 'ls-tree', '-r', '--full-tree', '-z', sourceCommitSha], {
    env, encoding: 'buffer', windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
  })
    .toString('utf8').split('\0').filter(Boolean);
  return entries.flatMap(entry => {
    const separator = entry.indexOf('\t');
    if (separator < 0 || !/^160000 commit [0-9a-f]{40,64}$/iu.test(entry.slice(0, separator))) return [];
    const sourcePath = entry.slice(separator + 1);
    return /(?:^|\/)\.claude\/worktrees\//iu.test(sourcePath) ? [sourcePath] : [];
  });
}

function safePathWithin(root, relativePath, description) {
  requireCondition(typeof relativePath === 'string' && relativePath.length > 0 && !isAbsolute(relativePath),
    `${description} must be a repository-relative path`);
  const rootReal = realpathSync(root);
  let candidateReal;
  try { candidateReal = realpathSync(resolve(rootReal, relativePath)); }
  catch { throw new Error(`${description} does not exist in the repository`); }
  const rel = relative(rootReal, candidateReal);
  requireCondition(rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel), `${description} escapes the repository`);
  return candidateReal;
}

function getGitBlob(root, commitSha, absolutePath) {
  const rootReal = realpathSync(root);
  const relativePath = relative(rootReal, absolutePath).split(sep).join('/');
  requireCondition(relativePath.length > 0 && relativePath !== '..' && !relativePath.startsWith('../'),
    'evidence artifact must be inside the Git repository');
  let objectId;
  try {
    objectId = git(rootReal, ['rev-parse', '--verify', `${commitSha}:${relativePath}`]).trim();
  } catch {
    throw new Error(`evidence artifact is not present in the frozen Git tree: ${relativePath}`);
  }
  requireCondition(/^[0-9a-f]{40,64}$/i.test(objectId), `Git tree entry is invalid: ${relativePath}`);
  requireCondition(git(rootReal, ['cat-file', '-t', objectId]).trim() === 'blob',
    `evidence artifact is not a tracked file: ${relativePath}`);
  return git(rootReal, ['cat-file', 'blob', objectId], 'buffer');
}

function verifyTrackedArtifact(root, commitSha, ref, description, usedPaths, requireNonEmpty = false) {
  requireCondition(ref && typeof ref === 'object' && !Array.isArray(ref), `${description} reference is required`);
  requireCondition(typeof ref.sha256 === 'string' && hashPattern.test(ref.sha256), `${description}.sha256 must be lowercase SHA-256`);
  const absolutePath = safePathWithin(root, ref.artifactPath, `${description}.artifactPath`);
  const declaredPath = resolve(realpathSync(root), ref.artifactPath);
  let fileStat;
  try { fileStat = lstatSync(declaredPath); }
  catch { throw new Error(`${description} must be a tracked regular file`); }
  requireCondition(fileStat.isFile() && !fileStat.isSymbolicLink(), `${description} must be a tracked regular file`);
  const canonicalPath = relative(realpathSync(root), absolutePath).split(sep).join('/').toLowerCase();
  requireCondition(!usedPaths.has(canonicalPath), `${description} must use a distinct evidence artifact`);
  usedPaths.add(canonicalPath);
  const workingBytes = readFileSync(absolutePath);
  const treeBytes = getGitBlob(root, commitSha, declaredPath);
  const actualHash = sha256(workingBytes);
  requireCondition(actualHash === ref.sha256, `${description} SHA-256 does not match its bytes`);
  requireCondition(sha256(treeBytes) === actualHash, `${description} differs from the frozen Git tree`);
  if (requireNonEmpty) requireCondition(workingBytes.length > 0, `${description} must contain captured output`);
  return workingBytes;
}

function verifyEvidenceArtifact(root, ref, description, usedPaths, requireNonEmpty = false) {
  requireCondition(ref && typeof ref === 'object' && !Array.isArray(ref), `${description} reference is required`);
  requireCondition(typeof ref.sha256 === 'string' && hashPattern.test(ref.sha256), `${description}.sha256 must be lowercase SHA-256`);
  const absolutePath = safePathWithin(root, ref.artifactPath, `${description}.artifactPath`);
  const canonicalPath = relative(realpathSync(root), absolutePath).split(sep).join('/').toLowerCase();
  requireCondition(!usedPaths.has(canonicalPath), `${description} must use a distinct evidence artifact`);
  usedPaths.add(canonicalPath);
  const bytes = readFileSync(absolutePath);
  requireCondition(sha256(bytes) === ref.sha256, `${description} SHA-256 does not match its bytes`);
  if (requireNonEmpty) requireCondition(bytes.length > 0, `${description} must contain captured output`);
  return bytes;
}

function isKnownGeneratedOutputDirectory(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '').toLowerCase();
  const parts = normalized.split('/');
  const repoPrefixes = parts[0] === 'agentos' ? ['agentos/'] : [''];
  for (const repoPrefix of repoPrefixes) {
    const exactOutputs = [
      `${repoPrefix}apps/server/dist`,
      `${repoPrefix}packages/agent-core/dist`,
      `${repoPrefix}packages/process-runtime/dist`,
      `${repoPrefix}packages/shared/dist`,
      `${repoPrefix}packages/agent-core/.agentos/logs/diagnostics`,
      `${repoPrefix}apps/web/.next`,
      `${repoPrefix}apps/web/.next-live`,
      `${repoPrefix}apps/web/test-results`,
      `${repoPrefix}apps/web/playwright-report`,
    ];
    if (exactOutputs.some(output => normalized === output || normalized.startsWith(`${output}/`))) return true;
    if (normalized === `${repoPrefix}apps/web/next-env.d.ts`
      || normalized === `${repoPrefix}apps/web/tsconfig.tsbuildinfo`) return true;
    const webPrefix = `${repoPrefix}apps/web/`;
    if (normalized.startsWith(webPrefix)) {
      const firstDirectory = normalized.slice(webPrefix.length).split('/')[0];
      if (/^\.next-p4-[^/]+$/u.test(firstDirectory) || /^\.next-acceptance-[^/]+$/u.test(firstDirectory)) return true;
    }
    const rootLength = repoPrefix ? 1 : 0;
    const appNodeModules = parts.length === rootLength + 3
      && parts[rootLength] === 'apps' && parts[rootLength + 2] === 'node_modules';
    const packageNodeModules = parts.length === rootLength + 3
      && parts[rootLength] === 'packages' && parts[rootLength + 2] === 'node_modules';
    const scriptNodeModules = parts.length === rootLength + 2
      && parts[rootLength] === 'scripts' && parts[rootLength + 1] === 'node_modules';
    if (appNodeModules || packageNodeModules || scriptNodeModules) return true;
  }
  return false;
}

function findUntrackedBuildInputs(root) {
  const sourceRoots = ['apps', 'packages', 'scripts', 'agentos/apps', 'agentos/packages', 'agentos/scripts'];
  const trackedText = git(root, ['ls-files', '--full-name', '-z', '--', ...sourceRoots], 'buffer').toString('utf8');
  const tracked = new Set(trackedText.split('\0').filter(Boolean).map(path => path.replaceAll('\\', '/').toLowerCase()));
  const untracked = [];
  const visit = (absoluteDirectory, relativeDirectory) => {
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const relativePath = `${relativeDirectory}/${entry.name}`.replaceAll('\\', '/');
      if (isKnownGeneratedOutputDirectory(relativePath)) continue;
      const absolutePath = resolve(absoluteDirectory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git') {
          if (!tracked.has(relativePath.toLowerCase())) untracked.push(relativePath);
          continue;
        }
        visit(absolutePath, relativePath);
      } else if (!tracked.has(relativePath.toLowerCase())) {
        untracked.push(relativePath);
      }
    }
  };
  for (const sourceRoot of sourceRoots) {
    const absoluteDirectory = resolve(root, sourceRoot);
    try { visit(absoluteDirectory, sourceRoot); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return untracked;
}

/** Capture the exact Git tree after rejecting tracked changes and untracked build inputs. */
export function verifySourceSnapshot(root) {
  const rootReal = realpathSync(root);
  const fromRootToTop = git(rootReal, ['rev-parse', '--show-cdup']).trim();
  requireCondition(fromRootToTop.length === 0, '--repository-root must be the Git repository root');
  const commitSha = git(rootReal, ['rev-parse', 'HEAD']).trim();
  const treeSha = git(rootReal, ['rev-parse', 'HEAD^{tree}']).trim();
  requireCondition(/^[0-9a-f]{40}$/i.test(commitSha) && /^[0-9a-f]{40}$/i.test(treeSha),
    'could not resolve the frozen Git commit and tree');
  const trackedChanges = git(rootReal, ['status', '--porcelain=v1', '--untracked-files=no']).trim();
  requireCondition(trackedChanges.length === 0, 'tracked checkout files differ from the frozen Git tree');
  const untracked = findUntrackedBuildInputs(rootReal);
  requireCondition(untracked.length === 0,
    `untracked source/build inputs are present under apps, packages, or scripts: ${untracked.slice(0, 8).join(', ')}${untracked.length > 8 ? ` (and ${untracked.length - 8} more)` : ''}`);
  requireCondition(git(rootReal, ['rev-parse', 'HEAD']).trim() === commitSha
    && git(rootReal, ['rev-parse', 'HEAD^{tree}']).trim() === treeSha,
  'Git HEAD changed while verifying the source snapshot');
  return { root: rootReal, commitSha, treeSha };
}

function readEvidenceJson(root, ref, description, usedPaths) {
  const bytes = verifyEvidenceArtifact(root, ref, description, usedPaths, true);
  try {
    const parsed = JSON.parse(bytes.toString('utf8'));
    requireCondition(parsed && typeof parsed === 'object' && !Array.isArray(parsed), `${description} must contain a JSON object`);
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${description} must contain valid JSON`);
    throw error;
  }
}

export function validateManifest(manifest) {
  requireCondition(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'manifest must be an object');
  requireCondition(manifest.schemaVersion === 2, 'manifest.schemaVersion must be 2');
  requireCondition(manifest.manifestId === 'agentos-existing-project-acceptance-v2', 'manifestId is unsupported');
  requireCondition(manifest.status === 'runner-supported', 'manifest.status must be runner-supported');
  const modes = manifest.modes;
  requireCondition(modes && typeof modes === 'object' && !Array.isArray(modes), 'manifest.modes must be an object');
  requireCondition(
    modes['simulated-provider']?.providerExecution === 'simulated'
      && modes['simulated-provider']?.platform === 'any'
      && modes['simulated-provider']?.credentialBoundary === 'none',
    'simulated-provider mode must be explicitly credential-free and platform-neutral',
  );
  requireCondition(
    modes['real-windows-acceptance']?.providerExecution === 'real'
      && modes['real-windows-acceptance']?.platform === 'win32'
      && modes['real-windows-acceptance']?.credentialBoundary === 'operator-managed-outside-ci',
    'real-windows-acceptance must be separate, Windows-only, and outside CI',
  );

  const requirements = manifest.receiptRequirements;
  requireCondition(requirements?.repositoryCommitSha === 'full-40-character-git-sha', 'full repository commit SHA is required');
  requireCondition(requirements?.repositoryTreeSha === 'full-40-character-git-sha', 'full repository tree SHA is required');
  requireCondition(requirements?.actualCheckoutMustMatchExpectedSha === true, 'the checkout must match the externally supplied expected SHA');
  requireCondition(requirements?.immutableRepositorySnapshot === true, 'repository commit and tree must be identical at start and end');
  const project = requirements.projectRepository;
  requireCondition(project?.commitSha === 'full-40-character-git-commit-sha-in-runtime-repository'
    && project.treeSha === 'git-tree-resolved-from-project-commit'
    && project.defaultCommit === 'expected-runtime-sha'
    && project.distinctCommitRequiresExplicitProjectSha === true
    && project.receiptMustNotSelectProjectSha === true,
  'project identity must be supplied externally and bound to a real commit and its tree');
  requireCondition(sameArray(requirements?.modelFields, ['provider', 'id']), 'model provider and id are required');
  requireCondition(requirements.processExitCode === 0 && requirements.acceptanceExitCode === 0,
    'process and acceptance exits must both require 0');
  requireCondition(requirements.candidate?.artifactPath === 'runner-captured-runtime-diff',
    'candidate must be captured from the collaboration runtime');
  requireCondition(requirements.candidate?.hashAlgorithm === 'sha256-file-bytes-matching-runtime-database-diff',
    'candidate hash must match the persisted collaboration runtime diff');
  requireCondition(requirements.candidate?.hashFormat === '64-character-lowercase-hex', 'candidate hash format is unsupported');
  requireCondition(requirements.evidenceArtifacts?.artifactPath === 'repository-relative-worktree-file'
    && requirements.evidenceArtifacts?.hashAlgorithm === 'sha256-file-bytes'
    && requirements.evidenceArtifacts?.mustBeCommittedBeforeExecution === false,
  'execution evidence must be hash-checked without requiring it to be committed before execution');
  requireCondition(requirements.realPlanEvidence?.mode === 'real-windows-acceptance-only'
    && requirements.realPlanEvidence.artifactPath === 'plan/real-plan.json'
    && requirements.realPlanEvidence.hashAlgorithm === 'sha256-raw-plan-file-bytes'
    && requirements.realPlanEvidence.receiptMustMatchCapturedPlanFields === true,
  'real acceptance must preserve and bind the original raw plan bytes');
  requireCondition(requirements.baselineProbe?.sourcePathPrefix === 'agentos/scripts/fixtures/p4-memory-source-probes/'
    && requirements.baselineProbe.sourceMustBeCommittedAtProjectSha === true
    && requirements.baselineProbe.isolatedWorkspaceSourceMustBeTrackedAndClean === true
    && requirements.baselineProbe.runtimeCheckoutSourceMustBeCleanWhenProjectShaEqualsExpectedSha === true
    && sameArray(requirements.baselineProbe.sourceBindings,
      ['sourcePath', 'sourceSha256', 'sourceBlobSha', 'sourceCommitSha'])
    && requirements.baselineProbe.argvMustBeBoundAndIdenticalAcrossBaselineAndCandidate === true
    && requirements.baselineProbe.baselineRequiresNonzeroAndExpectedAssertionMarker === true
    && requirements.baselineProbe.candidateRequiresZeroAndPassMarker === true
    && requirements.baselineProbe.candidateRunsAgainstFrozenCandidatePatchOverlay === true
    && requirements.baselineProbe.externalArgvFilesRequireSha256 === true,
  'real baseline and candidate probes must be source-bound, reproducible, and exit-checked');

  const scenarios = requirements.scenarios;
  requireCondition(sameArray(scenarios?.exactKinds, scenarioKinds) && scenarios?.exactCount === scenarioKinds.length,
    'exactly one defect and one feature scenario are required');
  if (Object.hasOwn(scenarios, 'directApprovalAllowed')) {
    requireCondition(typeof scenarios.directApprovalAllowed === 'boolean',
      'scenarios.directApprovalAllowed must be a boolean');
  }
  if (Object.hasOwn(scenarios, 'minimumReworkScenarios')) {
    requireCondition(Number.isInteger(scenarios.minimumReworkScenarios)
      && scenarios.minimumReworkScenarios >= 1 && scenarios.minimumReworkScenarios <= scenarios.exactCount,
    'scenarios.minimumReworkScenarios must be between one and the exact scenario count');
  }
  if (scenarios.directApprovalAllowed === true) {
    requireCondition((scenarios.minimumReworkScenarios ?? scenarios.exactCount) >= 1,
      'direct approval requires at least one scenario with a complete rework history');
  }
  requireCondition(scenarios?.baselineReproduction === 'capture-declared-baseline-probes-separately-from-acceptance-commands-and-require-a-matching-nonzero-failure-on-the-frozen-base',
    'each scenario must reproduce its declared defect or feature gap on the frozen base');
  requireCondition(sameArray(scenarios?.requiredIdentityFields, identityFields), 'every scenario requires project, task, run, and candidate identities');
  requireCondition(sameArray(scenarios?.uniqueAcrossScenarios, ['taskId', 'runId', 'candidateId']),
    'task, run, and candidate identities must be distinct across scenarios');
  requireCondition(sameArray(scenarios?.requiredRoles, roleNames) && scenarios?.uniqueRoleIds === true,
    'planner, implementer, and reviewer identities must be distinct within each scenario');
  requireCondition(scenarios?.uniqueReviewEventIds === true, 'review event ids must be unique within each scenario');
  requireCondition(scenarios?.status === 'passed', 'each scenario must pass');
  requireCondition(sameArray(scenarios?.reviewTransitions, reviewTransitions),
    'review must include changes requested, revision submitted, and approval in order');
  requireCondition(sameArray(scenarios?.requiredCommandStages, commandStages),
    'each scenario must include retest, preview, and apply command artifacts');
  requireCondition(scenarios?.successfulExitCode === 0, 'all acceptance commands must exit 0');
  requireCondition(sameArray(scenarios?.commandArtifactFields, [
    'schemaVersion', 'kind', 'scenarioId', 'stage', 'commandId', 'argv', 'cwd', 'rawExitCode',
    'expectedExitCode', 'frozenCandidateSha256', 'stdout', 'stderr', 'stageResult', 'observedAt',
  ]), 'command artifacts must carry the complete structured execution record');

  requireCondition(requirements.trust?.receiptSignature === 'not-required'
    && requirements.trust?.acceptanceVerdict === 'requires-local-runtime-database-verification',
  'receipts must use local runtime evidence; no external signature is required');
  return manifest;
}

function verifyRepositorySnapshot(root, receipt, expectedSha) {
  requireCondition(typeof expectedSha === 'string' && shaPattern.test(expectedSha), '--expected-sha must be a full 40-character Git SHA');
  const snapshot = verifySourceSnapshot(root);
  const rootReal = snapshot.root;
  const actualCommit = snapshot.commitSha;
  requireCondition(actualCommit.toLowerCase() === expectedSha.toLowerCase(), 'actual checkout HEAD does not match --expected-sha');
  const actualTree = snapshot.treeSha;

  const repository = receipt.repository;
  requireCondition(repository?.commitSha?.toLowerCase() === actualCommit.toLowerCase()
    && repository?.treeSha?.toLowerCase() === actualTree.toLowerCase(),
  'receipt commit/tree do not match the actual frozen Git checkout');
  requireCondition(repository?.commitShaAtStart?.toLowerCase() === actualCommit.toLowerCase()
    && repository?.commitShaAtEnd?.toLowerCase() === actualCommit.toLowerCase()
    && repository?.treeShaAtStart?.toLowerCase() === actualTree.toLowerCase()
    && repository?.treeShaAtEnd?.toLowerCase() === actualTree.toLowerCase(),
  'receipt start/end commit and tree must match the actual frozen Git checkout');
  return { root: rootReal, commitSha: actualCommit, treeSha: actualTree };
}

function validateReviewHistory(root, scenario, priorCandidateSha, frozenCandidateSha, usedPaths, directApprovalAllowed) {
  const history = scenario.reviewHistory;
  const directApproval = Array.isArray(history) && history.length === 1;
  requireCondition(Array.isArray(history)
    && (history.length === reviewTransitions.length || directApproval)
    && (!directApproval || directApprovalAllowed),
  `scenario ${scenario.kind} must include a permitted direct approval or the complete review history`);
  const transitions = directApproval ? ['approved'] : reviewTransitions;
  const eventIds = new Set();
  const requestId = history[0]?.id;
  for (const [index, event] of history.entries()) {
    const transition = transitions[index];
    requireCondition(event?.transition === transition, `scenario ${scenario.kind} review history must include ${transition} in order`);
    requireCondition(nonEmpty(event.id) && !eventIds.has(event.id),
      `scenario ${scenario.kind} review history event ids must be present and unique`);
    eventIds.add(event.id);
    requireCondition(isIsoDate(event.timestamp), `scenario ${scenario.kind} review event ${transition} requires an ISO timestamp`);
    if (index > 0) requireCondition(Date.parse(event.timestamp) >= Date.parse(history[index - 1].timestamp),
      `scenario ${scenario.kind} review history timestamps must not go backwards`);

    const isReviewerEvent = transition !== 'revision-submitted';
    const expectedRole = isReviewerEvent ? 'reviewer' : 'implementer';
    const expectedActor = scenario.roles[expectedRole];
    requireCondition(event.actorRole === expectedRole && event.actorId === expectedActor,
      `scenario ${scenario.kind} ${transition} must be attributed to its ${expectedRole}`);

    if (transition === 'changes-requested') {
      requireCondition(event.candidateSha256 === priorCandidateSha,
        `scenario ${scenario.kind} change request must identify the pre-revision candidate hash`);
      requireCondition(Array.isArray(event.requestedChanges) && event.requestedChanges.length > 0 && event.requestedChanges.every(nonEmpty),
        `scenario ${scenario.kind} reviewer must record concrete requested changes`);
    } else if (transition === 'revision-submitted') {
      requireCondition(event.fromCandidateSha256 === priorCandidateSha && event.toCandidateSha256 === frozenCandidateSha
        && event.fromCandidateSha256 !== event.toCandidateSha256,
      `scenario ${scenario.kind} revision must change the requested candidate hash`);
      requireCondition(event.addressedReviewEventId === requestId,
        `scenario ${scenario.kind} revision must address the recorded change request`);
      requireCondition(Array.isArray(event.changedPaths) && event.changedPaths.length > 0 && event.changedPaths.every(nonEmpty),
        `scenario ${scenario.kind} revision must identify changed paths`);
    } else {
      requireCondition(event.candidateSha256 === frozenCandidateSha && event.decision === 'approved',
        `scenario ${scenario.kind} approval must apply to the final frozen candidate`);
    }

    const document = readEvidenceJson(root, event.evidence,
      `scenario ${scenario.kind} ${transition} evidence`, usedPaths);
    requireCondition(document.schemaVersion === 1 && document.kind === 'review-history-event'
      && document.scenarioId === scenario.id && document.eventId === event.id
      && document.transition === event.transition && document.actorRole === event.actorRole
      && document.actorId === event.actorId && document.timestamp === event.timestamp,
    `scenario ${scenario.kind} ${transition} evidence does not match its receipt entry`);
    if (transition === 'changes-requested') {
      requireCondition(document.candidateSha256 === event.candidateSha256
        && JSON.stringify(document.requestedChanges) === JSON.stringify(event.requestedChanges),
      `scenario ${scenario.kind} change-request evidence is inconsistent`);
    } else if (transition === 'revision-submitted') {
      requireCondition(document.fromCandidateSha256 === event.fromCandidateSha256
        && document.toCandidateSha256 === event.toCandidateSha256
        && document.addressedReviewEventId === event.addressedReviewEventId
        && JSON.stringify(document.changedPaths) === JSON.stringify(event.changedPaths),
      `scenario ${scenario.kind} revision evidence is inconsistent`);
    } else {
      requireCondition(document.candidateSha256 === event.candidateSha256 && document.decision === event.decision,
        `scenario ${scenario.kind} approval evidence is inconsistent`);
    }
  }
}

function validateStageResult(stage, result, frozenCandidateSha, scenarioKind) {
  requireCondition(result && typeof result === 'object' && !Array.isArray(result), `${stage} stageResult is required`);
  if (stage === 'retest') {
    requireCondition(result.status === 'passed' && nonEmpty(result.testRunId)
      && Number.isInteger(result.commandCount) && result.commandCount > 0
      && result.rawExitCode === 0,
    `${scenarioKind} retest must record a successful acceptance command`);
  } else if (stage === 'preview') {
    requireCondition(result.status === 'ready' && nonEmpty(result.previewId)
      && result.candidateSha256 === frozenCandidateSha,
    `${scenarioKind} preview must be ready for the final frozen candidate`);
  } else {
    requireCondition(result.status === 'applied' && nonEmpty(result.applicationId)
      && result.candidateSha256 === frozenCandidateSha,
    `${scenarioKind} apply evidence must identify the applied frozen candidate`);
  }
}

function validateCommands(root, scenario, frozenCandidateSha, usedPaths) {
  requireCondition(Array.isArray(scenario.commands) && scenario.commands.length === commandStages.length,
    `scenario ${scenario.kind} must include retest, preview, and apply commands`);
  const commandIds = new Set();
  for (const [index, stage] of commandStages.entries()) {
    const command = scenario.commands[index];
    requireCondition(command?.stage === stage, `scenario ${scenario.kind} commands must include ${stage} in order`);
    requireCondition(nonEmpty(command.id) && !commandIds.has(command.id),
      `scenario ${scenario.kind} command ids must be present and unique`);
    commandIds.add(command.id);
    requireCondition(Array.isArray(command.argv) && command.argv.length > 0 && command.argv.every(nonEmpty),
      `scenario ${scenario.kind} ${stage} requires the actual argument vector`);
    requireCondition(nonEmpty(command.cwd), `scenario ${scenario.kind} ${stage} requires a working directory`);
    requireCondition(command.expectedExitCode === 0 && command.rawExitCode === command.expectedExitCode,
      `scenario ${scenario.kind} ${stage} command did not exit successfully`);
    requireCondition(command.frozenCandidateSha256 === frozenCandidateSha,
      `scenario ${scenario.kind} ${stage} is not bound to the final frozen candidate hash`);

    const record = readEvidenceJson(root, command.artifact,
      `scenario ${scenario.kind} ${stage} command artifact`, usedPaths);
    requireCondition(record.schemaVersion === 1 && record.kind === 'acceptance-command'
      && record.scenarioId === scenario.id && record.stage === stage && record.commandId === command.id
      && JSON.stringify(record.argv) === JSON.stringify(command.argv) && record.cwd === command.cwd
      && record.rawExitCode === command.rawExitCode && record.expectedExitCode === command.expectedExitCode
      && record.frozenCandidateSha256 === frozenCandidateSha,
    `scenario ${scenario.kind} ${stage} command artifact does not match its receipt entry`);
    requireCondition(isIsoDate(record.observedAt),
      `scenario ${scenario.kind} ${stage} command artifact requires a valid observation timestamp`);
    validateStageResult(stage, record.stageResult, frozenCandidateSha, scenario.kind);

    const stdout = verifyEvidenceArtifact(root, record.stdout,
      `scenario ${scenario.kind} ${stage} stdout`, usedPaths, true).toString('utf8');
    verifyEvidenceArtifact(root, record.stderr,
      `scenario ${scenario.kind} ${stage} stderr`, usedPaths);
    requireCondition(stdout.includes(command.id) && stdout.includes(frozenCandidateSha),
      `scenario ${scenario.kind} ${stage} captured stdout must identify the command and frozen hash`);
    if (stage === 'retest' && scenario.baselineProbe) {
      let outputRecord;
      try { outputRecord = JSON.parse(stdout); }
      catch { throw new Error(`scenario ${scenario.kind} retest stdout must be structured JSON`); }
      requireCondition(outputRecord.commandId === command.id
        && outputRecord.frozenCandidateSha256 === frozenCandidateSha
        && outputRecord.outputSha256 === sha256(Buffer.from(outputRecord.output ?? '', 'utf8')),
      `scenario ${scenario.kind} retest stdout is not bound to the frozen candidate`);
      verifyProbeCandidateOutput(scenario, outputRecord.output);
    }
  }
}

function validateBaselineReproduction(root, scenario, frozenSourceSha, usedPaths, repositoryRootPath) {
  const baseline = scenario.baselineReproduction;
  if (scenario.baselineProbe) {
    requireCondition(baseline?.expectedFailurePattern === scenario.expectedBaselineFailure,
      `real ${scenario.kind} baseline failure marker differs from the captured plan`);
    const actualGitlinks = frozenAcceptanceGitlinkPaths(repositoryRootPath, frozenSourceSha);
    requireCondition(Array.isArray(baseline.excludedGitlinkPaths)
      && JSON.stringify(baseline.excludedGitlinkPaths) === JSON.stringify(actualGitlinks),
    `real ${scenario.kind} baseline excluded Gitlinks differ from the frozen source tree`);
  }
  requireCondition(baseline?.status === 'reproduced' && nonEmpty(baseline.expectedFailurePattern)
    && shaPattern.test(baseline.baseCommit ?? '') && shaPattern.test(baseline.baseTreeSha ?? '')
    && baseline.sourceCommitSha?.toLowerCase() === frozenSourceSha.toLowerCase()
    && baseline.baseParentCommitSha?.toLowerCase() === frozenSourceSha.toLowerCase(),
  `scenario ${scenario.kind} requires a baseline failure on a workspace based on the frozen source commit`);
  requireCondition(Array.isArray(scenario.baselineCommands) && scenario.baselineCommands.length > 0
    && scenario.baselineCommands.every(nonEmpty) && Array.isArray(scenario.acceptanceCommands)
    && scenario.acceptanceCommands.length > 0 && scenario.acceptanceCommands.every(nonEmpty)
    && Array.isArray(baseline.commands) && baseline.commands.length === scenario.baselineCommands.length,
  `scenario ${scenario.kind} baseline must run every separately declared baseline probe`);
  requireCondition(JSON.stringify(scenario.commands?.[0]?.argv) === JSON.stringify(scenario.acceptanceCommands),
    `scenario ${scenario.kind} retest must execute the exact declared acceptance commands`);
  let matchingFailure = false;
  for (const [index, command] of baseline.commands.entries()) {
    requireCondition(command.command === scenario.baselineCommands[index] && nonEmpty(command.id)
      && Number.isInteger(command.rawExitCode),
    `scenario ${scenario.kind} baseline command identity or exit code is incomplete`);
    const record = readEvidenceJson(root, command.artifact, `scenario ${scenario.kind} baseline command`, usedPaths);
    requireCondition(record.schemaVersion === 1 && record.kind === 'baseline-command'
      && record.scenarioKind === scenario.kind && record.commandId === command.id
      && record.command === command.command && record.rawExitCode === command.rawExitCode
      && record.expectedOutcome === 'nonzero-reproduction'
      && record.expectedFailurePattern === baseline.expectedFailurePattern
      && record.workspaceBaseCommit === baseline.baseCommit && record.workspaceBaseTreeSha === baseline.baseTreeSha
      && record.sourceCommitSha === baseline.sourceCommitSha && record.baseParentCommitSha === baseline.baseParentCommitSha
      && (!scenario.baselineProbe || JSON.stringify(record.excludedGitlinkPaths) === JSON.stringify(baseline.excludedGitlinkPaths))
      && isIsoDate(record.observedAt),
    `scenario ${scenario.kind} baseline command artifact does not match the receipt`);
    const stdout = verifyEvidenceArtifact(root, record.stdout, `scenario ${scenario.kind} baseline stdout`, usedPaths).toString('utf8');
    const stderr = verifyEvidenceArtifact(root, record.stderr, `scenario ${scenario.kind} baseline stderr`, usedPaths).toString('utf8');
    if (scenario.baselineProbe && command.command === scenario.baselineProbe.command) {
      verifyProbeBaselineRecord(scenario, record, stdout, stderr);
      matchingFailure = true;
    } else if (command.rawExitCode !== 0 && `${stdout}\n${stderr}`.includes(baseline.expectedFailurePattern)) {
      matchingFailure = true;
    }
  }
  requireCondition(matchingFailure, `scenario ${scenario.kind} must capture its expected baseline failure with a nonzero exit`);
}

function validateRealPlanEvidence(root, receipt, snapshot, usedPaths, suppliedPlanBytes) {
  const planEvidence = receipt.realPlanEvidence;
  requireCondition(planEvidence?.kind === 'real-plan' && typeof planEvidence.sha256 === 'string'
    && hashPattern.test(planEvidence.sha256) && planEvidence.artifact?.sha256 === planEvidence.sha256
    && planEvidence.artifact.artifactPath === 'plan/real-plan.json',
  'real acceptance receipt must bind the exact raw plan bytes');
  const planBytes = verifyEvidenceArtifact(root, planEvidence.artifact,
    'real acceptance plan bytes', usedPaths, true);
  requireCondition(sha256(planBytes) === planEvidence.sha256,
    'real acceptance plan SHA-256 does not match its captured bytes');
  const parsedPlan = verifyRealPlanReceiptBinding(receipt, planBytes, suppliedPlanBytes);
  requireCondition(parsedPlan.scenarios.length === scenarioKinds.length,
    'captured real plan must contain exactly two defect/feature scenarios');
  for (const planned of parsedPlan.scenarios) {
    requireCondition(scenarioKinds.includes(planned.kind), 'captured real plan contains an unsupported scenario kind');
    verifyPlanProbeSource(planned, snapshot.root, snapshot.commitSha);
  }
}

/** Recompute the final candidate path inventory during offline receipt validation. */
export function verifyFinalCandidateScope(repositoryRootPath, scope, patchBytes) {
  const root = realpathSync(repositoryRootPath);
  const candidatePatchBytes = Buffer.isBuffer(patchBytes) ? patchBytes : Buffer.from(patchBytes ?? '');
  requireCondition(Array.isArray(scope) && scope.length > 0,
    'frozen real plan must declare a nonempty candidate scope');
  requireCondition(candidatePatchBytes.length > 0,
    'final candidate patch does not identify a nonempty unique changed-path set');
  const normalizedScopes = [];
  let existingAnchor = false;
  for (const rawPath of scope) {
    requireCondition(typeof rawPath === 'string' && rawPath.length > 0,
      'frozen candidate scope entries must be nonempty paths');
    const scopedPath = rawPath.replaceAll('\\', '/');
    requireCondition(!scopedPath.startsWith('/') && !/^[a-z]:/iu.test(scopedPath)
      && !/[\u0000-\u001f\u007f]/u.test(scopedPath)
      && !scopedPath.split('/').some(part => !part || part === '.' || part === '..')
      && /^agentos\/(?:apps|packages)\//iu.test(scopedPath)
      && !/(?:^|\/)fixtures\/p4-existing-project-acceptance(?:\/|$)/iu.test(scopedPath),
    'frozen candidate scope must use safe repository-relative AgentOS source paths');
    const absolute = resolve(root, scopedPath);
    const lexicalRelative = relative(root, absolute);
    requireCondition(lexicalRelative !== '..' && !lexicalRelative.startsWith(`..${sep}`)
      && !isAbsolute(lexicalRelative), 'frozen candidate scope escapes the repository');
    if (existsSync(absolute)) {
      requireCondition(!lstatSync(absolute).isSymbolicLink(),
        'frozen candidate scope cannot traverse a symbolic link');
      const actual = realpathSync(absolute);
      const actualRelative = relative(root, actual);
      requireCondition(actualRelative !== '..' && !actualRelative.startsWith(`..${sep}`)
        && !isAbsolute(actualRelative), 'frozen candidate scope resolves outside the repository');
      existingAnchor = true;
    }
    normalizedScopes.push(scopedPath.replace(/\/$/u, ''));
  }
  requireCondition(existingAnchor,
    'frozen candidate scope must anchor to an existing AgentOS source path');

  let numstat;
  try {
    numstat = execFileSync('git', ['-C', root, 'apply', '--numstat', '-'], {
      input: candidatePatchBytes,
      encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`final candidate patch path inventory could not be parsed: ${String(error?.stderr || error?.message || error).slice(0, 2000)}`);
  }
  const changedPaths = numstat.split(/\r?\n/u).filter(Boolean).map(line => {
    const fields = line.split('\t');
    requireCondition(fields.length === 3 && fields[2].length > 0,
      'final candidate patch contains an unsupported path entry');
    return fields[2].replaceAll('\\', '/');
  });
  requireCondition(changedPaths.length > 0 && new Set(changedPaths).size === changedPaths.length,
    'final candidate patch does not identify a nonempty unique changed-path set');
  requireCondition(changedPaths.every(changedPath => normalizedScopes.some(scopedPath =>
    changedPath === scopedPath || changedPath.startsWith(`${scopedPath}/`))),
  'final candidate patch contains a path outside the frozen plan scope');
  return changedPaths;
}

/** Independently derive the candidate tree from the frozen source and patch using a disposable index. */
export function deriveCandidateProbeOverlayTreeSha(repositoryRootPath, scenario, patchBytes) {
  const root = realpathSync(repositoryRootPath);
  const baseline = scenario?.baselineReproduction;
  const patch = Buffer.isBuffer(patchBytes) ? patchBytes : Buffer.from(patchBytes ?? '');
  requireCondition(patch.length > 0, 'cannot derive a candidate overlay tree from an empty patch');
  requireCondition(shaPattern.test(baseline?.sourceCommitSha ?? '')
    && shaPattern.test(baseline?.baseParentCommitSha ?? '')
    && shaPattern.test(baseline?.baseCommit ?? '') && shaPattern.test(baseline?.baseTreeSha ?? '')
    && shaPattern.test(scenario?.workspaceBaseCommit ?? '') && shaPattern.test(scenario?.workspaceBaseTreeSha ?? '')
    && baseline.baseParentCommitSha.toLowerCase() === baseline.sourceCommitSha.toLowerCase()
    && baseline.baseCommit.toLowerCase() === scenario.workspaceBaseCommit.toLowerCase()
    && baseline.baseTreeSha.toLowerCase() === scenario.workspaceBaseTreeSha.toLowerCase(),
  `real ${scenario?.kind ?? 'scenario'} candidate base is not bound to its frozen source snapshot`);
  const excludedGitlinks = baseline.excludedGitlinkPaths;
  const actualGitlinks = frozenAcceptanceGitlinkPaths(root, baseline.sourceCommitSha);
  requireCondition(Array.isArray(excludedGitlinks)
    && JSON.stringify(excludedGitlinks) === JSON.stringify(actualGitlinks),
  `real ${scenario.kind} candidate base omitted Gitlinks not excluded by the frozen runner rules`);
  if (excludedGitlinks.length === 0) {
    requireCondition(scenario.workspaceBaseCommit.toLowerCase() === baseline.sourceCommitSha.toLowerCase(),
      `real ${scenario.kind} candidate base commit differs from its frozen source without an excluded Gitlink`);
  }

  const temporaryRoot = process.platform === 'win32' ? realpathSync.native(tmpdir()) : tmpdir();
  const indexRoot = mkdtempSync(join(temporaryRoot, 'agentos-p4-overlay-index-'));
  try {
    const indexPath = join(indexRoot, 'index');
    const objectPath = join(indexRoot, 'objects');
    mkdirSync(objectPath);
    const discoveryEnv = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
      'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX', 'GIT_NAMESPACE']) delete discoveryEnv[key];
    const repositoryObjects = execFileSync('git', ['-C', root, 'rev-parse', '--git-path', 'objects'], {
      env: discoveryEnv, encoding: 'utf8', windowsHide: true, timeout: 15_000,
    }).trim();
    const absoluteRepositoryObjects = isAbsolute(repositoryObjects) ? repositoryObjects : resolve(root, repositoryObjects);
    const inheritedAlternates = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    const alternates = [realpathSync(absoluteRepositoryObjects), inheritedAlternates]
      .filter(Boolean).join(pathDelimiter);
    const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
      'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX', 'GIT_NAMESPACE']) delete env[key];
    Object.assign(env, {
      GIT_INDEX_FILE: indexPath,
      GIT_OBJECT_DIRECTORY: objectPath,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates,
    });
    const runGit = (args, input) => {
      try {
        return execFileSync('git', ['-C', root, ...args], {
          ...(input === undefined ? {} : { input }),
          env, encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
        }).trim();
      } catch (error) {
        const wrapped = new Error(`bounded temporary-index git ${args[0]} failed: ${String(error?.stderr || error?.message || error).slice(0, 2000)}`);
        wrapped.status = error?.status;
        wrapped.stderr = error?.stderr;
        throw wrapped;
      }
    };
    const frozenSourceHead = runGit(['rev-parse', 'HEAD']);
    requireCondition(frozenSourceHead.toLowerCase() === baseline.sourceCommitSha.toLowerCase(),
      `real ${scenario.kind} frozen source HEAD changed before overlay derivation`);
    runGit(['read-tree', baseline.sourceCommitSha]);
    if (excludedGitlinks.length) runGit(['update-index', '--force-remove', '--', ...excludedGitlinks]);
    const derivedBaseTreeSha = runGit(['write-tree']);
    requireCondition(derivedBaseTreeSha.toLowerCase() === scenario.workspaceBaseTreeSha.toLowerCase(),
      `real ${scenario.kind} baseline tree cannot be derived from its frozen source and excluded Gitlinks`);
    // The runner's gitlink-filtered baseline is a disposable synthetic commit
    // that need not exist in the receipt repository. Use it directly when
    // present; otherwise read the independently verified frozen tree.
    const workspaceCommitProbe = spawnSync('git', ['-C', root, 'cat-file', '-e', `${scenario.workspaceBaseCommit}^{commit}`], {
      env, encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024,
    });
    if (workspaceCommitProbe.error) {
      throw new Error(`bounded temporary-index git cat-file failed: ${workspaceCommitProbe.error.message}`);
    }
    const workspaceCommitExists = workspaceCommitProbe.status === 0;
    if (!workspaceCommitExists) {
      const missingSyntheticCommit = workspaceCommitProbe.status === 128
        && /not a valid object name|could not get object info|bad object/iu.test(workspaceCommitProbe.stderr);
      requireCondition(excludedGitlinks.length > 0 && missingSyntheticCommit,
        `real ${scenario.kind} workspace base commit is unavailable from the frozen source object store`);
    }
    if (workspaceCommitExists) {
      const ancestry = runGit(['rev-list', '--parents', '-n', '1', scenario.workspaceBaseCommit]).split(/\s+/u);
      requireCondition(ancestry[0]?.toLowerCase() === scenario.workspaceBaseCommit.toLowerCase()
        && (excludedGitlinks.length === 0
          ? scenario.workspaceBaseCommit.toLowerCase() === baseline.sourceCommitSha.toLowerCase()
          : ancestry[1]?.toLowerCase() === baseline.sourceCommitSha.toLowerCase() && ancestry.length === 2),
      `real ${scenario.kind} workspace base commit does not descend directly from the frozen source`);
      runGit(['read-tree', scenario.workspaceBaseCommit]);
    } else {
      runGit(['read-tree', derivedBaseTreeSha]);
    }
    requireCondition(runGit(['write-tree']).toLowerCase() === scenario.workspaceBaseTreeSha.toLowerCase(),
      `real ${scenario.kind} workspace base commit/tree cannot be independently verified`);
    try {
      runGit(['apply', '--cached', '--whitespace=nowarn', '-'], patch);
    } catch (error) {
      throw new Error(`real ${scenario.kind} frozen candidate patch does not apply to its independently derived base: ${String(error?.stderr || error?.message || error).slice(0, 2000)}`);
    }
    return runGit(['write-tree']);
  } finally {
    rmSync(indexRoot, { recursive: true, force: true, maxRetries: 16, retryDelay: 100 });
  }
}

/** Cross-bind the candidate probe cwd and independently derived overlay tree to its receipt entry. */
export function verifyCandidateProbeExecutionBinding(scenario, record, repositoryRootPath, patchBytes) {
  const binding = scenario?.candidateProbe;
  requireCondition(binding && typeof binding === 'object' && !Array.isArray(binding),
    `real ${scenario?.kind ?? 'scenario'} candidate probe execution identity is required`);
  requireCondition(typeof binding.executionRoot === 'string' && isAbsolute(binding.executionRoot)
    && resolve(binding.executionRoot) === binding.executionRoot
    && record.executionRoot === binding.executionRoot && record.cwd === binding.executionRoot,
  `real ${scenario.kind} candidate probe execution root differs from its captured cwd`);
  requireCondition(shaPattern.test(scenario.workspaceBaseCommit ?? '')
    && binding.workspaceBaseCommit?.toLowerCase() === scenario.workspaceBaseCommit.toLowerCase()
    && record.workspaceBaseCommit?.toLowerCase() === scenario.workspaceBaseCommit.toLowerCase()
    && shaPattern.test(scenario.workspaceBaseTreeSha ?? '')
    && binding.workspaceBaseTreeSha?.toLowerCase() === scenario.workspaceBaseTreeSha.toLowerCase()
    && record.workspaceBaseTreeSha?.toLowerCase() === scenario.workspaceBaseTreeSha.toLowerCase(),
  `real ${scenario.kind} candidate probe base commit/tree differs from the frozen workspace`);
  requireCondition(shaPattern.test(binding.candidateOverlayTreeSha ?? '')
    && record.candidateOverlayTreeSha?.toLowerCase() === binding.candidateOverlayTreeSha.toLowerCase(),
  `real ${scenario.kind} candidate probe overlay tree differs from its captured execution`);
  const independentlyDerivedTreeSha = deriveCandidateProbeOverlayTreeSha(repositoryRootPath, scenario, patchBytes);
  requireCondition(binding.candidateOverlayTreeSha.toLowerCase() === independentlyDerivedTreeSha.toLowerCase()
    && record.candidateOverlayTreeSha.toLowerCase() === independentlyDerivedTreeSha.toLowerCase(),
  `real ${scenario.kind} candidate probe overlay tree differs from the independently derived frozen candidate`);
}

function validateCandidateProbeEvidence(root, repositoryRootPath, receipt, scenario, usedPaths, patchBytes) {
  requireCondition(scenario.baselineProbe && scenario.candidateProbe,
    `real ${scenario.kind} scenario requires source-bound baseline and candidate probe evidence`);
  requireCondition(scenario.baselineProbe.sourceCommitSha?.toLowerCase() === receipt.repository.commitSha.toLowerCase(),
    `real ${scenario.kind} baseline probe sourceCommit must match the receipt frozen SHA`);
  const candidateEvidence = scenario.candidateProbe;
  requireCondition(nonEmpty(candidateEvidence.commandId) && candidateEvidence.artifact,
    `real ${scenario.kind} candidate probe command and artifact are required`);
  const record = readEvidenceJson(root, candidateEvidence.artifact,
    `real ${scenario.kind} candidate probe command`, usedPaths);
  requireCondition(record.schemaVersion === 1 && record.kind === 'candidate-probe-command'
    && record.scenarioKind === scenario.kind && record.commandId === candidateEvidence.commandId
    && record.command === candidateEvidence.command && JSON.stringify(record.argv) === JSON.stringify(candidateEvidence.argv)
    && record.argvSha256 === candidateEvidence.argvSha256
    && candidateEvidence.command === scenario.baselineProbe.command
    && JSON.stringify(candidateEvidence.argv) === JSON.stringify(scenario.baselineProbe.argv)
    && candidateEvidence.argvSha256 === scenario.baselineProbe.argvSha256
    && record.rawExitCode === candidateEvidence.rawExitCode
    && record.candidateSha256 === candidateEvidence.candidateSha256
    && record.sourcePath === scenario.baselineProbe.sourcePath
    && record.sourceSha256 === scenario.baselineProbe.sourceSha256
    && record.sourceBlobSha === scenario.baselineProbe.sourceBlobSha
    && record.sourceCommitSha === scenario.baselineProbe.sourceCommitSha
    && record.workspaceBaseCommit === scenario.workspaceBaseCommit
    && record.workspaceKind === 'frozen-candidate-overlay'
    && isIsoDate(record.observedAt),
  `real ${scenario.kind} candidate probe artifact differs from its receipt binding`);
  verifyCandidateProbeExecutionBinding(scenario, record, repositoryRootPath, patchBytes);
  const stdout = verifyEvidenceArtifact(root, record.stdout,
    `real ${scenario.kind} candidate probe stdout`, usedPaths, true).toString('utf8');
  verifyEvidenceArtifact(root, record.stderr,
    `real ${scenario.kind} candidate probe stderr`, usedPaths);
  verifyProbeCandidateRecord(scenario, record, stdout, scenario.frozenCandidate.sha256);
  requireCondition(candidateEvidence.rawExitCode === 0
    && candidateEvidence.candidateSha256 === scenario.frozenCandidate.sha256,
  `real ${scenario.kind} candidate probe must pass against the final frozen candidate`);
}

export function validateReceipt(manifest, receipt, options = {}) {
  validateManifest(manifest);
  requireCondition(receipt && typeof receipt === 'object' && !Array.isArray(receipt), 'receipt must be an object');
  requireCondition(receipt.schemaVersion === 2, 'receipt.schemaVersion must be 2');
  requireCondition(receipt.manifestId === manifest.manifestId, 'receipt manifestId does not match');

  requireCondition(typeof receipt.mode === 'string' && Object.hasOwn(manifest.modes, receipt.mode),
    'unsupported acceptance mode: ' + String(receipt.mode));
  const mode = manifest.modes[receipt.mode];
  requireCondition(receipt.providerExecution === mode.providerExecution, 'provider execution type does not match the selected mode');
  requireCondition(receipt.credentialBoundary === mode.credentialBoundary, 'credential boundary does not match the selected mode');
  requireCondition(mode.platform === 'any' || receipt.platform === mode.platform, `mode ${receipt.mode} requires platform ${mode.platform}`);
  const providerEvidence = receipt.providerEvidence;
  if (receipt.mode === 'simulated-provider') {
    requireCondition(providerEvidence?.kind === SIMULATED_CODEX_PROVIDER_KIND
      && receipt.model?.provider === 'fixture-provider',
    'simulated-provider receipts must identify the deterministic fixture and fixture model');
  } else {
    requireCondition(providerEvidence?.kind === OFFICIAL_CODEX_PROVIDER_KIND
      && receipt.model?.provider === 'codex',
    'real acceptance rejects fixture/simulated Provider evidence and requires the official npm Codex identity');
    requireCondition(providerEvidence.trustBoundary === OFFICIAL_CODEX_TRUST_BOUNDARY,
      'real acceptance Provider identity must declare the local-operator trust boundary');
  }
  if (receipt.mode === 'real-windows-acceptance') {
    requireCondition(process.env.CI?.toLowerCase() !== 'true', 'real-windows-acceptance receipts cannot be captured or validated inside CI');
    requireCondition(process.platform === 'win32', 'real-windows-acceptance receipts can only be validated on Windows');
    verifyOfficialCodexIdentity(providerEvidence);
  }

  const expectedSha = options.expectedSha;
  const root = options.repositoryRoot ?? repositoryRoot;
  const snapshot = verifyRepositorySnapshot(root, receipt, expectedSha);
  if (receipt.mode === 'real-windows-acceptance') {
    requireCondition(options.evidenceRoot, 'real acceptance receipt validation requires its evidence directory');
  } else {
    requireCondition(receipt.realPlanEvidence === undefined,
      'simulated-provider receipts cannot claim real plan or real source-probe evidence');
  }
  for (const field of manifest.receiptRequirements.modelFields) {
    requireCondition(nonEmpty(receipt.model?.[field]), `receipt.model.${field} is required`);
  }
  requireCondition(receipt.processExitCode === 0 && receipt.acceptanceExitCode === 0,
    'process and acceptance exits must both be 0');

  const scenarios = manifest.receiptRequirements.scenarios;
  requireCondition(Array.isArray(receipt.scenarios) && receipt.scenarios.length === scenarios.exactCount,
    'receipt must contain exactly one defect and one feature scenario');
  const idsSeen = Object.fromEntries(scenarios.uniqueAcrossScenarios.map(field => [field, new Set()]));
  const scenarioIdsSeen = new Set();
  const scenarioKindsSeen = new Set();
  const usedPaths = new Set();
  const evidenceRoot = options.evidenceRoot ?? root;
  if (receipt.mode === 'real-windows-acceptance') {
    validateRealPlanEvidence(evidenceRoot, receipt, snapshot, usedPaths, options.realPlanBytes);
  }
  let reworkScenarioCount = 0;

  for (const scenario of receipt.scenarios) {
    requireCondition(scenario && typeof scenario === 'object' && !Array.isArray(scenario), 'each scenario must be an object');
    requireCondition(nonEmpty(scenario.id) && !scenarioIdsSeen.has(scenario.id), 'scenario ids must be present and unique');
    scenarioIdsSeen.add(scenario.id);
    requireCondition(scenarios.exactKinds.includes(scenario.kind) && !scenarioKindsSeen.has(scenario.kind),
      `scenario kind must be exactly one of: ${scenarios.exactKinds.join(', ')}`);
    scenarioKindsSeen.add(scenario.kind);
    requireCondition(scenario.status === scenarios.status, `scenario ${scenario.kind} did not pass`);

    for (const field of scenarios.requiredIdentityFields) {
      requireCondition(nonEmpty(scenario.ids?.[field]), `scenario ${scenario.kind} ids.${field} is required`);
    }
    for (const field of scenarios.uniqueAcrossScenarios) {
      requireCondition(!idsSeen[field].has(scenario.ids[field]), `scenario ${scenario.kind} ids.${field} must be unique across scenarios`);
      idsSeen[field].add(scenario.ids[field]);
    }
    const roleIds = scenarios.requiredRoles.map(role => scenario.roles?.[role]);
    requireCondition(roleIds.every(nonEmpty) && new Set(roleIds).size === roleIds.length,
      `scenario ${scenario.kind} requires distinct planner, implementer, and reviewer ids`);

    const candidate = scenario.frozenCandidate;
    requireCondition(candidate && typeof candidate === 'object' && shaPattern.test(candidate.commitSha ?? '')
      && candidate.commitSha.toLowerCase() === snapshot.commitSha.toLowerCase()
      && shaPattern.test(candidate.treeSha ?? '') && candidate.treeSha.toLowerCase() === snapshot.treeSha.toLowerCase(),
    `scenario ${scenario.kind} frozen candidate must name the actual checkout commit and tree`);
    requireCondition(typeof candidate.sha256 === 'string' && hashPattern.test(candidate.sha256),
      `scenario ${scenario.kind} frozen candidate requires a lowercase SHA-256`);
  const candidateBytes = verifyEvidenceArtifact(evidenceRoot, candidate,
    `scenario ${scenario.kind} frozen candidate`, usedPaths, true);
    const finalCandidateSha = sha256(candidateBytes);

    if (receipt.mode === 'real-windows-acceptance') {
      verifyFinalCandidateScope(root, scenario.scope, candidateBytes);
      validateCandidateProbeEvidence(evidenceRoot, root, receipt, scenario, usedPaths, candidateBytes);
    } else {
      requireCondition(scenario.baselineProbe === undefined && scenario.candidateProbe === undefined,
        'simulated-provider scenarios cannot claim real source-probe evidence');
    }
    validateBaselineReproduction(evidenceRoot, scenario, snapshot.commitSha, usedPaths, root);

    const directApproval = Array.isArray(scenario.reviewHistory) && scenario.reviewHistory.length === 1;
    const directApprovalAllowed = scenarios.directApprovalAllowed === true;
    let priorCandidateSha;
    if (directApproval) {
      requireCondition(directApprovalAllowed && scenario.priorCandidate === undefined,
        `scenario ${scenario.kind} direct approval must be enabled and omit priorCandidate`);
    } else {
      const priorCandidate = scenario.priorCandidate;
      requireCondition(priorCandidate && typeof priorCandidate === 'object'
        && typeof priorCandidate.sha256 === 'string' && hashPattern.test(priorCandidate.sha256)
        && priorCandidate.sha256 !== finalCandidateSha,
      `scenario ${scenario.kind} must preserve a distinct pre-review candidate hash`);
      verifyEvidenceArtifact(evidenceRoot, priorCandidate,
        `scenario ${scenario.kind} pre-review candidate`, usedPaths, true);
      priorCandidateSha = priorCandidate.sha256;
      reworkScenarioCount += 1;
    }

    validateReviewHistory(evidenceRoot, scenario, priorCandidateSha, finalCandidateSha, usedPaths, directApprovalAllowed);
    validateCommands(evidenceRoot, scenario, finalCandidateSha, usedPaths);
  }
  requireCondition(scenarioKindsSeen.size === scenarioKinds.length && scenarioKinds.every(kind => scenarioKindsSeen.has(kind)),
    'receipt must contain both the defect and feature scenarios');
  const minimumReworkScenarios = scenarios.minimumReworkScenarios ?? scenarios.exactCount;
  requireCondition(reworkScenarioCount >= minimumReworkScenarios,
    `receipt must contain at least ${minimumReworkScenarios} scenario with the complete three-step rework history`);

  return {
    status: 'structurally-verified',
    structuralStatus: 'structurally-verified',
    acceptanceStatus: 'runtime-database-verification-required',
    runtimeEvidenceStatus: 'not-checked',
    verificationBoundary: 'structure-and-hashes-only; run the local verifier for runtime acceptance',
    commitSha: snapshot.commitSha,
    treeSha: snapshot.treeSha,
    scenarioKinds: scenarioKinds,
  };
}

function parseArguments(argv) {
  const result = {
    manifestPath: defaultManifestPath,
    receiptPath: undefined,
    expectedSha: undefined,
    repositoryRoot: repositoryRoot,
    evidenceRoot: undefined,
    planPath: undefined,
    checkManifest: false,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (['--manifest', '--receipt', '--expected-sha', '--repository-root', '--evidence-root', '--plan'].includes(argument)) {
      requireCondition(!seen.has(argument), `${argument} may only be specified once`);
      seen.add(argument);
      const value = argv[index + 1];
      requireCondition(typeof value === 'string' && value.length > 0 && !value.startsWith('--'), `${argument} requires a value`);
      index += 1;
      if (argument === '--manifest') result.manifestPath = resolve(process.cwd(), value);
      else if (argument === '--receipt') result.receiptPath = resolve(process.cwd(), value);
      else if (argument === '--expected-sha') result.expectedSha = value;
      else if (argument === '--repository-root') result.repositoryRoot = resolve(process.cwd(), value);
      else if (argument === '--evidence-root') result.evidenceRoot = resolve(process.cwd(), value);
      else result.planPath = resolve(process.cwd(), value);
    } else if (argument === '--check-manifest') {
      requireCondition(!seen.has(argument), `${argument} may only be specified once`);
      seen.add(argument);
      result.checkManifest = true;
    } else throw new Error(`unknown argument: ${argument}`);
  }
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const manifest = validateManifest(JSON.parse(readFileSync(options.manifestPath, 'utf8')));
  if (options.checkManifest) {
    console.log(`MANIFEST_VALID=${manifest.manifestId}; contractStatus=runner-supported; structuralStatus=structurally-verified; runtime evidence is checked by the local verifier.`);
    return;
  }
  if (!options.receiptPath) throw new Error('ACCEPTANCE_RECEIPT_MISSING: a receipt is required for structural validation');
  if (!options.expectedSha) throw new Error('EXPECTED_SHA_MISSING: receipts require --expected-sha <full-commit-sha>');
  if (options.planPath && !existsSync(options.planPath)) throw new Error('REAL_PLAN_MISSING: --plan path does not exist');
  const receipt = JSON.parse(readFileSync(options.receiptPath, 'utf8'));
  const result = validateReceipt(manifest, receipt, {
    expectedSha: options.expectedSha,
    repositoryRoot: options.repositoryRoot,
    evidenceRoot: options.evidenceRoot,
    realPlanBytes: options.planPath ? readFileSync(options.planPath) : undefined,
  });
  console.log(JSON.stringify(result, null, 2));
  // This command verifies structure only. The separate local runner opens the
  // evidence database and verifies persisted task, Run, Event, review, process,
  // command, preview, and apply records before claiming runtime acceptance.
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  main().catch(error => {
    console.error(`ACCEPTANCE_RECEIPT_INVALID=${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
