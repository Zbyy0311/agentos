/**
 * LITE-07-102 candidate evidence harness: Task/Run/Stage terminal outcomes and restart
 * convergence.
 *
 * Phases:
 *   trigger    - the production dispatcher fails a canonical Run at startup (missing provider
 *                executable) and the dispatch-time terminal trigger fires exactly once
 *   bounded    - the fact the trigger produced is bounded record-only text, and nothing from
 *                the provider process was persisted
 *   idempotent - a replay of the same terminal Run modifies nothing and creates nothing
 *   restart    - the production startup sweep repairs a terminal Run whose Candidate was lost
 *                to a crash between the terminal commit and the trigger, and leaves every Run
 *                row untouched
 *   refuse     - a non-terminal Run is refused without being modified and without execution
 *
 * Usage (from apps/server, with tsx resolvable):
 *   node --import tsx ../../scripts/verify-lite-07-102-candidate-evidence.mjs --out <dir>
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { SqliteStore } from '../apps/server/src/store/SqliteStore.ts';
import { RunSnapshotRepository } from '../apps/server/src/store/RunSnapshotRepository.ts';
import { WorkspaceAdmissionRepository } from '../apps/server/src/store/WorkspaceAdmissionRepository.ts';
import { createProviderExecutionChain } from '../apps/server/src/services/run-engine/providerExecutionChain.ts';
import { TerminalMemoryCandidateReconciler } from '../apps/server/src/services/TerminalMemoryCandidateReconciler.ts';
import { M3_013_LEGACY_WORKFLOW_V2_ID } from '../apps/server/src/migrations/migrations/013-workflow-creation-metadata-v2.ts';

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const OUT = resolve(argValue('--out', '.'));
mkdirSync(OUT, { recursive: true });

const receipts = [];
const phases = {};
let phase = 'setup';
class ReceiptFailure extends Error {}

function expect(requirementId, id, step, actual, expected) {
  let passed = true;
  let detail;
  try { assert.deepEqual(actual, expected); }
  catch (error) { passed = false; detail = String(error.message).split(String.fromCharCode(10))[0]; }
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

const root = mkdtempSync(join(tmpdir(), 'agentos-102-'));
const workspaceRoot = join(root, 'workspace');
mkdirSync(workspaceRoot, { recursive: true });
const store = new SqliteStore(root);
const db = store.getDatabase();
const NOW = new Date().toISOString();
const WS = 'ws_lite102';
const STAGE_KEYS = ['codex_manager', 'kimi_worker', 'opencode_reviewer', 'codex_final_review'];

db.prepare('INSERT INTO workspaces (id,name,root_path,canonical_root_path,last_opened_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
  .run(WS, WS, workspaceRoot, workspaceRoot, NOW, NOW, NOW);

/** A canonical Run whose provider executable cannot be started, wired exactly like the
 *  production composition (snapshot, stages, admission, run.start Operation). */
