import { createHash } from 'node:crypto';
import { areMemoryTextFieldsSafe } from '../store/MemoryContentSafety.js';
import type { MemoryEntryRecord } from '../store/MemoryEntryRepository.js';
import type { TransactionDatabase } from '../store/Transaction.js';
import type { RetrievedMemoryEntry } from './MemoryRetrievalService.js';

const MAX_VECTOR_DIMENSIONS = 8192;
const PREPARE_BATCH_SIZE = 32;
const HYBRID_SEMANTIC_WEIGHT = 0.65;
const HYBRID_BASELINE_WEIGHT = 0.35;
const RETRIEVABLE_STATUSES = new Set(['candidate', 'active', 'conflicted']);

export type MemorySemanticReason =
  | 'SEMANTIC_DISABLED'
  | 'SEMANTIC_ADAPTER_UNAVAILABLE'
  | 'REMOTE_DISABLED'
  | 'INVALID_QUERY'
  | 'INVALID_MODEL'
  | 'INELIGIBLE_CANDIDATE'
  | 'INVALID_WORKSPACE'
  | 'CROSS_WORKSPACE_CANDIDATES'
  | 'EMBEDDING_FAILED'
  | 'REMOTE_CONFIG_INVALID'
  | 'REMOTE_NETWORK_ERROR'
  | 'REMOTE_TIMEOUT'
  | 'REMOTE_HTTP_ERROR'
  | 'REMOTE_INVALID_RESPONSE'
  | 'INVALID_VECTOR'
  | 'CACHE_UNAVAILABLE'
  | 'CACHE_MISS'
  | 'CACHE_STALE'
  | 'SEMANTIC_QUALITY_GATE_REQUIRED';

export class MemoryEmbeddingError extends Error {
  constructor(readonly reason: MemorySemanticReason) {
    super(reason);
    this.name = 'MemoryEmbeddingError';
  }
}

