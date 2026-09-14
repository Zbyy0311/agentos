/**
 * Run one literal acceptance command and preserve its stdout, stderr and exit
 * status for a later Lite evidence receipt. The command is deliberately kept
 * separate from receipt assembly so a failed invocation is still auditable.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');

function value(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name) {
  const result = value(name);
  if (!result) throw new Error(`${name} is required`);
  return result;
}

const cwdInput = required('--cwd');
const executable = required('--executable');
const args = JSON.parse(required('--args-json'));
const outputDirectory = resolve(repositoryRoot, required('--out-dir'));
const extraEnvironment = value('--env-json') ? JSON.parse(value('--env-json')) : {};

if (!Array.isArray(args) || !args.every(argument => typeof argument === 'string')) {
  throw new Error('--args-json must be an array of strings');
}
if (extraEnvironment === null || typeof extraEnvironment !== 'object' || Array.isArray(extraEnvironment)) {
  throw new Error('--env-json must be an object');
}
if (/<[^>]+>/.test(JSON.stringify({ executable, args, extraEnvironment }))) {
  throw new Error('literal command cannot contain placeholders');
}

const cwd = resolve(repositoryRoot, cwdInput);
mkdirSync(outputDirectory, { recursive: true });
let before;
try {
  before = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: repositoryRoot, encoding: 'utf8',
  });
} catch (error) {
  throw new Error(`cannot capture pre-run checkout state: ${error.message}`);
}

const childExecutable = process.platform === 'win32' && executable === 'pnpm' ? 'pnpm.cmd' : executable;
const child = spawn(childExecutable, args, {
  cwd,
  env: { ...process.env, ...extraEnvironment },
  windowsHide: true,
});
const stdout = [];
const stderr = [];
let spawnError = null;
child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
child.on('error', error => { spawnError = error; });

const result = await new Promise(resolveResult => {
  child.on('close', (code, signal) => resolveResult({ code, signal }));
});

const after = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
  cwd: repositoryRoot, encoding: 'utf8',
});
writeFileSync(resolve(outputDirectory, 'stdout.txt'), Buffer.concat(stdout));
writeFileSync(resolve(outputDirectory, 'stderr.txt'), Buffer.concat(stderr));
writeFileSync(resolve(outputDirectory, 'exit.txt'), `${result.code ?? -1}\n`);
writeFileSync(resolve(outputDirectory, 'execution.json'), `${JSON.stringify({
  schemaVersion: 1,
  command: { executable, args },
  cwd: cwdInput.replaceAll('\\', '/'),
  rawExitCode: result.code ?? -1,
  signal: result.signal ?? null,
  error: spawnError?.message ?? null,
  trackedCheckoutUnchanged: before === after,
}, null, 2)}\n`);

console.log(JSON.stringify({
  outputDirectory: outputDirectory.replaceAll('\\', '/'),
  rawExitCode: result.code ?? -1,
  signal: result.signal ?? null,
  error: spawnError?.message ?? null,
  trackedCheckoutUnchanged: before === after,
}));
