import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const auditRoot = resolve(root, 'docs/implementation/lite-closeout');
const evidenceRoot = resolve(auditRoot, 'evidence');
const baseline = '33d12571b4a19fbbb17060a7d1a60f6fea756f09';
const baselineTag = baseline.slice(0, 8);
const auditRootRelative = 'docs/implementation/lite-closeout/';
const matrixPath = resolve(auditRoot, 'matrix.json');
const evidencePath = resolve(auditRoot, 'evidence.json');
const promotionsPath = resolve(auditRoot, 'pass-promotions.json');
const classificationPath = resolve(evidenceRoot, `runtime-verify-classification-${baselineTag}.json`);
const directReceiptRoot = resolve(evidenceRoot, `final-${baselineTag}-receipts`);
const directRunRoot = resolve(evidenceRoot, `final-${baselineTag}-runs`);

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const unique = values => [...new Set(values)];
const sortedUnique = values => unique(values).sort();
const commandText = command => [command.executable, ...command.args].join(' ');
const receiptFiles = readdirSync(directReceiptRoot).filter(name => name.endsWith('.json')).sort();
const assertSourceMapping = assertion => {
  const sourcePath = resolve(root, assertion.file);
  if (!existsSync(sourcePath)) throw new Error(`missing assertion source: ${assertion.file}`);
  const source = readFileSync(sourcePath, 'utf8').split(/\r?\n/);
  if (!source[assertion.line - 1]?.includes(assertion.expression)) {
    throw new Error(`assertion expression is not at source line: ${assertion.id}`);
  }
  if (!source.join('\n').includes(assertion.name)) throw new Error(`assertion test name is absent: ${assertion.id}`);
};

const matrix = readJson(matrixPath);
const evidence = readJson(evidencePath);
const ledger = readJson(promotionsPath);
const classification = readJson(classificationPath);
if (matrix.status !== 'frozen') throw new Error('matrix must remain frozen');
if (classification.classificationCounts.PASS_CANDIDATE !== 179
  || classification.classificationCounts.ASSERTION_GAP !== 0
  || classification.classificationCounts.IMPLEMENTATION_GAP !== 0
  || classification.classificationCounts.UNRESOLVED !== 0) {
  throw new Error(`classification is not the closed candidate set: ${JSON.stringify(classification.classificationCounts)}`);
}
if (ledger.baselineSha !== 'ad11319870c921e77e826c71787bd63f61a830aa') {
  throw new Error(`unexpected prior promotion baseline: ${ledger.baselineSha}`);
}

const rowsById = new Map(matrix.requirements.map(row => [row.id, row]));
const candidateRows = classification.candidateRows;
const candidateIds = new Set(candidateRows.map(row => row.id));
if (candidateRows.length !== 179 || candidateIds.size !== 179) throw new Error('candidate row set is not exactly 179 rows');
for (const row of candidateRows) {
  const current = rowsById.get(row.id);
  if (!current || current.state !== 'RUNTIME-VERIFY') throw new Error(`candidate is not an open runtime row: ${row.id}`);
  if (!Array.isArray(row.assertionBundles) || row.assertionBundles.length === 0) throw new Error(`candidate has no semantic bundle: ${row.id}`);
}

const directReceipts = receiptFiles.map(file => ({ file, raw: readJson(resolve(directReceiptRoot, file)) }));
for (const { file, raw } of directReceipts) {
  if (raw.baseline !== baseline || raw.rawExitCode !== 0 || raw.counts.failed !== 0 || raw.counts.skipped !== 0) {
    throw new Error(`direct receipt is not clean/current: ${file}`);
  }
  if (!Array.isArray(raw.assertionCoverage) || raw.assertionCoverage.length === 0) throw new Error(`direct receipt has no assertions: ${file}`);
  for (const assertion of raw.assertionCoverage) assertSourceMapping(assertion);
}

