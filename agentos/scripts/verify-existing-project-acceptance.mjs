// Execute two isolated AgentOS collaboration acceptances through the production
// HTTP routes, CollaborationWorkflowService, and native provider process chain.
// The deterministic mode uses a local Codex-protocol fixture process; it never
// calls a remote model. Real mode is deliberately unavailable until the source
// exposes both P2 readiness and collaboration preview routes.
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { validateManifest, validateReceipt } from './validate-existing-project-acceptance.mjs';

const scriptRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: scriptRoot, encoding: 'utf8' }).stdout.trim();
const manifest = validateManifest(JSON.parse(readFileSync(new URL('./p4-existing-project-acceptance.manifest.json', import.meta.url), 'utf8')));
const shaPattern = /^[0-9a-f]{40}$/i;
const hashPattern = /^[0-9a-f]{64}$/;
const secretKeyPattern = /(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH(?:ORIZATION)?|PASSWORD|SECRET|CREDENTIAL)/i;

function invariant(ok, message) { if (!ok) throw new Error(message); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function hashFile(path) { return sha256(readFileSync(path)); }
function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed (${result.status}): ${safeText(result.stderr || result.stdout)}`);
  return result.stdout.trim();
}
function safeText(value) {
  return String(value ?? '')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/giu, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*)[^\s,;]+/giu, '$1[REDACTED]')
    .slice(0, 16_000);
}

function recordProgress(evidenceRoot, kind, event) {
  const path = join(evidenceRoot, 'scenarios', kind, 'runner-progress.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ observedAt: new Date().toISOString(), ...event })}\n`, 'utf8');
}

function isPathInside(directory, target) {
  const relativePath = relative(resolve(directory), resolve(target));
  return relativePath === '' || (!isAbsolute(relativePath) && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`));
}

export function changedPathsFromPatch(patchText) {
  invariant(typeof patchText === 'string' && patchText.trim().length > 0,
    'candidate patch does not identify a unique changed-path set');
  const result = spawnSync('git', ['apply', '--numstat', '-'], {
    cwd: repoRoot, input: patchText, encoding: 'utf8', windowsHide: true, shell: false,
    timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  invariant(!result.error && result.status === 0,
    `candidate patch path inventory could not be parsed: ${safeText(result.error?.message || result.stderr || '')}`);
  const paths = result.stdout.split(/\r?\n/u).filter(Boolean).map(line => {
    const fields = line.split('\t');
    invariant(fields.length === 3 && fields[2].length > 0 && !fields[2].includes('\n'),
      'candidate patch contains an unsupported path entry');
    return fields[2].replaceAll('\\', '/');
  });
  invariant(paths.length > 0 && new Set(paths).size === paths.length,
    'candidate patch does not identify a unique changed-path set');
  return paths;
}

export function verifyFrozenCandidatePreview(response, expected) {
  invariant(response?.workspaceId === expected.workspaceId
    && response.collaborationTaskId === expected.collaborationTaskId
    && response.candidateId === expected.candidateId
    && response.baseCommit === expected.baseCommit
    && response.contentHash === expected.contentHash
    && response.diffHash === expected.diffHash,
  'candidate preview response does not match the exact frozen candidate identity');
  return {
    candidateId: response.candidateId,
    candidateBaseCommit: response.baseCommit,
    candidateContentHash: response.contentHash,
    candidateDiffHash: response.diffHash,
  };
}

/** Read only the exact terminal candidates from this runner's isolated data root.
 * The public task response intentionally contains summaries, never raw patches. */
export function loadOwnedFrozenCandidates(databasePath, workspaceId, taskId, summaries) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = db.prepare(`SELECT id,canonical_run_id,round,base_commit,head_commit,diff_hash,content_hash,
      diff_text,test_status,test_command,test_exit_code,test_output,created_at
      FROM collaboration_candidates WHERE workspace_id=? AND collaboration_task_id=? ORDER BY round ASC`)
      .all(workspaceId, taskId);
    invariant(rows.length === summaries.length && rows.length > 0,
      'isolated candidate inventory differs from the HTTP task summaries');
    return rows.map(row => {
      const summary = summaries.find(item => item.id === row.id);
      invariant(summary && row.round === summary.round && row.diff_hash === summary.diffHash
        && row.content_hash === summary.contentHash && row.test_status === summary.testStatus
        && row.test_exit_code === summary.testExitCode
        && typeof row.diff_text === 'string' && sha256(Buffer.from(row.diff_text, 'utf8')) === row.diff_hash,
      'isolated frozen candidate bytes or identity differ from the HTTP task summary');
      return {
        id: row.id, canonicalRunId: row.canonical_run_id, round: row.round,
        baseCommit: row.base_commit, headCommit: row.head_commit,
        diffHash: row.diff_hash, contentHash: row.content_hash, diffText: row.diff_text,
        testStatus: row.test_status, testCommand: row.test_command,
        testExitCode: row.test_exit_code, testOutput: row.test_output, createdAt: row.created_at,
      };
    });
  } finally { db.close(); }
}

function assertCandidateChangesStayInScope(plan, paths) {
  const scopes = plan.scope.map(value => value.replaceAll('\\', '/').replace(/\/$/u, ''));
  invariant(paths.every(path => scopes.some(scope => path === scope || path.startsWith(`${scope}/`))),
    `${plan.kind} candidate patch contains a path outside the approved scenario scope`);
}

export function selectOwnedPendingApprovals(requests, context) {
  const pending = requests.filter(request => request.workspaceId === context.workspaceId
    && request.runId === context.runId && request.status === 'pending');
  for (const request of pending) {
    invariant(request.category === 'command' && request.riskLevel === 'high'
      && request.title === 'Approve provider stage execution',
    'refusing to resolve an unexpected runtime approval for the acceptance Run');
    invariant(Number.isSafeInteger(request.version) && request.version > 0,
      'runtime approval is missing its compare-and-swap version');
    let snapshot;
    try { snapshot = JSON.parse(request.requestSnapshotJson); }
    catch { throw new Error('runtime approval has an invalid frozen request snapshot'); }
    invariant(snapshot.schemaVersion === 1 && snapshot.workspaceId === context.workspaceId
      && snapshot.runId === context.runId && snapshot.agent?.agentId === context.implementerAgentId,
    'runtime approval does not bind the exact isolated acceptance workspace, Run, and implementer');
    invariant(snapshot.provider?.adapterId === 'builtin.codex'
      && realpathSync(snapshot.launch?.executable) === realpathSync(context.executable),
    'runtime approval does not bind the configured Codex executable');
    invariant(typeof snapshot.launch?.cwd === 'string' && isPathInside(context.worktreeRoot, snapshot.launch.cwd),
      'runtime approval working directory is outside the isolated AgentOS worktree root');
  }
  return pending;
}
function assertNoSecretLikeDiff(text) {
  invariant(!/(?:api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*[^\s]+/iu.test(text)
    && !/\bBearer\s+[A-Za-z0-9._~+\/-]{16,}/iu.test(text),
  'candidate diff resembles credential material; refusing to write it to the acceptance evidence');
}
function gitSnapshot(root, expectedSha) {
  const actual = git(root, ['rev-parse', 'HEAD']);
  invariant(shaPattern.test(expectedSha) && actual.toLowerCase() === expectedSha.toLowerCase(), 'source HEAD does not match --expected-sha');
  invariant(git(root, ['status', '--porcelain=v1', '--untracked-files=no']) === '', 'source checkout has tracked changes');
  return { commitSha: actual, treeSha: git(root, ['rev-parse', 'HEAD^{tree}']) };
}

function writeArtifact(evidenceRoot, relativePath, bytes) {
  invariant(!relativePath.startsWith('/') && !relativePath.includes('..'), 'evidence artifact path is unsafe');
  const absolutePath = resolve(evidenceRoot, relativePath);
  const rel = relative(resolve(evidenceRoot), absolutePath);
  invariant(rel !== '..' && !rel.startsWith(`..${sep}`), 'evidence artifact escapes evidence directory');
  mkdirSync(dirname(absolutePath), { recursive: true });
  const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
  writeFileSync(absolutePath, content, { flag: 'wx' });
  return { artifactPath: relativePath.split(sep).join('/'), sha256: sha256(content) };
}

function writeJsonArtifact(evidenceRoot, relativePath, value) {
  return writeArtifact(evidenceRoot, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeReviewEvidence(evidenceRoot, kind, scenarioId, id, data) {
  return writeJsonArtifact(evidenceRoot, `scenarios/${kind}/reviews/${id}.json`, {
    schemaVersion: 1, kind: 'review-history-event', scenarioId, eventId: id, ...data,
  });
}

function simulationCliSource(statePath) {
  return `
const fs = require('node:fs');
const path = require('node:path');
const stateFile = ${JSON.stringify(statePath)};
const args = process.argv.slice(2);
const prompt = args.at(-1) || '';
const role = /P4_ACCEPTANCE_SIM_ROLE=(planner|implementer|reviewer)/u.exec(prompt)?.[1];
const scenario = /P4_ACCEPTANCE_SCENARIO=(defect|feature)/u.exec(prompt)?.[1];
if (!role || !scenario) process.exit(73);
let state = { defect: { implementations: 0, reviews: 0 }, feature: { implementations: 0, reviews: 0 } };
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
const say = text => process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) + '\\n');
  const target = path.join(process.cwd(), 'agentos', 'scripts', 'fixtures', 'p4-existing-project-acceptance');
