import type { SqliteStore } from '../store/SqliteStore.js';
import { inTransaction, isTransactionActive } from '../store/Transaction.js';
import { createEntityId } from '../store/Identity.js';
import { isCanonicalUtcTimestamp } from '../store/CanonicalTimestamp.js';
import { ArtifactCompletionRepository, ArtifactCompletionRepositoryError, isArtifactConclusion,
  type ArtifactCompletionRecord } from '../store/ArtifactCompletionRepository.js';
import { MemoryCandidateRepository, type MemoryCandidateRecord } from '../store/MemoryCandidateRepository.js';
import { deriveWorkspaceEventContext } from '../store/WorkspaceEventWriter.js';
import { MemoryRuntimeEventEmitter } from './MemoryRuntimeEventEmitter.js';
import { DurableMemoryRuntimeEventContextAuthority } from './MemoryRuntimeEventContextAuthority.js';
import { hashMemoryText, normalizeMemoryText } from './MemoryCandidateGenerationService.js';

export interface CompleteArtifactInput {
  workspaceId: string; artifactId: string; conclusion: unknown;
  sourceKey: string; decidedAt: string;
  /** Optional assertions from an existing client; never authority. */
  artifactType?: unknown; runId?: unknown;
}
export interface ArtifactCompletionResult {
  completion: ArtifactCompletionRecord; candidate: MemoryCandidateRecord; converged: boolean;
}
interface ArtifactSource {
  artifactType: string; runId: string | null; provenanceKind: 'LEGACY' | 'CANONICAL';
  operationId: string | null;
}

export class ArtifactCompletionService {
  private readonly completions: ArtifactCompletionRepository;
  private readonly candidates: MemoryCandidateRepository;
  private readonly emitter: MemoryRuntimeEventEmitter;
  constructor(private readonly store: SqliteStore) {
    const db = store.getDatabase();
    this.completions = new ArtifactCompletionRepository(db);
    this.candidates = new MemoryCandidateRepository(db);
    this.emitter = new MemoryRuntimeEventEmitter({ store, factWriter: store.runtimeEventOutboxWriter(),
      eventAuthority: new DurableMemoryRuntimeEventContextAuthority(db) });
  }
  complete(input: CompleteArtifactInput): ArtifactCompletionResult {
    return inTransaction(this.store.getDatabase(), () => this.completeWithinTransaction(input));
  }
  completeWithinTransaction(input: CompleteArtifactInput): ArtifactCompletionResult {
    const db = this.store.getDatabase();
    if (!isTransactionActive(db) || !input ||
      [input.workspaceId, input.artifactId, input.sourceKey].some(v => typeof v !== 'string' || !v.trim()) ||
      input.sourceKey.length > 256 || !isCanonicalUtcTimestamp(input.decidedAt)) {
      throw new ArtifactCompletionRepositoryError('INPUT_INVALID');
    }
    const source = db.prepare(`SELECT artifact_type AS artifactType, canonical_run_id AS runId,
      provenance_kind AS provenanceKind, source_operation_id AS operationId
      FROM runtime_artifacts WHERE workspace_id = ? AND id = ?`).get(input.workspaceId, input.artifactId) as ArtifactSource | undefined;
    if (!source) throw new ArtifactCompletionRepositoryError('NOT_FOUND');
    if (!isArtifactConclusion(source.artifactType, input.conclusion) ||
      (input.artifactType !== undefined && input.artifactType !== source.artifactType) ||
      (input.runId !== undefined && input.runId !== source.runId)) {
      throw new ArtifactCompletionRepositoryError('INPUT_INVALID');
    }
    const existing = this.completions.findByArtifact(input.workspaceId, input.artifactId)
      ?? this.completions.findBySourceKey(input.workspaceId, input.sourceKey);
    if (existing) {
      if (existing.artifactId !== input.artifactId || existing.conclusion !== input.conclusion || existing.sourceKey !== input.sourceKey) {
        throw new ArtifactCompletionRepositoryError('CONFLICT');
      }
      const candidate = this.candidates.findCandidateById(input.workspaceId, existing.candidateId);
      if (!candidate) throw new ArtifactCompletionRepositoryError('SOURCE_INVALID');
      return { completion: existing, candidate, converged: true };
    }
    // The bounded evidence is the typed conclusion and source identity, never
    // raw provider output, command text or an assumed user assertion.
    const content = `${source.artifactType}: ${input.conclusion}\nArtifact: ${input.artifactId}`;
    const candidate = this.candidates.createCandidateWithinTransaction({
      id: createEntityId('memoryCandidate'), workspaceId: input.workspaceId,
      scope: 'workspace', category: 'decision', authority: 'agent-derived', confidence: 0.6, importance: 0.5,
      title: `${source.artifactType} result: ${input.conclusion}`, content,
      summary: `${source.artifactType} Artifact completed: ${input.conclusion}`,
      exactContentHash: hashMemoryText(content), normalizedTextHash: hashMemoryText(normalizeMemoryText(content)),
      tokenEstimate: Math.max(1, Math.ceil(content.length / 4)), minConfidence: 0.9, maxTokenEstimate: 4000,
      sources: [{ kind: 'artifact', id: input.artifactId }, ...(source.runId === null ? [] : [{ kind: 'run' as const, id: source.runId }])],
      createdAt: input.decidedAt,
    });
    const completion = this.completions.recordWithinTransaction({
      id: createEntityId('artifact'), workspaceId: input.workspaceId, artifactId: input.artifactId,
      artifactType: source.artifactType as 'review' | 'test', runId: source.runId, conclusion: input.conclusion,
      candidateId: candidate.id, sourceKey: input.sourceKey, decidedAt: input.decidedAt, createdAt: input.decidedAt,
    });
    if (source.provenanceKind === 'LEGACY' && source.runId === null) {
      const origin = { kind: 'memory.artifact_completion', completionId: completion.id } as const;
      this.store.workspaceEventWriter().appendWithinTransaction({ type: 'memory.candidate_created',
        workspaceId: input.workspaceId, timestamp: input.decidedAt, origin, context: deriveWorkspaceEventContext(origin),
        payload: { candidateId: candidate.id, scope: candidate.scope, category: candidate.category,
          authority: candidate.authority, decision: candidate.decision! } });
    } else {
      if (source.runId === null) throw new ArtifactCompletionRepositoryError('SOURCE_INVALID');
      const operation = source.operationId === null
        ? db.prepare("SELECT id, correlation_id AS correlationId FROM operations WHERE workspace_id = ? AND run_id = ? AND type = 'run.start' ORDER BY created_at, id LIMIT 1")
          .get(input.workspaceId, source.runId)
        : db.prepare('SELECT id, correlation_id AS correlationId FROM operations WHERE workspace_id = ? AND run_id = ? AND id = ?')
          .get(input.workspaceId, source.runId, source.operationId);
      const proven = operation as { id: string; correlationId: string } | undefined;
      if (!proven) throw new ArtifactCompletionRepositoryError('SOURCE_INVALID');
      this.emitter.emitPersistedCandidateWithinTransaction({ workspaceId: input.workspaceId,
        runId: source.runId, candidateId: candidate.id, completionId: completion.id, timestamp: input.decidedAt,
        eventContext: { origin: 'operation', operationId: proven.id,
          context: { correlationId: proven.correlationId, causationId: proven.id } } });
    }
    return { completion, candidate, converged: false };
  }
}