const directProofs = directReceipts.map(({ file, raw }, index) => {
  const id = `S9-ACCEL-33D-DIRECT-${String(index + 1).padStart(3, '0')}`;
  const requirementIds = sortedUnique(raw.assertionCoverage.map(assertion => assertion.requirementId));
  return {
    id,
    baseline,
    kind: raw.format === 'vitest' ? 'vitest' : 'local-tests',
    command: commandText(raw.command),
    cwd: String(raw.cwd).replaceAll('\\', '/'),
    rawReceipt: `docs/implementation/lite-closeout/evidence/final-${baselineTag}-receipts/${file}`,
    result: { passed: raw.counts.passed, failed: raw.counts.failed, skipped: raw.counts.skipped, exitCode: raw.rawExitCode },
    requirementIds,
    environment: `Windows; ${raw.format === 'vitest' ? 'Vitest' : 'node:test'}; final implementation baseline ${baseline}; literal named-test invocation`,
    limitation: 'This proof maps every declared requirement to concrete assert/expect calls in the named test bodies and preserves the original raw receipt. It is not a real Provider or browser invocation unless separately identified below.',
  };
});
const directProofByRequirement = new Map();
for (const proof of directProofs) {
  for (const requirementId of proof.requirementIds) {
    if (!directProofByRequirement.has(requirementId)) directProofByRequirement.set(requirementId, []);
    directProofByRequirement.get(requirementId).push(proof);
  }
}

const affectedSpecs = [
  ['artifact', 'artifact.json', ['LITE-07-104']],
  ['browser-13-101', 'browser-13-101-current/browser-13-101.json', ['LITE-13-101']],
  ['compaction-repository', 'compaction-repository.json', ['LITE-09-107']],
  ['compaction-service', 'compaction-service.json', ['LITE-09-107']],
  ['compaction-trigger', 'compaction-trigger.json', ['LITE-09-107']],
  ['controlled-07003', 'controlled-07003.json', ['LITE-07-003']],
  ['controlled-07013', 'controlled-07013.json', ['LITE-07-013']],
  ['controlled-s1-budget', 'controlled-s1-budget.json', ['LITE-07-007', 'LITE-07-109']],
  ['controlled-s7', 'controlled-s7.json', ['LITE-07-106', 'LITE-07-107', 'LITE-07-108']],
  ['memory-candidate', 'memory-candidate.json', ['LITE-07-002', 'LITE-07-004', 'LITE-07-011']],
  ['memory-context', 'memory-context.json', ['LITE-07-008']],
  ['memory-retrieval', 'memory-retrieval.json', ['LITE-07-001']],
  ['memory-runtime', 'memory-runtime.json', ['LITE-07-001', 'LITE-07-009', 'LITE-07-101']],
  ['recovery', 'recovery.json', ['LITE-13-008']],
  ['runtime-inspector', 'runtime-inspector.json', ['LITE-13-002', 'LITE-13-003', 'LITE-13-015']],
];
const affectedRows = new Set(affectedSpecs.flatMap(([, , ids]) => ids));
const affectedProofs = affectedSpecs.map(([label, file, requirementIds]) => {
  const raw = readJson(resolve(evidenceRoot, 'final-f466-affected-pass', file));
  if (raw.baseline !== baseline || raw.rawExitCode !== 0 || raw.counts.failed !== 0 || raw.counts.skipped !== 0) {
    throw new Error(`affected receipt is not clean/current: ${file}`);
  }
  for (const assertion of raw.assertionCoverage) assertSourceMapping(assertion);
  const mappedIds = sortedUnique(raw.assertionCoverage.map(assertion => assertion.requirementId));
  const missing = requirementIds.filter(id => !mappedIds.includes(id));
  if (missing.length) throw new Error(`affected receipt ${file} misses ${missing.join(', ')}`);
  const id = `S9-ACCEL-33D-AFFECTED-${label.toUpperCase().replaceAll(/[^A-Z0-9]+/g, '-')}`;
  return {
    id,
    baseline,
    kind: raw.format === 'controlled-harness' ? 'controlled-harness' : 'local-tests',
    command: commandText(raw.command),
    cwd: String(raw.cwd).replaceAll('\\', '/'),
    rawReceipt: `docs/implementation/lite-closeout/evidence/final-f466-affected-pass/${file}`,
    result: { passed: raw.counts.passed, failed: raw.counts.failed, skipped: raw.counts.skipped, exitCode: raw.rawExitCode },
    requirementIds: sortedUnique(requirementIds),
    environment: `Windows; final implementation baseline ${baseline}; affected old-PASS receipt recaptured on the current code`,
    limitation: 'This receipt is used only to re-anchor an old PASS whose implementation path was changed or whose current clean evidence is being made explicit. It preserves the exact raw execution and does not broaden the requirement.',
  };
});
const affectedProofByRequirement = new Map();
for (const proof of affectedProofs) {
  for (const requirementId of proof.requirementIds) {
    if (!affectedProofByRequirement.has(requirementId)) affectedProofByRequirement.set(requirementId, []);
    affectedProofByRequirement.get(requirementId).push(proof);
  }
}
for (const requirementId of affectedRows) {
  if (!rowsById.has(requirementId) || rowsById.get(requirementId).state !== 'PASS') throw new Error(`affected row is not an old PASS: ${requirementId}`);
  if (!affectedProofByRequirement.has(requirementId)) throw new Error(`affected row has no current receipt: ${requirementId}`);
}

