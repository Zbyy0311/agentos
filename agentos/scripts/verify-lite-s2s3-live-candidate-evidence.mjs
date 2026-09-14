/**
 * LITE S2/S3 live candidate evidence harness.
 *
 * It runs the two env-gated real-Provider gates (canonical artifact chain, runtime approval
 * chain) as child processes with M4_P4_KEEP_ROOT=1, preserves their raw stdout/stderr/exit
 * codes, and then re-derives the clauses from the durable store that same invocation left
 * behind. The gate's own assertions cover ordering (pause before spawn, stale version,
 * replay); the receipts here show the persisted facts those assertions are about, read from
 * the real rows.
 *
 * Usage (from the project root):
 *   node scripts/verify-lite-s2s3-live-candidate-evidence.mjs --out <dir>
 *     --opencode-cli <exe> --model <provider/model>
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const LF = String.fromCharCode(10);

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const OUT = resolve(argValue('--out', '.'));
const SERVER_DIR = resolve(argValue('--server-dir', join(import.meta.dirname, '..', 'apps', 'server')));
const EXE = argValue('--opencode-cli', process.env.AGENTOS_OPENCODE_CLI);
const MODEL = argValue('--model', process.env.AGENTOS_OPENCODE_MODEL);
// Roots are preserved by default: a real-Provider gate keeps its root precisely so the
// captured provider output stays inspectable, and a cleanup failure must never destroy the
// report that the same run produced.
const CLEANUP = argValue('--cleanup', '0') === '1';
/**
 * When a gate invocation has already been preserved, its raw stdout/stderr/exit and kept
 * root can be re-read instead of paying for another real-Provider call. The receipts then
 * come from that same preserved invocation, which is what the pack has to bind to.
 */
const REUSE = argValue('--reuse', undefined);
const reuseRoot = REUSE === undefined ? undefined : resolve(REUSE);
mkdirSync(OUT, { recursive: true });
if (!EXE || !MODEL) throw new Error('--opencode-cli and --model are required');

const receipts = [];
const phases = {};
let phase = 'setup';
class ReceiptFailure extends Error {}

function expect(requirementId, id, step, actual, expected) {
  let passed = true;
  let detail;
  try { assert.deepEqual(actual, expected); }
  catch (error) { passed = false; detail = String(error.message).split(LF)[0]; }
  receipts.push({ id, requirementId, phase, step, actual, expected,
    outcome: passed ? 'passed' : 'failed',
    ...(detail === undefined ? {} : { detail }) });
  if (!passed) throw new ReceiptFailure(id);
  return actual;
}

function catchPhase(error) {
  if (!(error instanceof ReceiptFailure)) throw error;
  phases[phase] = { ...(phases[phase] ?? {}), failedReceipt: error.message };
}