/** Implementations return one finite, non-zero vector for each input string. */
export interface MemoryEmbeddingPort {
  readonly modelId: string;
  readonly modelVersion: string;
  /** A remote implementation is never used unless the service opts in. */
  readonly isRemote: boolean;
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export interface MemorySemanticRetrievalOptions {
  readonly remoteEnabled?: boolean;
  readonly clock?: () => number;
  /** Used only when semantic mode was explicitly enabled but no real port could be configured. */
  readonly unavailableReason?: MemorySemanticReason;
  /** Request workspace and query-cache namespace. Global entries may originate elsewhere. */
  readonly workspaceId?: string;
  /** Production factory verifies a real-adapter corpus receipt before cache use. */
  readonly qualityGate?: () => boolean;
}

export interface MemorySemanticOperationStatus {
  readonly degraded: boolean;
  readonly reason?: MemorySemanticReason;
  readonly preparedEntryCount?: number;
}

export interface MemorySemanticRerankResult {
  readonly results: RetrievedMemoryEntry[];
  readonly degraded: boolean;
  readonly reason?: MemorySemanticReason;
}

interface SqlRow {
  readonly dimensions: number;
  readonly vector_json: string;
}

interface CurrentEntryRow {
  readonly workspace_id: string;
  readonly version: number;
  readonly status: string;
  readonly sensitivity: string;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly expires_at: string | null;
  readonly title: string;
  readonly summary: string;
  readonly content: string;
  readonly tags_json: string;
}

type CurrentEntryState = 'current' | 'stale' | 'ineligible';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

function embeddingTextFields(title: string, summary: string, content: string, tags: readonly string[]): string {
  return [title, summary, content, ...tags].join('\n');
}

function embeddingText(entry: MemoryEntryRecord): string {
  return embeddingTextFields(entry.title, entry.summary, entry.content, entry.tags);
}

function contentHash(entry: MemoryEntryRecord): string {
  return sha256(embeddingText(entry));
}

function locallyEligible(entry: MemoryEntryRecord, nowMs: number): boolean {
  if (!RETRIEVABLE_STATUSES.has(entry.status) || entry.sensitivity !== 'ordinary') return false;
  if (!Array.isArray(entry.tags) || !entry.tags.every(tag => typeof tag === 'string')) return false;
  if (!areMemoryTextFieldsSafe([entry.title, entry.summary, entry.content, ...entry.tags])) return false;
  if (entry.validFrom !== null) {
    const startsAt = Date.parse(entry.validFrom);
    if (!Number.isFinite(startsAt) || nowMs < startsAt) return false;
  }
  for (const end of [entry.validUntil, entry.expiresAt]) {
    if (end === null) continue;
    const endsAt = Date.parse(end);
    if (!Number.isFinite(endsAt) || nowMs >= endsAt) return false;
  }
  return true;
}

function resolveRequestWorkspace(
  candidates: readonly RetrievedMemoryEntry[],
  requestedWorkspaceId: string | undefined,
  configuredWorkspaceId: string,
): { readonly workspaceId: string; readonly reason?: MemorySemanticReason } {
  const explicitWorkspaceId = requestedWorkspaceId ?? (configuredWorkspaceId || undefined);
  if (explicitWorkspaceId !== undefined && !isNonBlank(explicitWorkspaceId)) {
    return { workspaceId: '', reason: 'INVALID_WORKSPACE' };
  }
  const nonGlobalWorkspaces = new Set(
    candidates.filter(item => item.entry.scope !== 'global').map(item => item.entry.workspaceId),
  );
  if (nonGlobalWorkspaces.size > 1) return { workspaceId: '', reason: 'CROSS_WORKSPACE_CANDIDATES' };
  const workspaceId = explicitWorkspaceId?.trim() ?? [...nonGlobalWorkspaces][0] ?? '';
  if (workspaceId && [...nonGlobalWorkspaces].some(candidateWorkspace => candidateWorkspace !== workspaceId)) {
    return { workspaceId, reason: 'CROSS_WORKSPACE_CANDIDATES' };
  }
  return { workspaceId };
}

function currentEntryState(
  db: TransactionDatabase,
  entry: MemoryEntryRecord,
  nowMs: number,
): CurrentEntryState {
  const row = db.prepare(
    `SELECT workspace_id, version, status, sensitivity, valid_from, valid_until, expires_at,
            title, summary, content, tags_json
     FROM memory_entries WHERE id = ?`,
  ).get(entry.id) as CurrentEntryRow | undefined;
  if (!row) return 'stale';

  let tags: unknown;
  try { tags = JSON.parse(row.tags_json) as unknown; } catch { return 'ineligible'; }
  if (!Array.isArray(tags) || !tags.every(tag => typeof tag === 'string')) return 'ineligible';
  const currentText = [row.title, row.summary, row.content, ...tags] as string[];
  if (!RETRIEVABLE_STATUSES.has(row.status) || row.sensitivity !== 'ordinary'
    || !areMemoryTextFieldsSafe(currentText)) return 'ineligible';
  if (row.valid_from !== null) {
    const startsAt = Date.parse(row.valid_from);
    if (!Number.isFinite(startsAt) || nowMs < startsAt) return 'ineligible';
  }
  for (const end of [row.valid_until, row.expires_at]) {
    if (end === null) continue;
    const endsAt = Date.parse(end);
    if (!Number.isFinite(endsAt) || nowMs >= endsAt) return 'ineligible';
  }

  const dbTextHash = sha256(embeddingTextFields(row.title, row.summary, row.content, tags as string[]));
  if (row.workspace_id !== entry.workspaceId || row.version !== entry.version || row.status !== entry.status
    || row.valid_from !== entry.validFrom || row.valid_until !== entry.validUntil || row.expires_at !== entry.expiresAt
    || dbTextHash !== contentHash(entry)) return 'stale';
  return 'current';
}

function validateVector(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_VECTOR_DIMENSIONS) return null;
  if (!value.every(item => typeof item === 'number' && Number.isFinite(item))) return null;
  const norm = Math.sqrt(value.reduce((sum, item) => sum + item * item, 0));
  if (!Number.isFinite(norm) || norm <= 0) return null;
  return value.map(item => item / norm);
}

function decodeVector(row: SqlRow | undefined): number[] | null {
  if (!row || !Number.isSafeInteger(row.dimensions) || row.dimensions < 1 || row.dimensions > MAX_VECTOR_DIMENSIONS) return null;
  try {
    const vector = validateVector(JSON.parse(row.vector_json) as unknown);
    return vector?.length === row.dimensions ? vector : null;
  } catch {
    return null;
  }
}

