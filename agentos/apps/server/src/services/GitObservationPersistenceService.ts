import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';
import {
  canEmitCanonicalGitObservationEventV1,
  mapGitObservationEventDirtyStateV1,
  serializeChangedFilesV1,
  serializeGitObservationSnapshotV1,
  type AuthorizedRuntimeEventContextV1,
  type GitObservationEventBindingV1,
  type GitObservationRuntimeEventContextAuthorityV1,
  type GitObservationSnapshotV1,
  type RuntimeEventContextAuthoritySourceV1,
} from '@agentos/shared';
import type { SqliteStore } from '../store/SqliteStore.js';
import { inTransaction, type TransactionDatabase } from '../store/Transaction.js';
import type { DurableRuntimeFactWriter } from '../store/RuntimeEventRepository.js';
import type { WorkspaceGitObservationRepository } from '../store/WorkspaceGitObservationRepository.js';

/**
 * P6-L1C-M3: durable Git Observation persistence.
 *
 * Connects the completed M2 collector output (snapshot + bounded diff bytes)
 * to the frozen L1B/M1 persistence, canonical Artifact, Runtime Event, and
 * Outbox contracts. This service never executes Git and never reparses M2
 * output; it consumes a finished GitObservationSnapshotV1.
 *
 * Crash consistency follows the frozen CANONICAL_DIFF_ARTIFACT_COMMIT_ORDER_V1:
 * immutable Artifact bytes are staged (temp file + atomic rename) BEFORE
 * BEGIN IMMEDIATE; the Artifact row, Git Observation row, Runtime Events, and
 * one Outbox row per Event commit atomically in ONE transaction. A normal
 * failure before commit removes the staged Artifact directory; a process
 * crash after the final rename but before the commit leaves an allowed
 * orphan file whose bytes can never be referenced by a committed row.
 */

export class GitObservationPersistenceError extends Error {
  constructor(
    readonly code:
      | 'INPUT_INVALID'
      | 'AUTHORITY_UNPROVEN'
      | 'ARTIFACT_STAGING_FAILED'
      | 'PERSISTENCE_FAILED',
    message: string,
  ) {
    super('GIT_OBSERVATION_' + code + ': ' + message);
    this.name = 'GitObservationPersistenceError';
  }
}

/** Server-owned persistence command; no caller-controlled storage or IDs. */
export type GitObservationPersistenceCommandV1 =
  | {
      readonly workspaceId: string;
      readonly snapshot: GitObservationSnapshotV1;
      readonly binding: { readonly subjectKind: 'WORKSPACE_ONLY' };
    }
  | {
      readonly workspaceId: string;
      readonly snapshot: GitObservationSnapshotV1;
      readonly binding: {
        readonly subjectKind: 'LEGACY_AGENT_RUN';
        readonly admissionId: string;
        readonly legacyRunId: string;
      };
    }
  | {
      readonly workspaceId: string;
      readonly snapshot: GitObservationSnapshotV1;
      readonly diffBytes?: Uint8Array | null;
      readonly binding: {
        readonly subjectKind: 'CANONICAL_RUN';
        readonly admissionId: string;
        readonly canonicalRunId: string;
        readonly authoritySource: RuntimeEventContextAuthoritySourceV1;
      };
    };

export interface GitObservationPersistenceResultV1 {
  readonly observationId: string;
  readonly diffArtifactId: string | null;
  readonly eventsCreated: number;
  readonly outboxRowsCreated: number;
}

export interface CanonicalCommandOwnershipVerifierV1 {
  /** Proves the command is owned by this Workspace/canonical Run. */
  verifyCanonicalCommandOwnership(input: {
    readonly workspaceId: string;
    readonly canonicalRunId: string;
    readonly commandId: string;
  }): boolean;
}

/**
 * Deterministic fault-injection seam used only by tests to place failures at
 * exact frozen crash windows. Production never injects a fault.
 */
export interface GitObservationPersistenceFaultInjection {
  readonly beforeTempWrite?: () => void;
  readonly failTempWrite?: () => void;
  readonly failRename?: () => void;
  readonly crashBeforeBegin?: () => void;
  readonly beforeArtifactInsert?: () => void;
  readonly beforeObservationInsert?: () => void;
  readonly beforeEventAppend?: () => void;
  readonly beforeOutboxInsert?: () => void;
}