const capturePrefix = (prefix) => {
  const passAuditRoot = resolve(root, 'logs/pass-audit', baseline);
  const dirs = readdirSync(passAuditRoot).filter(name => name.startsWith(prefix)).sort();
  if (!dirs.length) throw new Error(`missing Provider capture: ${prefix}`);
  return resolve(passAuditRoot, dirs.at(-1));
};
const providerDefinitions = [
  {
    provider: 'codex', prefix: 'final-provider-codex-node-', model: 'gpt-5.6-luna',
    sourcePath: 'apps/server/src/services/run-engine/RunEngineProviderDispatcher.test.ts',
    name: 'LITE-04-101: current-machine Codex gate drives the canonical chain to completion (env-gated)',
    assertions: [
      ['A1', 1073, 'assert.equal(result.outcome, \'claimed-and-progressed\');', 'the canonical dispatcher claims and progresses the real Codex Run'],
      ['A2', 1079, 'assert.equal(run.status, \'completed\');', 'the real Codex Run reaches the completed terminal state'],
      ['A3', 1080, 'assert.ok(fx.runStageRepo.listByRun(WS, RUN).every(stage => stage.status === \'completed\'));', 'every canonical stage completes'],
      ['A4', 1083, 'assert.equal(outboxCount, eventCount);', 'durable Outbox count equals the Runtime Event count'],
      ['A5', 1084, 'assert.ok(eventCount > 0);', 'the completed real Run produced canonical Runtime Events'],
    ],
  },
  {
    provider: 'kimi', prefix: 'final-provider-kimi-luna-serial-', model: 'opencodex/gpt-5.6-luna',
    sourcePath: 'apps/server/src/services/run-engine/RunEngineProviderDispatcher.test.ts',
    name: 'LITE-04-101: current-machine Kimi gate with an explicit routed model (env-gated)',
    assertions: [
      ['A1', 1094, 'assert.equal(result.outcome, \'claimed-and-progressed\');', 'the canonical dispatcher claims and progresses the real Kimi-routed Run'],
      ['A2', 1100, 'assert.equal(run.status, \'completed\');', 'the real Kimi-routed Run reaches the completed terminal state'],
      ['A3', 1103, 'assert.equal(outboxCount, eventCount);', 'durable Outbox count equals the Runtime Event count'],
      ['A4', 1104, 'assert.ok(eventCount > 0);', 'the completed real Run produced canonical Runtime Events'],
    ],
  },
  {
    provider: 'opencode', prefix: 'final-provider-opencode-free-serial-', model: 'opencode/big-pickle',
    sourcePath: 'apps/server/src/services/run-engine/RunEngineProviderDispatcher.test.ts',
    name: 'LITE-04-101: real OpenCode completes the canonical production chain (env-gated)',
    assertions: [
      ['A1', 1121, 'assert.equal(result.outcome, \'claimed-and-progressed\');', 'the canonical dispatcher claims and progresses the real OpenCode Run'],
      ['A2', 1123, 'assert.equal(run.status, \'completed\', `OpenCode failed: ${run.failureCode}`);', 'the real OpenCode Run reaches the completed terminal state'],
      ['A3', 1124, 'assert.ok(fx.runStageRepo.listByRun(WS, RUN).every(stage => stage.status === \'completed\'));', 'every canonical stage completes'],
      ['A4', 1126, 'assert.equal(processes.length, STAGE_KEYS.length);', 'the canonical process records cover every stage'],
      ['A5', 1130, 'assert.equal(outboxCount, eventCount);', 'durable Outbox count equals the Runtime Event count'],
      ['A6', 1134, 'assert.ok(', 'the real OpenCode assistant text reaches the durable output sink'],
    ],
  },
];
const providerProofs = providerDefinitions.map(definition => {
  const captureRoot = capturePrefix(definition.prefix);
  const capture = readJson(resolve(captureRoot, 'receipt.json'));
  if (capture.baseline !== baseline || capture.rawExitCode !== 0 || capture.counts.passed !== 1 || capture.counts.failed !== 0 || capture.counts.skipped !== 0) {
    throw new Error(`Provider capture is not clean/current: ${definition.provider}`);
  }
  const destination = resolve(evidenceRoot, `final-${baselineTag}-provider`, definition.provider);
  mkdirSync(destination, { recursive: true });
  const stdoutPath = resolve(destination, 'stdout.txt');
  const stderrPath = resolve(destination, 'stderr.txt');
  copyFileSync(resolve(captureRoot, 'stdout.log'), stdoutPath);
  copyFileSync(resolve(captureRoot, 'stderr.log'), stderrPath);
  const relativeLog = path => relative(root, path).replaceAll('\\', '/');
  const assertions = definition.assertions.map(([suffix, line, expression, clause]) => {
    const assertion = {
      id: `S9-ACCEL-33D-PROVIDER-${definition.provider.toUpperCase()}-${suffix}`,
      requirementId: 'LITE-04-101',
      provider: definition.provider,
      file: definition.sourcePath,
      name: definition.name,
      line,
      expression,
      clause,
      whyDirect: `The named real ${definition.provider} gate executes the canonical AgentOS Adapter/Registry/Process Runtime/Run Engine path and observes this concrete terminal or durability assertion; it is not a file-level or keyword-level claim.`,
      outcome: 'passed',
    };
    assertSourceMapping(assertion);
    return assertion;
  });
  const raw = {
    schemaVersion: 1,
    baseline,
    provider: definition.provider,
    model: definition.model,
    command: capture.command,
    cwd: String(capture.cwd).replaceAll('\\', '/'),
    environment: capture.environment,
    trackedCheckoutUnchanged: capture.trackedCheckoutUnchanged,
    rawExitCode: capture.rawExitCode,
    signal: capture.signal ?? null,
    error: capture.error ?? null,
    logs: [stdoutPath, stderrPath].map(path => ({ path: relativeLog(path), sha256: digest(path) })),
    counts: { passed: capture.counts.passed, failed: capture.counts.failed, skipped: capture.counts.skipped, total: capture.counts.passed + capture.counts.failed + capture.counts.skipped },
    assertionCoverage: assertions,
  };
  const rawPath = resolve(destination, 'receipt.json');
  writeJson(rawPath, raw);
  return {
    id: `S9-ACCEL-33D-PROVIDER-${definition.provider.toUpperCase()}`,
    baseline,
    kind: 'runtime-verification',
    provider: definition.provider,
    command: commandText(capture.command),
    cwd: String(capture.cwd).replaceAll('\\', '/'),
    rawReceipt: relative(root, rawPath).replaceAll('\\', '/'),
    result: { passed: raw.counts.passed, failed: raw.counts.failed, skipped: raw.counts.skipped, exitCode: raw.rawExitCode },
    requirementIds: ['LITE-04-101'],
    environment: `Windows; real ${definition.provider} CLI; explicit model ${definition.model}; final implementation baseline ${baseline}`,
    limitation: definition.provider === 'opencode'
      ? 'This is a local real-completion receipt using opencode/big-pickle because deepseek/deepseek-v4-flash returned 402 Insufficient Balance. It does not prove hosted-CI reproducibility, OpenCode cancellation, or change the separately authorized LITE-04-101 DEFERRED state.'
      : `This is a local real-completion receipt using explicit model ${definition.model}. It does not prove hosted-CI reproducibility and does not change the separately authorized LITE-04-101 DEFERRED state.`,
  };
});