function cosine(left: readonly number[], right: readonly number[]): number | null {
  if (left.length !== right.length || left.length === 0) return null;
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) dot += left[index]! * right[index]!;
  return Number.isFinite(dot) ? Math.max(-1, Math.min(1, dot)) : null;
}

function baselineRelevance(entries: readonly RetrievedMemoryEntry[]): number[] {
  const scores = entries.map(item => item.score);
  if (scores.some(score => !Number.isFinite(score))) return [];
  const low = Math.min(...scores);
  const high = Math.max(...scores);
  if (high > low) return scores.map(score => (score - low) / (high - low));

  const ranks = entries.map(item => item.rank);
  const best = Math.min(...ranks);
  const worst = Math.max(...ranks);
  if (worst <= best) return entries.map(() => 1);
  return ranks.map(rank => 1 - (rank - best) / (worst - best));
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  const octets = host.split('.').map(Number);
  return octets.length === 4 && octets.every((octet, index) =>
    Number.isInteger(octet) && octet >= 0 && octet <= 255 && (index !== 0 || octet === 127));
}

/**
 * OpenAI-compatible HTTP embeddings adapter. Construction is explicit and the
 * enclosing service still requires remoteEnabled=true before any request.
 * The adapter sends text only to the configured HTTPS endpoint and never logs it.
 */
export class HttpMemoryEmbeddingPort implements MemoryEmbeddingPort {
  readonly isRemote: boolean;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: {
    readonly endpoint: string;
    readonly modelId: string;
    readonly modelVersion: string;
    readonly apiKey?: string;
    readonly timeoutMs?: number;
    readonly fetch?: typeof fetch;
  }) {
    let parsed: URL;
    try { parsed = new URL(config.endpoint); } catch { throw new MemoryEmbeddingError('REMOTE_CONFIG_INVALID'); }
    const loopback = isLoopbackHostname(parsed.hostname);
    if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))
      || !isNonBlank(config.modelId) || !isNonBlank(config.modelVersion)) {
      throw new MemoryEmbeddingError('REMOTE_CONFIG_INVALID');
    }
    this.isRemote = !loopback;
    this.endpoint = parsed.toString();
    this.fetcher = config.fetch ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) {
      throw new MemoryEmbeddingError('REMOTE_CONFIG_INVALID');
    }
  }

  get modelId(): string { return this.config.modelId; }
  get modelVersion(): string { return this.config.modelVersion; }

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: 'POST',
        // A loopback service or HTTPS endpoint must not redirect text to a
        // different origin or an insecure destination outside this opt-in.
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.config.modelId, input: texts }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      throw new MemoryEmbeddingError(name === 'TimeoutError' || name === 'AbortError' ? 'REMOTE_TIMEOUT' : 'REMOTE_NETWORK_ERROR');
    }
    if (!response.ok) throw new MemoryEmbeddingError('REMOTE_HTTP_ERROR');

    let payload: unknown;
    try { payload = await response.json(); } catch { throw new MemoryEmbeddingError('REMOTE_INVALID_RESPONSE'); }
    if (typeof payload !== 'object' || payload === null || !('data' in payload) || !Array.isArray(payload.data)) {
      throw new MemoryEmbeddingError('REMOTE_INVALID_RESPONSE');
    }
    const ordered: unknown[] = Array(texts.length).fill(undefined);
    for (const item of payload.data) {
      if (typeof item !== 'object' || item === null || !('index' in item) || !('embedding' in item)) {
        throw new MemoryEmbeddingError('REMOTE_INVALID_RESPONSE');
      }
      const index = item.index;
      if (!Number.isSafeInteger(index) || index < 0 || index >= texts.length || ordered[index] !== undefined) {
        throw new MemoryEmbeddingError('REMOTE_INVALID_RESPONSE');
      }
      ordered[index] = item.embedding;
    }
    if (ordered.some(vector => vector === undefined)) throw new MemoryEmbeddingError('REMOTE_INVALID_RESPONSE');
    return ordered as readonly (readonly number[])[];
  }
}