export interface GitObservationPersistenceServiceDependencies {
  readonly store: SqliteStore;
  readonly db: TransactionDatabase;
  readonly observations: WorkspaceGitObservationRepository;
  readonly factWriter: DurableRuntimeFactWriter;
  readonly eventAuthority: GitObservationRuntimeEventContextAuthorityV1;
  /** Artifact storage root (defaults to <cwd>/.agentos/artifacts). */
  readonly artifactRoot?: string;
  readonly canonicalCommandVerifier?: CanonicalCommandOwnershipVerifierV1;
  readonly now?: () => Date;
  readonly createArtifactId?: () => string;
  readonly createObservationId?: () => string;
  readonly faultInjection?: GitObservationPersistenceFaultInjection;
}

const CANONICAL_DIFF_MIME_TYPE = 'text/x-diff';

export class GitObservationPersistenceService {
  private readonly store: SqliteStore;
  private readonly db: TransactionDatabase;
  private readonly observations: WorkspaceGitObservationRepository;
  private readonly factWriter: DurableRuntimeFactWriter;
  private readonly eventAuthority: GitObservationRuntimeEventContextAuthorityV1;
  private readonly artifactRoot: string;
  private readonly canonicalCommandVerifier?: CanonicalCommandOwnershipVerifierV1;
  private readonly now: () => Date;
  private readonly createArtifactId: () => string;
  private readonly createObservationId: () => string;
  private readonly faults: GitObservationPersistenceFaultInjection;

  constructor(dependencies: GitObservationPersistenceServiceDependencies) {
    this.store = dependencies.store;
    this.db = dependencies.db;
    this.observations = dependencies.observations;
    this.factWriter = dependencies.factWriter;
    this.eventAuthority = dependencies.eventAuthority;
    this.artifactRoot = dependencies.artifactRoot
      ?? nodePath.join(nodePath.resolve(process.cwd()), '.agentos', 'artifacts');
    this.canonicalCommandVerifier = dependencies.canonicalCommandVerifier;
    this.now = dependencies.now ?? (() => new Date());
    this.createArtifactId = dependencies.createArtifactId ?? (() => randomUUID());
    this.createObservationId = dependencies.createObservationId ?? (() => randomUUID());
    this.faults = dependencies.faultInjection ?? {};
  }

  async persist(command: GitObservationPersistenceCommandV1): Promise<GitObservationPersistenceResultV1> {
    if (command.workspaceId.trim().length === 0) {
      throw new GitObservationPersistenceError('INPUT_INVALID', 'workspaceId is required');
    }
    const binding = command.binding;
    if (binding.subjectKind === 'WORKSPACE_ONLY') {
      return this.persistWorkspaceOnly(command as Extract<GitObservationPersistenceCommandV1, { binding: { subjectKind: 'WORKSPACE_ONLY' } }>);
    }
    if (binding.subjectKind === 'LEGACY_AGENT_RUN') {
      return this.persistLegacyAgentRun(command as Extract<GitObservationPersistenceCommandV1, { binding: { subjectKind: 'LEGACY_AGENT_RUN' } }>);
    }
    return this.persistCanonicalRun(command as Extract<GitObservationPersistenceCommandV1, { binding: { subjectKind: 'CANONICAL_RUN' } }>);
  }

  // ------------------------------------------------------------------
  // MODE A: WORKSPACE_ONLY — observation only; no events/outbox/artifact.
  // ------------------------------------------------------------------
  private async persistWorkspaceOnly(
    command: Extract<GitObservationPersistenceCommandV1, { binding: { subjectKind: 'WORKSPACE_ONLY' } }>,
  ): Promise<GitObservationPersistenceResultV1> {
    const observationId = this.createObservationId();
    const row = this.buildObservationRow(command, observationId, null, null, null);
    inTransaction(this.db, () => {
      this.observations.insertObservation(row);
    });
    return { observationId, diffArtifactId: null, eventsCreated: 0, outboxRowsCreated: 0 };
  }

