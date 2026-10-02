// Validate a future existing-project acceptance receipt without running acceptance itself.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
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

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0 && !/^(?:todo|tbd|unknown|placeholder|n\/a)$/i.test(value.trim());
}

function safePathWithin(root, relativePath, description) {
  requireCondition(typeof relativePath === 'string' && relativePath.length > 0 && !isAbsolute(relativePath), `${description} must be a repository-relative path`);
  const rootReal = realpathSync(root);
  const candidateReal = realpathSync(resolve(rootReal, relativePath));
  const rel = relative(rootReal, candidateReal);
  requireCondition(rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel), `${description} escapes the repository`);
  return candidateReal;
}

export function validateManifest(manifest) {
  requireCondition(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'manifest must be an object');
  requireCondition(manifest.schemaVersion === 1, 'manifest.schemaVersion must be 1');
  requireCondition(manifest.manifestId === 'agentos-existing-project-acceptance-v1', 'manifestId is unsupported');
  requireCondition(manifest.status === 'contract-only', 'manifest.status must remain contract-only');
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
  requireCondition(requirements?.immutableRepositorySnapshot === true, 'repository commit and tree must be identical at start and end');
  requireCondition(JSON.stringify(requirements?.modelFields) === JSON.stringify(['provider', 'id']), 'model provider and id are required');
  requireCondition(Array.isArray(requirements?.requiredIds) && requirements.requiredIds.length > 0, 'at least one required id is needed');
  requireCondition(requirements.requiredIds.every(nonEmpty), 'requiredIds entries must be non-empty');
  requireCondition(new Set(requirements.requiredIds).size === requirements.requiredIds.length, 'requiredIds entries must be unique');
  requireCondition(Number.isInteger(requirements.commands?.minimum) && requirements.commands.minimum >= 1, 'at least one command receipt is required');
  requireCondition(JSON.stringify(requirements.commands?.requiredFields) === JSON.stringify(['id', 'argv', 'cwd', 'rawExitCode', 'expectedExitCode']), 'command receipt fields are unsupported');
  requireCondition(requirements.commands?.successfulExpectedExitCode === 0, 'successful commands must require exit code 0');
  requireCondition(requirements.processExitCode === 0 && requirements.acceptanceExitCode === 0, 'process and acceptance exits must both require 0');
  requireCondition(requirements.candidate?.artifactPath === 'repository-relative-file', 'candidate artifact path must be repository-relative');
  requireCondition(requirements.candidate?.hashAlgorithm === 'sha256-file-bytes', 'candidate file-byte SHA-256 is required');
  requireCondition(requirements.candidate?.hashFormat === '64-character-lowercase-hex', 'candidate hash format is unsupported');
  const scenarioRoles = requirements.scenarioRoles;
  requireCondition(Array.isArray(scenarioRoles?.required) && scenarioRoles.required.length > 0, 'scenario role requirements are required');
  requireCondition(scenarioRoles.required.every(nonEmpty) && new Set(scenarioRoles.required).size === scenarioRoles.required.length,
    'scenario role names must be non-empty and unique');
  requireCondition(scenarioRoles.uniqueAgentIdsPerScenario === true, 'scenario role agent ids must be distinct');
  requireCondition(Number.isInteger(scenarioRoles.minimumScenarios) && scenarioRoles.minimumScenarios >= 1,
    'at least one scenario receipt is required');
  requireCondition(nonEmpty(scenarioRoles.successStatus), 'scenario success status is required');
  return manifest;
}

