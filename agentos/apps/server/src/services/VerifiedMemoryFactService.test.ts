import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createM3RuntimeEventRegistry,
  type AuthorizedRuntimeEventContextV1,
  type RuntimeEventContextAuthoritySourceV1,
} from '@agentos/shared';
import { createFileBackupProvider } from '../migrations/backup.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { MigrationRegistry } from '../migrations/registry.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import { migration046 } from '../migrations/migrations/046-memory-verified-facts.js';
import { MemoryCandidateRepository } from '../store/MemoryCandidateRepository.js';
import { OutboxRepository } from '../store/OutboxRepository.js';
import { RunSequenceAllocator } from '../store/RunSequenceAllocator.js';
import { RuntimeEventOutboxWriter, RuntimeEventRepository } from '../store/RuntimeEventRepository.js';
import type { TransactionDatabase } from '../store/Transaction.js';
import { MemoryRuntimeEventEmitter } from './MemoryRuntimeEventEmitter.js';
import type { MemoryRuntimeEventContextAuthorityV1 } from './MemoryRuntimeEventEmitter.js';
import {
  COLLABORATION_ACCEPTANCE_RUNNER_VERSION,
  VerifiedMemoryFactService,
  type VerifiedMemoryFactInput,
} from './VerifiedMemoryFactService.js';

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDb;
};

const NOW = '2026-10-01T00:00:00.000Z';
const WS = 'ws_verified_fact';
const TASK = 'task_verified_fact';
const RUN = 'run_verified_fact';
const OP = 'op_verified_fact';
const EVENT_CONTEXT: RuntimeEventContextAuthoritySourceV1 = {
  origin: 'operation', operationId: OP,
  context: { correlationId: 'corr_verified_fact', causationId: 'cause_verified_fact' },
};
const EVENT_AUTHORITY: MemoryRuntimeEventContextAuthorityV1 = {
  authorize(source): AuthorizedRuntimeEventContextV1 {
    return {
      correlationId: source.context.correlationId,
      causationId: source.context.causationId,
      origin: source.origin,
      authorityId: source.origin === 'operation' ? source.operationId
        : source.origin === 'canonical_command' ? source.commandId : source.eventId,
    } as unknown as AuthorizedRuntimeEventContextV1;
  },
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-verified-memory-fact-'));
  const db = new DatabaseSync(join(root, 'agentos.sqlite'));
  db.prepare('PRAGMA foreign_keys=ON').run();
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
    backupProvider: createFileBackupProvider(join(root, 'backup')),
  }).run();
  migration046.apply({ db: db as unknown as MinimalDatabaseSync });
  const tx = db as unknown as TransactionDatabase;
  db.prepare(`INSERT INTO workspaces(id,name,root_path,canonical_root_path,last_opened_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?)`).run(WS, WS, 'C:/tmp/verified-facts', 'C:/tmp/verified-facts', NOW, NOW, NOW);
  const events = new RuntimeEventRepository(tx, createM3RuntimeEventRegistry());
  const outbox = new OutboxRepository(tx, events);
  const writer = new RuntimeEventOutboxWriter(events, new RunSequenceAllocator(tx), outbox, tx);
  const emitter = new MemoryRuntimeEventEmitter({
    store: { getDatabase: () => tx }, factWriter: writer, eventAuthority: EVENT_AUTHORITY, now: () => new Date(NOW),
  });
  const service = new VerifiedMemoryFactService(tx);
  const emittedService = new VerifiedMemoryFactService(tx, emitter);
  const close = () => {
    try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); }
  };
  return { db, tx, service, emittedService, close };
}

function addTask(db: SqliteDb, taskId = TASK): void {
  db.prepare(`INSERT INTO tasks(id,workspace_id,title,status,created_by,created_at,updated_at,version)
    VALUES(?,?,?,'open','test',?,?,1)`).run(taskId, WS, taskId, NOW, NOW);
}