  // ------------------------------------------------------------------
  // MODE B: LEGACY_AGENT_RUN — observation with the legitimate legacy
  // Admission/subject binding; diff_artifact_id stays NULL; no events.
  // ------------------------------------------------------------------
  private async persistLegacyAgentRun(
    command: Extract<GitObservationPersistenceCommandV1, { binding: { subjectKind: 'LEGACY_AGENT_RUN' } }>,
  ): Promise<GitObservationPersistenceResultV1> {
    const observationId = this.createObservationId();
    const row = this.buildObservationRow(
      command,
      observationId,
      command.binding.admissionId,
      'LEGACY_AGENT_RUN',
      null,
    );
    inTransaction(this.db, () => {
      this.observations.insertObservation(row);
    });
    return { observationId, diffArtifactId: null, eventsCreated: 0, outboxRowsCreated: 0 };
  }

  // ------------------------------------------------------------------
  // MODE C: CANONICAL_RUN — observation + optional canonical diff Artifact
  // + canonical Runtime Events + one Outbox row per Event, atomically.
  // ------------------------------------------------------------------
  private async persistCanonicalRun(
    command: Extract<GitObservationPersistenceCommandV1, { binding: { subjectKind: 'CANONICAL_RUN' } }>,
  ): Promise<GitObservationPersistenceResultV1> {
    const { snapshot, workspaceId } = command;
    const { canonicalRunId, admissionId, authoritySource } = command.binding;

    // Authorize the causal context through the frozen authority model. A
    // plain RuntimeEventContext, admissionId, or runId is never equivalent.
    let authorized: AuthorizedRuntimeEventContextV1;
    try {
      authorized = this.eventAuthority.authorize(authoritySource);
    } catch (error) {
      throw new GitObservationPersistenceError(
        'AUTHORITY_UNPROVEN',
        'AuthorizedRuntimeEventContextV1 could not be established: '
          + (error instanceof Error ? error.message : 'rejected'),
      );
    }
    this.assertAuthorityOriginProven(workspaceId, canonicalRunId, authorized);

    const eventBinding: GitObservationEventBindingV1 = {
      subjectKind: 'CANONICAL_RUN',
      canonicalRunId,
      runtimeEventContext: authorized,
    };
    if (!canEmitCanonicalGitObservationEventV1(eventBinding)) {
      throw new GitObservationPersistenceError(
        'AUTHORITY_UNPROVEN',
        'Binding does not authorize canonical Git Observation events',
      );
    }

    // Canonical diff Artifact eligibility.
    const diffBytes = command.diffBytes ?? null;
    const eligible = snapshot.observationState === 'GIT'
      && snapshot.diffState === 'available'
      && diffBytes !== null;
    const sizeBytes = diffBytes?.byteLength ?? 0;
    const sha256 = diffBytes === null ? null : createHash('sha256').update(diffBytes).digest('hex');

    // Steps 1-4: collect bytes, validate hash/size, stage immutable file
    // BEFORE any committed DB row can reference it.
    let staged: { artifactId: string; storageKey: string; directory: string } | null = null;
    if (eligible && diffBytes !== null) {
      staged = await this.stageDiffArtifact(workspaceId, canonicalRunId, diffBytes);
    }

    const observationId = this.createObservationId();
    const timestamp = this.now().toISOString();
    let eventsCreated = 0;
    let outboxRowsCreated = 0;

    try {
      const row = this.buildObservationRow(
        command,
        observationId,
        admissionId,
        'CANONICAL_RUN',
        staged?.artifactId ?? null,
      );

      inTransaction(this.db, () => {
        // Step 6: canonical Artifact row.
        if (staged !== null && sha256 !== null) {
          this.faults.beforeArtifactInsert?.();
          this.store.createCanonicalRuntimeArtifact({
            id: staged.artifactId,
            workspaceId,
            type: 'diff',
            title: 'Git Observation diff ' + observationId,
            summary: undefined,
            originalPath: undefined,
            mimeType: CANONICAL_DIFF_MIME_TYPE,
            sizeBytes,
            sha256,
            contentAvailable: true,
            createdAt: timestamp,
          }, { kind: 'CANONICAL', canonicalRunId }, staged.storageKey);
        }

        // Step 7: Git Observation row.
        this.faults.beforeObservationInsert?.();
        this.observations.insertObservation(row);

        // Step 8 + 9: canonical Runtime Events + one Outbox row each.
        this.faults.beforeEventAppend?.();
        this.factWriter.appendWithinTransaction({
          type: snapshot.observationState === 'UNAVAILABLE'
            ? 'git.observation.unavailable'
            : 'git.observation.completed',
          workspaceId,
          runId: canonicalRunId,
          timestamp,
          source: 'git-runtime',
          eventContext: authorized,
          payload: snapshot.observationState === 'UNAVAILABLE'
            ? { errorCode: snapshot.error?.code ?? 'GIT_REPOSITORY_DISCOVERY_FAILED' }
            : {
                observationState: snapshot.observationState,
                dirtyState: mapGitObservationEventDirtyStateV1(snapshot),
              },
        });
        eventsCreated += 1;
        outboxRowsCreated += 1;

        if (staged !== null && sha256 !== null) {
          this.faults.beforeOutboxInsert?.();
          this.factWriter.appendWithinTransaction({
            type: 'artifact.diff.registered',
            workspaceId,
            runId: canonicalRunId,
            artifactId: staged.artifactId,
            timestamp,
            source: 'artifact-manager',
            eventContext: authorized,
            payload: {
              artifactId: staged.artifactId,
              contentHash: sha256,
              sizeBytes,
            },
          });
          eventsCreated += 1;
          outboxRowsCreated += 1;
        }
      });
    } catch (error) {
      // Normal failure before commit: the DB transaction is already rolled
      // back; remove the staged Artifact directory from this attempt.
      if (staged !== null) {
        await this.removeStagedArtifact(staged.directory);
      }
      if (error instanceof GitObservationPersistenceError) throw error;
      throw new GitObservationPersistenceError(
        'PERSISTENCE_FAILED',
        error instanceof Error ? error.message : 'durable Git Observation persistence failed',
      );
    }

    return {
      observationId,
      diffArtifactId: staged?.artifactId ?? null,
      eventsCreated,
      outboxRowsCreated,
    };
  }