function seedRun(suffix, opts = {}) {
  const runId = 'run_lite102_' + suffix;
  const taskId = 'task_lite102_' + suffix;
  const agentId = 'agent_lite102_' + suffix;
  const providerId = 'pcfg_lite102_' + suffix;
  const operationId = 'op_' + suffix.toUpperCase().padEnd(26, 'A').slice(0, 26);
  const executable = opts.executable ?? 'definitely-missing-provider-' + suffix + '.exe';
  db.prepare('INSERT INTO provider_configurations (id, workspace_id, name, provider_type, adapter_id, runtime_mode, capabilities_json, timeout_policy_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(providerId, WS, 'Provider ' + suffix, 'opencode', 'builtin.opencode', 'cli', '{}', '{}', NOW, NOW);
  db.prepare('INSERT INTO agent_profiles (id, workspace_id, name, agent_role, role_title, system_prompt, permissions_json, enabled, cli_command, cli_args_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,1,?,?,?,?)')
    .run(agentId, WS, 'Agent ' + suffix, 'opencode', 'Agent ' + suffix, 'bounded task', '["read"]', executable, '[]', NOW, NOW);
  db.prepare('INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version) VALUES (?,?,?,?,?,?,?,1)')
    .run(taskId, WS, 'Review the parser ' + suffix, 'open', 'lite102', NOW, NOW);
  db.prepare('INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, next_event_sequence, created_by, created_at, updated_at, version) VALUES (?,?,?,?,?,?,?,1,?,?,?,1)')
    .run(runId, WS, taskId, runId, opts.status ?? 'queued', 'initial', 'v2_api', 'lite102', NOW, NOW);
  db.prepare('INSERT INTO operations (id, type, status, workspace_id, aggregate_type, aggregate_id, run_id, correlation_id, created_at, updated_at, version) VALUES (?,?,?,?,?,?,?,?,?,?,1)')
    .run(operationId, 'run.start', 'queued', WS, 'run', runId, runId, operationId, NOW, NOW);
  const providerSnapshot = {
    providerConfigId: providerId, name: 'Provider ' + suffix, providerType: 'opencode', adapterId: 'builtin.opencode',
    runtimeMode: 'cli', executable, argsTemplate: [], model: 'deepseek/deepseek-v4-flash',
    environmentProfileId: null, secretProfileId: null, workingDirectoryMode: 'workspace', workspaceRelativeWorkingDirectory: null,
    capabilities: { sessionResume: false, structuredEvents: false, nativeApprovals: false, subagents: false, toolEvents: false, fileEvents: false, usageEvents: false, reasoningStream: false, interactiveInput: false, pause: false, cancellation: true, modelSelection: true, workspaceAwareness: true, nativeSandbox: false, outputContracts: false },
    timeoutPolicy: { discoveryTimeoutMs: 5000, validationTimeoutMs: 5000, startupTimeoutMs: 5000, idleTimeoutMs: null, totalTimeoutMs: null, cancelGracePeriodMs: 1000, approvalTimeoutMs: null },
    approvalMode: 'disabled', outputMode: 'parsed-text', enabled: true, version: 1,
  };
  const agentSnapshot = { agentId, name: 'Agent ' + suffix, role: 'opencode', roleTitle: 'Agent ' + suffix, systemPrompt: 'bounded task', permissions: ['read'], providerConfigId: providerId, enabled: true, version: 1 };
  new RunSnapshotRepository(db).insert({
    workspaceId: WS, runId, workflowDefinitionId: M3_013_LEGACY_WORKFLOW_V2_ID,
    payload: {
      schemaVersion: 2, capturedAt: NOW,
      run: { workspaceId: WS, taskId, origin: 'v2_api', reason: 'initial', parentRunId: null, rootRunId: runId },
      workflow: { definitionId: M3_013_LEGACY_WORKFLOW_V2_ID, definitionKey: 'legacy-pipeline', definitionVersion: 2,
        name: 'legacy-pipeline-v2', definitionHash: '9ea35ef455c5fefa45d0b28d1433933b2cc6b3fb9e412b4d4452afb7862a6b6d', worktreeMode: 'preferred',
        stages: STAGE_KEYS.map((key, index) => ({ workflowStageKey: key, name: key, sequence: index + 1, agent: agentSnapshot, provider: providerSnapshot, dependsOn: index === 0 ? [] : [STAGE_KEYS[index - 1]] })) },
      security: { redactionApplied: false },
    },
  });
  const snapshotId = db.prepare('SELECT id FROM run_snapshots WHERE workspace_id = ? AND run_id = ?').get(WS, runId).id;
  STAGE_KEYS.forEach((key, index) => db.prepare('INSERT INTO run_stages (id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name, sequence, attempt, status, created_at, updated_at, version) VALUES (?,?,?,?,?,?,?,1,?,?,?,1)')
    .run('stage_' + suffix + '_' + String(index), WS, runId, snapshotId, key, key, index + 1, 'pending', NOW, NOW));
  const admissions = new WorkspaceAdmissionRepository(db);
  // The Workspace holds exactly one admission row, so a Run that reuses the slot transitions
  // the previous holder to RELEASED instead of inserting a second row.
  // The slot to hand over is the Workspace's live MODIFYING holder, not merely the first row.
  const previous = admissions.listByWorkspace(WS)
    .find(row => row.state === 'GRANTED' && row.effectiveMutationClass === 'MODIFYING');
  if (previous !== undefined) {
    const released = admissions.updateState({ workspaceId: WS, admissionId: previous.id,
      expectedVersion: previous.version, state: 'RELEASED', queueReason: null,
      releaseReason: 'terminal', grantedAt: previous.grantedAt, releasedAt: NOW,
      effectiveMutationClass: previous.effectiveMutationClass,
      enforcementEvidenceJson: previous.enforcementEvidenceJson, updatedAt: NOW });
    if (!released) throw new Error('admission release lost a version race');
  }
  // request_order is unique per Workspace as well, so a fresh holder takes the next slot.
  const nextOrder = (admissions.maxRequestOrder(WS) ?? 0) + 1;
  admissions.insertAdmission({ id: 'adm_' + suffix, workspaceId: WS, subjectKind: 'CANONICAL_RUN',
    canonicalRunId: runId, legacyRunId: null, requestedMutationClass: 'MODIFYING', effectiveMutationClass: 'MODIFYING',
    enforcementEvidenceJson: null, requestOrder: nextOrder, state: 'GRANTED', queueReason: null, releaseReason: null,
    requestedAt: NOW, grantedAt: NOW, releasedAt: null, createdAt: NOW, updatedAt: NOW, version: 1 });
  return { runId, taskId, agentId, providerId, operationId };
}

/** The production composition root; the provider CLI is unreachable by construction. */
const makeChain = () => createProviderExecutionChain({
  store, artifactRoot: join(root, '.agentos', 'artifacts'),
  workspaceRootFor: () => workspaceRoot, worktreePathFor: () => workspaceRoot,
  environment: { PATH: '', SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
});
const chain = makeChain();
const runsOf = () => db.prepare('SELECT id, status, version, failure_code AS failureCode, updated_at AS updatedAt FROM runs WHERE workspace_id = ? ORDER BY id').all(WS);
const candidatesOf = () => db.prepare('SELECT id, scope, category, authority, decision, outcome, content, summary, merged_into_entry_id AS mergedIntoEntryId FROM memory_candidate_entries WHERE workspace_id = ? ORDER BY id').all(WS);
const eventsOf = runId => db.prepare('SELECT type, correlation_id AS correlationId FROM runtime_events WHERE run_id = ? ORDER BY sequence').all(runId);

// ------------------------------------------------------------------ trigger phase
phase = 'trigger';
const runA = seedRun('a');
try {
await chain.dispatcher.driveSafely(WS, runA.runId);
const run = db.prepare('SELECT id, status, failure_code AS failureCode, version FROM runs WHERE id = ?').get(runA.runId);
const events = eventsOf(runA.runId);
const candidates = candidatesOf().filter(candidate => candidate.id === 'mcand_terminal_' + runA.runId);
const processes = db.prepare('SELECT id FROM runtime_processes WHERE run_id = ?').all(runA.runId);
const sessions = db.prepare('SELECT id FROM provider_sessions WHERE run_id = ?').all(runA.runId);
const outputs = db.prepare('SELECT COUNT(*) AS n FROM process_output_references').get();
expect('LITE-07-102', 'S102-TRIGGER-01', 'a non-success terminal Run produces exactly one bounded Candidate from the dispatch-time trigger',
  { runStatus: run.status, failureCode: run.failureCode,
    terminalEvents: events.map(event => event.type).filter(type => type.startsWith('run.')),
    stageOutcomes: db.prepare('SELECT status FROM run_stages WHERE run_id = ? ORDER BY sequence').all(runA.runId).map(row => row.status),
    candidateCount: candidates.length,
    candidate: candidates.map(candidate => ({ id: candidate.id, scope: candidate.scope, category: candidate.category,
      authority: candidate.authority, decision: candidate.decision, outcome: candidate.outcome })),
    candidateEvents: db.prepare("SELECT COUNT(*) AS n FROM runtime_events WHERE run_id = ? AND type = 'memory.candidate_created'").get(runA.runId).n,
    providerProcesses: processes.length, providerSessions: sessions.length, outputReferences: Number(outputs.n) },
  { runStatus: 'failed', failureCode: 'PROVIDER_EXECUTABLE_NOT_ACCESSIBLE',
    terminalEvents: ['run.dequeued', 'run.started', 'run.failed'],
    stageOutcomes: ['failed', 'skipped', 'skipped', 'skipped'],
    candidateCount: 1,
    candidate: [{ id: 'mcand_terminal_' + runA.runId, scope: 'task', category: 'failure',
      authority: 'agent-derived', decision: 'review-required', outcome: 'review-required' }],
    candidateEvents: 1, providerProcesses: 0, providerSessions: 0, outputReferences: 0 });
} catch (error) { catchPhase(error); }

// ------------------------------------------------------------------ bounded phase
phase = 'bounded';
try {
const candidate = candidatesOf().find(item => item.id === 'mcand_terminal_' + runA.runId);
const content = String(candidate.content);
const lines = content.split(String.fromCharCode(10));
const allowedPrefixes = ['任务：', '结果：', '失败代码：', '失败说明：', 'Stage 结果：'];
const failureMessage = db.prepare('SELECT failure_message AS message FROM runs WHERE id = ?').get(runA.runId).message;
expect('LITE-07-102', 'S102-BOUNDED-01', 'the fact is bounded record-only evidence: allowlisted lines, truncated fields, no raw output',
  { contentBytes: content.length, withinBound: content.length <= 12000,
    everyLineAllowlisted: lines.every(line => allowedPrefixes.some(prefix => line.startsWith(prefix))),
    prefixesSeen: [...new Set(lines.map(line => allowedPrefixes.find(prefix => line.startsWith(prefix))))],
    failureCodeLine: lines.find(line => line.startsWith('失败代码：')),
    failureMessageTruncated: (lines.find(line => line.startsWith('失败说明：')) ?? '').length <= '失败说明：'.length + 400,
    stageSummary: lines.find(line => line.startsWith('Stage 结果：'))?.includes('codex_manager: failed'),
    storedMessageIsTheRunsOwnBoundedMessage: lines.find(line => line.startsWith('失败说明：')) === '失败说明：' + String(failureMessage).slice(0, 400),
    providerOutputRowsForThisWorkspace: Number(db.prepare('SELECT COUNT(*) AS n FROM process_output_references').get().n),
    sourceKinds: db.prepare('SELECT source_kind AS kind FROM memory_candidate_sources WHERE candidate_id = ? ORDER BY kind').all(candidate.id).map(row => row.kind) },
  { contentBytes: content.length, withinBound: true, everyLineAllowlisted: true,
    prefixesSeen: ['任务：', '结果：', '失败代码：', '失败说明：', 'Stage 结果：'],
    failureCodeLine: '失败代码：PROVIDER_EXECUTABLE_NOT_ACCESSIBLE',
    failureMessageTruncated: true, stageSummary: true,
    storedMessageIsTheRunsOwnBoundedMessage: true, providerOutputRowsForThisWorkspace: 0,
    sourceKinds: ['run'] });
} catch (error) { catchPhase(error); }

// --------------------------------------------------------------- idempotent phase
phase = 'idempotent';
try {
const before = { runs: runsOf(), candidates: candidatesOf().length,
  events: Number(db.prepare("SELECT COUNT(*) AS n FROM runtime_events WHERE run_id = ?").get(runA.runId).n) };
await chain.dispatcher.driveSafely(WS, runA.runId);
const terminalEvent = db.prepare("SELECT id, correlation_id AS correlationId FROM runtime_events WHERE run_id = ? AND type = 'run.failed' ORDER BY sequence DESC LIMIT 1").get(runA.runId);
const replay = chain.terminalCandidateGenerator.generateForRunTerminal({
  workspaceId: WS, runId: runA.runId, createdAt: NOW,
  eventContext: { origin: 'persisted_event', eventId: terminalEvent.id,
    context: { correlationId: terminalEvent.correlationId, causationId: terminalEvent.id } },
});
const after = { runs: runsOf(), candidates: candidatesOf().length,
  events: Number(db.prepare("SELECT COUNT(*) AS n FROM runtime_events WHERE run_id = ?").get(runA.runId).n) };
expect('LITE-07-102', 'S102-IDEMPOTENT-01', 'a replay neither modifies the terminal Run nor creates a second fact or Event',
  { replayOutcome: replay.outcome, replayCandidateMatches: replay.candidate?.id === 'mcand_terminal_' + runA.runId,
    runRowsUnchanged: JSON.stringify(after.runs) === JSON.stringify(before.runs),
    candidatesAdded: after.candidates - before.candidates, eventsAdded: after.events - before.events },
  { replayOutcome: 'existing', replayCandidateMatches: true, runRowsUnchanged: true,
    candidatesAdded: 0, eventsAdded: 0 });
} catch (error) { catchPhase(error); }

// ------------------------------------------------------------------ restart phase
phase = 'restart';
const runB = seedRun('b');
try {
const drivenB = await chain.dispatcher.drive(WS, runB.runId);
await chain.dispatcher.driveSafely(WS, runB.runId);
phases.driveB = (() => {
  const row = db.prepare('SELECT status, failure_code AS failureCode FROM runs WHERE id = ?').get(runB.runId);
  return { driven: drivenB, status: row.status, failureCode: row.failureCode,
    eventTypes: eventsOf(runB.runId).map(event => event.type),
    admissions: db.prepare('SELECT id, state, request_order AS requestOrder FROM workspace_admissions WHERE workspace_id = ? ORDER BY request_order').all(WS) };
})();
// The crash window: the terminal state and its canonical Event committed, but the process
// died before the trigger ran. The Candidate is the only thing missing, so removing that one
// row reproduces exactly the state a crash leaves behind.
const lostCandidate = 'mcand_terminal_' + runB.runId;
const candidateEventsForB = Number(db.prepare("SELECT COUNT(*) AS n FROM runtime_events WHERE run_id = ? AND type = 'memory.candidate_created'").get(runB.runId).n);
db.prepare('DELETE FROM memory_candidate_sources WHERE candidate_id = ?').run(lostCandidate);
db.prepare('DELETE FROM memory_candidate_entries WHERE id = ?').run(lostCandidate);
const terminalForB = Number(db.prepare("SELECT COUNT(*) AS n FROM runtime_events WHERE run_id = ? AND type IN ('run.failed','run.completed','run.cancelled')").get(runB.runId).n);
// runC reaches a terminal status through the database without a terminal Event at all: the
// sweep must report the missing authority instead of inventing one.
const runC = seedRun('c');
db.prepare("UPDATE runs SET status = 'cancelled', updated_at = ? WHERE id = ?").run(NOW, runC.runId);
const beforeSweep = runsOf();
const sweep = new TerminalMemoryCandidateReconciler({ store, generator: chain.terminalCandidateGenerator,
  onProblem: detail => { phases[phase] = { ...(phases[phase] ?? {}), problem: detail }; } }).reconcileOnStartup();
const afterSweep = runsOf();
const restored = candidatesOf().find(candidate => candidate.id === lostCandidate);
expect('LITE-07-102', 'S102-RESTART-01', 'the startup sweep repairs the crashed Run and reports the Run that has no authority to repair from',
  { terminalRunRows: beforeSweep.filter(run => ['completed', 'failed', 'cancelled'].includes(run.status)).length,
    generated: sweep.generated, existing: sweep.existing, missingAuthority: sweep.missingAuthority,
    unresolved: sweep.unresolved,
    repairedCandidate: restored === undefined ? null : { id: restored.id, scope: restored.scope,
      category: restored.category, decision: restored.decision, citesRun: db.prepare('SELECT COUNT(*) AS n FROM memory_candidate_sources WHERE candidate_id = ? AND source_kind = ?').get(restored.id, 'run').n === 1 },
    candidateEventsBefore: candidateEventsForB, terminalEventBefore: terminalForB,
    candidatesAfterSweep: candidatesOf().length },
  { terminalRunRows: 3, generated: 1, existing: 1, missingAuthority: 1, unresolved: 0,
    repairedCandidate: { id: lostCandidate, scope: 'task', category: 'failure', decision: 'review-required', citesRun: true },
    candidateEventsBefore: 1, terminalEventBefore: 1, candidatesAfterSweep: 2 });
expect('LITE-07-102', 'S102-RESTART-02', 'the sweep never mutates a Run row, terminal or not',
  { runRowsUnchanged: JSON.stringify(afterSweep) === JSON.stringify(beforeSweep),
    runs: afterSweep.map(run => ({ id: run.id, status: run.status })) },
  { runRowsUnchanged: true, runs: beforeSweep.map(run => ({ id: run.id, status: run.status })) });
// The sweep converges: running it again adds nothing and reports the repaired rows as existing.
const secondSweep = new TerminalMemoryCandidateReconciler({ store, generator: chain.terminalCandidateGenerator }).reconcileOnStartup();
expect('LITE-07-102', 'S102-RESTART-03', 'a second sweep converges with no new facts, so a restart loop cannot duplicate work',
  { generated: secondSweep.generated, existing: secondSweep.existing, missingAuthority: secondSweep.missingAuthority,
    candidates: candidatesOf().length },
  { generated: 0, existing: 2, missingAuthority: 1, candidates: 2 });
phases.restart = { sweep, secondSweep, lostCandidate };
} catch (error) { catchPhase(error); }

// ------------------------------------------------------------------- refuse phase
phase = 'refuse';
const runD = seedRun('d');
try {
const before = runsOf();
const refused = chain.terminalCandidateGenerator.generateForRunTerminal({ workspaceId: WS, runId: runD.runId, createdAt: NOW });
const after = runsOf();
expect('LITE-07-102', 'S102-REFUSE-01', 'a non-terminal Run is refused without being touched and without any execution starting',
  { outcome: refused.outcome,
    runRowsUnchanged: JSON.stringify(after) === JSON.stringify(before),
    runStatus: db.prepare('SELECT status FROM runs WHERE id = ?').get(runD.runId).status,
    candidateCreated: candidatesOf().some(candidate => candidate.id === 'mcand_terminal_' + runD.runId),
    providerProcesses: db.prepare('SELECT COUNT(*) AS n FROM runtime_processes WHERE run_id = ?').get(runD.runId).n,
    runtimeEvents: Number(db.prepare('SELECT COUNT(*) AS n FROM runtime_events WHERE run_id = ?').get(runD.runId).n) },
  { outcome: 'not-terminal', runRowsUnchanged: true, runStatus: 'queued', candidateCreated: false,
    providerProcesses: 0, runtimeEvents: 0 });
} catch (error) { catchPhase(error); }

phases.summary = { candidates: candidatesOf().map(candidate => ({ id: candidate.id, category: candidate.category, decision: candidate.decision })) };

store.close();
rmSync(root, { recursive: true, force: true });

const counts = { total: receipts.length, passed: 0, failed: 0, skipped: 0 };
for (const receipt of receipts) {
  if (receipt.outcome === 'passed') counts.passed += 1;
  else if (receipt.outcome === 'failed') counts.failed += 1;
  else counts.skipped += 1;
}
writeFileSync(join(OUT, 'receipts.json'), JSON.stringify({
  schemaVersion: 1, generatedAt: new Date().toISOString(), phases, counts, receipts,
}, null, 2) + String.fromCharCode(10), 'utf8');

console.log('S102_CANDIDATE_EVIDENCE: ' + (counts.failed === 0 ? 'passed' : 'failed'));
console.log('  receipts=' + counts.total + ' passed=' + counts.passed + ' failed=' + counts.failed);
for (const receipt of receipts.filter(item => item.outcome !== 'passed')) {
  console.log('  FAILED ' + receipt.id + ' (' + receipt.requirementId + '): ' + (receipt.detail ?? ''));
}
await new Promise(resolve => setTimeout(resolve, 100));
process.exitCode = counts.failed === 0 ? 0 : 1;
