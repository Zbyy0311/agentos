import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const finalMain = '90e2e5a13c23e541f25a75f3ffdeeb19353c35da';
const runId = '35059036634';
const tag = '90e2e5a1';
const tempRoot = 'C:/Users/Administrator/AppData/Local/Temp/agentos-ci-35059036634-6371ddd37e7c426588789ebbca940329';
const sourceDir = resolve(tempRoot, `raw-verification-${finalMain}`, finalMain, 'lite-regressions-2026-09-16T06-04-54-198Z');
const closeout = resolve(root, 'docs/implementation/lite-closeout');
const evidencePath = resolve(closeout, 'evidence.json');
const targetDir = resolve(closeout, 'evidence', `final-main-ci-${runId}`);
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const normalize = path => relative(root, path).replaceAll('\\', '/');

const source = readJson(resolve(sourceDir, 'receipt.json'));
if (source.baseline !== finalMain || source.rawExitCode !== 0 || source.signal !== null || source.error !== null
  || source.counts.passed !== 38 || source.counts.failed !== 0 || source.counts.skipped !== 0) {
  throw new Error('final main lite-regressions receipt is not a clean 38/0/0 exit-zero receipt');
}
mkdirSync(targetDir, { recursive: true });
const stdoutPath = resolve(targetDir, 'stdout.txt');
const stderrPath = resolve(targetDir, 'stderr.txt');
copyFileSync(resolve(sourceDir, 'stdout.log'), stdoutPath);
copyFileSync(resolve(sourceDir, 'stderr.log'), stderrPath);
const evidenceId = `S9-FINAL-MAIN-CI-${runId}`;
const raw = {
  ...source,
  cwd: '.',
  counts: {
    passed: source.counts.passed,
    failed: source.counts.failed,
    skipped: source.counts.skipped,
    total: source.counts.passed + source.counts.failed + source.counts.skipped,
  },
  logs: [stdoutPath, stderrPath].map(path => ({ path: normalize(path), sha256: sha256(path) })),
  assertionCoverage: [{
    id: `${evidenceId}-A1`,
    requirementId: 'LITE-FINAL-CLOSEOUT',
    file: 'scripts/verify-lite-scope.test.mjs',
    name: 'scope accepts the frozen matrix with individually authorized PASS rows',
    line: 127,
    expression: 'assert.equal(result.PASS, 230);',
    clause: 'The final main Lite scope contains the individually authorized PASS rows and no open GAP/RUNTIME-VERIFY rows.',
    outcome: 'passed',
  }],
  limitation: `GitHub Actions run ${runId} at exact final main ${finalMain}; the preserved lite-regressions raw receipt directly proves the named scope assertion and 38/0/0 regression-gate execution. The complete workflow conclusion also covers Server tests, shared harnesses, Workspace build, and raw-receipt preservation; this receipt does not mechanically prove every PASS row.`,
};
const rawPath = resolve(targetDir, 'receipt.json');
writeJson(rawPath, raw);
const evidence = readJson(evidencePath);
if (evidence.some(item => item.id === evidenceId)) throw new Error(`evidence already exists: ${evidenceId}`);
evidence.push({
  id: evidenceId,
  baseline: finalMain,
  kind: 'github-actions',
  command: [source.command.executable, ...source.command.args].join(' '),
  cwd: '.',
  rawReceipt: normalize(rawPath),
  result: { passed: 38, failed: 0, skipped: 0, exitCode: 0, conclusion: 'success' },
  url: `https://github.com/Zbyy0311/agentos/actions/runs/${runId}`,
  environment: `GitHub Actions; exact final main ${finalMain}; workflow run ${runId}`,
  requirementIds: [],
  limitation: raw.limitation,
});
writeJson(evidencePath, evidence);
console.log(JSON.stringify({ evidenceId, baseline: finalMain, rawReceipt: normalize(rawPath), counts: raw.counts }));