  // ------------------------------------------------------------------
  // Artifact byte staging: validate, temp write, atomic rename (pre-BEGIN).
  // ------------------------------------------------------------------
  private async stageDiffArtifact(
    workspaceId: string,
    canonicalRunId: string,
    diffBytes: Uint8Array,
  ): Promise<{ artifactId: string; storageKey: string; directory: string }> {
    const artifactId = this.createArtifactId();
    const directory = nodePath.join(this.artifactRoot, workspaceId, canonicalRunId, artifactId);
    const storageKey = nodePath
      .join(workspaceId, canonicalRunId, artifactId, 'content')
      .replaceAll(nodePath.sep, '/');
    const resolvedDirectory = nodePath.resolve(directory);
    if (!this.isWithinArtifactRoot(resolvedDirectory)) {
      throw new GitObservationPersistenceError(
        'ARTIFACT_STAGING_FAILED',
        'resolved Artifact path escapes the Artifact root',
      );
    }

    const temporaryPath = nodePath.join(resolvedDirectory, 'content.tmp-' + randomUUID());
    const finalPath = nodePath.join(resolvedDirectory, 'content');
    try {
      await mkdir(resolvedDirectory, { recursive: true });
      this.faults.beforeTempWrite?.();
      if (this.faults.failTempWrite) {
        this.faults.failTempWrite();
      } else {
        await writeFile(temporaryPath, diffBytes, { flag: 'wx' });
      }
      if (this.faults.failRename) {
        this.faults.failRename();
      } else {
        await rename(temporaryPath, finalPath);
      }
      // Crash window I: a process crash after the final rename but before
      // BEGIN leaves an orphan file whose bytes can never be referenced.
      this.faults.crashBeforeBegin?.();
    } catch (error) {
      await this.removeStagedArtifact(resolvedDirectory);
      if (error instanceof GitObservationPersistenceError) throw error;
      throw new GitObservationPersistenceError(
        'ARTIFACT_STAGING_FAILED',
        error instanceof Error ? error.message : 'canonical diff staging failed',
      );
    }

    return { artifactId, storageKey, directory: resolvedDirectory };
  }