if (role === 'planner') {
  say('Bounded plan: inspect the scoped fixture, change only its implementation and test, then run the listed acceptance command.');
} else if (role === 'implementer') {
  const first = state[scenario].implementations++ === 0;
  fs.mkdirSync(target, { recursive: true });
  if (scenario === 'defect') {
    fs.writeFileSync(path.join(target, 'defect.mjs'), first
      ? "export function normalizeWhitespace(value) { return String(value).replace(/[ \\t]+/g, ' '); }\\n"
      : "export function normalizeWhitespace(value) { return String(value).replace(/[ \\t]+/g, ' ').trim(); }\\n");
    fs.writeFileSync(path.join(target, 'defect.test.mjs'), "import test from 'node:test';\\nimport assert from 'node:assert/strict';\\nimport { normalizeWhitespace } from './defect.mjs';\\ntest('collapses repeated whitespace', () => assert.equal(normalizeWhitespace('one   two'), 'one two'));\\n" + (first ? '' : "test('trims boundary whitespace', () => assert.equal(normalizeWhitespace(' one two  '), 'one two'));\\n"));
  } else {
    fs.writeFileSync(path.join(target, 'feature.mjs'), first
      ? "export function slugify(value) { return String(value ?? '').trim().toLowerCase().replace(/ +/g, '-'); }\\n"
      : "export function slugify(value) { return String(value ?? '').normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }\\n");
    fs.writeFileSync(path.join(target, 'feature.test.mjs'), "import test from 'node:test';\\nimport assert from 'node:assert/strict';\\nimport { slugify } from './feature.mjs';\\ntest('creates a lowercase dashed slug', () => assert.equal(slugify('Quick Start'), 'quick-start'));\\n" + (first ? '' : "test('normalizes punctuation and accents', () => assert.equal(slugify('Crème: P4!'), 'creme-p4'));\\n"));
  }
  fs.writeFileSync(stateFile, JSON.stringify(state));
  say('Applied the bounded fixture change and updated its focused acceptance test.');
} else {
  const binding = label => {
    const prefix = label + ': ';
    return prompt.split(/\\r?\\n/u).find(line => line.startsWith(prefix))?.slice(prefix.length).trim();
  };
  const review = state[scenario].reviews++ === 0 ? {
    conclusion: 'changes_requested',
    summary: scenario === 'defect'
      ? 'Changes requested: trim leading and trailing whitespace and add a boundary assertion.'
      : 'Changes requested: normalize punctuation and accented characters and add an edge-case assertion.',
  } : { conclusion: 'approved', summary: 'The revised frozen candidate addresses the requested edge case and its recorded acceptance test passes.' };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  say(JSON.stringify({ agentosCollaborationReview: {
    version: 1, candidateId: binding('Candidate ID (copy exactly)'), candidateHash: binding('Candidate SHA-256 (copy exactly)'),
    runId: binding('Canonical Run ID (copy exactly)'), stageAttempt: Number(binding('Review stage attempt (copy exactly as a JSON number)')),
    reviewerAgentId: binding('Reviewer Agent ID (copy exactly)'), ...review,
  } }));
}
`;
}

function createSimulationExecutable(runRoot, statePath) {
  const fixturePath = join(runRoot, 'provider-fixture.cjs');
  writeFileSync(fixturePath, simulationCliSource(statePath), 'utf8');
  if (process.platform !== 'win32') {
    const executable = join(runRoot, 'codex-fixture');
    const wrapper = `#!/usr/bin/env node\nconst { spawnSync } = require('node:child_process');\nconst args = process.argv.slice(2);\nif (args[0] === '--version') { console.log('codex 0.46.0'); process.exit(0); }\nif (args[0] === 'exec' && args.includes('--help')) { console.log('Usage: codex exec --json'); process.exit(0); }\nconst result = spawnSync(process.execPath, [${JSON.stringify(fixturePath)}, ...args], { stdio: 'inherit' });\nprocess.exit(result.status ?? 1);\n`;
    writeFileSync(executable, wrapper, { encoding: 'utf8', mode: 0o755 });
    return realpathSync(executable);
  }

  const windir = process.env.WINDIR || 'C:\\Windows';
  const cscCandidates = [
    join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  const compiler = cscCandidates.find(existsSync);
  invariant(compiler, 'simulated Codex executable requires the installed Windows .NET Framework compiler');
  const executable = join(runRoot, 'codex-fixture.exe');
  const quoteCSharp = value => JSON.stringify(value);
  const source = `using System;\nusing System.Diagnostics;\nusing System.Linq;\nusing System.Text;\n\nstatic class CodexFixture {\n  static string Quote(string value) {\n    var b = new StringBuilder("\\\""); int slashes = 0;\n    foreach (char c in value) {\n      if (c == '\\\\') { slashes++; continue; }\n      if (c == '\\"') { b.Append('\\\\', slashes * 2 + 1); b.Append('\\"'); slashes = 0; continue; }\n      b.Append('\\\\', slashes); slashes = 0; b.Append(c);\n    }\n    b.Append('\\\\', slashes * 2); b.Append('\\\"'); return b.ToString();\n  }\n  static int Main(string[] args) {\n    if (args.Length == 1 && args[0] == "--version") { Console.WriteLine("codex 0.46.0"); return 0; }\n    if (args.Length >= 2 && args[0] == "exec" && args.Contains("--help")) { Console.WriteLine("Usage: codex exec --json"); return 0; }\n    try {\n      var start = new ProcessStartInfo(); start.FileName = ${quoteCSharp(process.execPath)};\n      start.Arguments = Quote(${quoteCSharp(fixturePath)}) + (args.Length == 0 ? "" : " " + String.Join(" ", args.Select(Quote)));\n      start.UseShellExecute = false; start.CreateNoWindow = true; start.RedirectStandardOutput = true; start.RedirectStandardError = true;\n      using (var child = Process.Start(start)) {\n        child.OutputDataReceived += (sender, eventArgs) => { if (eventArgs.Data != null) Console.Out.WriteLine(eventArgs.Data); };\n        child.ErrorDataReceived += (sender, eventArgs) => { if (eventArgs.Data != null) Console.Error.WriteLine(eventArgs.Data); };\n        child.BeginOutputReadLine(); child.BeginErrorReadLine(); child.WaitForExit(); child.WaitForExit(); return child.ExitCode;\n      }\n    } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }\n  }\n}\n`;
  const sourcePath = join(runRoot, 'codex-fixture.cs');
  writeFileSync(sourcePath, source, 'utf8');
  const result = spawnSync(compiler, ['/nologo', `/out:${executable}`, sourcePath], {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  invariant(!result.error && result.status === 0 && existsSync(executable),
    `could not compile the local Codex-protocol fixture: ${safeText(result.error?.message || result.stderr || result.stdout)}`);
  return realpathSync(executable);
}

function simulationPlan(kind) {
  const dir = 'agentos/scripts/fixtures/p4-existing-project-acceptance';
  const commands = [`node --test ${dir}/${kind}.test.mjs`];
  const objective = kind === 'defect'
    ? 'P4_ACCEPTANCE_SCENARIO=defect Correct repeated-whitespace normalization in the isolated acceptance fixture; preserve the existing simple case and fix the boundary behavior requested by independent review.'
    : 'P4_ACCEPTANCE_SCENARIO=feature Add deterministic slug normalization in the isolated acceptance fixture; preserve the basic case and address punctuation and accents after independent review.';
  return {
    kind, title: `Existing-project ${kind} acceptance fixture`, objective,
    expectedBaselineFailure: kind === 'defect' ? 'baseline exposes the whitespace defect' : 'baseline lacks slug normalization',
    scope: [`${dir}/${kind}.mjs`, `${dir}/${kind}.test.mjs`], baselineCommands: commands, acceptanceCommands: commands,
  };
}

function validatePlan(value) {
  invariant(value && typeof value === 'object' && Array.isArray(value.scenarios), 'plan must contain scenarios');
  invariant(value.scenarios.length === 2, 'plan must contain exactly defect and feature scenarios');
  const byKind = new Map(value.scenarios.map(item => [item.kind, item]));
  invariant(byKind.has('defect') && byKind.has('feature'), 'plan must contain exactly one defect and one feature');
  for (const kind of ['defect', 'feature']) {
    const scenario = byKind.get(kind);
    invariant(typeof scenario.title === 'string' && scenario.title.trim().length >= 8, `${kind} title is required`);
    invariant(typeof scenario.objective === 'string' && scenario.objective.trim().length >= 48, `${kind} objective must describe a concrete acceptance task`);
    invariant(typeof scenario.expectedBaselineFailure === 'string' && scenario.expectedBaselineFailure.trim().length >= 12,
      `${kind} expectedBaselineFailure must name a concrete failing assertion or output marker`);
    invariant(Array.isArray(scenario.scope) && scenario.scope.length > 0 && scenario.scope.every(item => typeof item === 'string' && item.length > 0), `${kind} scope is required`);
    invariant(Array.isArray(scenario.baselineCommands) && scenario.baselineCommands.length > 0 && scenario.baselineCommands.every(item => typeof item === 'string' && item.trim()), `${kind} baseline commands are required`);
    invariant(Array.isArray(scenario.acceptanceCommands) && scenario.acceptanceCommands.length > 0 && scenario.acceptanceCommands.every(item => typeof item === 'string' && item.trim()), `${kind} acceptance commands are required`);
  }
  return ['defect', 'feature'].map(kind => byKind.get(kind));
}

function validateRealPlanPaths(plans, repositoryRoot) {
  const root = realpathSync(repositoryRoot);
  for (const plan of plans) {
    const existing = [];
    for (const rawPath of plan.scope) {
      const scopedPath = rawPath.replaceAll('\\', '/');
      invariant(!scopedPath.startsWith('/') && !/^[a-z]:/iu.test(scopedPath)
        && !scopedPath.split('/').some(part => part === '..' || part === ''),
      `${plan.kind} real scope must use safe repository-relative paths`);
      invariant(/^agentos\/(?:apps|packages)\//iu.test(scopedPath)
        && !/fixtures\/p4-existing-project-acceptance/iu.test(scopedPath),
      `${plan.kind} real scope must target actual AgentOS application/package files, not runner fixtures`);
      const absolute = resolve(root, scopedPath);
      const relativePath = relative(root, absolute);
      invariant(relativePath && relativePath !== '..' && !relativePath.startsWith(`..${sep}`), `${plan.kind} scope escapes the frozen repository`);
      if (!existsSync(absolute)) continue; // A scoped feature file may be new; another existing source path must anchor it.
      invariant(!lstatSync(absolute).isSymbolicLink(), `${plan.kind} scope cannot traverse a symbolic link`);
      const actual = realpathSync(absolute);
      const actualRelative = relative(root, actual);
      invariant(actualRelative !== '..' && !actualRelative.startsWith(`..${sep}`), `${plan.kind} scope resolves outside the frozen repository`);
      existing.push(scopedPath);
    }
    invariant(existing.length > 0, `${plan.kind} real plan must anchor its scope to at least one existing frozen AgentOS source path`);
    invariant(JSON.stringify(plan.baselineCommands) !== JSON.stringify(plan.acceptanceCommands),
      `${plan.kind} real plan must separate frozen-baseline reproduction commands from candidate acceptance commands`);
    invariant(plan.baselineCommands.every(command => !/p4-existing-project-acceptance/iu.test(command)),
      `${plan.kind} real baseline commands cannot execute the deterministic runner fixture`);
    invariant(plan.acceptanceCommands.every(command => !/p4-existing-project-acceptance/iu.test(command)),
      `${plan.kind} real acceptance commands cannot execute the deterministic runner fixture`);
  }
  return plans;
}

function parseArguments(argv) {
  const options = { mode: undefined, expectedSha: undefined, repositoryRoot: repoRoot, evidenceDir: undefined, receiptPath: undefined, planPath: undefined, model: undefined, runReal: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--run-real-provider') { invariant(!seen.has(arg), `${arg} repeated`); seen.add(arg); options.runReal = true; continue; }
    if (!['--mode', '--expected-sha', '--repository-root', '--evidence-dir', '--verify-receipt', '--plan', '--model'].includes(arg)) throw new Error(`unknown argument: ${arg}`);
    invariant(!seen.has(arg), `${arg} repeated`); seen.add(arg);
    const value = argv[++i]; invariant(value && !value.startsWith('--'), `${arg} requires a value`);
    if (arg === '--mode') options.mode = value;
    else if (arg === '--expected-sha') options.expectedSha = value;
    else if (arg === '--repository-root') options.repositoryRoot = resolve(value);
    else if (arg === '--evidence-dir') options.evidenceDir = resolve(value);
    else if (arg === '--verify-receipt') options.receiptPath = resolve(value);
    else if (arg === '--plan') options.planPath = resolve(value);
    else options.model = value;
  }
  invariant(options.expectedSha && shaPattern.test(options.expectedSha), '--expected-sha must be a full commit SHA');
  if (options.receiptPath) {
    invariant(!options.mode && !options.runReal && !options.planPath, '--verify-receipt cannot be combined with execution options');
    invariant(existsSync(options.receiptPath), '--verify-receipt path does not exist');
    options.evidenceDir ??= dirname(options.receiptPath);
    return options;
  }
  invariant(['simulated-provider', 'real-windows-acceptance'].includes(options.mode), '--mode must be simulated-provider or real-windows-acceptance');
  if (options.mode === 'real-windows-acceptance') {
    invariant(options.runReal, 'real provider execution requires the explicit --run-real-provider flag');
    invariant(process.platform === 'win32', 'real-windows-acceptance is Windows-only');
    invariant(process.env.CI?.toLowerCase() !== 'true', 'real-windows-acceptance cannot run in CI');
    invariant(options.planPath && existsSync(options.planPath), 'real mode requires --plan with concrete defect and feature acceptance scenarios');
    invariant(options.model || process.env.AGENTOS_CODEX_MODEL, 'real mode requires --model or AGENTOS_CODEX_MODEL');
  } else {
    invariant(!options.runReal, '--run-real-provider is only valid with real-windows-acceptance');
  }
  return options;
}

function createServerRoot(runRoot) {
  const root = join(runRoot, 'server-data');
  mkdirSync(root, { recursive: true });
  return root;
}

async function reservePort() {
  const server = await import('node:net').then(({ createServer }) => createServer());
  await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolvePromise); });
  const port = server.address().port;
  await new Promise(resolvePromise => server.close(resolvePromise));
  return port;
}