const unchangedAudit = [];
const priorPromotionsById = new Map(ledger.promotions.map(promotion => [promotion.requirementId, promotion]));
const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim();
const sourceRootRelative = relative(gitRoot, root).replaceAll('\\', '/');
for (const promotion of ledger.promotions) {
  const row = rowsById.get(promotion.requirementId);
  const paths = row.implementation.map(file => `${sourceRootRelative}/${file}`);
  let changedFiles = [];
  try {
    changedFiles = execFileSync('git', ['diff', '--name-only', `${promotion.baselineSha}..${baseline}`, '--', ...paths], { cwd: gitRoot, encoding: 'utf8' })
      .split(/\r?\n/).map(file => file.trim()).filter(Boolean)
      .map(file => file.startsWith(`${sourceRootRelative}/`) ? file.slice(sourceRootRelative.length + 1) : file);
  } catch (error) {
    throw new Error(`cannot audit implementation path for ${promotion.requirementId}: ${error.message}`);
  }
  const recaptured = affectedRows.has(promotion.requirementId);
  if (changedFiles.length > 0 && !recaptured) {
    throw new Error(`unclassified implementation diff for old PASS ${promotion.requirementId}: ${changedFiles.join(', ')}`);
  }
  unchangedAudit.push({
    requirementId: promotion.requirementId,
    priorPromotionBaseline: promotion.baselineSha,
    currentBaseline: baseline,
    implementation: row.implementation,
    changedImplementationFiles: changedFiles,
    decision: recaptured ? 'recaptured-current-baseline' : 'reused-historical-evidence',
    reason: recaptured
      ? 'The implementation path changed or this row was deliberately re-captured; the current clean receipt replaces the old proof.'
      : 'The production implementation paths have an empty diff from the prior promotion baseline to the frozen current baseline; the historical raw receipt remains valid and is reused explicitly.',
  });
}

