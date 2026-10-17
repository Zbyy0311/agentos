import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import {
  EVENT_PAYLOAD_OFFLOAD_DISCRIMINATOR,
  type RuntimeEventPayloadOffloadSummary,
} from '@agentos/shared';
import type { TransactionDatabase } from '../store/Transaction.js';

/**
 * §47 oversized-payload offload. When a durable Event payload exceeds the 64KB
 * canonical-JSON limit, the full (already redacted) payload JSON is written to
 * a canonical raw Artifact and the Event row keeps only a
 * RuntimeEventPayloadOffloadSummary. All file and row writes happen
 * synchronously inside the caller's SQLite transaction; when the offload
 * itself fails the partial file is removed before the error propagates.
 */
export interface EventPayloadOffloadInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly stageId?: string;
  readonly processId?: string;
  readonly eventId: string;
  readonly eventType: string;
  /** Canonical JSON of the redacted payload that exceeded the limit. */
  readonly payloadJson: string;
  readonly timestamp: string;
}

export interface EventPayloadOffloader {
  isOffloadable(eventType: string): boolean;
  offloadWithinTransaction(input: EventPayloadOffloadInput): RuntimeEventPayloadOffloadSummary;
}

const PREVIEW_CHARS = 512;

export class EventPayloadOffloadService implements EventPayloadOffloader {
  private readonly ineligibleTypes: ReadonlySet<string>;

  constructor(
    private readonly db: TransactionDatabase,
    private readonly artifactRoot: string,
    options: { ineligibleEventTypes?: readonly string[] } = {},
  ) {
    this.ineligibleTypes = new Set(options.ineligibleEventTypes ?? []);
  }

  /**
   * Fail-closed offload eligibility (§47): every registered durable Event type
   * is offloadable by default because the original payload is preserved
   * byte-for-byte in the Artifact. Only types explicitly configured as
   * ineligible (e.g. payloads whose consumers cannot resolve an artifact
   * reference) reject oversized appends instead of silently truncating.
   */
  isOffloadable(eventType: string): boolean {
    return !this.ineligibleTypes.has(eventType);
  }

  offloadWithinTransaction(input: EventPayloadOffloadInput): RuntimeEventPayloadOffloadSummary {
    const bytes = Buffer.from(input.payloadJson, 'utf8');
    const { artifactId } = this.storeCanonicalRawArtifact({
      workspaceId: input.workspaceId,
      runId: input.runId,
      ...(input.stageId === undefined ? {} : { stageId: input.stageId }),
      ...(input.processId === undefined ? {} : { processId: input.processId }),
      title: `Event payload offload for ${input.eventType} ${input.eventId}`,
      summary: `Original ${input.eventType} payload (${bytes.byteLength} bytes) offloaded per 03-Event-Model §47`,
      bytes,
      timestamp: input.timestamp,
    });
    let storedKeys: string[] = [];
    try {
      const parsed = JSON.parse(input.payloadJson) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        storedKeys = Object.keys(parsed as Record<string, unknown>).sort();
      }
    } catch {
      storedKeys = [];
    }
    return {
      payloadKind: EVENT_PAYLOAD_OFFLOAD_DISCRIMINATOR,
      artifactId,
      eventType: input.eventType,
      sizeBytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      preview: input.payloadJson.slice(0, PREVIEW_CHARS),
      storedKeys,
    };
  }

  /**
   * Shared canonical raw-Artifact write used both by §47 payload offload and
   * §59 compaction. Synchronous, runs inside the caller's transaction; a
   * failed insert removes the partial file before the error propagates.
   */
  storeCanonicalRawArtifact(input: {
    readonly workspaceId: string;
    readonly runId: string;
    readonly stageId?: string;
    readonly processId?: string;
    readonly title: string;
    readonly summary: string;
    readonly bytes: Buffer;
    readonly timestamp: string;
  }): { readonly artifactId: string; readonly sha256: string; readonly sizeBytes: number } {
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    const artifactId = randomUUID();
    const storageKey = `event-payloads/${artifactId}/content`;
    const directory = join(resolve(this.artifactRoot), 'event-payloads', artifactId);
    const path = join(directory, 'content');
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(path, input.bytes, { flag: 'wx' });
      this.db.prepare(`
        INSERT INTO runtime_artifacts (
          id, workspace_id, provenance_kind, run_id, canonical_run_id, source_execution_id,
          agent_id, source_process_id, source_operation_id, source_stage_id,
          artifact_type, title, summary, original_path, storage_key, mime_type,
          size_bytes, sha256, content_available, created_at
        ) VALUES (?, ?, 'CANONICAL', NULL, ?, NULL, NULL, ?, NULL, ?, 'event-payload', ?, ?, NULL, ?, 'application/json', ?, ?, 1, ?)
      `).run(
        artifactId,
        input.workspaceId,
        input.runId,
        input.processId ?? null,
        input.stageId ?? null,
        input.title,
        input.summary,
        storageKey,
        input.bytes.byteLength,
        sha256,
        input.timestamp,
      );
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
    return { artifactId, sha256, sizeBytes: input.bytes.byteLength };
  }

  /** Read back an offloaded payload by artifactId (hash-verified). */
  readOffloadedPayload(artifactId: string): Buffer {
    return this.readCanonicalRawArtifact(artifactId);
  }

  /** Hash-verified read of any canonical event raw Artifact. */
  readCanonicalRawArtifact(artifactId: string): Buffer {
    const row = this.db.prepare(`
      SELECT storage_key, size_bytes, sha256, content_available
      FROM runtime_artifacts
      WHERE id = ? AND provenance_kind = 'CANONICAL' AND artifact_type = 'event-payload'
    `).get(artifactId) as { storage_key: string | null; size_bytes: number; sha256: string | null; content_available: number } | undefined;
    if (!row || row.content_available !== 1 || !row.storage_key || !row.sha256) {
      throw new Error('RUNTIME_EVENT_OFFLOAD_UNAVAILABLE: artifact is missing or content-unavailable');
    }
    const path = resolve(this.artifactRoot, row.storage_key);
    const rootResolved = resolve(this.artifactRoot);
    if (path !== rootResolved && !path.startsWith(rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep)) {
      throw new Error('RUNTIME_EVENT_OFFLOAD_UNAVAILABLE: artifact storage path escapes artifact root');
    }
    if (dirname(path) !== join(rootResolved, 'event-payloads', artifactId)) {
      throw new Error('RUNTIME_EVENT_OFFLOAD_UNAVAILABLE: artifact storage key is malformed');
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      throw new Error('RUNTIME_EVENT_OFFLOAD_UNAVAILABLE: artifact content is missing');
    }
    if (bytes.byteLength !== row.size_bytes || createHash('sha256').update(bytes).digest('hex') !== row.sha256) {
      throw new Error('RUNTIME_EVENT_OFFLOAD_UNAVAILABLE: artifact content hash verification failed');
    }
    return bytes;
  }
}