  private isWithinArtifactRoot(resolved: string): boolean {
    const root = nodePath.resolve(this.artifactRoot);
    return resolved === root || resolved.startsWith(root + nodePath.sep);
  }

  private async removeStagedArtifact(directory: string): Promise<void> {
    const resolved = nodePath.resolve(directory);
    if (!this.isWithinArtifactRoot(resolved)) return;
    await rm(resolved, { recursive: true, force: true });
  }

  // ------------------------------------------------------------------
  // Authority provenance proof per frozen origin.
  // ------------------------------------------------------------------
  private assertAuthorityOriginProven(
    workspaceId: string,
    canonicalRunId: string,
    authorized: AuthorizedRuntimeEventContextV1,
  ): void {
    if (authorized.origin === 'operation') {
      const row = this.db.prepare(
        'SELECT 1 AS present FROM operations WHERE workspace_id = ? AND run_id = ? AND id = ?',
      ).get(workspaceId, canonicalRunId, authorized.authorityId) as { present: number } | undefined;
      if (row === undefined) {
        throw new GitObservationPersistenceError(
          'AUTHORITY_UNPROVEN',
          'Operation authority does not exist in this Workspace/canonical Run',
        );
      }
      return;
    }
    if (authorized.origin === 'persisted_event') {
      const row = this.db.prepare(
        'SELECT 1 AS present FROM runtime_events WHERE workspace_id = ? AND run_id = ? AND id = ?',
      ).get(workspaceId, canonicalRunId, authorized.authorityId) as { present: number } | undefined;
      if (row === undefined) {
        throw new GitObservationPersistenceError(
          'AUTHORITY_UNPROVEN',
          'Persisted Event authority does not exist in this Workspace/canonical Run',
        );
      }
      return;
    }
    // canonical_command: there is no durable authoritative canonical-command
    // registry in this repository. Use the injected verifier seam, or fail
    // closed for this origin instead of fabricating causation.
    const verifier = this.canonicalCommandVerifier;
    if (verifier === undefined
      || !verifier.verifyCanonicalCommandOwnership({
        workspaceId,
        canonicalRunId,
        commandId: authorized.authorityId,
      })) {
      throw new GitObservationPersistenceError(
        'AUTHORITY_UNPROVEN',
        'canonical_command authority cannot be proven by any durable registry',
      );
    }
  }

  // ------------------------------------------------------------------
  // Observation row assembly (frozen snapshot serialization only).
  // ------------------------------------------------------------------
  private buildObservationRow(
    command: GitObservationPersistenceCommandV1,
    observationId: string,
    admissionId: string | null,
    subjectKind: 'CANONICAL_RUN' | 'LEGACY_AGENT_RUN' | null,
    diffArtifactId: string | null,
  ): Parameters<WorkspaceGitObservationRepository['insertObservation']>[0] {
    const { snapshot, workspaceId } = command;
    const now = this.now().toISOString();

    const canonicalRunId = command.binding.subjectKind === 'CANONICAL_RUN'
      ? command.binding.canonicalRunId
      : null;
    const legacyRunId = command.binding.subjectKind === 'LEGACY_AGENT_RUN'
      ? command.binding.legacyRunId
      : null;

    const dirtyState: 'clean' | 'dirty' | 'unknown' | null =
      snapshot.observationState === 'GIT'
        ? snapshot.dirtyState
        : snapshot.observationState === 'UNAVAILABLE'
          ? 'unknown'
          : null;

    return {
      id: observationId,
      workspaceId,
      admissionId,
      subjectKind,
      canonicalRunId,
      legacyRunId,
      observationState: snapshot.observationState,
      repositoryRoot: snapshot.repositoryRoot,
      baseCommitSha: snapshot.baseCommitSha,
      dirtyState,
      statusSummaryJson: serializeGitObservationSnapshotV1(snapshot),
      changedFilesJson: snapshot.changedFiles === null
        ? null
        : serializeChangedFilesV1(snapshot.changedFiles),
      diffArtifactId,
      cwd: snapshot.cwd,
      errorCode: snapshot.observationState === 'UNAVAILABLE' ? snapshot.error?.code ?? null : null,
      observedAt: now,
      createdAt: now,
    };
  }
}