function runBuild(packageRoot) {
  const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'pnpm';
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'pnpm --filter @agentos/server build']
    : ['--filter', '@agentos/server', 'build'];
  const result = spawnSync(command, args, { cwd: packageRoot, encoding: 'utf8', windowsHide: true, shell: false, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  invariant(!result.error && result.status === 0, `production server build failed: ${safeText(result.error?.message || result.stderr || result.stdout)}`);
}

function resolveExecutablePath(value) {
  if (existsSync(value)) return realpathSync(value);
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(locator, [value], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 10_000 });
  const resolved = result.status === 0 ? result.stdout.split(/\r?\n/u).map(item => item.trim()).find(Boolean) : undefined;
  invariant(resolved && existsSync(resolved), `could not resolve configured executable: ${value}`);
  return realpathSync(resolved);
}

async function startServer(runRoot, projectRoot, { requireP2Ready = false, worktreeRoot } = {}) {
  invariant(worktreeRoot, 'isolated runtime worktree root is required');
  const port = await reservePort();
  const child = spawn(process.execPath, [join(scriptRoot, 'apps/server/dist/index.js')], {
    cwd: scriptRoot,
    env: {
      ...process.env,
      AGENTOS_PROJECT_ROOT: projectRoot,
      AGENTOS_WORKTREE_ROOT: worktreeRoot,
      AGENTOS_SERVER_HOST: '127.0.0.1',
      AGENTOS_RUNTIME_DISPATCH_ENABLED: 'true',
      AGENTOS_FORCE_MOCK: 'false',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });
  const output = { text: '' };
  const collect = chunk => { output.text = safeText((output.text + chunk.toString()).slice(-32_000)); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('error', error => { output.text = safeText(`${output.text}\n${error.message}`); });
  const baseUrl = `http://127.0.0.1:${port}`;
  let readinessPath;
  let ready = false;
  try {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`isolated AgentOS server exited ${child.exitCode}: ${output.text}`);
    let response;
    let readinessEndpointsMissing = true;
    for (const path of ['/api/health/ready', '/api/maintenance/readiness']) {
      try { response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(1500) }); }
      catch { response = undefined; readinessEndpointsMissing = false; break; }
      if (response.status === 404) continue;
      readinessEndpointsMissing = false;
      if (response.status === 503) { response = undefined; readinessPath = path; break; }
      if (response.ok) { readinessPath = path; break; }
      throw new Error(`AgentOS readiness ${path} returned ${response.status}`);
    }
    if (response?.ok) { ready = true; break; }
    if (readinessPath && !response) { await delay(250); continue; }
    if (!readinessPath && readinessEndpointsMissing) {
      if (requireP2Ready) {
        throw new Error('P2 readiness endpoint is not present; refusing to begin an acceptance task');
      }
      try {
        const live = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1500) });
        if (live.ok) { readinessPath = '/api/health (legacy liveness fallback; simulated mode only)'; ready = true; break; }
      } catch { /* server is still starting */ }
    }
    await delay(250);
  }
  invariant(readinessPath && ready, `isolated AgentOS server did not become ready: ${output.text}`);
  return { child, output, baseUrl, port, readinessPath, worktreeRoot,
    databasePath: join(projectRoot, '.agentos', 'agentos.sqlite') };
  } catch (error) {
    await stopServer({ child }).catch(() => undefined);
    throw new Error(`${error instanceof Error ? error.message : String(error)}; server output: ${output.text}`);
  }
}

async function stopServer(server) {
  const hasExited = child => child.exitCode !== null || child.signalCode !== null;
  if (!server?.child || hasExited(server.child)) return;
  const exited = new Promise(resolvePromise => server.child.once('exit', resolvePromise));
  server.child.kill('SIGTERM');
  await Promise.race([exited, delay(10_000)]);
  if (!hasExited(server.child)) {
    server.child.kill('SIGKILL');
    await Promise.race([exited, delay(3000)]);
  }
  invariant(hasExited(server.child), 'isolated AgentOS server did not stop through its owned child handle');
}

async function request(baseUrl, route, { method = 'GET', body, headers = {}, timeoutMs = 30_000 } = {}) {
  let response;
  try {
    response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`${method} ${route} failed before an HTTP response: ${safeText(error instanceof Error ? error.message : String(error))}`);
  }
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  return { status: response.status, ok: response.ok, body: parsed, text, headers: response.headers };
}

async function api(baseUrl, route, options) {
  const result = await request(baseUrl, route, options);
  invariant(result.ok, `${options?.method ?? 'GET'} ${route} returned ${result.status}: ${safeText(result.text)}`);
  return result;
}

async function approveOwnedProviderStages(server, workspaceId, runId, implementerAgentId, executable, kind, evidenceRoot) {
  const listed = await api(server.baseUrl,
    `/api/workspaces/${encodeURIComponent(workspaceId)}/runtime-approvals`);
  const pending = selectOwnedPendingApprovals(listed.body.requests, {
    workspaceId, runId, implementerAgentId, executable, worktreeRoot: server.worktreeRoot,
  });
  for (const request of pending) {
    recordProgress(evidenceRoot, kind, { event: 'approval-requested', runId, requestId: request.id,
      stageId: request.stageId, stageAttempt: request.stageAttempt, category: request.category,
      riskLevel: request.riskLevel });
    await api(server.baseUrl,
      `/api/workspaces/${encodeURIComponent(workspaceId)}/runtime-approvals/${encodeURIComponent(request.id)}/resolve`, {
        method: 'POST', body: {
          expectedVersion: request.version, decision: 'approve_once',
          decidedBy: 'p4-existing-project-acceptance-runner',
        },
      });
    console.error(`P4_ACCEPTANCE_PROGRESS=${kind}: approved one frozen provider stage request=${request.id} attempt=${request.stageAttempt}`);
  }
  return pending.length;
}