/**
 * Optional M4 semantic reranking sidecar. It never discovers candidates: the
 * caller supplies the workspace/scope/status/expiry/sensitivity-filtered set.
 * `prepare` asynchronously fills local SQLite vector caches. `rerank` is
 * synchronous, preserves every supplied FTS candidate, and falls back to the
 * exact input order whenever a complete fresh cache is unavailable.
 */
export class MemorySemanticRetrieval {
  private readonly clock: () => number;
  private readonly remoteEnabled: boolean;
  private readonly queryWorkspaceId: string;
  private readonly unavailableReason: MemorySemanticReason | undefined;
  private readonly qualityGate: (() => boolean) | undefined;

  constructor(
    private readonly db: TransactionDatabase,
    private readonly embedding?: MemoryEmbeddingPort,
    options: MemorySemanticRetrievalOptions = {},
  ) {
    this.clock = options.clock ?? (() => Date.now());
    this.remoteEnabled = options.remoteEnabled === true;
    this.unavailableReason = options.unavailableReason;
    this.qualityGate = options.qualityGate;
    if (options.workspaceId !== undefined && !isNonBlank(options.workspaceId)) {
      throw new MemoryEmbeddingError('INVALID_WORKSPACE');
    }
    this.queryWorkspaceId = options.workspaceId?.trim() ?? '';
  }