const asPromotionAssertion = (row, assertion) => ({
  id: assertion.id,
  clause: assertion.clause || row.requirement,
  expression: assertion.expression,
  file: assertion.file,
  name: assertion.name,
  line: assertion.line,
  outcome: 'passed',
  whyDirect: assertion.whyDirect || 'The exact source assertion is preserved in the raw receipt and executed by the named test.',
});
const assertionsForProofs = (row, proofs) => {
  const result = [];
  const seen = new Set();
  for (const proof of proofs) {
    const raw = readJson(resolve(root, proof.rawReceipt));
    for (const assertion of raw.assertionCoverage.filter(item => item.requirementId === row.id)) {
      if (seen.has(assertion.id)) continue;
      seen.add(assertion.id);
      result.push(asPromotionAssertion(row, assertion));
    }
  }
  if (!result.length) throw new Error(`no direct assertions for ${row.id}`);
  for (const assertion of result) assertSourceMapping(assertion);
  return result;
};
const aggregateCounts = proofs => proofs.reduce((sum, proof) => ({
  passed: sum.passed + proof.result.passed,
  failed: sum.failed + proof.result.failed,
  skipped: sum.skipped + proof.result.skipped,
}), { passed: 0, failed: 0, skipped: 0 });
const promotionProofs = new Map();
for (const proof of [...directProofs, ...affectedProofs]) {
  for (const requirementId of proof.requirementIds) {
    if (!promotionProofs.has(requirementId)) promotionProofs.set(requirementId, []);
    promotionProofs.get(requirementId).push(proof);
  }
}

