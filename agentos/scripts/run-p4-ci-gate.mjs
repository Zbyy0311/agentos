// Run one P4 CI gate and preserve a receipt in a namespace separate from Lite.
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const separator = args.indexOf('--');
if (separator < 1) throw new Error('usage: node scripts/run-p4-ci-gate.mjs LABEL --mode MODE -- executable args...');

const label = args[0];
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid gate label');
const modeIndex = args.indexOf('--mode');
if (modeIndex < 1 || modeIndex + 1 >= separator) throw new Error('Missing --mode before --');
const mode = args[modeIndex + 1];
const allowedModes = new Set(['simulated-provider', 'real-windows-process', 'no-provider']);
if (!allowedModes.has(mode)) throw new Error(`Unsupported gate mode: ${mode}`);
if (mode === 'real-windows-process' && process.platform !== 'win32') {
  throw new Error(`Gate mode real-windows-process requires Windows; current platform is ${process.platform}`);
}
const command = args.slice(separator + 1);
if (!command.length) throw new Error('Missing executable');

const git = (...argv) => execFileSync('git', argv, { cwd: root, encoding: 'utf8' }).trim();
const commitSha = git('rev-parse', 'HEAD');
const candidateTreeSha = git('rev-parse', 'HEAD^{tree}');
const repositoryRoot = git('rev-parse', '--show-toplevel');
if (!/^[0-9a-f]{40}$/i.test(commitSha) || !/^[0-9a-f]{40}$/i.test(candidateTreeSha)) {
  throw new Error('Could not bind the gate receipt to a full Git commit and tree SHA');
}
const expectedCommitSha = process.env.GITHUB_SHA ?? null;
if (expectedCommitSha !== null
  && (!/^[0-9a-f]{40}$/i.test(expectedCommitSha) || expectedCommitSha.toLowerCase() !== commitSha.toLowerCase())) {
  throw new Error('The checkout HEAD does not match the immutable GITHUB_SHA for this run');
}

const generatedPathsExcludedFromCandidateHash = [
  'agentos/apps/web/test-results/',
  'agentos/logs/p4-ci-gates/',
];
function candidateSourceHash() {
  const hash = createHash('sha256').update('p4-candidate-source-v1\0');
  const trackedDiff = execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: root, encoding: 'buffer' });
  hash.update(trackedDiff);
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--full-name', '-z'], {
    cwd: root,
    encoding: 'buffer',
  }).toString('utf8').split('\0').filter(Boolean)
    .filter(path => !generatedPathsExcludedFromCandidateHash.some(prefix => path.startsWith(prefix)))
    .sort();
  for (const path of untracked) {
    const bytes = readFileSync(resolve(repositoryRoot, path));
    hash.update('\0file\0').update(path).update('\0').update(String(bytes.length)).update('\0').update(bytes);
  }
  return hash.digest('hex');
}
const candidateSourceSha256 = candidateSourceHash();

const runId = process.env.P4_CI_RUN_ID || `local-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error('Invalid P4_CI_RUN_ID');
const gateDirectory = resolve(root, 'logs/p4-ci-gates', commitSha, runId, label);
mkdirSync(gateDirectory, { recursive: true });
const stdoutPath = resolve(gateDirectory, 'stdout.log');
const stderrPath = resolve(gateDirectory, 'stderr.log');
const stdout = createWriteStream(stdoutPath, { flags: 'wx' });
const stderr = createWriteStream(stderrPath, { flags: 'wx' });
const providerPrefix = /^(?:OPENAI|ANTHROPIC|GOOGLE|GEMINI|AZURE|DEEPSEEK|OPENROUTER|MISTRAL|XAI|COHERE|VOLCENGINE|DASHSCOPE|ZHIPU|SILICONFLOW|TOGETHER|FIREWORKS|CEREBRAS|GROQ|AWS|CODEX|KIMI|OPENCODE(?:X)?|AGENTOS)(?:_|$)/i;
const providerSuffix = /(?:API_?KEY|ACCESS_?KEY|SECRET|TOKEN|CREDENTIALS?)$/i;
const providerCredentialNames = Object.entries(process.env)
  .filter(([name, value]) => providerPrefix.test(name) && providerSuffix.test(name) && typeof value === 'string' && value.trim().length > 0)
  .map(([name]) => name)
  .sort();
const startedAt = new Date().toISOString();
let outcome = { rawExitCode: null, signal: null, spawnError: null };

if (providerCredentialNames.length === 0) {
  const child = spawn(command[0], command.slice(1), {
    cwd: root,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', chunk => { stdout.write(chunk); process.stdout.write(chunk); });
  child.stderr?.on('data', chunk => { stderr.write(chunk); process.stderr.write(chunk); });
  child.on('error', error => { outcome.spawnError = { code: error.code, message: error.message }; });
  outcome = await new Promise(resolveOutcome => {
    child.on('close', (rawExitCode, signal) => {
      resolveOutcome({ rawExitCode, signal, spawnError: outcome.spawnError });
    });
  });
} else {
  const message = `P4 CI refuses provider credentials in its environment: ${providerCredentialNames.join(', ')}`;
  stderr.write(message + '\n');
  process.stderr.write(message + '\n');
  outcome.spawnError = { code: 'PROVIDER_CREDENTIAL_PRESENT', message };
}

await Promise.all([
  new Promise(done => stdout.end(done)),
  new Promise(done => stderr.end(done)),
]);
const sha256File = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const relativePath = path => relative(root, path).split(sep).join('/');
const receipt = {
  schemaVersion: 1,
  gate: label,
  mode,
  runId,
  startedAt,
  finishedAt: new Date().toISOString(),
  repository: {
    commitSha,
    candidateTreeSha,
    candidateSourceSha256,
    expectedCommitSha,
    generatedPathsExcludedFromCandidateHash,
  },
  runtime: { platform: process.platform, nodeVersion: process.version },
  providerCredentials: { injectedNames: providerCredentialNames },
  command: { argv: command },
  result: outcome,
  logs: {
    stdout: { path: relativePath(stdoutPath), sha256: sha256File(stdoutPath) },
    stderr: { path: relativePath(stderrPath), sha256: sha256File(stderrPath) },
  },
};
try {
  receipt.repository.commitShaAfter = git('rev-parse', 'HEAD');
  receipt.repository.candidateTreeShaAfter = git('rev-parse', 'HEAD^{tree}');
  receipt.repository.candidateSourceSha256After = candidateSourceHash();
  receipt.repository.immutableSourceVerified = receipt.repository.commitShaAfter.toLowerCase() === commitSha.toLowerCase()
    && receipt.repository.candidateTreeShaAfter.toLowerCase() === candidateTreeSha.toLowerCase()
    && receipt.repository.candidateSourceSha256After === candidateSourceSha256;
} catch (error) {
  receipt.repository.immutableSourceVerified = false;
  receipt.repository.verificationError = error instanceof Error ? error.message : String(error);
}
const receiptPath = resolve(gateDirectory, 'receipt.json');
await import('node:fs/promises').then(({ writeFile }) => writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' }));
console.log(`P4_GATE_RECEIPT=${relativePath(receiptPath)}`);
console.log(`P4_GATE_RESULT=${JSON.stringify({ gate: label, mode, commitSha, candidateTreeSha, candidateSourceSha256, immutableSourceVerified: receipt.repository.immutableSourceVerified, rawExitCode: outcome.rawExitCode, providerCredentialNames })}`);
process.exitCode = providerCredentialNames.length === 0
  && outcome.rawExitCode === 0
  && outcome.signal === null
  && outcome.spawnError === null
  && receipt.repository.immutableSourceVerified === true ? 0 : 1;