  async prepare(
    query: string,
    eligible: readonly RetrievedMemoryEntry[],
    requestWorkspaceId?: string,
  ): Promise<MemorySemanticOperationStatus> {
    if (!this.qualityApproved()) return { degraded: true, reason: 'SEMANTIC_QUALITY_GATE_REQUIRED', preparedEntryCount: 0 };
    if (!this.embedding) {
      return this.unavailableReason
        ? { degraded: true, reason: this.unavailableReason, preparedEntryCount: 0 }
        : { degraded: false, reason: 'SEMANTIC_DISABLED', preparedEntryCount: 0 };
    }
    if (this.embedding.isRemote && !this.remoteEnabled) return { degraded: true, reason: 'REMOTE_DISABLED', preparedEntryCount: 0 };
    if (!isNonBlank(query) || !areMemoryTextFieldsSafe([query])) {
      return { degraded: true, reason: 'INVALID_QUERY', preparedEntryCount: 0 };
    }
    if (!isNonBlank(this.embedding.modelId) || !isNonBlank(this.embedding.modelVersion)) {
      return { degraded: true, reason: 'INVALID_MODEL', preparedEntryCount: 0 };
    }
    const nowMs = this.clock();
    if (!Number.isFinite(nowMs)) return { degraded: true, reason: 'INELIGIBLE_CANDIDATE', preparedEntryCount: 0 };
    const requestWorkspace = resolveRequestWorkspace(eligible, requestWorkspaceId, this.queryWorkspaceId);
    if (requestWorkspace.reason) return { degraded: true, reason: requestWorkspace.reason, preparedEntryCount: 0 };
    const candidates = eligible.filter(item => locallyEligible(item.entry, nowMs));
    const skippedIneligible = candidates.length !== eligible.length;
    const normalizedQuery = normalizeQuery(query);
    if (!normalizedQuery) return { degraded: true, reason: 'INVALID_QUERY', preparedEntryCount: 0 };
    if (candidates.length === 0) {
      return {
        degraded: skippedIneligible,
        ...(skippedIneligible ? { reason: 'INELIGIBLE_CANDIDATE' as const } : {}),
        preparedEntryCount: 0,
      };
    }

    const modelId = this.embedding.modelId;
    const modelVersion = this.embedding.modelVersion;
    const queryHash = sha256(normalizedQuery);
    let queryVector: number[] | null = null;
    let needsQueryEmbedding = true;
    const entryVectors = new Map<string, number[]>();
    const entriesToEmbed: MemoryEntryRecord[] = [];
    try {
      // Fail closed before sending any text if migration 048 is unavailable.
      const queryRow = this.db.prepare(
        `SELECT dimensions, vector_json FROM memory_semantic_query_vectors
         WHERE workspace_id = ? AND query_hash = ? AND embedding_model_id = ? AND embedding_model_version = ?`,
      ).get(requestWorkspace.workspaceId, queryHash, modelId, modelVersion) as SqlRow | undefined;
      queryVector = decodeVector(queryRow);
      needsQueryEmbedding = queryVector === null;

      for (const item of candidates) {
        const entry = item.entry;
        const state = currentEntryState(this.db, entry, nowMs);
        if (state === 'ineligible') return { degraded: true, reason: 'INELIGIBLE_CANDIDATE', preparedEntryCount: 0 };
        if (state === 'stale') return { degraded: true, reason: 'CACHE_STALE', preparedEntryCount: 0 };

        const row = this.db.prepare(
          `SELECT dimensions, vector_json FROM memory_semantic_entry_vectors
           WHERE entry_id = ? AND entry_version = ? AND content_hash = ?
             AND embedding_model_id = ? AND embedding_model_version = ?`,
        ).get(entry.id, entry.version, contentHash(entry), modelId, modelVersion) as SqlRow | undefined;
        const cached = decodeVector(row);
        if (cached) entryVectors.set(entry.id, cached);
        else entriesToEmbed.push(entry);
      }
    } catch {
      return { degraded: true, reason: 'CACHE_UNAVAILABLE', preparedEntryCount: 0 };
    }

    try {
      if (needsQueryEmbedding) {
        const vectors = await this.embedding.embed([normalizedQuery]);
        if (vectors.length !== 1) return { degraded: true, reason: 'INVALID_VECTOR', preparedEntryCount: 0 };
        queryVector = validateVector(vectors[0]);
        if (!queryVector) return { degraded: true, reason: 'INVALID_VECTOR', preparedEntryCount: 0 };
      }

      for (let start = 0; start < entriesToEmbed.length; start += PREPARE_BATCH_SIZE) {
        const batch = entriesToEmbed.slice(start, start + PREPARE_BATCH_SIZE);
        const vectors = await this.embedding.embed(batch.map(embeddingText));
        if (vectors.length !== batch.length) return { degraded: true, reason: 'INVALID_VECTOR', preparedEntryCount: 0 };
        for (let index = 0; index < batch.length; index += 1) {
          const vector = validateVector(vectors[index]);
          if (!vector) return { degraded: true, reason: 'INVALID_VECTOR', preparedEntryCount: 0 };
          entryVectors.set(batch[index]!.id, vector);
        }
      }

      if (!queryVector || candidates.some(item => entryVectors.get(item.entry.id)?.length !== queryVector!.length)) {
        return { degraded: true, reason: 'INVALID_VECTOR', preparedEntryCount: 0 };
      }

      const completionNowMs = this.clock();
      if (!Number.isFinite(completionNowMs)) {
        return { degraded: true, reason: 'INELIGIBLE_CANDIDATE', preparedEntryCount: 0 };
      }
      const timestamp = new Date(completionNowMs).toISOString();
      try {
        this.db.exec('BEGIN IMMEDIATE');
        for (const item of candidates) {
          const state = currentEntryState(this.db, item.entry, completionNowMs);
          if (state !== 'current') {
            this.db.exec('ROLLBACK');
            return {
              degraded: true,
              reason: state === 'stale' ? 'CACHE_STALE' : 'INELIGIBLE_CANDIDATE',
              preparedEntryCount: 0,
            };
          }
        }
        this.db.prepare(
          `DELETE FROM memory_semantic_query_vectors
           WHERE workspace_id = ? AND query_hash = ?
             AND NOT (embedding_model_id = ? AND embedding_model_version = ?)`,
        ).run(requestWorkspace.workspaceId, queryHash, modelId, modelVersion);
        this.db.prepare(
          `INSERT INTO memory_semantic_query_vectors
            (workspace_id, query_hash, embedding_model_id, embedding_model_version, dimensions, vector_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(workspace_id, query_hash, embedding_model_id, embedding_model_version) DO UPDATE SET
             dimensions = excluded.dimensions, vector_json = excluded.vector_json, updated_at = excluded.updated_at`,
        ).run(requestWorkspace.workspaceId, queryHash, modelId, modelVersion,
          queryVector.length, JSON.stringify(queryVector), timestamp);

        for (const item of candidates) {
          const entry = item.entry;
          const hash = contentHash(entry);
          const vector = entryVectors.get(entry.id)!;
          this.db.prepare(
            `DELETE FROM memory_semantic_entry_vectors
             WHERE entry_id = ? AND NOT (
               entry_version = ? AND content_hash = ? AND embedding_model_id = ? AND embedding_model_version = ?
             )`,
          ).run(entry.id, entry.version, hash, modelId, modelVersion);
          this.db.prepare(
            `INSERT INTO memory_semantic_entry_vectors
              (entry_id, entry_version, content_hash, embedding_model_id, embedding_model_version,
               dimensions, vector_json, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(entry_id, entry_version, content_hash, embedding_model_id, embedding_model_version)
             DO UPDATE SET dimensions = excluded.dimensions, vector_json = excluded.vector_json, updated_at = excluded.updated_at`,
          ).run(entry.id, entry.version, hash, modelId, modelVersion,
            vector.length, JSON.stringify(vector), timestamp);
        }
        this.db.exec('COMMIT');
      } catch {
        try { this.db.exec('ROLLBACK'); } catch { /* preserve the stable failure status */ }
        return { degraded: true, reason: 'CACHE_UNAVAILABLE', preparedEntryCount: 0 };
      }

      return {
        degraded: skippedIneligible,
        ...(skippedIneligible ? { reason: 'INELIGIBLE_CANDIDATE' as const } : {}),
        preparedEntryCount: candidates.length,
      };
    } catch (error) {
      return { degraded: true, reason: this.reasonFrom(error), preparedEntryCount: 0 };
    }
  }