const newPromotions = [];
for (const candidate of candidateRows) {
  const row = rowsById.get(candidate.id);
  const proofs = directProofByRequirement.get(candidate.id) ?? [];
  if (!proofs.length) throw new Error(`candidate has no direct proof: ${candidate.id}`);
  const assertions = assertionsForProofs(row, proofs);
  const counts = aggregateCounts(proofs);
  const evidenceIds = proofs.map(proof => proof.id);
  newPromotions.push({
    promotionId: `PROMOTION-${row.id}`,
    requirementId: row.id,
    from: 'RUNTIME-VERIFY',
    to: 'PASS',
    baselineSha: baseline,
    implementation: row.implementation,
    evidenceIds,
    command: proofs.map(proof => proof.command).join(' ; '),
    cwd: proofs.map(proof => proof.cwd).filter((value, index, values) => values.indexOf(value) === index).join(' ; '),
    rawExitCode: 0,
    counts,
    assertions,
    rationale: `${row.id} is promoted individually from RUNTIME-VERIFY to PASS on final implementation baseline ${baseline}. The semantic review maps the clause to bundles ${candidate.assertionBundles.join(', ')}; the listed evidence contains ${assertions.length} exact source assert/expect mappings across ${proofs.length} literal receipts, each raw exit 0 with 0 fail and 0 skip. This is direct clause evidence, not a test-file existence, keyword match, suite-green inference, symbol check, or historical-finding inference.`,
  });
}

const affectedProofIdsByRequirement = new Map();
for (const proof of affectedProofs) {
  for (const requirementId of proof.requirementIds) {
    if (!affectedProofIdsByRequirement.has(requirementId)) affectedProofIdsByRequirement.set(requirementId, []);
    affectedProofIdsByRequirement.get(requirementId).push(proof);
  }
}
const updatedOldPromotions = ledger.promotions.map(previous => {
  const row = rowsById.get(previous.requirementId);
  if (!row) throw new Error(`old promotion row disappeared: ${previous.requirementId}`);
  if (!affectedRows.has(row.id)) {
    const audit = unchangedAudit.find(item => item.requirementId === row.id);
    if (!audit || audit.changedImplementationFiles.length) throw new Error(`old PASS reuse lacks empty path audit: ${row.id}`);
    return {
      ...previous,
      baselineSha: baseline,
      rationale: `${previous.rationale} Unchanged-path audit ${auditRootRelativePlaceholder('evidence/unchanged-path-audit-33d.json')} records an empty implementation diff from ${audit.priorPromotionBaseline} to ${baseline}; the historical raw receipt and exact assertions are preserved and reused under the acceleration plan's unchanged-path rule.`,
    };
  }
  const proofs = affectedProofIdsByRequirement.get(row.id) ?? [];
  const assertions = assertionsForProofs(row, proofs);
  const counts = aggregateCounts(proofs);
  return {
    ...previous,
    baselineSha: baseline,
    evidenceIds: proofs.map(proof => proof.id),
    command: proofs.map(proof => proof.command).join(' ; '),
    cwd: proofs.map(proof => proof.cwd).filter((value, index, values) => values.indexOf(value) === index).join(' ; '),
    rawExitCode: 0,
    counts,
    assertions,
    rationale: `${row.id} remains an individually authorized PASS. Its old implementation path was changed or intentionally re-captured; current baseline ${baseline} evidence ${proofs.map(proof => proof.id).join(', ')} directly maps the row's executed assertions with raw exit 0 / 0 fail / 0 skip. The old receipt remains preserved; this is a controlled re-anchor, not a bulk promotion.`,
  };
});
const allPromotions = [...updatedOldPromotions, ...newPromotions];
if (new Set(allPromotions.map(promotion => promotion.requirementId)).size !== 230) throw new Error('promotion ledger does not contain 230 unique PASS rows');

const replaceEvidence = new Map();
for (const proof of [...directProofs, ...affectedProofs, ...providerProofs]) replaceEvidence.set(proof.id, proof);
const nextEvidence = evidence.filter(item => !replaceEvidence.has(item.id));
nextEvidence.push(...[...directProofs, ...affectedProofs, ...providerProofs]);