function setupWorkspaceClone(sourceRoot, runRoot, kind, sourceSha, mode, statePath) {
  const target = join(runRoot, 'workspaces', kind);
  mkdirSync(dirname(target), { recursive: true });
  const clone = spawnSync('git', ['clone', '--shared', '--no-checkout', sourceRoot, target], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 });
  invariant(clone.status === 0, `could not make isolated ${kind} repository: ${safeText(clone.stderr)}`);
  // Configure only the disposable clone before materializing the frozen source.
  // Git for Windows can otherwise leave deep tracked cache paths absent.
  if (process.platform === 'win32') git(target, ['config', 'core.longpaths', 'true']);
  git(target, ['checkout', '--detach', sourceSha]);
  // A tracked .claude/worktrees gitlink is local worktree metadata, not an
  // application source file. The production snapshot service correctly rejects
  // every submodule mode, so omit only those metadata entries in this disposable
  // clone and bind the resulting baseline commit directly to sourceSha.
  const gitlinks = git(target, ['ls-files', '-s']).split(/\r?\n/u)
    .map(line => /^160000 [0-9a-f]+ 0\t(.+)$/iu.exec(line)?.[1])
    .filter(path => path && /(?:^|\/)\.claude\/worktrees\//iu.test(path));
  if (mode === 'simulated-provider') {
    const resolvedRunRoot = realpathSync(runRoot);
    const resolvedTarget = realpathSync(target);
    const gitTopLevel = realpathSync(git(target, ['rev-parse', '--show-toplevel']));
    const targetIdentity = statSync(resolvedTarget, { bigint: true });
    const gitIdentity = statSync(gitTopLevel, { bigint: true });
    invariant(relative(resolvedRunRoot, resolvedTarget).toLowerCase().startsWith(`workspaces${sep}`.toLowerCase())
      && targetIdentity.dev === gitIdentity.dev && targetIdentity.ino !== 0n && targetIdentity.ino === gitIdentity.ino,
    'simulated fixture compaction is limited to the runner-owned temporary Git clone');
    // Simulated acceptance exercises the complete production API and native
    // process pipeline while keeping Git snapshot work small and deterministic.
    // It is intentionally not an application-source acceptance claim.
    git(target, ['rm', '--cached', '--force', '-r', '--', '.']);
    git(target, ['clean', '--force', '--force', '-d', '-x']);
    const fixtureRoot = join(target, 'agentos/scripts/fixtures/p4-existing-project-acceptance');
    mkdirSync(fixtureRoot, { recursive: true });
    writeFileSync(join(fixtureRoot, 'defect.mjs'), "export function normalizeWhitespace(value) { return String(value); }\n");
    writeFileSync(join(fixtureRoot, 'defect.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import { normalizeWhitespace } from './defect.mjs'; test('baseline exposes the whitespace defect', () => assert.equal(normalizeWhitespace('one   two'), 'one two'));\n");
    writeFileSync(join(fixtureRoot, 'feature.mjs'), "export function slugify(value) { return String(value ?? ''); }\n");
    writeFileSync(join(fixtureRoot, 'feature.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import { slugify } from './feature.mjs'; test('baseline lacks slug normalization', () => assert.equal(slugify('Quick Start'), 'quick-start'));\n");
    writeFileSync(join(target, 'exec'), simulationCliSource(statePath), 'utf8');
    git(target, ['add', 'agentos/scripts/fixtures/p4-existing-project-acceptance', 'exec']);
    git(target, ['-c', 'user.name=AgentOS acceptance fixture', '-c', 'user.email=acceptance-fixture@example.invalid', 'commit', '-m', `P4 ${kind} deterministic fixture`]);
  } else if (gitlinks.length) {
    git(target, ['rm', '--cached', '--ignore-unmatch', '--', ...gitlinks]);
    git(target, ['-c', 'user.name=AgentOS acceptance fixture', '-c', 'user.email=acceptance-fixture@example.invalid', 'commit', '-m', `P4 ${kind} isolated acceptance baseline`]);
  }
  const baseCommit = git(target, ['rev-parse', 'HEAD']);
  return {
    root: target, baseCommit, baseTreeSha: git(target, ['rev-parse', 'HEAD^{tree}']), sourceCommitSha: sourceSha,
    baseParentCommitSha: mode === 'simulated-provider' || gitlinks.length ? git(target, ['rev-parse', 'HEAD^']) : baseCommit,
    excludedGitlinkPaths: gitlinks,
    workspaceKind: mode === 'simulated-provider' ? 'minimal-deterministic-fixture' : 'frozen-agentos-source',
  };
}

function captureBaselineReproduction(evidenceRoot, plan, workspace) {
  const commands = plan.baselineCommands.map((command, index) => {
    const observedAt = new Date().toISOString();
    const result = spawnSync(command, {
      cwd: workspace.root, encoding: 'utf8', shell: true, windowsHide: true,
      timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    });
    invariant(!result.error && Number.isInteger(result.status),
      `${plan.kind} baseline command could not complete: ${safeText(result.error?.message || '')}`);
    const stdoutText = safeText(result.stdout || '');
    const stderrText = safeText(result.stderr || '');
    const commandId = `${plan.kind}-baseline-${index + 1}-${randomUUID()}`;
    const stdout = writeArtifact(evidenceRoot, `scenarios/${plan.kind}/baseline/${commandId}.stdout.txt`, stdoutText);
    const stderr = writeArtifact(evidenceRoot, `scenarios/${plan.kind}/baseline/${commandId}.stderr.txt`, stderrText);
    const artifact = writeJsonArtifact(evidenceRoot, `scenarios/${plan.kind}/baseline/${commandId}.json`, {
      schemaVersion: 1, kind: 'baseline-command', scenarioKind: plan.kind, commandId, command,
      cwd: workspace.root, rawExitCode: result.status, expectedOutcome: 'nonzero-reproduction',
      expectedFailurePattern: plan.expectedBaselineFailure, workspaceBaseCommit: workspace.baseCommit,
      workspaceBaseTreeSha: workspace.baseTreeSha, sourceCommitSha: workspace.sourceCommitSha,
      baseParentCommitSha: workspace.baseParentCommitSha, excludedGitlinkPaths: workspace.excludedGitlinkPaths,
      workspaceKind: workspace.workspaceKind,
      observedAt, stdout, stderr,
    });
    return { id: commandId, command, rawExitCode: result.status, artifact };
  });
  const expectedFailureCaptured = commands.some(command => {
    const artifactPath = resolve(evidenceRoot, command.artifact.artifactPath);
    const record = JSON.parse(readFileSync(artifactPath, 'utf8'));
    const stdout = readFileSync(resolve(evidenceRoot, record.stdout.artifactPath), 'utf8');
    const stderr = readFileSync(resolve(evidenceRoot, record.stderr.artifactPath), 'utf8');
    return command.rawExitCode !== 0 && `${stdout}\n${stderr}`.includes(plan.expectedBaselineFailure);
  });
  invariant(expectedFailureCaptured, `${plan.kind} frozen workspace did not reproduce its declared baseline failure`);
  return {
    status: 'reproduced', expectedFailurePattern: plan.expectedBaselineFailure,
    baseCommit: workspace.baseCommit, baseTreeSha: workspace.baseTreeSha,
    sourceCommitSha: workspace.sourceCommitSha, baseParentCommitSha: workspace.baseParentCommitSha,
    excludedGitlinkPaths: workspace.excludedGitlinkPaths, workspaceKind: workspace.workspaceKind, commands,
  };
}

function selectAgents(agents) {
  const choose = names => agents.find(agent => names.includes(agent.id)) ?? agents.find(agent => names.includes(agent.role));
  const planner = choose(['codex', 'codex_manager']);
  const implementer = choose(['kimi', 'kimi_worker']);
  const reviewer = choose(['opencode', 'opencode_reviewer']);
  invariant(planner && implementer && reviewer && new Set([planner.id, implementer.id, reviewer.id]).size === 3,
    'default workspace must expose distinct Codex, Kimi, and OpenCode Agent profiles');
  return { planner, implementer, reviewer };
}

async function configureWorkspace(baseUrl, workspaceId, mode, model, executable) {
  const profiles = await api(baseUrl, `/api/workspaces/${encodeURIComponent(workspaceId)}/agents`);
  const agents = selectAgents(profiles.body.agents);
  const roleConfig = [
    [agents.planner, 'planner', ['read']],
    [agents.implementer, 'implementer', ['read', 'write']],
    [agents.reviewer, 'reviewer', ['read', 'review']],
  ];
  // Replace potentially stale provider/model settings before patching profiles:
  // the profile endpoint validates its existing model against the selected adapter.
  const providers = await api(baseUrl, `/api/workspaces/${encodeURIComponent(workspaceId)}/provider-configs`);
  const configs = new Map(providers.body.providerConfigs.map(config => [config.id, config]));
  for (const agent of Object.values(agents)) {
    const config = configs.get(agent.providerConfigId);
    invariant(config, `provider configuration missing for ${agent.id}`);
    await api(baseUrl, `/api/workspaces/${encodeURIComponent(workspaceId)}/provider-configs/${encodeURIComponent(config.id)}`, {
      method: 'PUT',
      body: {
        expectedVersion: config.version,
        providerType: 'codex', adapterId: 'builtin.codex', runtimeMode: 'cli', executable,
        argsTemplate: mode === 'simulated-provider' ? ['exec'] : ['exec', '--ephemeral', '--skip-git-repo-check'],
        model, workingDirectoryMode: 'worktree', outputMode: 'structured', enabled: true,
      },
    });
  }
  for (const [agent, role, permissions] of roleConfig) {
    const systemPrompt = mode === 'simulated-provider'
      ? `P4_ACCEPTANCE_SIM_ROLE=${role}\nYou are the ${role}. Stay within the approved plan and report concrete evidence.`
      : `You are the ${role} in a bounded existing-project acceptance run. Follow the user's concrete plan, keep changes within scope, and report evidence.`;
    await api(baseUrl, `/api/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agent.id)}`, {
      method: 'PATCH', body: { permissions, systemPrompt },
    });
  }
  return agents;
}

async function createAndRunScenario(server, plan, workspaceRoot, baselineEvidence, mode, model, executable, evidenceRoot) {
  console.error(`P4_ACCEPTANCE_PROGRESS=${plan.kind}: creating isolated workspace and task`);
  recordProgress(evidenceRoot, plan.kind, { event: 'workspace-creation-started', mode });
  const workspace = await api(server.baseUrl, '/api/workspaces', {
    method: 'POST', body: { name: `P4 acceptance ${plan.kind} ${randomUUID().slice(0, 8)}`, rootPath: workspaceRoot.root, git: true, memory: false, readme: false, docs: false },
  });
  const workspaceId = workspace.body.workspace.id;
  recordProgress(evidenceRoot, plan.kind, { event: 'workspace-created', workspaceId });
  const agents = await configureWorkspace(server.baseUrl, workspaceId, mode, model, executable);
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/collaboration/tasks`;
  const created = await api(server.baseUrl, base, {
    method: 'POST', timeoutMs: 120_000, body: {
      title: plan.title, objective: plan.objective, scope: plan.scope, acceptanceCommands: plan.acceptanceCommands,
      plannerAgentId: agents.planner.id, implementerAgentId: agents.implementer.id, reviewerAgentId: agents.reviewer.id,
      maxReworkRounds: 1,
    },
  });
  console.error(`P4_ACCEPTANCE_PROGRESS=${plan.kind}: task created; confirming bounded run`);
  let task = created.body.task;
  const taskId = task.id;
  recordProgress(evidenceRoot, plan.kind, { event: 'task-created', workspaceId, taskId,
    plannerAgentId: agents.planner.id, implementerAgentId: agents.implementer.id,
    reviewerAgentId: agents.reviewer.id });
  let confirmationComplete = false;
  let confirmationError;
  const confirmation = api(server.baseUrl, `${base}/${encodeURIComponent(taskId)}/confirm`, {
    method: 'POST', timeoutMs: 180_000, body: { expectedVersion: task.version }, headers: { 'Idempotency-Key': `p4-acceptance-confirm-${randomUUID()}` },
  }).then(() => { confirmationComplete = true; }, error => { confirmationError = error; });
  const confirmationDeadline = Date.now() + 180_000;
  while (!confirmationComplete && !confirmationError && Date.now() < confirmationDeadline) {
    await delay(5000);
    if (confirmationComplete || confirmationError) break;
    try {
      const observed = await api(server.baseUrl, `${base}/${encodeURIComponent(taskId)}/progress`, { timeoutMs: 5000 });
      task = observed.body.progress.task;
      console.error(`P4_ACCEPTANCE_PROGRESS=${plan.kind}: confirm pending; task=${task.status}; control=${task.pendingControl?.state ?? 'none'}`);
    } catch (error) {
      console.error(`P4_ACCEPTANCE_PROGRESS=${plan.kind}: confirm pending; progress probe=${safeText(error instanceof Error ? error.message : String(error))}`);
    }
  }
  await confirmation;
  invariant(confirmationComplete, `${plan.kind} confirmation exceeded the 180s bounded wait`);
  console.error(`P4_ACCEPTANCE_PROGRESS=${plan.kind}: run confirmed; awaiting review/revision`);
  recordProgress(evidenceRoot, plan.kind, { event: 'run-confirmed', taskId,
    runId: task.canonicalRunId ?? null });
  const deadline = Date.now() + (mode === 'real-windows-acceptance' ? 900_000 : 240_000);
  let details;
  let lastObserved;
  let lastProgressSignature;
  while (Date.now() < deadline) {
    const progress = await api(server.baseUrl, `${base}/${encodeURIComponent(taskId)}/progress`);
    const view = progress.body.progress;
    task = view.task;
    const currentRunId = view.currentRunId ?? task.canonicalRunId;
    const currentRun = view.runs.find(run => run.runId === currentRunId) ?? view.runs.at(-1);
    const currentStage = view.currentStage;
    lastObserved = {
      taskStatus: task.status,
      runId: currentRun?.runId ?? currentRunId ?? null,
      runStatus: currentRun?.status ?? 'unknown',
      stageKey: currentStage?.stageKey ?? 'unknown',
      stageStatus: currentStage?.status ?? 'unknown',
      stageAttempt: currentStage?.attempt ?? null,
      eventCursor: view.eventCursor ?? 0,
      candidateCount: view.candidates?.length ?? 0,
    };
    const signature = JSON.stringify(lastObserved);
    if (signature !== lastProgressSignature) {
      console.error(`P4_ACCEPTANCE_PROGRESS=${plan.kind}: ${JSON.stringify(lastObserved)}`);
      recordProgress(evidenceRoot, plan.kind, { event: 'runtime-progress', ...lastObserved });
      lastProgressSignature = signature;
    }
    if (currentRun?.runId) {
      await approveOwnedProviderStages(server, workspaceId, currentRun.runId,
        agents.implementer.id, executable, plan.kind, evidenceRoot);
    }
    if (['awaiting_application', 'failed', 'blocked', 'cancelled', 'applied'].includes(task.status)) {
      details = await api(server.baseUrl, `${base}/${encodeURIComponent(taskId)}`);
      break;
    }
    await delay(500);
  }
  invariant(details, `${plan.kind} collaboration exceeded its ${mode === 'real-windows-acceptance' ? 900 : 240}s bound; last observed ${JSON.stringify(lastObserved ?? { taskStatus: task.status })}`);
  invariant(task.status === 'awaiting_application', `${plan.kind} task did not reach approved application state: ${task.status}; ${safeText(task.failureReason || '')}`);
  const candidates = loadOwnedFrozenCandidates(server.databasePath, workspaceId, taskId, details.body.candidates);
  const reviews = details.body.reviews.slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  invariant(candidates.length === 2 && candidates[0].round === 0 && candidates[1].round === 1, `${plan.kind} did not produce exactly one review revision`);
  invariant(reviews.length === 2 && reviews[0].conclusion === 'changes_requested' && reviews[1].conclusion === 'approved', `${plan.kind} lacks changes-requested -> revision -> approved review history`);
  invariant(candidates[0].diffHash !== candidates[1].diffHash, `${plan.kind} revision did not change the frozen candidate`);
  invariant(reviews[0].candidateId === candidates[0].id && reviews[1].candidateId === candidates[1].id, `${plan.kind} reviews do not bind the respective candidates`);
  invariant(reviews.every(review => review.reviewerAgentId === agents.reviewer.id), `${plan.kind} review was not performed by its assigned reviewer`);
  invariant(candidates[1].testStatus === 'passed' && candidates[1].testExitCode === 0, `${plan.kind} final acceptance command did not pass`);
  console.error(`P4_ACCEPTANCE_PROGRESS=${plan.kind}: review requested changes; revision hash ${candidates[0].diffHash} -> ${candidates[1].diffHash}; independent approval persisted`);
  recordProgress(evidenceRoot, plan.kind, { event: 'review-revision-approved', taskId,
    runId: task.canonicalRunId, priorCandidateId: candidates[0].id, priorCandidateSha256: candidates[0].diffHash,
    finalCandidateId: candidates[1].id, finalCandidateSha256: candidates[1].diffHash,
    reviewIds: reviews.map(review => review.id), retestExitCode: candidates[1].testExitCode });

  const initialPatch = Buffer.from(candidates[0].diffText, 'utf8');
  const finalPatch = Buffer.from(candidates[1].diffText, 'utf8');
  assertNoSecretLikeDiff(initialPatch.toString('utf8'));
  assertNoSecretLikeDiff(finalPatch.toString('utf8'));
  const priorRef = writeArtifact(evidenceRoot, `scenarios/${plan.kind}/prior.patch`, initialPatch);
  const finalRef = writeArtifact(evidenceRoot, `scenarios/${plan.kind}/final.patch`, finalPatch);
  invariant(priorRef.sha256 === candidates[0].diffHash && finalRef.sha256 === candidates[1].diffHash, `${plan.kind} candidate patch bytes differ from stored hashes`);

  const approvedTask = details.body.task;
  const candidateSummary = details.body.candidate;
  const candidateBaseCommit = approvedTask.baseCommit;
  invariant(candidateSummary?.id === candidates[1].id && candidateSummary.diffHash === finalRef.sha256
    && hashPattern.test(candidateSummary.contentHash ?? '') && shaPattern.test(candidateBaseCommit ?? ''),
  `${plan.kind} approved task details lack the frozen candidate preview identity`);
  const previewIdentity = {
    workspaceId, collaborationTaskId: taskId, candidateId: candidateSummary.id,
    baseCommit: candidateBaseCommit, contentHash: candidateSummary.contentHash, diffHash: candidateSummary.diffHash,
  };
  const previewQuery = new URLSearchParams({
    candidateBaseCommit: previewIdentity.baseCommit,
    candidateContentHash: previewIdentity.contentHash,
  });
  const previewRoute = `${base}/${encodeURIComponent(taskId)}/candidates/${encodeURIComponent(candidates[1].id)}/preview?${previewQuery}`;
  const preview = await api(server.baseUrl, previewRoute);
  const appliedPreviewIdentity = verifyFrozenCandidatePreview(preview.body, previewIdentity);
  const previewBytes = Buffer.from(JSON.stringify(preview.body, null, 2) + '\n');
  recordProgress(evidenceRoot, plan.kind, { event: 'candidate-preview-verified', candidateId: candidates[1].id,
    candidateSha256: finalRef.sha256, candidateContentHash: previewIdentity.contentHash, previewPath: previewRoute });

  const applyRoute = `${base}/${encodeURIComponent(taskId)}/apply`;
  const applyRequestBody = {
    expectedVersion: approvedTask.version,
    candidateId: appliedPreviewIdentity.candidateId,
    candidateBaseCommit: appliedPreviewIdentity.candidateBaseCommit,
    candidateContentHash: appliedPreviewIdentity.candidateContentHash,
  };
  const applied = await api(server.baseUrl, `${base}/${encodeURIComponent(taskId)}/apply`, {
    method: 'POST', body: applyRequestBody, headers: { 'Idempotency-Key': `p4-acceptance-apply-${randomUUID()}` },
  });
  invariant(applied.body.task?.status === 'applied' && applied.body.task.currentCandidateId === candidates[1].id,
    `${plan.kind} apply API did not apply the reviewed candidate`);
  const afterApply = await api(server.baseUrl, `${base}/${encodeURIComponent(taskId)}`);
  invariant(afterApply.body.task.status === 'applied' && afterApply.body.task.currentCandidateId === candidates[1].id
    && afterApply.body.candidate?.id === candidates[1].id && afterApply.body.candidate.diffHash === finalRef.sha256,
  `${plan.kind} persisted apply state or frozen candidate identity is missing`);
  console.error(`P4_ACCEPTANCE_PROGRESS=${plan.kind}: retest exit=0; preview verified; apply persisted`);
  recordProgress(evidenceRoot, plan.kind, { event: 'candidate-applied-and-persisted', candidateId: candidates[1].id,
    candidateSha256: finalRef.sha256, applyStatus: afterApply.body.task.status });

  const history = [];
  const requestedChanges = [safeText(reviews[0].summary)];
  const reviewRequest = {
    id: reviews[0].id, transition: 'changes-requested', actorRole: 'reviewer', actorId: agents.reviewer.id,
    timestamp: reviews[0].createdAt, candidateSha256: candidates[0].diffHash, requestedChanges,
  };
  const scenarioId = `${plan.kind}-${taskId}`;
  reviewRequest.evidence = writeReviewEvidence(evidenceRoot, plan.kind, scenarioId, reviewRequest.id, reviewRequest);
  history.push(reviewRequest);
  const changedPaths = changedPathsFromPatch(candidates[1].diffText);
  assertCandidateChangesStayInScope(plan, changedPaths);
  const revision = {
    id: candidates[1].id, transition: 'revision-submitted', actorRole: 'implementer', actorId: agents.implementer.id,
    timestamp: candidates[1].createdAt, fromCandidateSha256: candidates[0].diffHash,
    toCandidateSha256: candidates[1].diffHash, addressedReviewEventId: reviews[0].id, changedPaths,
  };
  revision.evidence = writeReviewEvidence(evidenceRoot, plan.kind, scenarioId, revision.id, revision);
  history.push(revision);
  const approval = {
    id: reviews[1].id, transition: 'approved', actorRole: 'reviewer', actorId: agents.reviewer.id,
    timestamp: reviews[1].createdAt, candidateSha256: candidates[1].diffHash, decision: 'approved',
  };
  approval.evidence = writeReviewEvidence(evidenceRoot, plan.kind, scenarioId, approval.id, approval);
  history.push(approval);

  const commands = [];
  const makeCommand = (stage, argv, rawOutput, result, pathFragment, requestBody = null) => {
    const commandId = `${plan.kind}-${stage}-${randomUUID()}`;
    const outputText = Buffer.isBuffer(rawOutput) ? rawOutput.toString('utf8') : String(rawOutput ?? '');
    const sanitizedOutput = safeText(outputText);
    const stdout = writeJsonArtifact(evidenceRoot, `scenarios/${plan.kind}/commands/${commandId}.stdout.json`, {
      schemaVersion: 1, commandId, frozenCandidateSha256: candidates[1].diffHash,
      outputSha256: sha256(Buffer.from(sanitizedOutput, 'utf8')), output: sanitizedOutput,
    });
    const stderr = writeArtifact(evidenceRoot, `scenarios/${plan.kind}/commands/${commandId}.stderr.txt`, '');
    const observedAt = new Date().toISOString();
    const cwd = workspaceRoot.root;
    const artifact = writeJsonArtifact(evidenceRoot, `scenarios/${plan.kind}/commands/${commandId}.json`, {
      schemaVersion: 1, kind: 'acceptance-command', scenarioId, stage, commandId, argv,
      cwd, rawExitCode: result.rawExitCode, expectedExitCode: 0, frozenCandidateSha256: candidates[1].diffHash,
      stdout, stderr, stageResult: result, observedAt, apiPath: pathFragment, requestBody,
    });
    commands.push({ id: commandId, stage, argv, cwd, rawExitCode: result.rawExitCode, expectedExitCode: 0, frozenCandidateSha256: candidates[1].diffHash, artifact });
  };
  makeCommand('retest', plan.acceptanceCommands, candidates[1].testOutput, {
    status: 'passed', testRunId: candidates[1].id, commandCount: plan.acceptanceCommands.length, rawExitCode: candidates[1].testExitCode,
  }, undefined);
  makeCommand('preview', ['GET', previewRoute], previewBytes, {
    status: 'ready', previewId: candidates[1].id, candidateSha256: candidates[1].diffHash, rawExitCode: 0,
  }, previewRoute);
  makeCommand('apply', ['POST', applyRoute], JSON.stringify(applied.body), {
    status: 'applied', applicationId: applied.body.task.applyIdempotencyKey ?? taskId, candidateSha256: candidates[1].diffHash, rawExitCode: 0,
  }, applyRoute, applyRequestBody);

  const progress = (await api(server.baseUrl, `${base}/${encodeURIComponent(taskId)}/progress`)).body.progress;
  const runIds = progress.runs.map(run => run.runId);
  const scenario = {
    id: `${plan.kind}-${taskId}`, kind: plan.kind, status: 'passed',
    ids: { projectId: workspaceId, taskId, runId: candidates[1].canonicalRunId, candidateId: candidates[1].id },
    baselineCommands: plan.baselineCommands,
    acceptanceCommands: plan.acceptanceCommands,
    previewIdentity: {
      candidateId: previewIdentity.candidateId, baseCommit: previewIdentity.baseCommit,
      contentHash: previewIdentity.contentHash, diffHash: previewIdentity.diffHash,
    },
    baselineReproduction: baselineEvidence,
    roles: { planner: agents.planner.id, implementer: agents.implementer.id, reviewer: agents.reviewer.id },
    frozenCandidate: { ...finalRef, commitSha: server.sourceSnapshot.commitSha, treeSha: server.sourceSnapshot.treeSha },
    priorCandidate: priorRef,
    workspaceBaseCommit: candidates[1].baseCommit,
    workspaceBaseTreeSha: workspaceRoot.baseTreeSha,
    reviewHistory: history,
    commands,
    runtimeEvidence: { workspaceId, collaborationTaskId: taskId, runIds, candidateIds: candidates.map(row => row.id), reviewIds: reviews.map(row => row.id), eventIds: [] },
  };
  return { scenario, agentBindings: agents, runIds, candidateIds: candidates.map(row => row.id), reviewIds: reviews.map(row => row.id), previewResponse: preview.body, applyResponse: applied.body };
}

function tableRows(db, sql, ...args) { return db.prepare(sql).all(...args); }
function verifyRuntimeDatabaseEvidence(evidenceRoot, receipt) {
  const databaseRef = receipt.runtimeEvidence?.database;
  invariant(databaseRef && typeof databaseRef.artifactPath === 'string' && hashPattern.test(databaseRef.sha256), 'runtime database evidence reference is required');
  const databasePath = resolve(evidenceRoot, databaseRef.artifactPath);
  const evidenceRel = relative(resolve(evidenceRoot), databasePath);
  invariant(evidenceRel !== '..' && !evidenceRel.startsWith(`..${sep}`) && existsSync(databasePath), 'runtime database must be inside evidence directory');
  invariant(hashFile(databasePath) === databaseRef.sha256, 'runtime database SHA-256 does not match copied bytes');
  invariant(Number.isSafeInteger(receipt.runtimeEvidence.serverPid) && receipt.runtimeEvidence.serverPid > 0
    && Number.isInteger(receipt.runtimeEvidence.port) && receipt.runtimeEvidence.port > 0 && receipt.runtimeEvidence.port < 65536
    && typeof receipt.runtimeEvidence.readinessPath === 'string', 'isolated production server identity is incomplete');
  const serverProcess = receipt.runtimeEvidence.serverProcess;
  invariant(serverProcess?.pid === receipt.runtimeEvidence.serverPid && serverProcess.stopped === true
    && (Number.isInteger(serverProcess.exitCode) || typeof serverProcess.signalCode === 'string'),
  'isolated production server stop is not proven through its owned child process handle');
  if (receipt.mode === 'real-windows-acceptance') {
    invariant(receipt.runtimeEvidence.readinessPath !== '/api/health (legacy liveness fallback; simulated mode only)',
      'real acceptance cannot use liveness as readiness');
  }

  const requireSameSet = (declared, actual, description) => {
    invariant(Array.isArray(declared) && declared.length === actual.length
      && new Set(declared).size === declared.length && declared.every(value => actual.includes(value)),
    `${description} do not match the persisted database rows`);
  };
  const readCommand = (scenario, stage) => {
    const command = scenario.commands.find(item => item.stage === stage);
    invariant(command, `${scenario.kind} ${stage} command receipt is missing`);
    const commandPath = resolve(evidenceRoot, command.artifact.artifactPath);
    invariant(hashFile(commandPath) === command.artifact.sha256, `${scenario.kind} ${stage} command artifact hash mismatch`);
    const record = JSON.parse(readFileSync(commandPath, 'utf8'));
    invariant(record.commandId === command.id && record.scenarioId === scenario.id && record.stage === stage
      && record.rawExitCode === command.rawExitCode && record.frozenCandidateSha256 === scenario.frozenCandidate.sha256,
    `${scenario.kind} ${stage} command artifact identity mismatch`);
    const outputPath = resolve(evidenceRoot, record.stdout.artifactPath);
    invariant(hashFile(outputPath) === record.stdout.sha256, `${scenario.kind} ${stage} stdout artifact hash mismatch`);
    const outputRecord = JSON.parse(readFileSync(outputPath, 'utf8'));
    invariant(outputRecord.commandId === command.id && outputRecord.frozenCandidateSha256 === scenario.frozenCandidate.sha256
      && outputRecord.outputSha256 === sha256(Buffer.from(outputRecord.output, 'utf8')),
    `${scenario.kind} ${stage} stdout is not bound to the command and frozen candidate`);
    return { command, record, outputRecord };
  };

  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const provenScenarios = [];
    let totalProviderCalls = 0;
    for (const scenario of receipt.scenarios) {
      const evidence = scenario.runtimeEvidence;
      invariant(evidence && evidence.workspaceId === scenario.ids.projectId && evidence.collaborationTaskId === scenario.ids.taskId,
        `${scenario.kind} runtime identifiers are missing or inconsistent`);
      const task = db.prepare(`SELECT id,workspace_id,status,planner_agent_id,implementer_agent_id,reviewer_agent_id,
        current_candidate_id,canonical_run_id,canonical_task_id,base_commit,applied_at,acceptance_commands_json
        FROM collaboration_tasks WHERE id=? AND workspace_id=?`).get(evidence.collaborationTaskId, evidence.workspaceId);
      invariant(task && task.status === 'applied' && task.applied_at && task.current_candidate_id === scenario.ids.candidateId,
        `${scenario.kind} database does not record the reviewed candidate as applied`);
      invariant(task.planner_agent_id === scenario.roles.planner && task.implementer_agent_id === scenario.roles.implementer && task.reviewer_agent_id === scenario.roles.reviewer,
        `${scenario.kind} role identities differ from the persisted collaboration plan`);
      const acceptanceCommands = JSON.parse(task.acceptance_commands_json);
      invariant(JSON.stringify(acceptanceCommands) === JSON.stringify(scenario.acceptanceCommands),
        `${scenario.kind} acceptance commands differ from the persisted task plan`);
      invariant(Array.isArray(scenario.baselineCommands) && scenario.baselineCommands.length > 0
        && scenario.baselineReproduction?.commands?.length === scenario.baselineCommands.length
        && scenario.baselineReproduction.commands.every((command, index) => command.command === scenario.baselineCommands[index]),
      `${scenario.kind} baseline command artifacts differ from the declared frozen-baseline probes`);
      invariant(JSON.stringify(scenario.commands[0].argv) === JSON.stringify(acceptanceCommands),
        `${scenario.kind} retest artifact does not identify the exact acceptance command`);
      const workspace = db.prepare('SELECT root_path FROM workspaces WHERE id=?').get(task.workspace_id);
      invariant(workspace && resolve(workspace.root_path).toLowerCase() === resolve(scenario.commands[0].cwd).toLowerCase(),
        `${scenario.kind} command working directory differs from the persisted workspace`);

      const candidates = tableRows(db, `SELECT id,canonical_run_id,round,base_commit,head_commit,diff_hash,content_hash,diff_text,test_status,test_command,test_exit_code,test_output,status,review_conclusion,review_summary,created_at,manifest_json
        FROM collaboration_candidates WHERE collaboration_task_id=? AND workspace_id=? ORDER BY round ASC`, task.id, task.workspace_id);
      invariant(candidates.length === 2 && candidates[0].round === 0 && candidates[1].round === 1,
        `${scenario.kind} database must contain the initial and revised candidates`);
      invariant(candidates[1].id === scenario.ids.candidateId && candidates[1].id === task.current_candidate_id,
        `${scenario.kind} final candidate identity differs from the applied task`);
      invariant(sha256(Buffer.from(candidates[0].diff_text, 'utf8')) === candidates[0].diff_hash
        && sha256(Buffer.from(candidates[1].diff_text, 'utf8')) === candidates[1].diff_hash,
      `${scenario.kind} database candidate bytes do not match their persisted SHA-256`);
      invariant(candidates[0].diff_hash !== candidates[1].diff_hash, `${scenario.kind} review revision did not change candidate bytes`);
      invariant(candidates[1].test_status === 'passed' && candidates[1].test_exit_code === 0 && candidates[1].status === 'applied'
        && candidates[1].test_output && candidates[1].test_command === acceptanceCommands.join(' && '),
      `${scenario.kind} final candidate lacks persisted passing acceptance-command evidence`);
      invariant(task.base_commit === candidates[1].base_commit && task.base_commit === scenario.workspaceBaseCommit
        && scenario.workspaceBaseTreeSha === scenario.baselineReproduction.baseTreeSha,
      `${scenario.kind} candidate base does not match the frozen workspace base`);
      invariant(scenario.baselineReproduction.status === 'reproduced'
        && scenario.baselineReproduction.baseCommit === task.base_commit
        && scenario.baselineReproduction.sourceCommitSha === receipt.repository.commitSha
        && scenario.baselineReproduction.baseParentCommitSha === receipt.repository.commitSha,
      `${scenario.kind} baseline failure evidence is incomplete`);
      const baselineFailures = [];
      for (const baselineCommand of scenario.baselineReproduction.commands) {
        const commandPath = resolve(evidenceRoot, baselineCommand.artifact.artifactPath);
        invariant(hashFile(commandPath) === baselineCommand.artifact.sha256, `${scenario.kind} baseline command artifact hash mismatch`);
        const record = JSON.parse(readFileSync(commandPath, 'utf8'));
        const stdoutPath = resolve(evidenceRoot, record.stdout.artifactPath);
        const stderrPath = resolve(evidenceRoot, record.stderr.artifactPath);
        invariant(hashFile(stdoutPath) === record.stdout.sha256 && hashFile(stderrPath) === record.stderr.sha256,
          `${scenario.kind} baseline output artifact hash mismatch`);
        invariant(record.command === baselineCommand.command && record.cwd === workspace.root_path
          && record.expectedFailurePattern === scenario.baselineReproduction.expectedFailurePattern
          && record.workspaceBaseCommit === task.base_commit && record.workspaceBaseTreeSha === scenario.workspaceBaseTreeSha,
        `${scenario.kind} baseline command is not bound to its frozen workspace`);
        const combinedOutput = `${readFileSync(stdoutPath, 'utf8')}\n${readFileSync(stderrPath, 'utf8')}`;
        if (record.rawExitCode !== 0 && combinedOutput.includes(scenario.baselineReproduction.expectedFailurePattern)) baselineFailures.push(record);
      }
      invariant(baselineFailures.length > 0,
        `${scenario.kind} did not reproduce the declared baseline failure using its frozen-baseline probes`);

      const reviews = tableRows(db, `SELECT id,candidate_id,canonical_run_id,stage_id,stage_attempt,reviewer_agent_id,candidate_diff_hash,conclusion,summary,created_at
        FROM collaboration_reviews WHERE collaboration_task_id=? AND workspace_id=? ORDER BY created_at ASC,id ASC`, task.id, task.workspace_id);
      invariant(reviews.length === 2 && reviews[0].conclusion === 'changes_requested' && reviews[1].conclusion === 'approved',
        `${scenario.kind} persisted reviews do not contain the required change request and approval`);
      invariant(reviews[0].candidate_id === candidates[0].id && reviews[1].candidate_id === candidates[1].id
        && reviews.every(review => review.reviewer_agent_id === task.reviewer_agent_id)
        && reviews[0].candidate_diff_hash === candidates[0].diff_hash && reviews[1].candidate_diff_hash === candidates[1].diff_hash,
      `${scenario.kind} review rows do not independently bind the assigned reviewer and candidate hashes`);
      invariant(reviews[0].canonical_run_id === candidates[0].canonical_run_id && reviews[1].canonical_run_id === candidates[1].canonical_run_id
        && candidates[0].canonical_run_id !== candidates[1].canonical_run_id,
      `${scenario.kind} review rows are not tied to the initial and revision Runs`);
      const [requestEvent, revisionEvent, approvalEvent] = scenario.reviewHistory;
      invariant(requestEvent.id === reviews[0].id && requestEvent.candidateSha256 === candidates[0].diff_hash
        && requestEvent.actorId === reviews[0].reviewer_agent_id && requestEvent.requestedChanges.includes(safeText(reviews[0].summary)),
      `${scenario.kind} changes-requested receipt differs from the persisted independent review`);
      invariant(revisionEvent.fromCandidateSha256 === candidates[0].diff_hash && revisionEvent.toCandidateSha256 === candidates[1].diff_hash
        && revisionEvent.addressedReviewEventId === reviews[0].id && revisionEvent.actorId === task.implementer_agent_id,
      `${scenario.kind} revision receipt does not address the actual requested review`);
      const persistedChangedPaths = changedPathsFromPatch(candidates[1].diff_text);
      invariant(JSON.stringify(revisionEvent.changedPaths) === JSON.stringify(persistedChangedPaths),
        `${scenario.kind} revision changed paths do not match the persisted frozen candidate patch`);
      invariant(approvalEvent.id === reviews[1].id && approvalEvent.candidateSha256 === candidates[1].diff_hash
        && approvalEvent.actorId === reviews[1].reviewer_agent_id && approvalEvent.decision === reviews[1].conclusion,
      `${scenario.kind} approval receipt differs from the persisted independent review`);

      const runs = tableRows(db, `SELECT id,parent_run_id,reason,status,task_id FROM runs WHERE task_id=? AND workspace_id=? ORDER BY created_at ASC,id ASC`, task.canonical_task_id, task.workspace_id);
      invariant(runs.length === 2 && runs[0].reason === 'initial' && runs[1].reason === 'review-fix'
        && runs[1].parent_run_id === runs[0].id && runs.every(run => run.status === 'completed'),
      `${scenario.kind} canonical Run chain does not prove revision after requested changes`);
      requireSameSet(evidence.runIds, runs.map(run => run.id), `${scenario.kind} Run ids`);
      invariant(task.canonical_run_id === runs[1].id && candidates[1].canonical_run_id === runs[1].id,
        `${scenario.kind} applied candidate is not bound to the final review Run`);
      invariant(scenario.frozenCandidate.commitSha === receipt.repository.commitSha && scenario.frozenCandidate.treeSha === receipt.repository.treeSha,
        `${scenario.kind} candidate is not bound to the frozen source commit and tree`);

      const sessions = tableRows(db, `SELECT ps.id,ps.run_id,ps.stage_id,ps.stage_attempt,ps.agent_id,ps.provider_config_id,ps.provider_type,ps.adapter_id,ps.status,ps.completed_at,pc.model,pc.executable,rs.workflow_stage_key
        FROM provider_sessions ps JOIN provider_configurations pc ON pc.id=ps.provider_config_id AND pc.workspace_id=ps.workspace_id
        JOIN run_stages rs ON rs.id=ps.stage_id AND rs.run_id=ps.run_id AND rs.workspace_id=ps.workspace_id
        WHERE ps.workspace_id=? AND ps.run_id IN (?,?) ORDER BY ps.run_id,rs.sequence,ps.stage_attempt`, task.workspace_id, runs[0].id, runs[1].id);
      invariant(sessions.length === 6 && sessions.every(session => session.status === 'completed' && session.completed_at
        && session.provider_type === 'codex' && session.adapter_id === 'builtin.codex' && session.model === receipt.model.id),
      `${scenario.kind} native Provider session/model evidence is incomplete or does not match the receipt`);
      const stageAgents = new Map(sessions.map(session => [`${session.run_id}:${session.workflow_stage_key}`, session.agent_id]));
      for (const run of runs) {
        invariant(stageAgents.get(`${run.id}:plan`) === task.planner_agent_id
          && stageAgents.get(`${run.id}:implement`) === task.implementer_agent_id
          && stageAgents.get(`${run.id}:review`) === task.reviewer_agent_id,
        `${scenario.kind} Provider sessions do not prove all three assigned workflow roles for both Runs`);
      }
      const providerExecutable = receipt.providerEvidence?.executablePath;
      invariant(typeof providerExecutable === 'string' && sessions.every(session => session.provider_type === 'codex'
        && resolve(session.executable).toLowerCase() === resolve(providerExecutable).toLowerCase()),
      `${scenario.kind} configured Provider executable differs from the receipt`);
      const processRows = tableRows(db, `SELECT id,run_id,stage_id,stage_attempt,provider_session_id,process_type,status,executable_resolved,native_pid,native_started_at,native_birth_identity,exit_code,authority_role
        FROM runtime_processes WHERE workspace_id=? AND run_id IN (?,?) AND process_type='provider' ORDER BY run_id,stage_id,stage_attempt`, task.workspace_id, runs[0].id, runs[1].id);
      invariant(processRows.length === sessions.length && processRows.every(process => process.status === 'exited' && process.exit_code === 0
        && Number.isSafeInteger(process.native_pid) && process.native_pid > 0 && process.native_started_at
        && process.native_birth_identity && process.executable_resolved && resolve(process.executable_resolved).toLowerCase() === resolve(providerExecutable).toLowerCase()
        && process.authority_role === 'primary-provider'),
      `${scenario.kind} native Provider process rows are missing, nonzero, or lack birth-identity evidence`);
      invariant(new Set(processRows.map(process => `${process.native_pid}:${process.native_started_at}:${process.native_birth_identity}`)).size === processRows.length,
        `${scenario.kind} native Provider process birth identities are not unique`);
      const sessionIds = new Set(sessions.map(session => session.id));
      invariant(processRows.every(process => sessionIds.has(process.provider_session_id)), `${scenario.kind} process rows are not tied to persisted Provider sessions`);

      const eventRows = tableRows(db, `SELECT id,run_id,type,durability,sequence,timestamp FROM runtime_events WHERE workspace_id=? AND run_id IN (?,?) ORDER BY run_id,sequence`, task.workspace_id, runs[0].id, runs[1].id);
      invariant(eventRows.length > 0 && runs.every(run => eventRows.some(event => event.run_id === run.id && event.type === 'run.completed' && event.durability === 'durable')),
        `${scenario.kind} persisted runtime Events lack durable Run completion evidence`);
      const expectedSets = {
        runIds: runs.map(row => row.id), candidateIds: candidates.map(row => row.id), reviewIds: reviews.map(row => row.id),
        providerSessionIds: sessions.map(row => row.id), providerProcessIds: processRows.map(row => row.id), eventIds: eventRows.map(row => row.id),
      };
      for (const [field, actual] of Object.entries(expectedSets)) requireSameSet(evidence[field], actual, `${scenario.kind} ${field}`);
      const topScenario = receipt.runtimeEvidence.scenarios.find(item => item.id === scenario.id);
      invariant(topScenario && topScenario.workspaceId === task.workspace_id && topScenario.collaborationTaskId === task.id,
        `${scenario.kind} top-level runtime identity differs from the persisted task`);
      for (const [field, actual] of Object.entries(expectedSets)) requireSameSet(topScenario[field], actual, `${scenario.kind} top-level ${field}`);

      const priorPatch = readFileSync(resolve(evidenceRoot, scenario.priorCandidate.artifactPath));
      const finalPatch = readFileSync(resolve(evidenceRoot, scenario.frozenCandidate.artifactPath));
      invariant(priorPatch.toString('utf8') === candidates[0].diff_text && finalPatch.toString('utf8') === candidates[1].diff_text,
        `${scenario.kind} candidate evidence bytes do not match the runtime database`);
      const retest = readCommand(scenario, 'retest');
      invariant(retest.record.rawExitCode === candidates[1].test_exit_code && retest.record.stageResult.rawExitCode === candidates[1].test_exit_code
        && retest.record.stageResult.testRunId === candidates[1].id && retest.outputRecord.output === safeText(candidates[1].test_output),
      `${scenario.kind} retest artifact does not match the persisted acceptance command result`);
      const preview = readCommand(scenario, 'preview');
      const previewResponse = JSON.parse(preview.outputRecord.output);
      const previewIdentity = scenario.previewIdentity;
      invariant(previewIdentity?.candidateId === candidates[1].id && previewIdentity.baseCommit === task.base_commit
        && previewIdentity.contentHash === candidates[1].content_hash && previewIdentity.diffHash === candidates[1].diff_hash,
      `${scenario.kind} preview identity differs from the persisted candidate row`);
      invariant(previewResponse.workspaceId === task.workspace_id && previewResponse.collaborationTaskId === task.id
        && previewResponse.candidateId === candidates[1].id && previewResponse.baseCommit === task.base_commit
        && previewResponse.contentHash === candidates[1].content_hash && previewResponse.diffHash === candidates[1].diff_hash,
      `${scenario.kind} captured preview response does not match the persisted frozen candidate`);
      const previewUrl = new URL(preview.command.argv[1], 'http://agentos.local');
      invariant(preview.command.argv[0] === 'GET'
        && previewUrl.searchParams.get('candidateBaseCommit') === previewResponse.baseCommit
        && previewUrl.searchParams.get('candidateContentHash') === previewResponse.contentHash,
      `${scenario.kind} preview request did not address the exact frozen candidate hashes`);
      const apply = readCommand(scenario, 'apply');
      const applyResponse = JSON.parse(apply.outputRecord.output);
      invariant(apply.record.requestBody?.candidateId === previewResponse.candidateId
        && apply.record.requestBody?.candidateBaseCommit === previewResponse.baseCommit
        && apply.record.requestBody?.candidateContentHash === previewResponse.contentHash,
      `${scenario.kind} apply request is not bound to the exact displayed candidate preview`);
      invariant(applyResponse.task?.status === 'applied' && applyResponse.task?.currentCandidateId === candidates[1].id,
        `${scenario.kind} captured apply response does not identify the applied candidate`);
      totalProviderCalls += sessions.length;
      provenScenarios.push({ kind: scenario.kind, runCount: runs.length, providerCalls: sessions.length, nativeProcessCount: processRows.length, durableEventCount: eventRows.length });
    }
    invariant(receipt.providerEvidence?.invocationCount === totalProviderCalls, 'Provider invocation count differs from persisted native sessions');
    if (receipt.mode === 'simulated-provider') {
      invariant(receipt.providerEvidence.kind === 'deterministic-fixture-cli' && receipt.model.id === 'agentos-p4-deterministic-fixture-v1',
        'simulated receipt must identify the deterministic fixture and model');
    } else {
      const providerExecutable = receipt.providerEvidence.executablePath;
      invariant(process.platform === 'win32' && basename(providerExecutable).toLowerCase().startsWith('codex'),
        'real receipt must prove the configured native Windows Codex executable');
      invariant(receipt.providerEvidence.executableSha256 === hashFile(providerExecutable), 'configured Codex executable bytes changed after capture');
    }
    return { status: receipt.mode === 'simulated-provider' ? 'simulated-runtime-verified' : 'runtime-verified', provenScenarios };
  } finally {
    db.close();
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const sourceRoot = realpathSync(options.repositoryRoot);
  if (options.receiptPath) {
    const receipt = JSON.parse(readFileSync(options.receiptPath, 'utf8'));
    const structure = validateReceipt(manifest, receipt, {
      expectedSha: options.expectedSha, repositoryRoot: sourceRoot, evidenceRoot: options.evidenceDir,
    });
    const runtime = verifyRuntimeDatabaseEvidence(options.evidenceDir, receipt);
    const report = { ...structure, acceptanceStatus: runtime.status, runtimeEvidenceStatus: 'verified', providerCalls: receipt.providerEvidence.invocationCount, receiptPath: options.receiptPath };
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const sourceSnapshot = gitSnapshot(sourceRoot, options.expectedSha);
  const plans = options.mode === 'simulated-provider'
    ? ['defect', 'feature'].map(simulationPlan)
    : validatePlan(JSON.parse(readFileSync(options.planPath, 'utf8')));
  if (options.mode === 'real-windows-acceptance') validateRealPlanPaths(plans, sourceRoot);
  const runId = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`;
  const evidenceRoot = options.evidenceDir ?? (options.mode === 'real-windows-acceptance'
    ? join(homedir(), 'Documents', 'AgentOS', 'existing-project-acceptance', runId)
    : join(tmpdir(), 'agentos-existing-project-acceptance', runId));
  mkdirSync(evidenceRoot, { recursive: true });
  const runRoot = mkdtempSync(join(tmpdir(), 'agentos-existing-project-run-'));
  const statePath = join(runRoot, 'simulator-state.json');
  writeFileSync(statePath, JSON.stringify({ defect: { implementations: 0, reviews: 0 }, feature: { implementations: 0, reviews: 0 } }));
  let server;
  let serverProjectRoot;
  let workspaceRoots = [];
  let scenarioResults = [];
  let runFailure;
  let completed = false;
  try {
    runBuild(scriptRoot);
    serverProjectRoot = createServerRoot(runRoot);
    server = await startServer(runRoot, serverProjectRoot, {
      requireP2Ready: options.mode === 'real-windows-acceptance',
      worktreeRoot: join(runRoot, 'runtime-worktrees'),
    });
    const collaborationRoutesSource = readFileSync(join(scriptRoot, 'apps/server/src/routes/collaborations.ts'), 'utf8');
    invariant(/router\.get\(['"`]\/collaboration\/tasks\/:collaborationId\/candidates\/:candidateId\/preview['"`]/u.test(collaborationRoutesSource),
      'P2 frozen candidate preview route is not integrated; no acceptance task was started');
    if (options.mode === 'real-windows-acceptance') {
      invariant(server.readinessPath !== '/api/health (legacy liveness fallback; simulated mode only)', 'P2 readiness is required before real acceptance');
    }
    const model = options.mode === 'simulated-provider' ? 'agentos-p4-deterministic-fixture-v1' : (options.model || process.env.AGENTOS_CODEX_MODEL);
    let executable;
    if (options.mode === 'simulated-provider') {
      executable = createSimulationExecutable(runRoot, statePath);
      const version = spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 10_000 });
      const help = spawnSync(executable, ['exec', '--help'], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 10_000 });
      invariant(version.status === 0 && /codex\s+\d+\.\d+\.\d+/iu.test(version.stdout)
        && help.status === 0 && /exec.*--json/isu.test(help.stdout), 'local Codex fixture does not satisfy adapter version/structured-output probes');
    }
    else {
      executable = resolveExecutablePath(process.env.AGENTOS_CODEX_CLI || 'codex');
      const version = spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 15_000 });
      invariant(version.status === 0 && !version.error, `configured Codex CLI is not executable: ${version.error?.message || safeText(version.stderr)}`);
      const help = spawnSync(executable, ['exec', '--help'], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 15_000 });
      invariant(help.status === 0 && /--json/u.test(`${help.stdout}${help.stderr}`), 'configured Codex CLI does not advertise structured --json output');
    }
    const workspaces = [];
    const baselineResults = [];
    for (const plan of plans) {
      const workspace = setupWorkspaceClone(sourceRoot, runRoot, plan.kind, sourceSnapshot.commitSha, options.mode, statePath);
      workspaceRoots.push(workspace.root);
      workspaces.push(workspace);
      baselineResults.push(captureBaselineReproduction(evidenceRoot, plan, workspace));
    }
    server.sourceSnapshot = sourceSnapshot;
    for (let index = 0; index < plans.length; index += 1) {
      const result = await createAndRunScenario(server, plans[index], workspaces[index], baselineResults[index], options.mode, model, executable, evidenceRoot);
      scenarioResults.push(result);
    }
    const serverIdentity = { pid: server.child.pid, port: server.port, readinessPath: server.readinessPath };
    await stopServer(server);
    serverIdentity.exitCode = server.child.exitCode;
    serverIdentity.signalCode = server.child.signalCode;
    console.error(`P4_ACCEPTANCE_PROGRESS=server: owned server stopped pid=${serverIdentity.pid} exit=${serverIdentity.exitCode ?? 'signal'} signal=${serverIdentity.signalCode ?? 'none'}`);
    server = undefined;
    const databaseSource = join(serverProjectRoot, '.agentos', 'agentos.sqlite');
    invariant(existsSync(databaseSource), 'isolated AgentOS runtime database was not created');
    const runtimeDir = join(evidenceRoot, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    const databaseDestination = join(runtimeDir, 'agentos.sqlite');
    copyFileSync(databaseSource, databaseDestination);
    const databaseArtifact = { artifactPath: 'runtime/agentos.sqlite', sha256: hashFile(databaseDestination) };
    const providerExecutable = realpathSync(executable);
    const providerEvidence = {
      kind: options.mode === 'simulated-provider' ? 'deterministic-fixture-cli' : 'configured-codex-cli',
      providerType: 'codex', adapterId: 'builtin.codex', executablePath: providerExecutable,
      executableSha256: hashFile(providerExecutable),
      invocationCount: 0,
      credentialEnvironmentVariableNames: Object.keys(process.env).filter(key => secretKeyPattern.test(key)).sort(),
    };
    const runtimeScenarios = [];
    const db = new DatabaseSync(databaseDestination, { readOnly: true });
    try {
      for (const result of scenarioResults) {
        const { scenario } = result;
        const sessions = tableRows(db, `SELECT id FROM provider_sessions WHERE workspace_id=? AND run_id IN (?,?) ORDER BY run_id,created_at,id`, scenario.ids.projectId, ...result.runIds);
        const processRows = tableRows(db, `SELECT id FROM runtime_processes WHERE workspace_id=? AND run_id IN (?,?) AND process_type='provider' ORDER BY run_id,stage_id,stage_attempt`, scenario.ids.projectId, ...result.runIds);
        const events = tableRows(db, `SELECT id FROM runtime_events WHERE workspace_id=? AND run_id IN (?,?) ORDER BY run_id,sequence`, scenario.ids.projectId, ...result.runIds);
        const scenarioEvidence = scenario.runtimeEvidence;
        scenarioEvidence.providerSessionIds = sessions.map(row => row.id);
        scenarioEvidence.providerProcessIds = processRows.map(row => row.id);
        scenarioEvidence.eventIds = events.map(row => row.id);
        runtimeScenarios.push({ id: scenario.id, ...scenarioEvidence });
      }
    } finally { db.close(); }
    providerEvidence.invocationCount = runtimeScenarios.reduce((sum, item) => sum + item.providerSessionIds.length, 0);
    const receipt = {
      schemaVersion: 2, manifestId: manifest.manifestId, mode: options.mode,
      platform: process.platform, providerExecution: options.mode === 'simulated-provider' ? 'simulated' : 'real',
      credentialBoundary: options.mode === 'simulated-provider' ? 'none' : 'operator-managed-outside-ci',
      repository: {
        commitSha: sourceSnapshot.commitSha, treeSha: sourceSnapshot.treeSha,
        commitShaAtStart: sourceSnapshot.commitSha, commitShaAtEnd: git(sourceRoot, ['rev-parse', 'HEAD']),
        treeShaAtStart: sourceSnapshot.treeSha, treeShaAtEnd: git(sourceRoot, ['rev-parse', 'HEAD^{tree}']),
      },
      model: { provider: options.mode === 'simulated-provider' ? 'fixture-provider' : 'codex', id: model },
      providerEvidence,
      runtimeEvidence: {
        database: databaseArtifact, serverPid: serverIdentity.pid, port: serverIdentity.port,
        readinessPath: serverIdentity.readinessPath,
        serverProcess: {
          pid: serverIdentity.pid, exitCode: serverIdentity.exitCode,
          signalCode: serverIdentity.signalCode, stopped: true,
        },
        scenarios: runtimeScenarios,
      },
      processExitCode: 0, acceptanceExitCode: 0,
      scenarios: scenarioResults.map(item => item.scenario),
    };
    const structure = validateReceipt(manifest, receipt, {
      expectedSha: options.expectedSha, repositoryRoot: sourceRoot, evidenceRoot,
    });
    const runtime = verifyRuntimeDatabaseEvidence(evidenceRoot, receipt);
    const report = { ...structure, acceptanceStatus: runtime.status, runtimeEvidenceStatus: 'verified', providerCalls: providerEvidence.invocationCount, receiptPath: join(evidenceRoot, 'receipt.json') };
    writeJsonArtifact(evidenceRoot, 'receipt.json', receipt);
    writeJsonArtifact(evidenceRoot, 'verification.json', report);
    completed = true;
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    runFailure = error;
    throw error;
  } finally {
    if (server) await stopServer(server).catch(() => undefined);
    if (runFailure && serverProjectRoot) {
      try {
        const diagnostics = join(evidenceRoot, 'diagnostics');
        mkdirSync(diagnostics, { recursive: true });
        const databaseSource = join(serverProjectRoot, '.agentos', 'agentos.sqlite');
        if (existsSync(databaseSource)) {
          const databaseDestination = join(diagnostics, 'failed-runtime.sqlite');
          copyFileSync(databaseSource, databaseDestination);
          for (const suffix of ['-wal', '-shm']) {
            if (existsSync(`${databaseSource}${suffix}`)) copyFileSync(`${databaseSource}${suffix}`, `${databaseDestination}${suffix}`);
          }
        }
        writeJsonArtifact(evidenceRoot, 'diagnostics/failure.json', {
          schemaVersion: 1, error: safeText(runFailure instanceof Error ? runFailure.message : String(runFailure)),
          serverPid: server?.child.pid, port: server?.port, readinessPath: server?.readinessPath,
          temporaryRunRoot: runRoot,
          serverOutput: options.mode === 'simulated-provider' ? server?.output.text : '[omitted for real-provider privacy]',
        });
      } catch { /* keep the original runner failure as the user-facing result */ }
    }
    if (completed) {
      const runtimeWorktrees = resolve(evidenceRoot, 'runtime-worktrees');
      const relativeRuntimePath = relative(resolve(evidenceRoot), runtimeWorktrees);
      if (relativeRuntimePath === 'runtime-worktrees') {
        try { rmSync(runtimeWorktrees, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* retain only externally scoped recovery evidence */ }
      }
    }
    if (completed) {
      for (const workspaceRoot of workspaceRoots.reverse()) {
        const safeRunRoot = resolve(runRoot);
        const absolute = resolve(workspaceRoot);
        const rel = relative(safeRunRoot, absolute);
        if (rel === '..' || rel.startsWith(`..${sep}`) || !absolute.startsWith(`${safeRunRoot}${sep}`)) continue;
        try { rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* evidence database remains authoritative */ }
      }
      try { rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* keep successful evidence independent from cleanup */ }
    }
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  main().catch(error => {
    console.error(`EXISTING_PROJECT_ACCEPTANCE_FAILED=${safeText(error instanceof Error ? error.message : String(error))}`);
    process.exitCode = 1;
  });
}

export {
  verifyRuntimeDatabaseEvidence, validatePlan, validateRealPlanPaths, simulationPlan,
  createSimulationExecutable,
};
