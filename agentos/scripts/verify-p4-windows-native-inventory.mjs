// Confirm the Windows-only process tests are present and passed in the captured full-suite log.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const agentosRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: agentosRoot, encoding: 'utf8' }).trim();
const required = [
  {
    file: 'agentos/packages/process-runtime/src/node-driver.test.ts',
    titles: [
      'P5B-04/W2/W3/W7/W10: a child created as the provider FIRST instruction cannot escape the AgentOS Job',
      'P5B-02/03/07/W4/W5/W6: an immediately built multi-level tree is owned and terminated while an unrelated control survives',
      'W1: provider code cannot execute before Job ownership (suspended-create trace evidence)',
      'W9: provider stdout/stderr bytes and exact argv survive the owned channel',
      'W12: an unrelated PowerShell child of another parent is not an AgentOS Job helper',
    ],
  },
  {
    file: 'agentos/packages/process-runtime/src/platform-process-tree.test.ts',
    titles: ['W8: a helper start failure during owned spawn rejects with no proof'],
  },
  {
    file: 'agentos/packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts',
    titles: [
      'W1: kill-on-close ownership loss via session close reaps the provider; recovery sees MISSING (no terminateTree on the proof path)',
      'W2: spawn capture and live probe carry the same CANONICAL FILETIME; classifier SAME (primitive-only)',
      'W3: read-only probe fails closed on an invalid PID (never MISSING)',
      'W3: probe failure / unreadable identity fails closed to unknown (not missing)',
    ],
  },
  {
    file: 'agentos/packages/process-runtime/src/p6-l1c-win32-spawn-error.test.ts',
    titles: [
      'maps Win32 ERROR_FILE_NOT_FOUND (2) to ENOENT',
      'maps Win32 ERROR_PATH_NOT_FOUND (3) to ENOENT',
      'maps Win32 ERROR_ACCESS_DENIED (5) to EACCES',
      'maps every other Win32 code to unknown (null)',
      'never parses localized message text (numeric identity only)',
    ],
  },
  {
    file: 'agentos/packages/process-runtime/src/native-birth-identity.test.ts',
    titles: [
      'accepts the exact canonical durable form',
      'rejects raw untagged decimals, leading zeros, zero, and malformed prefixes',
      'rejects non-string values',
      'canonicalizes a valid helper decimal into the tagged durable form',
      'fails closed (null) for non-canonical helper decimals',
      'round-trips a >2^53 value digit-exactly without Number conversion',
    ],
  },
];

function fail(message) { throw new Error(`P4 Windows native process inventory: ${message}`); }
if (process.platform !== 'win32') fail(`requires win32; current platform is ${process.platform}`);
const receiptArgument = process.argv.indexOf('--receipt');
const expectedShaArgument = process.argv.indexOf('--expected-sha');
if (receiptArgument < 0 || !process.argv[receiptArgument + 1]) {
  fail('usage: node scripts/verify-p4-windows-native-inventory.mjs --receipt <process-runtime-receipt.json> --expected-sha <full-commit-sha>');
}
if (expectedShaArgument < 0 || !/^[0-9a-f]{40}$/i.test(process.argv[expectedShaArgument + 1] ?? '')) {
  fail('an exact 40-character --expected-sha is required');
}

for (const item of required) {
  const sourcePath = resolve(repoRoot, item.file);
  const source = readFileSync(sourcePath, 'utf8');
  for (const title of item.titles) {
    if (!source.includes(title)) fail(`expected native test is missing from ${item.file}: ${title}`);
  }
}

const receiptPath = realpathSync(resolve(agentosRoot, process.argv[receiptArgument + 1]));
const receiptRelativeToRoot = relative(realpathSync(repoRoot), receiptPath);
if (receiptRelativeToRoot.startsWith('..' + sep) || isAbsolute(receiptRelativeToRoot)) fail('receipt path escapes the repository');
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
if (receipt.schemaVersion !== 1 || receipt.gate !== 'process-runtime' || receipt.mode !== 'real-windows-process') {
  fail('receipt is not for the full real-Windows Process Runtime gate');
}
if (receipt.runtime?.platform !== 'win32' || receipt.result?.rawExitCode !== 0 || receipt.result?.signal !== null || receipt.result?.spawnError !== null) {
  fail('full Process Runtime gate did not complete successfully on Windows');
}
if (!/^[0-9a-f]{40}$/i.test(receipt.repository?.commitSha ?? '')
  || receipt.repository.commitSha.toLowerCase() !== process.argv[expectedShaArgument + 1].toLowerCase()) {
  fail('receipt commit SHA does not match the exact expected SHA');
}
if (receipt.repository?.commitShaAfter?.toLowerCase() !== receipt.repository.commitSha.toLowerCase()
  || receipt.repository?.candidateTreeShaAfter?.toLowerCase() !== receipt.repository.candidateTreeSha?.toLowerCase()
  || !/^[0-9a-f]{64}$/.test(receipt.repository?.candidateSourceSha256 ?? '')
  || receipt.repository?.candidateSourceSha256After !== receipt.repository.candidateSourceSha256
  || receipt.repository?.immutableSourceVerified !== true) {
  fail('receipt does not prove the exact commit and source snapshot stayed unchanged during the gate');
}
if (!Array.isArray(receipt.providerCredentials?.injectedNames) || receipt.providerCredentials.injectedNames.length !== 0) {
  fail('provider credential guard did not pass');
}

// The gate runner writes receipt log paths relative to agentosRoot, while repoRoot
// is the parent checkout used for the inventory source paths.
const stdoutPath = realpathSync(resolve(agentosRoot, receipt.logs?.stdout?.path ?? ''));
const stdoutRelativeToRoot = relative(realpathSync(repoRoot), stdoutPath);
if (stdoutRelativeToRoot.startsWith('..' + sep) || isAbsolute(stdoutRelativeToRoot)) fail('stdout log path escapes the repository');
const stdoutBytes = readFileSync(stdoutPath);
if (createHash('sha256').update(stdoutBytes).digest('hex') !== receipt.logs.stdout.sha256) fail('stdout log hash does not match the receipt');
const stderrPath = realpathSync(resolve(agentosRoot, receipt.logs?.stderr?.path ?? ''));
const stderrRelativeToRoot = relative(realpathSync(repoRoot), stderrPath);
if (stderrRelativeToRoot.startsWith('..' + sep) || isAbsolute(stderrRelativeToRoot)) fail('stderr log path escapes the repository');
if (createHash('sha256').update(readFileSync(stderrPath)).digest('hex') !== receipt.logs?.stderr?.sha256) fail('stderr log hash does not match the receipt');
const output = stdoutBytes.toString('utf8').replace(/\u001b\[[0-9;]*m/g, '');
const outputLines = output.split(/\r?\n/);
const missing = [];
for (const item of required) {
  for (const title of item.titles) {
    const line = outputLines.find(value => value.includes(title));
    if (!line || !/[✓✔]/u.test(line) || /\b(?:skip|skipped|todo|fail|failed)\b/i.test(line)) missing.push(title);
  }
}
if (missing.length > 0) fail(`expected tests did not show a passing result in the verbose receipt: ${missing.join(' | ')}`);

console.log(JSON.stringify({
  status: 'passed',
  platform: process.platform,
  gate: receipt.gate,
  commitSha: receipt.repository?.commitSha,
  candidateSourceSha256: receipt.repository?.candidateSourceSha256,
  verifiedTests: required.reduce((count, item) => count + item.titles.length, 0),
  files: required.map(item => item.file),
  receipt: relative(agentosRoot, receiptPath).split(sep).join('/'),
}, null, 2));