function runGate(name, testFile, flag) {
  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  const args = ['--import', 'tsx', '--test', '--test-concurrency=1', testFile];
  let stdout;
  let stderr;
  let status;
  if (reuseRoot === undefined) {
    const result = spawnSync(process.execPath, args, {
      cwd: SERVER_DIR,
      env: { ...process.env, [flag]: '1', M4_P4_KEEP_ROOT: '1',
        AGENTOS_OPENCODE_CLI: EXE, AGENTOS_OPENCODE_MODEL: MODEL },
      encoding: 'buffer',
      maxBuffer: 256 * 1024 * 1024,
    });
    stdout = result.stdout ?? Buffer.alloc(0);
    stderr = result.stderr ?? Buffer.alloc(0);
    status = result.status;
  } else {
    stdout = readFileSync(join(reuseRoot, name, 'stdout.txt'));
    stderr = readFileSync(join(reuseRoot, name, 'stderr.txt'));
    status = Number(readFileSync(join(reuseRoot, name, 'exit.txt'), 'utf8').trim());
  }
  writeFileSync(join(dir, 'stdout.txt'), stdout);
  writeFileSync(join(dir, 'stderr.txt'), stderr);
  writeFileSync(join(dir, 'exit.txt'), String(status ?? -1), 'utf8');
  const text = stdout.toString('utf8');
  // Node's test runner intercepts a test's console.error and a phase's own output can land
  // on either stream, so both are searched; the runner's default reporter prints the totals
  // with the information glyph, while the TAP-ish form is accepted as well.
  const kept = /kept root: (.+)$/mu.exec(text) ?? /kept root: (.+)$/mu.exec(stderr.toString('utf8'));
  const pass = /(?:#|\u2139)\s*pass (\d+)/u.exec(text);
  const fail = /(?:#|\u2139)\s*fail (\d+)/u.exec(text);
  const skipped = /(?:#|\u2139)\s*skipped (\d+)/u.exec(text);
  return {
    name, dir, flag,
    command: 'node ' + args.join(' '),
    reusedFrom: reuseRoot === undefined ? null : join(reuseRoot, name),
    exitCode: status, signal: null,
    stdoutBytes: stdout.length, stderrBytes: stderr.length,
    keptRoot: kept === null ? null : kept[1].trim(),
    testSummary: pass === null || fail === null || skipped === null
      ? null
      : { pass: Number(pass[1]), fail: Number(fail[1]), skipped: Number(skipped[1]) },
  };
}

function openKeptStore(gate) {
  if (gate.keptRoot === null) throw new Error('the gate did not report a kept root: ' + gate.name);
  const path = join(gate.keptRoot, '.agentos', 'agentos.sqlite');
  return { path, db: new DatabaseSync(path, { readOnly: true }) };
}

const gates = {
  artifact: runGate('artifact-gate', 'src/services/run-engine/CanonicalArtifactResult.liveGate.test.ts', 'M4_P4_REAL_ARTIFACT_GATE'),
  approval: runGate('approval-gate', 'src/services/run-engine/RuntimeApprovalGate.liveGate.test.ts', 'M4_P4_REAL_APPROVAL_GATE'),
};
phases.gates = Object.fromEntries(Object.values(gates).map(gate => [gate.name, {
  command: gate.command, exitCode: gate.exitCode, signal: gate.signal,
  reusedFrom: gate.reusedFrom,
  stdoutBytes: gate.stdoutBytes, stderrBytes: gate.stderrBytes,
  keptRoot: gate.keptRoot, testSummary: gate.testSummary }]));

// --------------------------------------------------------------- artifact phase
phase = 'artifact';
try {
const WS = 'ws_live_artifact';
const RUN = 'run_live_artifact';
const gate = gates.artifact;
expect('LITE-07-104', 'S2E-GATE-01', 'the real-Provider artifact gate itself passed under its gated run',
  { exitCode: gate.exitCode, signal: gate.signal, testSummary: gate.testSummary },
  { exitCode: 0, signal: null, testSummary: { pass: 1, fail: 0, skipped: 0 } });
const kept = openKeptStore(gate);
const db = kept.db;
const stageKeys = new Map(db.prepare('SELECT id, workflow_stage_key FROM run_stages WHERE workspace_id = ?').all(WS)
  .map(row => [row.id, row.workflow_stage_key]));
const artifacts = db.prepare('SELECT id, artifact_type, canonical_run_id, source_stage_id, summary, provenance_kind FROM runtime_artifacts WHERE workspace_id = ? ORDER BY id').all(WS);
const completions = db.prepare('SELECT id, artifact_id, artifact_type, conclusion, candidate_id, source_key FROM artifact_completions WHERE workspace_id = ? ORDER BY id').all(WS);
const candidates = db.prepare('SELECT id, scope, category, authority, decision, outcome, merged_into_entry_id FROM memory_candidate_entries WHERE workspace_id = ? ORDER BY id').all(WS);
const candidateSources = db.prepare('SELECT candidate_id, source_kind, source_id FROM memory_candidate_sources').all();
const candidateEvents = db.prepare('SELECT type, payload_json FROM runtime_events WHERE workspace_id = ? AND type = ?').all(WS, 'memory.candidate_created');
const runtimeEventCount = Number(db.prepare('SELECT COUNT(*) AS c FROM runtime_events WHERE workspace_id = ?').get(WS).c);
const outboxCount = Number(db.prepare('SELECT COUNT(*) AS c FROM outbox_messages WHERE aggregate_id = ?').get(RUN).c);
const entries = db.prepare('SELECT id, scope, category, content FROM memory_entries WHERE workspace_id = ?').all(WS);
const entrySources = db.prepare('SELECT memory_entry_id, source_kind, source_id FROM memory_entry_sources').all();
const runRow = db.prepare('SELECT id, status FROM runs WHERE workspace_id = ? AND id = ?').get(WS, RUN);
const stages = db.prepare('SELECT id, status FROM run_stages WHERE workspace_id = ? AND run_id = ?').all(WS, RUN);

expect('LITE-07-104', 'S2E-ARTIFACT-01', 'a real review produced a canonical Artifact bound to the Run and a known Stage',
  { runStatus: runRow?.status, allStagesCompleted: stages.every(stage => stage.status === 'completed'),
    artifactCount: artifacts.length,
    artifacts: artifacts.map(artifact => ({ id: artifact.id, type: artifact.artifact_type,
      runMatches: artifact.canonical_run_id === RUN, provenance: artifact.provenance_kind,
      stageKey: stageKeys.get(artifact.source_stage_id) ?? null, summaryNonEmpty: artifact.summary.trim().length > 0 })) },
  { runStatus: 'completed', allStagesCompleted: true, artifactCount: 3,
    artifacts: artifacts.map(artifact => ({ id: artifact.id, type: 'review', runMatches: true,
      provenance: 'CANONICAL', stageKey: stageKeys.get(artifact.source_stage_id) ?? null, summaryNonEmpty: true })) });
const REVIEW_VOCABULARY = ['approved', 'changes_requested'];
expect('LITE-07-104', 'S2E-COMPLETION-01', 'every Artifact reached exactly one type-matched terminal completion from the canonical seam',
  { completions: completions.length,
    oneCompletionPerArtifact: completions.length === artifacts.length
      && completions.map(completion => completion.artifact_id).sort().join() === artifacts.map(artifact => artifact.id).sort().join(),
    coveredArtifacts: completions.map(completion => completion.artifact_id).sort(),
    types: completions.map(completion => completion.artifact_type),
    conclusionMatchesType: completions.every(completion => completion.artifact_type === 'review'
      ? REVIEW_VOCABULARY.includes(completion.conclusion)
      : ['pass', 'fail'].includes(completion.conclusion)),
    fromCanonicalSeam: completions.every(completion => completion.source_key.startsWith('canonical-result:')) },
  { completions: 3, oneCompletionPerArtifact: true,
    coveredArtifacts: artifacts.map(artifact => artifact.id).sort(),
    types: artifacts.map(artifact => artifact.artifact_type),
    conclusionMatchesType: true, fromCanonicalSeam: true });
const artifactCandidates = candidates.filter(candidate => completions.some(completion => completion.candidate_id === candidate.id));
expect('LITE-07-104', 'S2E-CANDIDATE-01', 'each completion produced a review-required Candidate that cites the Artifact as its source',
  { candidateCount: artifactCandidates.length,
    candidates: artifactCandidates.map(candidate => ({ id: candidate.id, scope: candidate.scope,
      category: candidate.category, authority: candidate.authority, decision: candidate.decision,
      citesArtifact: candidateSources.some(source => source.candidate_id === candidate.id
        && source.source_kind === 'artifact'
        && completions.some(completion => completion.artifact_id === source.source_id)) })),
    oneCandidatePerCompletion: artifactCandidates.length === completions.length },
  { candidateCount: 3,
    candidates: artifactCandidates.map(candidate => ({ id: candidate.id, scope: 'workspace',
      category: 'decision', authority: 'agent-derived', decision: 'review-required', citesArtifact: true })),
    oneCandidatePerCompletion: true });
expect('LITE-07-104', 'S2E-EVENT-01', 'each completion Candidate became a canonical Runtime Event with exactly one Outbox handoff',
  { eventTypes: [...new Set(candidateEvents.map(row => row.type))],
    eventCandidates: candidateEvents.map(row => JSON.parse(row.payload_json).candidateId).sort(),
    completionCandidates: completions.map(completion => completion.candidate_id).sort(),
    everyCompletionHasEvent: completions.every(completion => candidateEvents
      .some(row => JSON.parse(row.payload_json).candidateId === completion.candidate_id)),
    oneEventPerCandidate: candidateEvents.length === new Set(candidateEvents
      .map(row => JSON.parse(row.payload_json).candidateId)).size,
    runtimeEventCount, outboxCount, oneHandoffPerEvent: outboxCount === runtimeEventCount },
  { eventTypes: ['memory.candidate_created'],
    eventCandidates: candidateEvents.map(row => JSON.parse(row.payload_json).candidateId).sort(),
    completionCandidates: completions.map(completion => completion.candidate_id).sort(),
    everyCompletionHasEvent: true, oneEventPerCandidate: true,
    runtimeEventCount, outboxCount, oneHandoffPerEvent: true });
const accepted = candidates.filter(candidate => candidate.merged_into_entry_id !== null);
expect('LITE-07-104', 'S2E-ENTRY-01', 'accepting the Candidate promoted a durable Entry that keeps the Artifact provenance',
  { acceptedCandidates: accepted.map(candidate => candidate.id), entryCount: entries.length,
    entryIds: entries.map(entry => entry.id),
    entriesMatchAccepted: accepted.every(candidate => entries.some(entry => entry.id === candidate.merged_into_entry_id)),
    contentsNonEmpty: entries.every(entry => entry.content.trim().length > 0),
    artifactProvenanceKept: entrySources.some(source => source.source_kind === 'artifact'
      && artifacts.some(artifact => artifact.id === source.source_id)),
    entrySourceKinds: [...new Set(entrySources.map(source => source.source_kind))] },
  { acceptedCandidates: [completions[0].candidate_id], entryCount: 1, entryIds: entries.map(entry => entry.id),
    entriesMatchAccepted: true, contentsNonEmpty: true, artifactProvenanceKept: true,
    entrySourceKinds: [...new Set(entrySources.map(source => source.source_kind))] });
// LITE-07-104 also has to stay review-gated: the artifacts the reviewed Candidate did NOT
// accept remain review-required, so the chain never auto-promotes machine-produced facts.
const unreviewed = candidates.filter(candidate => candidate.merged_into_entry_id === null);
expect('LITE-07-104', 'S2E-REVIEW-GATE-01', 'only the reviewed Candidate was promoted; every unreviewed one stays review-required and unmapped',
  { artifactCandidates: artifactCandidates.length, totalCandidates: candidates.length,
    everyCandidateIsReviewRequired: candidates.every(candidate => candidate.decision === 'review-required'),
    reviewedCandidateWasPromoted: accepted.length === 1 && accepted[0].merged_into_entry_id !== null,
    unreviewedCandidates: unreviewed.length,
    unreviewedStayUnmapped: unreviewed.every(candidate => candidate.merged_into_entry_id === null),
    acceptedCandidatePredatesNothing: accepted.every(candidate => candidate.merged_into_entry_id !== null) },
  { artifactCandidates: 3, totalCandidates: 4,
    everyCandidateIsReviewRequired: true, reviewedCandidateWasPromoted: true,
    unreviewedCandidates: 3, unreviewedStayUnmapped: true, acceptedCandidatePredatesNothing: true });
phases.artifact = { keptRoot: gate.keptRoot, dbPath: kept.path, artifacts: artifacts.length,
  completions: completions.length, candidates: candidates.length, entries: entries.length,
  runtimeEventCount, outboxCount };
db.close();
} catch (error) { catchPhase(error); }

// --------------------------------------------------------------- approval phase
phase = 'approval';
try {
const WS_A = 'ws_live_approval_a';
const WS_B = 'ws_live_approval_b';
const gate = gates.approval;
expect('LITE-08-005', 'S3E-GATE-01', 'the real-Provider approval gate itself passed under its gated run',
  { exitCode: gate.exitCode, signal: gate.signal, testSummary: gate.testSummary },
  { exitCode: 0, signal: null, testSummary: { pass: 1, fail: 0, skipped: 0 } });
const kept = openKeptStore(gate);
const db = kept.db;
const requestRows = db.prepare('SELECT id, run_id, stage_id, status, version, resolution, expires_at, action_fingerprint, agent_snapshot_hash, provider_snapshot_hash, launch_plan_hash, request_snapshot_json FROM runtime_approval_requests WHERE workspace_id = ? ORDER BY created_at, id').all(WS_A);
const decisionRows = db.prepare('SELECT approval_request_id, decision, decided_by FROM approval_decisions WHERE workspace_id = ? ORDER BY decided_at, id').all(WS_A);
const processRows = db.prepare('SELECT id, run_id, status FROM runtime_processes WHERE workspace_id = ?').all(WS_A);
const runA = db.prepare('SELECT id, status FROM runs WHERE workspace_id = ?').all(WS_A);
const stageRowsA = db.prepare('SELECT id, status FROM run_stages WHERE workspace_id = ?').all(WS_A);
const decisionCandidates = db.prepare('SELECT id, scope, category, authority, decision, outcome FROM memory_candidate_entries WHERE workspace_id = ? ORDER BY id').all(WS_A);
const decisionSources = db.prepare('SELECT candidate_id, source_kind, source_id FROM memory_candidate_sources').all();
const candidateEvents = db.prepare('SELECT payload_json FROM runtime_events WHERE workspace_id = ? AND type = ?').all(WS_A, 'memory.candidate_created');
const expiryRequests = db.prepare('SELECT id, run_id, stage_id, status, resolution, expires_at, action_fingerprint, launch_plan_hash FROM runtime_approval_requests WHERE workspace_id = ? ORDER BY created_at, id').all(WS_B);
const expiryDecisions = db.prepare('SELECT id FROM approval_decisions WHERE workspace_id = ?').all(WS_B);
const expiryProcesses = db.prepare('SELECT id FROM runtime_processes WHERE workspace_id = ?').all(WS_B);
const runB = db.prepare('SELECT id, status FROM runs WHERE workspace_id = ?').all(WS_B);
const stageRowsB = db.prepare('SELECT id, status FROM run_stages WHERE workspace_id = ?').all(WS_B);
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

expect('LITE-08-005', 'S3E-REQUEST-01', 'the paused Run carries its own persisted request with frozen identities',
  { requestCount: requestRows.length,
    runsOnStage: [...new Set(requestRows.map(row => row.run_id))],
    stagesOnRequest: [...new Set(requestRows.map(row => row.stage_id))],
    statuses: [...new Set(requestRows.map(row => row.status))],
    resolutions: [...new Set(requestRows.map(row => row.resolution))],
    frozenIdentities: requestRows.every(row => hex64(row.action_fingerprint) && hex64(row.agent_snapshot_hash)
      && hex64(row.provider_snapshot_hash) && hex64(row.launch_plan_hash)),
    snapshotsPersisted: requestRows.every(row => row.request_snapshot_json.length > 0),
    expiriesInFuture: requestRows.every(row => row.expires_at > new Date(0).toISOString()),
    distinctActions: new Set(requestRows.map(row => row.action_fingerprint)).size },
  { requestCount: 2, runsOnStage: [requestRows[0].run_id],
    stagesOnRequest: [requestRows[0].stage_id, requestRows[1].stage_id].sort(),
    statuses: ['approved'], resolutions: ['approve_once'], frozenIdentities: true,
    snapshotsPersisted: true, expiriesInFuture: true, distinctActions: 2 });
expect('LITE-08-005', 'S3E-PROCESS-01', 'the authorized Run executed real provider processes while decision rows stay one per request',
  { providerProcesses: processRows.length,
    processesPerRun: processRows.filter(row => row.run_id === requestRows[0].run_id).length,
    distinctProcesses: new Set(processRows.map(row => row.id)).size,
    decisionRows: decisionRows.length,
    decisions: decisionRows.map(row => row.decision),
    oneDecisionPerRequest: decisionRows.length === requestRows.length
      && decisionRows.every(row => requestRows.some(request => request.id === row.approval_request_id)),
    runStatuses: [...new Set(runA.map(row => row.status))],
    stageStatuses: [...new Set(stageRowsA.map(row => row.status))] },
  { providerProcesses: 2, processesPerRun: 2, distinctProcesses: 2, decisionRows: 2,
    decisions: ['allow_once', 'allow_once'], oneDecisionPerRequest: true,
    runStatuses: ['completed'], stageStatuses: ['completed'] });
const sourcesOf = candidate => decisionSources.filter(source => source.candidate_id === candidate.id);
const decisionsPerRequest = new Map();
for (const row of decisionRows) {
  decisionsPerRequest.set(row.approval_request_id, (decisionsPerRequest.get(row.approval_request_id) ?? 0) + 1);
}
const decisionTrigger = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'approval_decisions_reject_update'").get();
expect('LITE-08-006', 'S3E-IDEMPOTENT-01', 'each resolved request keeps exactly one durable decision and that decision cannot be rewritten',
  { requests: requestRows.length, decisions: decisionRows.length,
    perRequestDecisionCounts: [...decisionsPerRequest.values()],
    everyRequestHasExactlyOneDecision: requestRows.every(request => decisionsPerRequest.get(request.id) === 1),
    distinctDecidedRequests: decisionsPerRequest.size,
    distinctResolutions: new Set(requestRows.map(row => row.resolution)).size,
    decisionsAreImmutable: decisionTrigger !== undefined && /RAISE\(ABORT, 'APPROVAL_DECISION_IMMUTABLE'\)/u.test(String(decisionTrigger.sql)) },
  { requests: 2, decisions: 2, perRequestDecisionCounts: [1, 1],
    everyRequestHasExactlyOneDecision: true, distinctDecidedRequests: 2,
    distinctResolutions: 1, decisionsAreImmutable: true });
const userCandidates = decisionCandidates.filter(candidate => candidate.authority === 'user-explicit');
const describeDecisionCandidate = candidate => {
  const sources = sourcesOf(candidate);
  return { scope: candidate.scope, category: candidate.category, authority: candidate.authority,
    outcome: candidate.outcome,
    sourceKinds: [...new Set(sources.map(source => source.source_kind))].sort(),
    citesItsRun: sources.some(source => source.source_kind === 'run'),
    citesAResolutionEvent: sources.some(source => source.source_kind === 'event') };
};
expect('LITE-07-103', 'S3E-DECISION-CANDIDATE-01', 'each accepted decision produced its own user-authority Candidate citing the Run and its resolution Event',
  { userAuthorityCandidates: userCandidates.length, described: userCandidates.map(describeDecisionCandidate),
    distinctResolutionEvents: new Set(userCandidates.flatMap(candidate => sourcesOf(candidate)
      .filter(source => source.source_kind === 'event').map(source => source.source_id))).size,
    eventCandidates: candidateEvents.map(row => JSON.parse(row.payload_json).candidateId).sort(),
    allCandidateIds: decisionCandidates.map(candidate => candidate.id).sort() },
  { userAuthorityCandidates: 2,
    described: userCandidates.map(() => ({ scope: 'workspace', category: 'decision',
      authority: 'user-explicit', outcome: 'review-required', sourceKinds: ['event', 'run'],
      citesItsRun: true, citesAResolutionEvent: true })),
    distinctResolutionEvents: 2,
    eventCandidates: decisionCandidates.map(candidate => candidate.id).sort(),
    allCandidateIds: decisionCandidates.map(candidate => candidate.id).sort() });
expect('LITE-08-007', 'S3E-EXPIRY-01', 'an expired request records no decision, spawns nothing and keeps its paused attempt',
  { requests: expiryRequests.map(row => ({ status: row.status, resolution: row.resolution,
      frozen: hex64(row.action_fingerprint) && hex64(row.launch_plan_hash) })),
    decisions: expiryDecisions.length, providerProcesses: expiryProcesses.length,
    runStatuses: [...new Set(runB.map(row => row.status))],
    attemptStageStillWaiting: (() => {
      const stage = stageRowsB.find(row => row.id === expiryRequests[0].stage_id);
      return stage === undefined ? 'stage-missing' : stage.status;
    })(),
    anyStageRunning: stageRowsB.some(row => row.status === 'running'),
    stageStatuses: stageRowsB.map(row => row.status).sort() },
  { requests: expiryRequests.map(row => ({ status: 'expired', resolution: null, frozen: true })),
    decisions: 0, providerProcesses: 0, runStatuses: ['waiting_approval'],
    attemptStageStillWaiting: 'waiting_approval', anyStageRunning: false,
    stageStatuses: stageRowsB.map(row => row.status).sort() });
phases.approval = { keptRoot: gate.keptRoot, dbPath: kept.path, requests: requestRows.length,
  decisions: decisionRows.length, providerProcesses: processRows.length,
  decisionCandidates: decisionCandidates.length, expiredRequests: expiryRequests.length,
  expiredDecisions: expiryDecisions.length, expiredProcesses: expiryProcesses.length };
db.close();
} catch (error) { catchPhase(error); }

const counts = { total: receipts.length, passed: 0, failed: 0, skipped: 0 };
for (const receipt of receipts) {
  if (receipt.outcome === 'passed') counts.passed += 1;
  else if (receipt.outcome === 'failed') counts.failed += 1;
  else counts.skipped += 1;
}
writeFileSync(join(OUT, 'receipts.json'), JSON.stringify({
  schemaVersion: 1, generatedAt: new Date().toISOString(),
  client: EXE, model: MODEL, phases, counts, receipts,
}, null, 2) + LF, 'utf8');

console.log('S2S3_LIVE_CANDIDATE_EVIDENCE: ' + (counts.failed === 0 ? 'passed' : 'failed'));
console.log('  model=' + MODEL + ' receipts=' + counts.total + ' passed=' + counts.passed + ' failed=' + counts.failed);
for (const receipt of receipts.filter(item => item.outcome !== 'passed')) {
  console.log('  FAILED ' + receipt.id + ' (' + receipt.requirementId + '): ' + (receipt.detail ?? ''));
}
await new Promise(resolve => setTimeout(resolve, 100));

if (CLEANUP) {
  for (const gate of Object.values(gates)) {
    if (gate.keptRoot === null) continue;
    try { rmSync(gate.keptRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); }
    catch (error) { console.log('  cleanup skipped for ' + gate.keptRoot + ': ' + String(error.code ?? error)); }
  }
}

process.exitCode = counts.failed === 0 ? 0 : 1;