  /** Synchronous cache-only ranking for the runtime resolver/selector path. */
  rerank(
    eligible: readonly RetrievedMemoryEntry[],
    query: string,
    requestWorkspaceId?: string,
  ): MemorySemanticRerankResult {
    if (!this.qualityApproved()) return this.fallback(eligible, 'SEMANTIC_QUALITY_GATE_REQUIRED');
    if (!this.embedding) {
      return this.unavailableReason
        ? this.fallback(eligible, this.unavailableReason)
        : { results: [...eligible], degraded: false };
    }
    if (this.embedding.isRemote && !this.remoteEnabled) return this.fallback(eligible, 'REMOTE_DISABLED');
    if (!isNonBlank(query) || !areMemoryTextFieldsSafe([query])) return this.fallback(eligible, 'INVALID_QUERY');
    if (!isNonBlank(this.embedding.modelId) || !isNonBlank(this.embedding.modelVersion)) return this.fallback(eligible, 'INVALID_MODEL');
    if (eligible.length === 0) return { results: [], degraded: false };

    const nowMs = this.clock();
    if (!Number.isFinite(nowMs)) return this.fallback(eligible, 'INELIGIBLE_CANDIDATE');
    const requestWorkspace = resolveRequestWorkspace(eligible, requestWorkspaceId, this.queryWorkspaceId);
    if (requestWorkspace.reason) return this.fallback(eligible, requestWorkspace.reason);
    let degraded = false;
    let semanticCandidates: RetrievedMemoryEntry[] = [];
    for (const item of eligible) {
      if (!locallyEligible(item.entry, nowMs)) {
        degraded = true;
        continue;
      }
      try {
        const state = currentEntryState(this.db, item.entry, nowMs);
        if (state === 'stale') return this.fallback(eligible, 'CACHE_STALE');
        if (state === 'ineligible') {
          degraded = true;
          continue;
        }
        semanticCandidates.push(item);
      } catch {
        return this.fallback(eligible, 'CACHE_UNAVAILABLE');
      }
    }
    if (semanticCandidates.length === 0) {
      return degraded ? this.fallback(eligible, 'INELIGIBLE_CANDIDATE') : { results: [...eligible], degraded: false };
    }

    try {
      const modelId = this.embedding.modelId;
      const modelVersion = this.embedding.modelVersion;
      const queryHash = sha256(normalizeQuery(query));
      const queryRow = this.db.prepare(
        `SELECT dimensions, vector_json FROM memory_semantic_query_vectors
         WHERE workspace_id = ? AND query_hash = ?
           AND embedding_model_id = ? AND embedding_model_version = ?`,
      ).get(requestWorkspace.workspaceId, queryHash, modelId, modelVersion) as SqlRow | undefined;
      const queryVector = decodeVector(queryRow);
      if (!queryVector) {
        const reason = queryRow ? 'INVALID_VECTOR' : 'CACHE_MISS';
        return this.fallback(eligible, reason);
      }

      const vectors: number[][] = [];
      for (const item of semanticCandidates) {
        const entry = item.entry;
        const hash = contentHash(entry);
        const row = this.db.prepare(
          `SELECT dimensions, vector_json FROM memory_semantic_entry_vectors
           WHERE entry_id = ? AND entry_version = ? AND content_hash = ?
             AND embedding_model_id = ? AND embedding_model_version = ?`,
        ).get(entry.id, entry.version, hash, modelId, modelVersion) as SqlRow | undefined;
        const vector = decodeVector(row);
        if (!vector) {
          if (row) return this.fallback(eligible, 'INVALID_VECTOR');
          const stale = this.db.prepare(
            `SELECT 1 AS present FROM memory_semantic_entry_vectors
             WHERE entry_id = ? AND embedding_model_id = ? AND embedding_model_version = ? LIMIT 1`,
          ).get(entry.id, modelId, modelVersion);
          return this.fallback(eligible, stale ? 'CACHE_STALE' : 'CACHE_MISS');
        }
        if (vector.length !== queryVector.length) return this.fallback(eligible, 'INVALID_VECTOR');
        vectors.push(vector);
      }

      const baseline = baselineRelevance(semanticCandidates);
      if (baseline.length !== semanticCandidates.length) return this.fallback(eligible, 'INVALID_VECTOR');
      const scored = semanticCandidates.map((item, index) => {
        const similarity = cosine(queryVector, vectors[index]!);
        if (similarity === null) return null;
        const semantic = (similarity + 1) / 2;
        const score = HYBRID_SEMANTIC_WEIGHT * semantic + HYBRID_BASELINE_WEIGHT * baseline[index]!;
        return { item, score, similarity };
      });
      if (scored.some(item => item === null)) return this.fallback(eligible, 'INVALID_VECTOR');
      scored.sort((left, right) => {
        const leftItem = left!.item;
        const rightItem = right!.item;
        if (leftItem.entry.pinned !== rightItem.entry.pinned) return leftItem.entry.pinned ? -1 : 1;
        return right!.score - left!.score || leftItem.rank - rightItem.rank || leftItem.entry.id.localeCompare(rightItem.entry.id);
      });
      const semanticSet = new Set(semanticCandidates);
      const rankedSlots: Array<RetrievedMemoryEntry | undefined> = Array(eligible.length);
      eligible.forEach((item, index) => {
        // Keep pinned defaults and every exact FTS hit in its baseline slot.
        // Semantic similarity only orders non-pinned, non-FTS candidates.
        if (!semanticSet.has(item) || item.entry.pinned || item.ftsRank !== null) {
          rankedSlots[index] = { ...item, rank: index + 1 };
        }
      });
      const semanticOnly = scored.filter(result => result!.item.ftsRank === null && !result!.item.entry.pinned);
      let semanticIndex = 0;
      for (let index = 0; index < rankedSlots.length; index += 1) {
        if (rankedSlots[index] !== undefined) continue;
        const ranked = semanticOnly[semanticIndex++]!;
        rankedSlots[index] = {
          ...ranked.item, rank: index + 1, score: ranked.score, semanticSimilarity: ranked.similarity,
          reasons: [...new Set([...ranked.item.reasons, 'semantic-relevance' as const])],
        };
      }
      return {
        results: rankedSlots.map(item => item as RetrievedMemoryEntry),
        degraded,
        ...(degraded ? { reason: 'INELIGIBLE_CANDIDATE' as const } : {}),
      };
    } catch {
      return this.fallback(eligible, 'CACHE_UNAVAILABLE');
    }
  }

  private qualityApproved(): boolean {
    try { return this.qualityGate?.() ?? true; } catch { return false; }
  }

  private fallback(eligible: readonly RetrievedMemoryEntry[], reason: MemorySemanticReason): MemorySemanticRerankResult {
    return { results: [...eligible], degraded: true, reason };
  }

  private reasonFrom(error: unknown): MemorySemanticReason {
    if (error instanceof MemoryEmbeddingError) return error.reason;
    return 'EMBEDDING_FAILED';
  }
}