export function validateReceipt(manifest, receipt, options = {}) {
  validateManifest(manifest);
  requireCondition(receipt && typeof receipt === 'object' && !Array.isArray(receipt), 'receipt must be an object');
  requireCondition(receipt.schemaVersion === 1, 'receipt.schemaVersion must be 1');
  requireCondition(receipt.manifestId === manifest.manifestId, 'receipt manifestId does not match');

  requireCondition(typeof receipt.mode === 'string' && Object.hasOwn(manifest.modes, receipt.mode), 'unsupported acceptance mode: ' + String(receipt.mode));
  const mode = manifest.modes[receipt.mode];
  requireCondition(receipt.providerExecution === mode.providerExecution, 'provider execution type does not match the selected mode');
  requireCondition(receipt.credentialBoundary === mode.credentialBoundary, 'credential boundary does not match the selected mode');
  requireCondition(mode.platform === 'any' || receipt.platform === mode.platform, `mode ${receipt.mode} requires platform ${mode.platform}`);
  if (receipt.mode === 'real-windows-acceptance') {
    requireCondition(process.env.CI?.toLowerCase() !== 'true', 'real-windows-acceptance receipts cannot be captured or validated inside CI');
    requireCondition(process.platform === 'win32', 'real-windows-acceptance receipts can only be validated on Windows');
  }

  const commitSha = receipt.repository?.commitSha;
  requireCondition(typeof commitSha === 'string' && shaPattern.test(commitSha), 'receipt.repository.commitSha must be a full 40-character Git SHA');
  requireCondition(typeof options.expectedSha === 'string' && shaPattern.test(options.expectedSha), '--expected-sha must be a full 40-character Git SHA');
  requireCondition(commitSha.toLowerCase() === options.expectedSha.toLowerCase(), 'receipt commit SHA does not match --expected-sha');
  const treeSha = receipt.repository?.treeSha;
  requireCondition(typeof treeSha === 'string' && shaPattern.test(treeSha), 'receipt.repository.treeSha must be a full 40-character Git tree SHA');
  requireCondition(receipt.repository?.commitShaAtStart?.toLowerCase() === commitSha.toLowerCase()
    && receipt.repository?.commitShaAtEnd?.toLowerCase() === commitSha.toLowerCase()
    && receipt.repository?.treeShaAtStart?.toLowerCase() === treeSha.toLowerCase()
    && receipt.repository?.treeShaAtEnd?.toLowerCase() === treeSha.toLowerCase(),
  'receipt must prove the exact commit and tree were unchanged for the entire run');

  for (const field of manifest.receiptRequirements.modelFields) {
    requireCondition(nonEmpty(receipt.model?.[field]), `receipt.model.${field} is required`);
  }
  for (const field of manifest.receiptRequirements.requiredIds) {
    requireCondition(nonEmpty(receipt.ids?.[field]), `receipt.ids.${field} is required`);
  }

  const commands = receipt.commands;
  requireCondition(Array.isArray(commands) && commands.length >= manifest.receiptRequirements.commands.minimum, 'receipt.commands must contain at least one command');
  const commandIds = new Set();
  for (const [index, command] of commands.entries()) {
    requireCondition(nonEmpty(command?.id), `receipt.commands[${index}].id is required`);
    requireCondition(!commandIds.has(command.id), `duplicate command id: ${command.id}`);
    commandIds.add(command.id);
    requireCondition(Array.isArray(command.argv) && command.argv.length > 0 && command.argv.every(nonEmpty), `receipt.commands[${index}].argv must be a non-empty argument vector`);
    requireCondition(nonEmpty(command.cwd), `receipt.commands[${index}].cwd is required`);
    requireCondition(Number.isInteger(command.rawExitCode), `receipt.commands[${index}].rawExitCode must be an integer`);
    requireCondition(command.expectedExitCode === manifest.receiptRequirements.commands.successfulExpectedExitCode, `receipt.commands[${index}].expectedExitCode must be 0`);
    requireCondition(command.rawExitCode === command.expectedExitCode, `receipt.commands[${index}] did not exit as expected`);
  }
  requireCondition(receipt.processExitCode === manifest.receiptRequirements.processExitCode, 'receipt.processExitCode must be 0');
  requireCondition(receipt.acceptanceExitCode === manifest.receiptRequirements.acceptanceExitCode, 'receipt.acceptanceExitCode must be 0');

  const scenarioRequirements = manifest.receiptRequirements.scenarioRoles;
  requireCondition(Array.isArray(receipt.scenarios) && receipt.scenarios.length >= scenarioRequirements.minimumScenarios,
    'receipt.scenarios must contain at least one scenario');
  const scenarioIds = new Set();
  for (const [index, scenario] of receipt.scenarios.entries()) {
    requireCondition(nonEmpty(scenario?.id), `receipt.scenarios[${index}].id is required`);
    requireCondition(!scenarioIds.has(scenario.id), `duplicate scenario id: ${scenario.id}`);
    scenarioIds.add(scenario.id);
    requireCondition(scenario.status === scenarioRequirements.successStatus, `receipt.scenarios[${index}] did not pass`);
    for (const role of scenarioRequirements.required) {
      requireCondition(nonEmpty(scenario.roles?.[role]), `receipt.scenarios[${index}].roles.${role} is required`);
    }
    const agentIds = scenarioRequirements.required.map(role => scenario.roles[role]);
    requireCondition(new Set(agentIds).size === agentIds.length, `receipt.scenarios[${index}] must assign distinct agent ids to each role`);
  }

  const candidatePath = safePathWithin(options.repositoryRoot ?? repositoryRoot, receipt.candidate?.artifactPath, 'receipt.candidate.artifactPath');
  requireCondition(typeof receipt.candidate.sha256 === 'string' && hashPattern.test(receipt.candidate.sha256), 'receipt.candidate.sha256 must be 64 lowercase hexadecimal characters');
  const actualCandidateHash = createHash('sha256').update(readFileSync(candidatePath)).digest('hex');
  requireCondition(actualCandidateHash === receipt.candidate.sha256, 'candidate artifact SHA-256 does not match the receipt');
  return { commitSha, candidatePath, candidateSha256: actualCandidateHash, commandCount: commands.length, mode: receipt.mode };
}

function parseArguments(argv) {
  const result = { manifestPath: defaultManifestPath, receiptPath: undefined, expectedSha: undefined, checkManifest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--manifest' || argument === '--receipt' || argument === '--expected-sha') {
      const value = argv[index + 1];
      requireCondition(typeof value === 'string' && value.length > 0 && !value.startsWith('--'), `${argument} requires a value`);
      index += 1;
      if (argument === '--manifest') result.manifestPath = resolve(process.cwd(), value);
      else if (argument === '--receipt') result.receiptPath = resolve(process.cwd(), value);
      else result.expectedSha = value;
    }
    else if (argument === '--check-manifest') result.checkManifest = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const manifest = validateManifest(JSON.parse(readFileSync(options.manifestPath, 'utf8')));
  if (options.checkManifest) {
    console.log(`MANIFEST_VALID=${manifest.manifestId}; acceptanceStatus=${manifest.status}; manifest only; no acceptance run is claimed.`);
    return;
  }
  if (!options.receiptPath) throw new Error('ACCEPTANCE_RECEIPT_MISSING: a real or simulated acceptance run cannot pass without --receipt');
  if (!options.expectedSha) throw new Error('EXPECTED_SHA_MISSING: acceptance receipts require --expected-sha <full-commit-sha>');
  const receipt = JSON.parse(readFileSync(options.receiptPath, 'utf8'));
  const result = validateReceipt(manifest, receipt, { expectedSha: options.expectedSha });
  console.log(JSON.stringify({ status: 'valid', manifestId: manifest.manifestId, ...result }, null, 2));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  main().catch(error => {
    console.error(`ACCEPTANCE_RECEIPT_INVALID=${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