function addRun(db: SqliteDb, options: {
  runId?: string; taskId?: string; status?: string; failureCode?: string | null; snapshotHash?: string; omitFailedEvent?: boolean;
} = {}): string {
  const runId = options.runId ?? RUN;
  const taskId = options.taskId ?? TASK;
  db.prepare(`INSERT INTO runs(id,workspace_id,task_id,root_run_id,status,reason,created_by,created_at,updated_at,version)
    VALUES(?,?,?,?,'queued','initial','test',?,?,1)`).run(runId, WS, taskId, runId, NOW, NOW);
  const snapshotHash = options.snapshotHash ?? 'a'.repeat(64);
  db.prepare(`INSERT INTO run_snapshots(id,workspace_id,run_id,workflow_definition_id,snapshot_schema_version,
      snapshot_json,content_hash,redaction_applied,captured_at)
    VALUES(?,?,?,'workflow_00000000000000000000000002',1,'{}',?,0,?)`)
    .run(`snapshot_${runId}`, WS, runId, snapshotHash, NOW);
  if (options.status !== undefined) {
    db.prepare('UPDATE runs SET status=?,failure_code=?,next_event_sequence=2 WHERE id=?')
      .run(options.status, options.failureCode ?? null, runId);
  }
  if (options.status === 'failed' && options.omitFailedEvent !== true) {
    db.prepare(`INSERT INTO runtime_events(
      id,schema_version,type,workspace_id,task_id,run_id,sequence,timestamp,source,correlation_id,
      severity,visibility,durability,payload_json,created_at
    ) VALUES(?,1,'run.failed',?,?,?,1,?,'runtime-engine',?,'error','workspace','durable','{"status":"failed"}',?)`)
      .run(`evt_fail_${runId}`, WS, taskId, runId, NOW, `corr_${runId}`, NOW);
  }
  return runId;
}

function addOperation(db: SqliteDb, runId = RUN): void {
  db.prepare(`INSERT INTO operations(id,type,status,workspace_id,aggregate_type,aggregate_id,run_id,correlation_id,
      created_at,started_at,updated_at,version)
    VALUES(?,'run.start','running',?,'run',?,?,?, ?,?,?,1)`)
    .run(OP, WS, runId, runId, EVENT_CONTEXT.context.correlationId, NOW, NOW, NOW);
}

