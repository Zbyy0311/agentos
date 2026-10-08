import { createHash } from 'node:crypto';
import type { RuntimeEventContextAuthoritySourceV1 } from '@agentos/shared';
import { MemoryCandidateRepository, type CreateMemoryCandidateInput, type MemoryCandidateRecord } from '../store/MemoryCandidateRepository.js';
import { areMemoryTextFieldsSafe } from '../store/MemoryContentSafety.js';
import { inTransaction, type TransactionDatabase } from '../store/Transaction.js';
import type { MemoryRuntimeEventEmitter } from './MemoryRuntimeEventEmitter.js';

export const VERIFIED_MEMORY_FACT_SOURCE_KINDS = ['failure-code', 'environment', 'test-result'] as const;
export type VerifiedMemoryFactSourceKind = typeof VERIFIED_MEMORY_FACT_SOURCE_KINDS[number];
export const COLLABORATION_ACCEPTANCE_RUNNER_VERSION = 'collaboration-acceptance.v1' as const;

/** The caller supplies only an identity for a durable source, never fact content or trust metadata. */
export interface VerifiedMemoryFactInput {
  readonly workspaceId: string;
  readonly sourceKind: VerifiedMemoryFactSourceKind;
  /** Run id, runtime_process id, or collaboration_candidate id, according to sourceKind. */
  readonly sourceId: string;
  readonly createdAt: string;
  /** Required when an emitter is configured; authority is re-proven by the emitter in the write transaction. */
  readonly eventContext?: RuntimeEventContextAuthoritySourceV1;
}

export interface VerifiedMemoryFact {
  readonly id: string;
  readonly workspaceId: string;
  readonly candidateId: string;
  readonly entryId: string | null;
  readonly decision: 'auto-accept' | 'review-required';
  readonly evidenceHash: string;
}

export interface VerifiedMemoryAutoAcceptPolicy {
  readonly enabled: boolean;
  /** Version 0 means no override exists; the bounded low-risk fact policy is enabled. */
  readonly version: number;
}

interface Evidence {
  readonly runId: string;
  readonly taskId: string;
  readonly environmentId: string;
  readonly commitId?: string;
  readonly outcome: string;
  readonly title: string;
  readonly content: string;
  readonly category: 'failure' | 'environment' | 'test';
  readonly key: string;
  readonly sources: readonly { readonly kind: 'run' | 'artifact'; readonly id: string }[];
}

interface FactRow {
  id: string;
  workspace_id: string;
  source_kind: string;
  source_id: string;
  evidence_hash: string;
  outcome_hash: string;
  environment_id: string;
  commit_id: string | null;
  fact_key: string;
  candidate_id: string;
  entry_id: string | null;
  decision: 'auto-accept' | 'review-required';
}

interface DecisionSignals {
  readonly policy: VerifiedMemoryAutoAcceptPolicy;
  readonly conflictingEvidence: boolean;
  readonly exactEntryId: string | undefined;
  readonly nearEntryId: string | undefined;
}

