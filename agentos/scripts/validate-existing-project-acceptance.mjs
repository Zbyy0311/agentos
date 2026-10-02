// Validate receipt structure and frozen source/candidate bindings. A receipt
// is structurally verified here; runtime acceptance is checked separately by
// verify-existing-project-acceptance.mjs against the local AgentOS database.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, sep, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

  const scenarios = requirements.scenarios;
  requireCondition(sameArray(scenarios?.exactKinds, scenarioKinds) && scenarios?.exactCount === scenarioKinds.length,
    'exactly one defect and one feature scenario are required');
  requireCondition(scenarios?.baselineReproduction === 'capture-all-acceptance-commands-and-a-matching-nonzero-expected-failure-on-the-frozen-base',
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
  const rootReal = realpathSync(root);
  const fromRootToTop = git(rootReal, ['rev-parse', '--show-cdup']).trim();
  requireCondition(fromRootToTop.length === 0,
    '--repository-root must be the Git repository root');
  const actualCommit = git(rootReal, ['rev-parse', 'HEAD']).trim();
  requireCondition(actualCommit.toLowerCase() === expectedSha.toLowerCase(), 'actual checkout HEAD does not match --expected-sha');
  const actualTree = git(rootReal, ['rev-parse', 'HEAD^{tree}']).trim();
  requireCondition(/^[0-9a-f]{40}$/i.test(actualTree), 'could not resolve the actual Git tree SHA');
  const trackedChanges = git(rootReal, ['status', '--porcelain=v1', '--untracked-files=no']).trim();
  requireCondition(trackedChanges.length === 0, 'tracked checkout files differ from the frozen Git tree');

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

function validateReviewHistory(root, scenario, priorCandidateSha, frozenCandidateSha, usedPaths) {
  const history = scenario.reviewHistory;
  requireCondition(Array.isArray(history) && history.length === reviewTransitions.length,
    `scenario ${scenario.kind} must include the complete review history`);
  const eventIds = new Set();
  const requestId = history[0]?.id;
  for (const [index, event] of history.entries()) {
    const transition = reviewTransitions[index];
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
  }
}

function validateBaselineReproduction(root, scenario, frozenSourceSha, usedPaths) {
  const baseline = scenario.baselineReproduction;
  requireCondition(baseline?.status === 'reproduced' && nonEmpty(baseline.expectedFailurePattern)
    && shaPattern.test(baseline.baseCommit ?? '') && shaPattern.test(baseline.baseTreeSha ?? '')
    && baseline.sourceCommitSha?.toLowerCase() === frozenSourceSha.toLowerCase()
    && baseline.baseParentCommitSha?.toLowerCase() === frozenSourceSha.toLowerCase(),
  `scenario ${scenario.kind} requires a baseline failure on a workspace based on the frozen source commit`);
  requireCondition(Array.isArray(scenario.acceptanceCommands) && scenario.acceptanceCommands.length > 0
    && scenario.acceptanceCommands.every(nonEmpty) && Array.isArray(baseline.commands)
    && baseline.commands.length === scenario.acceptanceCommands.length,
  `scenario ${scenario.kind} baseline must run every declared acceptance command`);
  requireCondition(JSON.stringify(scenario.commands?.[0]?.argv) === JSON.stringify(scenario.acceptanceCommands),
    `scenario ${scenario.kind} retest must execute the exact declared acceptance commands`);
  let matchingFailure = false;
  for (const [index, command] of baseline.commands.entries()) {
    requireCondition(command.command === scenario.acceptanceCommands[index] && nonEmpty(command.id)
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
      && isIsoDate(record.observedAt),
    `scenario ${scenario.kind} baseline command artifact does not match the receipt`);
    const stdout = verifyEvidenceArtifact(root, record.stdout, `scenario ${scenario.kind} baseline stdout`, usedPaths).toString('utf8');
    const stderr = verifyEvidenceArtifact(root, record.stderr, `scenario ${scenario.kind} baseline stderr`, usedPaths).toString('utf8');
    if (command.rawExitCode !== 0 && `${stdout}\n${stderr}`.includes(baseline.expectedFailurePattern)) matchingFailure = true;
  }
  requireCondition(matchingFailure, `scenario ${scenario.kind} must capture its expected baseline failure with a nonzero exit`);
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
  if (receipt.mode === 'real-windows-acceptance') {
    requireCondition(process.env.CI?.toLowerCase() !== 'true', 'real-windows-acceptance receipts cannot be captured or validated inside CI');
    requireCondition(process.platform === 'win32', 'real-windows-acceptance receipts can only be validated on Windows');
  }

  const expectedSha = options.expectedSha;
  const root = options.repositoryRoot ?? repositoryRoot;
  const snapshot = verifyRepositorySnapshot(root, receipt, expectedSha);
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
  const evidenceRoot = options.evidenceRoot ?? root;
  const candidateBytes = verifyEvidenceArtifact(evidenceRoot, candidate,
    `scenario ${scenario.kind} frozen candidate`, usedPaths, true);
    const finalCandidateSha = sha256(candidateBytes);

    validateBaselineReproduction(evidenceRoot, scenario, snapshot.commitSha, usedPaths);

    const priorCandidate = scenario.priorCandidate;
    requireCondition(priorCandidate && typeof priorCandidate === 'object'
      && typeof priorCandidate.sha256 === 'string' && hashPattern.test(priorCandidate.sha256)
      && priorCandidate.sha256 !== finalCandidateSha,
    `scenario ${scenario.kind} must preserve a distinct pre-review candidate hash`);
  verifyEvidenceArtifact(evidenceRoot, priorCandidate,
      `scenario ${scenario.kind} pre-review candidate`, usedPaths, true);

    validateReviewHistory(evidenceRoot, scenario, priorCandidate.sha256, finalCandidateSha, usedPaths);
    validateCommands(evidenceRoot, scenario, finalCandidateSha, usedPaths);
  }
  requireCondition(scenarioKindsSeen.size === scenarioKinds.length && scenarioKinds.every(kind => scenarioKindsSeen.has(kind)),
    'receipt must contain both the defect and feature scenarios');

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
    checkManifest: false,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (['--manifest', '--receipt', '--expected-sha', '--repository-root', '--evidence-root'].includes(argument)) {
      requireCondition(!seen.has(argument), `${argument} may only be specified once`);
      seen.add(argument);
      const value = argv[index + 1];
      requireCondition(typeof value === 'string' && value.length > 0 && !value.startsWith('--'), `${argument} requires a value`);
      index += 1;
      if (argument === '--manifest') result.manifestPath = resolve(process.cwd(), value);
      else if (argument === '--receipt') result.receiptPath = resolve(process.cwd(), value);
      else if (argument === '--expected-sha') result.expectedSha = value;
      else if (argument === '--repository-root') result.repositoryRoot = resolve(process.cwd(), value);
      else result.evidenceRoot = resolve(process.cwd(), value);
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
  const receipt = JSON.parse(readFileSync(options.receiptPath, 'utf8'));
  const result = validateReceipt(manifest, receipt, {
    expectedSha: options.expectedSha,
    repositoryRoot: options.repositoryRoot,
    evidenceRoot: options.evidenceRoot,
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