function addCollaborationTest(db: SqliteDb, input: {
  readonly suffix: string;
  readonly status: 'passed' | 'failed';
  readonly exitCode: number;
  readonly runId?: string;
  readonly taskId?: string;
  readonly commit?: string;
  readonly command?: string;
  readonly diffText?: string;
  readonly includeRunnerReceipt?: boolean;
}) {
  const runId = input.runId ?? RUN;
  const taskId = input.taskId ?? TASK;
  const collabId = `collab_${input.suffix}`;
  const candidateId = `candidate_${input.suffix}`;
  const commit = input.commit ?? 'b'.repeat(40);
  const command = input.command ?? 'pnpm test --filter acceptance';
  const diffText = input.diffText ?? `diff --git a/${input.suffix}.txt b/${input.suffix}.txt\n+${input.status}\n`;
  const manifestJson = JSON.stringify([{ path: 'untracked.txt', sizeBytes: 1, sha256: 'f'.repeat(64) }]);
  db.prepare(`INSERT INTO collaboration_tasks(
      id,workspace_id,title,objective,scope_json,acceptance_commands_json,planner_agent_id,implementer_agent_id,
      reviewer_agent_id,status,plan_hash,base_commit,canonical_task_id,canonical_run_id,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,? ,? ,?,'awaiting_application',?,?,?,?,?,?)`)
    .run(collabId, WS, 'candidate evidence', 'prove tests', '[]', JSON.stringify([command]),
      'planner', 'implementer', 'reviewer', digest(collabId), commit, taskId, runId, NOW, NOW);
  db.prepare(`INSERT INTO collaboration_candidates(
      id,collaboration_task_id,workspace_id,canonical_run_id,round,base_commit,head_commit,diff_hash,diff_text,
      snapshot_version,manifest_json,test_status,test_command,test_exit_code,test_output,status,
      diff_artifact_id,manifest_artifact_id,version,created_at,updated_at
    ) VALUES(?,?,?,?,0,?,?,?,?,2,?,?,?,?,?,'created',NULL,NULL,1,?,?)`)
    .run(candidateId, collabId, WS, runId, commit, commit, digest(diffText), diffText,
      manifestJson, input.status, command, input.exitCode, `exit ${input.exitCode}`,
      NOW, NOW);
  if (input.includeRunnerReceipt !== false) {
    db.prepare(`INSERT INTO memory_test_runner_receipts(
      candidate_id,workspace_id,run_id,commit_id,result,exit_code,output_sha256,runner_version,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      candidateId, WS, runId, commit, input.status, input.exitCode, digest(`exit ${input.exitCode}`),
      COLLABORATION_ACCEPTANCE_RUNNER_VERSION, NOW,
    );
  }
  return candidateId;
}

function count(db: SqliteDb, sql: string, ...params: unknown[]): number {
  return Number((db.prepare(sql).get(...params) as { c: number }).c);
}

function failureInput(sourceId = RUN): VerifiedMemoryFactInput {
  return { workspaceId: WS, sourceKind: 'failure-code', sourceId, createdAt: NOW };
}

test('failure facts require the whitelisted Run code, its immutable snapshot, and same-Run failed Event', () => {
  const fx = fixture();
  try {
    addTask(fx.db);
    addRun(fx.db, { status: 'failed', failureCode: 'PROVIDER_TIMEOUT' });
    const [fact] = fx.service.accumulateTerminal({ workspaceId: WS, runId: RUN, createdAt: NOW });
    assert.ok(fact);
    const candidate = new MemoryCandidateRepository(fx.tx).findCandidateById(WS, fact.candidateId)!;
    assert.equal(fact.decision, 'auto-accept');
    assert.equal(candidate.scope, 'task');
    assert.equal(candidate.authority, 'system-verified');
    assert.equal(candidate.confidence, 1);
    assert.match(candidate.content, /PROVIDER_TIMEOUT/);
    assert.doesNotMatch(candidate.content, /failure_message|stack|secret/i);

    const invalidRun = 'run_without_event';
    addTask(fx.db, 'task_without_event');
    addRun(fx.db, { runId: invalidRun, taskId: 'task_without_event', status: 'failed', failureCode: 'TEST_FAILED', omitFailedEvent: true });
    assert.throws(() => fx.service.accumulate(failureInput(invalidRun)), /MEMORY_FACT_SOURCE_INVALID/);

    fx.db.prepare("UPDATE runs SET failure_code='UNTRUSTED_MODEL_CODE' WHERE id=?").run(RUN);
    assert.throws(() => fx.service.accumulate(failureInput()), /MEMORY_FACT_SOURCE_INVALID/);
  } finally { fx.close(); }
});

test('input rejects caller-authored content, authority, owner, scope, and confidence fields', () => {
  const fx = fixture();
  try {
    addTask(fx.db);
    addRun(fx.db, { status: 'failed', failureCode: 'STAGE_TIMEOUT' });
    for (const forged of [
      { content: 'remember my token=abc' }, { authority: 'system-verified' }, { ownerTaskId: 'other-task' },
      { scope: 'global' }, { confidence: 1 }, { category: 'decision' },
    ]) {
      assert.throws(() => fx.service.accumulate({ ...failureInput(), ...forged } as VerifiedMemoryFactInput), /MEMORY_FACT_INPUT_INVALID/);
    }
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_verified_facts'), 0);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_candidate_entries'), 0);
  } finally { fx.close(); }
});

test('completed runtime environment facts require the same owned process/session/run and store no raw environment paths', () => {
  const fx = fixture();
  try {
    addTask(fx.db);
    addRun(fx.db, { status: 'completed' });
    const stageId = 'stage_env';
    const snapshotId = `snapshot_${RUN}`;
    fx.db.prepare(`INSERT INTO run_stages(id,workspace_id,run_id,run_snapshot_id,workflow_stage_key,name,sequence,attempt,status,created_at,updated_at,version)
      VALUES(?,?,?,?,?,'provider',1,1,'pending',?,?,1)`).run(stageId, WS, RUN, snapshotId, 'provider', NOW, NOW);
    fx.db.prepare(`INSERT INTO provider_configurations(
      id,workspace_id,name,provider_type,adapter_id,runtime_mode,executable,capabilities_json,timeout_policy_json,
      approval_mode,output_mode,enabled,version,created_at,updated_at
    ) VALUES('pcfg_env',?,'env provider','codex','builtin.codex','cli','codex.exe','{}','{}','disabled','structured',1,1,?,?)`)
      .run(WS, NOW, NOW);
    fx.db.prepare(`INSERT INTO agent_profiles(workspace_id,id,name,agent_role,role_title,system_prompt,permissions_json,
      enabled,cli_command,cli_args_json,created_at,updated_at) VALUES(?,'agent_env','Codex','codex','Worker','prompt','[]',1,'codex','[]',?,?)`)
      .run(WS, NOW, NOW);
    const sessionId = `psess_${'C'.repeat(26)}`;
    fx.db.prepare(`INSERT INTO provider_sessions(
      id,workspace_id,task_id,run_id,stage_id,stage_attempt,authority_role,agent_id,provider_config_id,
      provider_config_version,provider_type,adapter_id,adapter_version,config_schema_version,runtime_mode,
      status,started_at,completed_at,claim_epoch,capabilities_json,created_at,updated_at,version
    ) VALUES(?,?,?,?,?,1,'primary-provider','agent_env','pcfg_env',1,'codex','builtin.codex','1.0.0',1,'cli',
      'completed',?,?,1,'{}',?,?,1)`).run(sessionId, WS, TASK, RUN, stageId, NOW, NOW, NOW, NOW);
    const processId = `proc_${'D'.repeat(26)}`;
    fx.db.prepare(`INSERT INTO runtime_processes(
      id,workspace_id,task_id,run_id,stage_id,stage_attempt,provider_session_id,authority_role,claim_epoch,
      process_type,platform,status,executable_resolved,executable_fingerprint,args_redacted_json,cwd_resolved,
      shell,detached,stdin_mode,stdout_mode,stderr_mode,exit_code,exited_at,timeout_policy_json,
      security_profile_ref,created_at,updated_at,version
    ) VALUES(?,?,?,?,?,1,?,'primary-provider',1,'provider','win32','exited','codex.exe',?,'[]',?,
      0,0,'closed','capture','capture',0,?,'{}','default',?,?,1)`)
      .run(processId, WS, TASK, RUN, stageId, sessionId, 'e'.repeat(64), 'C:/private/path', NOW, NOW, NOW);

    const [fact] = fx.service.accumulateTerminal({ workspaceId: WS, runId: RUN, createdAt: NOW });
    assert.ok(fact);
    const candidate = new MemoryCandidateRepository(fx.tx).findCandidateById(WS, fact.candidateId)!;
    assert.equal(candidate.scope, 'task');
    assert.match(candidate.content, /win32/);
    assert.doesNotMatch(candidate.content, /private|codex\.exe|psess/i);
    assert.throws(() => fx.service.accumulate({ workspaceId: 'other-workspace', sourceKind: 'environment', sourceId: processId, createdAt: NOW }), /MEMORY_FACT_SOURCE_INVALID/);
  } finally { fx.close(); }
});

test('collaboration test facts require a commit-bound immutable runner receipt with the persisted output hash', () => {
  const fx = fixture();
  try {
    addTask(fx.db);
    addRun(fx.db, { status: 'completed' });
    const candidateId = addCollaborationTest(fx.db, { suffix: 'valid', status: 'passed', exitCode: 0 });
    fx.service.setPolicy(WS, 0, true);
    const fact = fx.service.accumulate({ workspaceId: WS, sourceKind: 'test-result', sourceId: candidateId, createdAt: NOW });
    assert.equal(fact.decision, 'auto-accept');
    assert.ok(fact.entryId);
    const candidate = new MemoryCandidateRepository(fx.tx).findCandidateById(WS, fact.candidateId)!;
    assert.equal(candidate.scope, 'task');
    assert.equal(candidate.authority, 'system-verified');
    assert.match(candidate.content, /Server-executed collaboration acceptance tests passed; exit code 0/);
    assert.match(candidate.content, new RegExp(`output sha256 ${digest('exit 0')}`));
    assert.equal((fx.db.prepare('SELECT source_id FROM memory_verified_facts WHERE id=?').get(fact.id) as { source_id: string }).source_id, candidateId);
    const candidateRow = fx.db.prepare('SELECT diff_artifact_id,manifest_artifact_id FROM collaboration_candidates WHERE id=?')
      .get(candidateId) as { diff_artifact_id: string | null; manifest_artifact_id: string | null };
    assert.equal(candidateRow.diff_artifact_id, null);
    assert.equal(candidateRow.manifest_artifact_id, null);
    assert.throws(() => fx.db.prepare('UPDATE memory_test_runner_receipts SET output_sha256=? WHERE candidate_id=?')
      .run('0'.repeat(64), candidateId), /MEMORY_TEST_RUNNER_RECEIPT_IMMUTABLE/);
    assert.throws(() => fx.db.prepare('DELETE FROM memory_test_runner_receipts WHERE candidate_id=?')
      .run(candidateId), /MEMORY_TEST_RUNNER_RECEIPT_IMMUTABLE/);

    const missingReceipt = addCollaborationTest(fx.db, { suffix: 'no-receipt', status: 'passed', exitCode: 0, includeRunnerReceipt: false });
    assert.throws(() => fx.service.accumulate({ workspaceId: WS, sourceKind: 'test-result', sourceId: missingReceipt, createdAt: NOW }), /MEMORY_FACT_SOURCE_INVALID/);
    const forgedExit = addCollaborationTest(fx.db, { suffix: 'forged-exit', status: 'passed', exitCode: 1, includeRunnerReceipt: false });
    assert.throws(() => fx.service.accumulate({ workspaceId: WS, sourceKind: 'test-result', sourceId: forgedExit, createdAt: NOW }), /MEMORY_FACT_SOURCE_INVALID/);
    const wrongCommit = addCollaborationTest(fx.db, { suffix: 'wrong-commit', status: 'passed', exitCode: 0, includeRunnerReceipt: false });
    assert.throws(() => fx.db.prepare(`INSERT INTO memory_test_runner_receipts(
      candidate_id,workspace_id,run_id,commit_id,result,exit_code,output_sha256,runner_version,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      wrongCommit, WS, RUN, 'c'.repeat(40), 'passed', 0, digest('exit 0'), COLLABORATION_ACCEPTANCE_RUNNER_VERSION, NOW,
    ), /MEMORY_TEST_RUNNER_RECEIPT_INVALID/);
    const wrongOutputHash = addCollaborationTest(fx.db, { suffix: 'wrong-output-hash', status: 'passed', exitCode: 0, includeRunnerReceipt: false });
    fx.db.prepare(`INSERT INTO memory_test_runner_receipts(
      candidate_id,workspace_id,run_id,commit_id,result,exit_code,output_sha256,runner_version,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      wrongOutputHash, WS, RUN, 'b'.repeat(40), 'passed', 0, digest('different output'), COLLABORATION_ACCEPTANCE_RUNNER_VERSION, NOW,
    );
    assert.throws(() => fx.service.accumulate({ workspaceId: WS, sourceKind: 'test-result', sourceId: wrongOutputHash, createdAt: NOW }), /MEMORY_FACT_SOURCE_INVALID/);
    assert.throws(() => fx.service.accumulate({ workspaceId: WS, sourceKind: 'test-result', sourceId: 'model_test_artifact', createdAt: NOW }), /MEMORY_FACT_SOURCE_INVALID/);
  } finally { fx.close(); }
});

test('workspace CAS defaults enabled; same fact replays idempotently and outcome conflicts stay review-required', () => {
  const fx = fixture();
  try {
    addTask(fx.db);
    addRun(fx.db, { status: 'completed' });
    const firstCandidateId = addCollaborationTest(fx.db, { suffix: 'pass', status: 'passed', exitCode: 0, diffText: 'shared accepted diff' });
    const failedCandidateId = addCollaborationTest(fx.db, { suffix: 'fail', status: 'failed', exitCode: 2 });
    assert.deepEqual(fx.service.policy(WS), { enabled: true, version: 0 });
    const first = fx.service.accumulate({ workspaceId: WS, sourceKind: 'test-result', sourceId: firstCandidateId, createdAt: NOW });
    assert.equal(first.decision, 'auto-accept');
    const aliasSourceId = addCollaborationTest(fx.db, { suffix: 'pass-alias', status: 'passed', exitCode: 0, diffText: 'shared accepted diff' });
    const alias = fx.service.accumulate({ workspaceId: WS, sourceKind: 'test-result', sourceId: aliasSourceId, createdAt: NOW });
    assert.equal(alias.candidateId, first.candidateId);
    assert.notEqual(alias.id, first.id);
    assert.deepEqual(fx.service.setPolicy(WS, 0, true), { enabled: true, version: 1 });
    assert.throws(() => fx.service.setPolicy(WS, 0, false), /MEMORY_POLICY_VERSION_CONFLICT/);

    const failed = fx.service.accumulate({ workspaceId: WS, sourceKind: 'test-result', sourceId: failedCandidateId, createdAt: NOW });
    assert.equal(failed.decision, 'review-required');
    assert.notEqual(failed.candidateId, first.candidateId);
    assert.deepEqual(fx.service.setPolicy(WS, 1, false), { enabled: false, version: 2 });
    const disabledSource = addCollaborationTest(fx.db, {
      suffix: 'disabled', status: 'passed', exitCode: 0, commit: 'c'.repeat(40),
    });
    const disabled = fx.service.accumulate({ workspaceId: WS, sourceKind: 'test-result', sourceId: disabledSource, createdAt: NOW });
    assert.equal(disabled.decision, 'review-required');
    assert.throws(() => fx.service.setPolicy(WS, 1, true), /MEMORY_POLICY_VERSION_CONFLICT/);

    const replay = fx.service.accumulate({ workspaceId: WS, sourceKind: 'test-result', sourceId: firstCandidateId, createdAt: NOW });
    assert.deepEqual(replay, first);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_verified_facts'), 4);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_candidate_entries'), 3);
  } finally { fx.close(); }
});

test('disabled workspace memory rejects fact accumulation while policy CAS remains available', () => {
  const fx = fixture();
  try {
    addTask(fx.db);
    addRun(fx.db, { status: 'failed', failureCode: 'PROVIDER_TIMEOUT' });
    fx.db.prepare('UPDATE workspaces SET memory_enabled=0 WHERE id=?').run(WS);

    assert.deepEqual(fx.service.setPolicy(WS, 0, false), { enabled: false, version: 1 });
    assert.throws(() => fx.service.accumulate(failureInput()), /MEMORY_FACT_MEMORY_DISABLED/u);
    assert.deepEqual(fx.service.accumulateTerminal({ workspaceId: WS, runId: RUN, createdAt: NOW }), []);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_verified_facts'), 0);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_candidate_entries'), 0);

    fx.db.prepare('UPDATE workspaces SET memory_enabled=1 WHERE id=?').run(WS);
    assert.equal(fx.service.accumulate(failureInput()).decision, 'review-required',
      'the independently versioned disabled auto-accept policy remains effective when memory is re-enabled');
  } finally { fx.close(); }
});

test('Candidate, Entry, Event, Outbox, and fact receipt roll back together when the emitter write fails', () => {
  const fx = fixture();
  try {
    addTask(fx.db);
    addRun(fx.db, { status: 'failed', failureCode: 'PROVIDER_TIMEOUT' });
    addOperation(fx.db);
    fx.db.exec(`CREATE TRIGGER fail_memory_fact_outbox BEFORE INSERT ON outbox_messages
      BEGIN SELECT RAISE(ABORT,'injected outbox failure'); END`);
    assert.throws(() => fx.emittedService.accumulate({ ...failureInput(), eventContext: EVENT_CONTEXT }), /MEMORY_EVENT_EMISSION_FAILED/);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_verified_facts'), 0);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_candidate_entries'), 0);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_entries'), 0);
    assert.equal(count(fx.db, "SELECT COUNT(*) AS c FROM runtime_events WHERE type LIKE 'memory.%'"), 0);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM outbox_messages'), 0);
  } finally { fx.close(); }
});

test('emitter commits fact receipt with its candidate Event and Outbox; repeated input returns deterministic receipt', () => {
  const fx = fixture();
  try {
    addTask(fx.db);
    addRun(fx.db, { status: 'failed', failureCode: 'STAGE_TIMEOUT' });
    addOperation(fx.db);
    const input = { ...failureInput(), eventContext: EVENT_CONTEXT };
    const first = fx.emittedService.accumulate(input);
    const replay = fx.emittedService.accumulate(input);
    assert.deepEqual(replay, first);
    assert.equal(count(fx.db, 'SELECT COUNT(*) AS c FROM memory_verified_facts'), 1);
    assert.equal(count(fx.db, "SELECT COUNT(*) AS c FROM runtime_events WHERE type='memory.candidate_created'"), 1);
    assert.equal(count(fx.db, `SELECT COUNT(*) AS c FROM outbox_messages o
      JOIN runtime_events e ON e.id=o.event_id WHERE e.type='memory.candidate_created'`), 1);
    const receipt = fx.db.prepare('SELECT candidate_id,entry_id FROM memory_verified_facts WHERE id=?').get(first.id) as {
      candidate_id: string; entry_id: string | null;
    };
    assert.equal(receipt.candidate_id, first.candidateId);
    assert.equal(receipt.entry_id, first.entryId);
  } finally { fx.close(); }
});