for (const candidate of candidateRows) {
  const row = rowsById.get(candidate.id);
  const proofs = directProofByRequirement.get(candidate.id) ?? [];
  row.state = 'PASS';
  row.evidence = proofs.map(proof => proof.id);
  row.evidenceBaseline = baseline;
  row.finding = `[acceleration controlled promotion ${baseline}] Semantic review ${candidate.assertionBundles.join(', ')} maps this clause to ${assertionsForProofs(row, proofs).length} exact executed source assertions across ${proofs.length} clean receipts. No implementation or assertion gap remained after the条款 → 实现 → 实际断言 review; the old finding is retained in history rather than used as the PASS reason.`;
}
for (const requirementId of affectedRows) {
  const row = rowsById.get(requirementId);
  const proofs = affectedProofIdsByRequirement.get(requirementId) ?? [];
  row.evidence = proofs.map(proof => proof.id);
  row.evidenceBaseline = baseline;
  row.finding = `[acceleration controlled re-anchor ${baseline}] Current clean receipt ${proofs.map(proof => proof.id).join(', ')} directly executes the existing acceptance assertions. The unchanged-path audit and prior evidence remain preserved; no new requirement or acceptance relaxation is introduced.`;
}

const reviewRows = [...candidateRows].map(candidate => {
  const row = rowsById.get(candidate.id);
  const proofs = directProofByRequirement.get(candidate.id) ?? [];
  const assertions = assertionsForProofs(row, proofs);
  return {
    requirementId: row.id,
    from: 'RUNTIME-VERIFY',
    to: 'PASS',
    baselineSha: baseline,
    implementation: row.implementation,
    assertionBundles: candidate.assertionBundles,
    evidenceIds: proofs.map(proof => proof.id),
    rawCounts: aggregateCounts(proofs),
    exactAssertionCount: assertions.length,
    exactAssertionIds: assertions.map(assertion => assertion.id),
    directEvidenceRule: 'Each assertion is the exact assert/expect expression at the stated source line in a named test that has a passing result in the preserved raw receipt.',
  };
});
writeJson(resolve(evidenceRoot, `unchanged-path-audit-${baseline.slice(0, 3)}.json`), {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  currentBaseline: baseline,
  rule: 'Historical PASS evidence is reused only when every production implementation path has an empty diff from its prior promotion baseline to the current frozen baseline. Changed paths are re-captured.',
  rows: unchangedAudit,
  counts: {
    reusedHistoricalEvidence: unchangedAudit.filter(row => row.decision === 'reused-historical-evidence').length,
    recapturedCurrentBaseline: unchangedAudit.filter(row => row.decision === 'recaptured-current-baseline').length,
    nonEmptyImplementationDiffs: unchangedAudit.filter(row => row.changedImplementationFiles.length > 0).length,
  },
});
writeJson(resolve(evidenceRoot, `controlled-promotion-review-${baseline}.json`), {
  schemaVersion: 1,
  authority: 'lite-pass-promotion-20260915',
  accelerationPlan: 'goal acceleration plan: classify all remaining rows, then promote only individually evidenced rows on one frozen implementation baseline',
  currentBaseline: baseline,
  method: '条款 → 当前生产实现 → 当前命名测试实际断言 → 原始执行收据；不使用关键词、文件存在、suite-green、symbol 或旧 finding 推断。',
  batchDecision: 'none: the JSON is serialized as 179 independent promotion objects; no aggregate PASS decision exists.',
  classification: {
  source: `docs/implementation/lite-closeout/evidence/runtime-verify-classification-${baselineTag}.json`,
    counts: classification.classificationCounts,
  },
  rows: reviewRows,
  providerSupplementalEvidence: providerProofs.map(proof => ({ id: proof.id, provider: proof.provider, baseline: proof.baseline, model: proof.environment })),
  deferredBoundary: 'LITE-04-101 remains DEFERRED. Local Provider receipts are supplemental final-gate evidence only and cannot satisfy its hosted-CI reproducibility condition.',
});

matrix.matrixVersion = 25;
matrix.promotionBaselineSha = baseline;
matrix.finalProviderEvidence = providerProofs.map(proof => proof.id);
matrix.changes.push({
  version: 25,
  baseline,
  authority: 'User-approved acceleration plan with controlled per-row PASS promotion',
  reason: 'On the single frozen implementation baseline, all 179 remaining RUNTIME-VERIFY rows were individually rechecked by semantic bundle and exact executed source assertions. Classification was PASS_CANDIDATE 179, ASSERTION_GAP 0, IMPLEMENTATION_GAP 0, UNRESOLVED 0. Existing DEFERRED rows, including LITE-04-101, were not changed; old PASS rows with changed paths were re-captured and unchanged paths were audited before reuse.',
  requirementIds: candidateRows.map(row => row.id),
  evidence: `docs/implementation/lite-closeout/evidence/controlled-promotion-review-${baseline}.json`,
});
ledger.matrixVersion = 25;
ledger.baselineSha = baseline;
ledger.promotions = allPromotions;