const FAILURE_CODES = new Set([
  'PROVIDER_AUTH_REQUIRED', 'PROVIDER_NOT_FOUND', 'PROVIDER_TIMEOUT', 'PROVIDER_OUTPUT_INVALID',
  'PROVIDER_PROCESS_FAILED', 'STAGE_TIMEOUT', 'PROCESS_SPAWN_FAILED', 'PROVIDER_START_FAILED',
  'TEST_FAILED',
]);
const RUNTIME_PLATFORMS = new Set(['aix', 'android', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32']);
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const stableHash = (value: unknown): string => sha256(JSON.stringify(value));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const nonBlank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function assertInput(value: unknown, emitterConfigured: boolean): asserts value is VerifiedMemoryFactInput {
  if (!isRecord(value)) throw new Error('MEMORY_FACT_INPUT_INVALID');
  const allowed = new Set(['workspaceId', 'sourceKind', 'sourceId', 'createdAt', 'eventContext']);
  if (Object.keys(value).some(key => !allowed.has(key))
    || !nonBlank(value.workspaceId) || !nonBlank(value.sourceId)
    || !(VERIFIED_MEMORY_FACT_SOURCE_KINDS as readonly unknown[]).includes(value.sourceKind)
    || typeof value.createdAt !== 'string' || value.createdAt.length > 40 || !Number.isFinite(Date.parse(value.createdAt))
    || (emitterConfigured && !isRecord(value.eventContext))) {
    throw new Error('MEMORY_FACT_INPUT_INVALID');
  }
}

function sameSignals(left: DecisionSignals, right: DecisionSignals): boolean {
  return left.policy.version === right.policy.version
    && left.policy.enabled === right.policy.enabled
    && left.conflictingEvidence === right.conflictingEvidence
    && left.exactEntryId === right.exactEntryId
    && left.nearEntryId === right.nearEntryId;
}

/**
 * Turns a small whitelist of durable Run/runtime/collaboration facts into
 * task-scoped Memory Candidates. Every other inference stays in the ordinary
 * review-required candidate flow.
 */
export class VerifiedMemoryFactService {
  private readonly candidates: MemoryCandidateRepository;

  constructor(
    private readonly db: TransactionDatabase,
    private readonly emitter?: MemoryRuntimeEventEmitter,
  ) {
    this.candidates = new MemoryCandidateRepository(db);
  }

  policy(workspaceId: string): VerifiedMemoryAutoAcceptPolicy {
    this.assertWorkspace(workspaceId);
    return this.readPolicy(workspaceId);
  }

  /** Workspace-scoped compare-and-swap; disabling it always routes facts to review. */
  setPolicy(workspaceId: string, expectedVersion: number, enabled: boolean): VerifiedMemoryAutoAcceptPolicy {
    if (!nonBlank(workspaceId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || typeof enabled !== 'boolean') {
      throw new Error('MEMORY_POLICY_INPUT_INVALID');
    }
    return inTransaction(this.db, () => {
      this.assertWorkspace(workspaceId);
      const current = this.readPolicy(workspaceId);
      if (current.version !== expectedVersion) throw new Error('MEMORY_POLICY_VERSION_CONFLICT');
      const now = new Date().toISOString();
      if (current.version === 0) {
        this.db.prepare(`INSERT INTO memory_auto_accept_policy(workspace_id,enabled,version,updated_at)
          VALUES(?,?,1,?)`).run(workspaceId, enabled ? 1 : 0, now);
      } else {
        const changed = this.db.prepare(`UPDATE memory_auto_accept_policy SET enabled=?,version=version+1,updated_at=?
          WHERE workspace_id=? AND version=?`).run(enabled ? 1 : 0, now, workspaceId, expectedVersion) as { changes?: number | bigint };
        if (Number(changed.changes ?? 0) !== 1) throw new Error('MEMORY_POLICY_VERSION_CONFLICT');
      }
      return this.readPolicy(workspaceId);
    });
  }

  accumulate(input: VerifiedMemoryFactInput): VerifiedMemoryFact {
    assertInput(input, this.emitter !== undefined);
    const evidence = this.readEvidence(input);
    this.assertMemoryEnabled(input.workspaceId);
    const evidenceHash = this.evidenceHash(evidence);
    const priorSource = this.findSourceReceipt(input);
    if (priorSource !== undefined) {
      if (priorSource.evidence_hash !== evidenceHash) throw new Error('MEMORY_FACT_SOURCE_CHANGED');
      return this.toFact(priorSource);
    }

    // Repeated independent sources for the exact same fact converge to the
    // first durable receipt and Candidate, rather than creating another Entry.
    const exactReceipt = this.findExactReceipt(input.workspaceId, evidence, evidenceHash);
    if (exactReceipt !== undefined) return this.aliasReceipt(input, evidenceHash, exactReceipt);

    const signals = this.decisionSignals(input.workspaceId, evidence, evidenceHash);
    const candidateInput = this.makeCandidateInput(input, evidence, evidenceHash, signals);
    try {
      if (this.emitter === undefined) {
        return inTransaction(this.db, () => {
          this.assertUnchanged(input, evidence, evidenceHash, signals);
          const record = this.candidates.createCandidateWithinTransaction(candidateInput);
          return this.insertReceipt(input, evidence, evidenceHash, record);
        });
      }

      this.emitter.emitCandidateCreated({
        ...candidateInput,
        runId: evidence.runId,
        eventContext: input.eventContext!,
        timestamp: input.createdAt,
      }, record => {
        // The emitter invokes this callback after Candidate, related Entry,
        // Runtime Event, and Outbox writes, but before COMMIT. Rechecking the
        // source and workspace policy here closes the preflight/commit race.
        this.assertUnchanged(input, evidence, evidenceHash, signals, record.id);
        this.insertReceipt(input, evidence, evidenceHash, record);
      });
      const receipt = this.findSourceReceipt(input);
      if (receipt === undefined) throw new Error('MEMORY_FACT_RECEIPT_MISSING');
      return this.toFact(receipt);
    } catch (error) {
      // Two same-source or exact-fact calls can race before either obtains the
      // SQLite write lock. The winner committed its deterministic receipt with
      // the Candidate/Event; a loser returns that durable winner.
      const sameSource = this.findSourceReceipt(input);
      if (sameSource !== undefined) {
        if (sameSource.evidence_hash !== evidenceHash) throw new Error('MEMORY_FACT_SOURCE_CHANGED');
        return this.toFact(sameSource);
      }
      const exactWinner = this.findExactReceipt(input.workspaceId, evidence, evidenceHash);
      if (exactWinner !== undefined) return this.aliasReceipt(input, evidenceHash, exactWinner);
      throw error;
    }
  }

  /**
   * Optional terminal-run hook for the generator/runtime parent. Only known,
   * durable sources are attempted; unsupported source rows are skipped.
   */
  accumulateTerminal(input: {
    readonly workspaceId: string;
    readonly runId: string;
    readonly createdAt: string;
    readonly eventContext?: RuntimeEventContextAuthoritySourceV1;
  }): readonly VerifiedMemoryFact[] {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.runId) || !Number.isFinite(Date.parse(input.createdAt))) {
      throw new Error('MEMORY_FACT_INPUT_INVALID');
    }
    this.assertWorkspace(input.workspaceId);
    if (!this.isMemoryEnabled(input.workspaceId)) return [];
    const terminal = this.db.prepare('SELECT status,failure_code FROM runs WHERE workspace_id=? AND id=?')
      .get(input.workspaceId, input.runId) as { status: string; failure_code: string | null } | undefined;
    if (terminal === undefined || !['completed', 'failed', 'cancelled'].includes(terminal.status)) return [];

    const facts: VerifiedMemoryFact[] = [];
    const attempt = (sourceKind: VerifiedMemoryFactSourceKind, sourceId: string) => {
      try {
        facts.push(this.accumulate({
          workspaceId: input.workspaceId, sourceKind, sourceId, createdAt: input.createdAt,
          ...(input.eventContext === undefined ? {} : { eventContext: input.eventContext }),
        }));
      } catch (error) {
        if (error instanceof Error && error.message === 'MEMORY_FACT_SOURCE_INVALID') return;
        throw error;
      }
    };
    if (terminal.status === 'failed' && FAILURE_CODES.has(terminal.failure_code ?? '')) {
      attempt('failure-code', input.runId);
    }
    const processes = this.db.prepare(`SELECT p.id FROM runtime_processes p
      JOIN provider_sessions s ON s.id=p.provider_session_id AND s.workspace_id=p.workspace_id
        AND s.task_id=p.task_id AND s.run_id=p.run_id AND s.stage_id=p.stage_id AND s.stage_attempt=p.stage_attempt
      WHERE p.workspace_id=? AND p.run_id=? AND p.process_type='provider' AND p.authority_role='primary-provider'
        AND p.status='exited' AND p.exit_code=0 AND p.exited_at IS NOT NULL
        AND s.authority_role='primary-provider' AND s.status='completed' AND s.completed_at IS NOT NULL
      ORDER BY p.id`).all(input.workspaceId, input.runId) as Array<{ id: string }>;
    for (const process of processes) attempt('environment', process.id);
    const candidates = this.db.prepare(`SELECT c.id FROM collaboration_candidates c
      JOIN collaboration_tasks t ON t.id=c.collaboration_task_id AND t.workspace_id=c.workspace_id
      WHERE c.workspace_id=? AND c.canonical_run_id=? AND t.canonical_run_id=c.canonical_run_id
        AND c.test_status IN ('passed','failed') ORDER BY c.id`).all(input.workspaceId, input.runId) as Array<{ id: string }>;
    for (const candidate of candidates) attempt('test-result', candidate.id);
    return facts;
  }

  private readPolicy(workspaceId: string): VerifiedMemoryAutoAcceptPolicy {
    const row = this.db.prepare('SELECT enabled,version FROM memory_auto_accept_policy WHERE workspace_id=?')
      .get(workspaceId) as { enabled: number; version: number } | undefined;
    return { enabled: row === undefined || row.enabled === 1, version: row?.version ?? 0 };
  }

  private readEvidence(input: VerifiedMemoryFactInput): Evidence {
    if (input.sourceKind === 'failure-code') {
      const run = this.db.prepare(`SELECT r.task_id,r.failure_code,s.content_hash FROM runs r
        JOIN run_snapshots s ON s.run_id=r.id AND s.workspace_id=r.workspace_id
        WHERE r.workspace_id=? AND r.id=? AND r.status='failed'`).get(input.workspaceId, input.sourceId) as
        { task_id: string; failure_code: string | null; content_hash: string } | undefined;
      const event = this.db.prepare(`SELECT id FROM runtime_events WHERE workspace_id=? AND run_id=? AND task_id=?
        AND type='run.failed' AND durability='durable' ORDER BY sequence DESC LIMIT 1`)
        .get(input.workspaceId, input.sourceId, run?.task_id ?? '') as { id: string } | undefined;
      if (!run || !event || !FAILURE_CODES.has(run.failure_code ?? '') || !/^[a-f0-9]{64}$/i.test(run.content_hash)) {
        throw new Error('MEMORY_FACT_SOURCE_INVALID');
      }
      const environmentId = sha256(`snapshot:${run.content_hash}`).slice(0, 24);
      return {
        runId: input.sourceId, taskId: run.task_id, environmentId, category: 'failure', key: 'failure-code',
        outcome: run.failure_code!,
        title: 'Verified execution failure code',
        content: `Execution failed with whitelisted code ${run.failure_code}. Frozen Run snapshot identity: ${environmentId}.`,
        sources: [{ kind: 'run', id: input.sourceId }],
      };
    }

    if (input.sourceKind === 'environment') {
      const process = this.db.prepare(`SELECT p.id,p.workspace_id,p.task_id,p.run_id,p.platform,
          p.executable_fingerprint,p.cwd_resolved,p.provider_session_id
        FROM runtime_processes p
        JOIN runs r ON r.id=p.run_id AND r.workspace_id=p.workspace_id AND r.task_id=p.task_id
        JOIN provider_sessions s ON s.id=p.provider_session_id AND s.workspace_id=p.workspace_id
          AND s.task_id=p.task_id AND s.run_id=p.run_id AND s.stage_id=p.stage_id AND s.stage_attempt=p.stage_attempt
        WHERE p.workspace_id=? AND p.id=? AND p.process_type='provider' AND p.authority_role='primary-provider'
          AND p.status='exited' AND p.exit_code=0 AND p.exited_at IS NOT NULL
          AND s.authority_role='primary-provider' AND s.status='completed' AND s.completed_at IS NOT NULL`)
        .get(input.workspaceId, input.sourceId) as {
          id: string; workspace_id: string; task_id: string; run_id: string; platform: string;
          executable_fingerprint: string | null; cwd_resolved: string; provider_session_id: string;
        } | undefined;
      if (!process || !RUNTIME_PLATFORMS.has(process.platform.toLowerCase()) || !nonBlank(process.provider_session_id)
        || !nonBlank(process.cwd_resolved)) throw new Error('MEMORY_FACT_SOURCE_INVALID');
      const environmentId = stableHash([
        process.workspace_id, process.platform.toLowerCase(), process.executable_fingerprint, process.cwd_resolved,
      ]).slice(0, 24);
      return {
        runId: process.run_id, taskId: process.task_id, environmentId, category: 'environment', key: 'runtime-platform',
        outcome: process.platform.toLowerCase(),
        title: 'Verified runtime platform',
        content: `Observed runtime platform ${process.platform.toLowerCase()}; environment identity ${environmentId}.`,
        sources: [{ kind: 'run', id: process.run_id }],
      };
    }

    const candidate = this.db.prepare(`SELECT c.*,r.task_id AS run_task_id,r.status AS run_status,
        t.acceptance_commands_json,t.canonical_run_id AS task_run_id,t.canonical_task_id AS task_task_id,
        rr.candidate_id AS receipt_candidate_id,rr.workspace_id AS receipt_workspace_id,
        rr.run_id AS receipt_run_id,rr.commit_id AS receipt_commit_id,rr.result AS receipt_result,
        rr.exit_code AS receipt_exit_code,rr.output_sha256 AS receipt_output_sha256,
        rr.runner_version AS receipt_runner_version
      FROM collaboration_candidates c
      JOIN collaboration_tasks t ON t.id=c.collaboration_task_id AND t.workspace_id=c.workspace_id
      JOIN runs r ON r.id=c.canonical_run_id AND r.workspace_id=c.workspace_id
      JOIN memory_test_runner_receipts rr ON rr.candidate_id=c.id AND rr.workspace_id=c.workspace_id
      WHERE c.workspace_id=? AND c.id=? AND t.canonical_run_id=c.canonical_run_id`)
      .get(input.workspaceId, input.sourceId) as Record<string, unknown> | undefined;
    if (!candidate || !['completed', 'failed'].includes(String(candidate.run_status))
      || candidate.run_task_id !== candidate.task_task_id
      || !['passed', 'failed'].includes(String(candidate.test_status))
      || !Number.isSafeInteger(candidate.test_exit_code)
      || (candidate.test_status === 'passed') !== (candidate.test_exit_code === 0)
      || typeof candidate.test_output !== 'string' || !nonBlank(candidate.test_output)
      || typeof candidate.test_command !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(String(candidate.head_commit))
      || typeof candidate.diff_text !== 'string' || sha256(candidate.diff_text) !== candidate.diff_hash
      || candidate.snapshot_version !== 2
      || candidate.receipt_candidate_id !== candidate.id || candidate.receipt_workspace_id !== input.workspaceId
      || candidate.receipt_run_id !== candidate.canonical_run_id
      || String(candidate.receipt_commit_id).toLowerCase() !== String(candidate.head_commit).toLowerCase()
      || candidate.receipt_result !== candidate.test_status || candidate.receipt_exit_code !== candidate.test_exit_code
      || !/^[a-f0-9]{64}$/i.test(String(candidate.receipt_output_sha256))
      || String(candidate.receipt_runner_version) !== COLLABORATION_ACCEPTANCE_RUNNER_VERSION
      || sha256(candidate.test_output).toLowerCase() !== String(candidate.receipt_output_sha256).toLowerCase()) {
      throw new Error('MEMORY_FACT_SOURCE_INVALID');
    }
    let manifest: unknown;
    try { manifest = JSON.parse(String(candidate.manifest_json)); } catch { throw new Error('MEMORY_FACT_SOURCE_INVALID'); }
    if (!Array.isArray(manifest) || manifest.some(item => !isRecord(item)
      || typeof item.path !== 'string' || !Number.isSafeInteger(item.sizeBytes) || Number(item.sizeBytes) < 0
      || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256))) {
      throw new Error('MEMORY_FACT_SOURCE_INVALID');
    }
    const manifestHash = sha256(String(candidate.manifest_json));
    let commands: unknown;
    try { commands = JSON.parse(String(candidate.acceptance_commands_json)); } catch { throw new Error('MEMORY_FACT_SOURCE_INVALID'); }
    if (!Array.isArray(commands) || commands.length === 0 || commands.some(command => !nonBlank(command))
      || candidate.test_command !== commands.join(' && ')) throw new Error('MEMORY_FACT_SOURCE_INVALID');

    const environmentId = sha256(`${input.workspaceId}:${String(candidate.head_commit).toLowerCase()}`).slice(0, 24);
    const commandHash = sha256(candidate.test_command);
    const key = `collaboration-acceptance:${commandHash}`;
    const outcome = candidate.test_status;
    const exitCode = candidate.test_exit_code;
    const runnerOutputHash = String(candidate.receipt_output_sha256).toLowerCase();
    return {
      runId: String(candidate.canonical_run_id), taskId: String(candidate.run_task_id), environmentId,
      commitId: String(candidate.head_commit).toLowerCase(), category: 'test', key,
      outcome: `${String(outcome)}:${String(exitCode)}`,
      title: 'Verified collaboration acceptance result',
      content: `Server-executed collaboration acceptance tests ${outcome}; exit code ${exitCode}; runner receipt ${COLLABORATION_ACCEPTANCE_RUNNER_VERSION}; output sha256 ${runnerOutputHash}; commit ${String(candidate.head_commit).toLowerCase()}; command hash ${commandHash}; diff ${String(candidate.diff_hash).toLowerCase()}; manifest ${manifestHash}.`,
      sources: [{ kind: 'run', id: String(candidate.canonical_run_id) }],
    };
  }

  private evidenceHash(evidence: Evidence): string {
    // Source ids and timestamps are receipts/provenance, not part of fact
    // identity. Equivalent facts from independent durable sources converge.
    return stableHash({
      taskId: evidence.taskId, environmentId: evidence.environmentId, commitId: evidence.commitId ?? null,
      title: evidence.title, content: evidence.content, category: evidence.category, key: evidence.key,
    });
  }

  private outcomeHash(evidence: Evidence): string {
    return stableHash(evidence.outcome);
  }

  private decisionSignals(
    workspaceId: string,
    evidence: Evidence,
    evidenceHash: string,
    excludeEntryId?: string,
  ): DecisionSignals {
    const conflict = this.db.prepare(`SELECT 1 AS present FROM memory_verified_facts
      WHERE workspace_id=? AND fact_key=? AND environment_id=? AND COALESCE(commit_id,'')=COALESCE(?,'')
        AND outcome_hash<>? LIMIT 1`)
      .get(workspaceId, evidence.key, evidence.environmentId, evidence.commitId ?? null, this.outcomeHash(evidence)) as { present: number } | undefined;
    const exactEntry = this.db.prepare(`SELECT id FROM memory_entries WHERE workspace_id=? AND status='active'
      AND scope='task' AND category=? AND owner_task_id=? AND owner_agent_id IS NULL
      AND owner_conversation_id IS NULL AND owner_run_id IS NULL AND exact_content_hash=?
      AND (? IS NULL OR id<>?) ORDER BY id LIMIT 1`)
      .get(workspaceId, evidence.category, evidence.taskId, sha256(evidence.content), excludeEntryId ?? null, excludeEntryId ?? null) as { id: string } | undefined;
    const exactEntryId = exactEntry?.id;
    const normalized = evidence.content.toLowerCase().replace(/\s+/gu, ' ').trim();
    const nearEntry = this.db.prepare(`SELECT id FROM memory_entries WHERE workspace_id=? AND status='active'
      AND scope='task' AND category=? AND owner_task_id=? AND owner_agent_id IS NULL
      AND owner_conversation_id IS NULL AND owner_run_id IS NULL AND normalized_text_hash=?
      AND (? IS NULL OR id<>?) ORDER BY id LIMIT 1`)
      .get(workspaceId, evidence.category, evidence.taskId, sha256(normalized), excludeEntryId ?? null, excludeEntryId ?? null) as { id: string } | undefined;
    const nearEntryId = nearEntry?.id;
    return {
      policy: this.readPolicy(workspaceId), conflictingEvidence: conflict !== undefined,
      exactEntryId, nearEntryId,
    };
  }

  private makeCandidateInput(
    input: VerifiedMemoryFactInput,
    evidence: Evidence,
    evidenceHash: string,
    signals: DecisionSignals,
  ): CreateMemoryCandidateInput {
    if (!areMemoryTextFieldsSafe([evidence.title, evidence.content])) throw new Error('MEMORY_FACT_SOURCE_INVALID');
    const candidateId = `mcand_fact_${sha256(`${input.workspaceId}:${input.sourceKind}:${input.sourceId}:${evidenceHash}`).slice(0, 32)}`;
    const sources = [...evidence.sources, { kind: 'run' as const, id: evidence.runId }]
      .filter((source, index, all) => all.findIndex(item => item.kind === source.kind && item.id === source.id) === index);
    return {
      id: candidateId, workspaceId: input.workspaceId, scope: 'task', ownerTaskId: evidence.taskId,
      category: evidence.category, authority: 'system-verified', confidence: 1, importance: 0.6,
      title: evidence.title, content: evidence.content,
      summary: `Durable ${input.sourceKind} evidence; environment ${evidence.environmentId}.`,
      tags: ['verified-fact', `environment:${evidence.environmentId}`],
      exactContentHash: sha256(evidence.content),
      normalizedTextHash: sha256(evidence.content.toLowerCase().replace(/\s+/gu, ' ').trim()),
      tokenEstimate: Math.ceil(evidence.content.length / 4), sources, createdAt: input.createdAt,
      minConfidence: 0.9, maxTokenEstimate: 2000,
      hasUnresolvedConflict: signals.conflictingEvidence || !signals.policy.enabled,
      // Existing exact/near Entries are inspected, but stay review-required
      // until a reviewer can explicitly converge them.
      duplicateResolved: signals.exactEntryId === undefined && signals.nearEntryId === undefined,
    };
  }

  private assertUnchanged(
    input: VerifiedMemoryFactInput,
    expected: Evidence,
    expectedHash: string,
    signals: DecisionSignals,
    excludeEntryId?: string,
  ): void {
    this.assertMemoryEnabled(input.workspaceId);
    const current = this.readEvidence(input);
    if (this.evidenceHash(current) !== expectedHash) throw new Error('MEMORY_FACT_SOURCE_CHANGED');
    if (!sameSignals(this.decisionSignals(input.workspaceId, current, expectedHash, excludeEntryId), signals)) {
      throw new Error('MEMORY_FACT_DECISION_CHANGED');
    }
    const sourceReceipt = this.findSourceReceipt(input);
    if (sourceReceipt !== undefined) throw new Error('MEMORY_FACT_REPLAY_RACE');
    if (this.findExactReceipt(input.workspaceId, expected, expectedHash) !== undefined) {
      throw new Error('MEMORY_FACT_EXACT_RACE');
    }
  }

  private findSourceReceipt(input: VerifiedMemoryFactInput): FactRow | undefined {
    return this.db.prepare(`SELECT * FROM memory_verified_facts
      WHERE workspace_id=? AND source_kind=? AND source_id=? ORDER BY created_at,id LIMIT 1`)
      .get(input.workspaceId, input.sourceKind, input.sourceId) as FactRow | undefined;
  }

  private findExactReceipt(workspaceId: string, evidence: Evidence, evidenceHash: string): FactRow | undefined {
    return this.db.prepare(`SELECT * FROM memory_verified_facts WHERE workspace_id=? AND fact_key=?
      AND environment_id=? AND COALESCE(commit_id,'')=COALESCE(?,'') AND evidence_hash=?
      ORDER BY created_at,id LIMIT 1`)
      .get(workspaceId, evidence.key, evidence.environmentId, evidence.commitId ?? null, evidenceHash) as FactRow | undefined;
  }

  private aliasReceipt(input: VerifiedMemoryFactInput, evidenceHash: string, winner: FactRow): VerifiedMemoryFact {
    return inTransaction(this.db, () => {
      this.assertMemoryEnabled(input.workspaceId);
      const evidence = this.readEvidence(input);
      if (this.evidenceHash(evidence) !== evidenceHash) throw new Error('MEMORY_FACT_SOURCE_CHANGED');
      const current = this.findSourceReceipt(input);
      if (current !== undefined) {
        if (current.evidence_hash !== evidenceHash) throw new Error('MEMORY_FACT_SOURCE_CHANGED');
        return this.toFact(current);
      }
      const exactWinner = this.findExactReceipt(input.workspaceId, evidence, evidenceHash);
      if (exactWinner === undefined || exactWinner.id !== winner.id) throw new Error('MEMORY_FACT_EXACT_RACE');
      this.insertReceiptRow(input, evidenceHash, winner.candidate_id, winner.entry_id, winner.decision);
      const receipt = this.findSourceReceipt(input);
      if (receipt === undefined) throw new Error('MEMORY_FACT_RECEIPT_MISSING');
      return this.toFact(receipt);
    });
  }

  private insertReceipt(
    input: VerifiedMemoryFactInput,
    evidence: Evidence,
    evidenceHash: string,
    candidate: MemoryCandidateRecord,
  ): VerifiedMemoryFact {
    const decision = candidate.decision === 'auto-accept' ? 'auto-accept' : 'review-required';
    this.insertReceiptRow(input, evidenceHash, candidate.id, candidate.mergedIntoEntryId, decision, evidence);
    const receipt = this.findSourceReceipt(input);
    if (receipt === undefined) throw new Error('MEMORY_FACT_RECEIPT_MISSING');
    return this.toFact(receipt);
  }

  private insertReceiptRow(
    input: VerifiedMemoryFactInput,
    evidenceHash: string,
    candidateId: string,
    entryId: string | null,
    decision: VerifiedMemoryFact['decision'],
    evidence?: Evidence,
  ): void {
    const fact = evidence ?? this.readEvidence(input);
    const id = `mfact_${sha256(`${input.workspaceId}:${input.sourceKind}:${input.sourceId}:${evidenceHash}`).slice(0, 40)}`;
    this.db.prepare(`INSERT INTO memory_verified_facts(
      id,workspace_id,source_kind,source_id,evidence_hash,outcome_hash,environment_id,commit_id,fact_key,candidate_id,entry_id,decision,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, input.workspaceId, input.sourceKind, input.sourceId, evidenceHash, this.outcomeHash(fact), fact.environmentId,
      fact.commitId ?? null, fact.key, candidateId, entryId, decision, input.createdAt,
    );
  }

  private assertWorkspace(workspaceId: string): void {
    if (!nonBlank(workspaceId) || this.db.prepare('SELECT 1 AS present FROM workspaces WHERE id=?').get(workspaceId) === undefined) {
      throw new Error('MEMORY_WORKSPACE_NOT_FOUND');
    }
  }

  private assertMemoryEnabled(workspaceId: string): void {
    this.assertWorkspace(workspaceId);
    if (!this.isMemoryEnabled(workspaceId)) throw new Error('MEMORY_FACT_MEMORY_DISABLED');
  }

  private isMemoryEnabled(workspaceId: string): boolean {
    const row = this.db.prepare('SELECT memory_enabled FROM workspaces WHERE id=?').get(workspaceId) as
      { memory_enabled: number } | undefined;
    return row?.memory_enabled === 1;
  }

  private toFact(row: FactRow): VerifiedMemoryFact {
    return {
      id: row.id, workspaceId: row.workspace_id, candidateId: row.candidate_id,
      entryId: row.entry_id, decision: row.decision, evidenceHash: row.evidence_hash,
    };
  }
}