function auditRootRelativePlaceholder(file) { return `${auditRootRelative}${file}`; }

writeJson(matrixPath, matrix);
writeJson(promotionsPath, ledger);
writeJson(evidencePath, nextEvidence);

const counts = Object.fromEntries(['PASS', 'GAP', 'RUNTIME-VERIFY', 'DEFERRED'].map(state => [state, matrix.requirements.filter(row => row.state === state).length]));
const markdown = [
  '# Lite acceleration result at 33d12571',
  '',
  'This is the controlled promotion ledger for the single frozen implementation baseline. It does not close the goal until final merged-main CI and `--require-closed` succeed.',
  '',
  `- implementation baseline: \`${baseline}\``,
  '- matrix version: 25 (still frozen)',
  `- counts after this controlled ledger: PASS ${counts.PASS} / GAP ${counts.GAP} / RUNTIME-VERIFY ${counts['RUNTIME-VERIFY']} / DEFERRED ${counts.DEFERRED}`,
  `- candidate classification: PASS_CANDIDATE ${classification.classificationCounts.PASS_CANDIDATE} / ASSERTION_GAP ${classification.classificationCounts.ASSERTION_GAP} / IMPLEMENTATION_GAP ${classification.classificationCounts.IMPLEMENTATION_GAP} / UNRESOLVED ${classification.classificationCounts.UNRESOLVED}`,
  `- direct current receipts: ${directProofs.length} clean receipts, ${directProofs.reduce((sum, proof) => sum + proof.result.passed, 0)} test invocations, ${reviewRows.reduce((sum, row) => sum + row.exactAssertionCount, 0)} exact assertion mappings across the candidate rows`,
  `- old PASS re-anchors: ${affectedProofs.length} current clean receipts; unchanged-path audit is preserved in \`evidence/unchanged-path-audit-${baseline.slice(0, 3)}.json\``,
  '- Provider supplement: Codex and Kimi-Luna completed; OpenCode completed with `opencode/big-pickle`; these do not alter the authorized DEFERRED state of LITE-04-101.',
  '',
  '## Remaining closeout gates',
  '',
  '- Main CI run `35045883487` first attempt is preserved as a one-test Windows `HIGH-1` failure; one evidence-supported rerun is in progress.',
  '- The promotion branch still needs the docs/evidence PR merge on top of the final main code SHA.',
  '- Final merged-main CI and `node scripts/verify-lite-scope.mjs --require-closed` remain mandatory.',
  '- `LITE-04-101` remains DEFERRED because hosted CI lacks the three CLI tools and controlled credentials; local receipts are not CI-reproducible evidence.',
  '',
  '## Per-row ledger',
  '',
  '| ID | Transition | Evidence | Exact assertions |',
  '| --- | --- | ---: | ---: |',
  ...reviewRows.map(row => `| ${row.requirementId} | ${row.from} → ${row.to} | ${row.evidenceIds.join(', ')} | ${row.exactAssertionCount} |`),
  '',
  'The machine-readable per-row implementation, command, counts, assertion objects and rationale are in `pass-promotions.json`; the semantic review index is in `evidence/controlled-promotion-review-33d12571.json`.',
  '',
].join('\n');
writeFileSync(resolve(auditRoot, 'ACCELERATION-RESULT-33D.md'), markdown);

console.log(JSON.stringify({ baseline, matrixVersion: matrix.matrixVersion, counts, directProofs: directProofs.length, affectedProofs: affectedProofs.length, providerProofs: providerProofs.map(proof => proof.id), candidateRows: candidateRows.length, exactAssertions: reviewRows.reduce((sum, row) => sum + row.exactAssertionCount, 0) }));
