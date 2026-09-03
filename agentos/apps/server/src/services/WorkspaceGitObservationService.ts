import type {
  GitObservationRuntimeEventContextAuthorityV1,
  GitObservationSnapshotV1,
} from '@agentos/shared';
import type { SqliteStore } from '../store/SqliteStore.js';
import {
  WorkspaceGitObservationRepository,
  type WorkspaceGitObservationRow,
} from '../store/WorkspaceGitObservationRepository.js';
import {
  GIT_COMMAND_CLEANUP_UNPROVEN_MESSAGE,
} from './GitCommandAdapter.js';
import {
  GitObservationCollector,
  type GitObservationCollectInputV1,
  type GitObservationCollectOutcomeV1,
} from './GitObservationCollector.js';
import {
  GitObservationPersistenceService,
  type GitObservationPersistenceCommandV1,
  type GitObservationPersistenceResultV1,
} from './GitObservationPersistenceService.js';

export type WorkspaceGitObservationServiceErrorCode =
  | 'INPUT_INVALID'
  | 'WORKSPACE_NOT_FOUND'
  | 'COLLECTION_FAILED'
  | 'PERSISTENCE_FAILED'
  | 'CLEANUP_UNPROVEN';

/** Stable, data-free errors at the M4 server-local boundary. */
export class WorkspaceGitObservationServiceError extends Error {
  constructor(readonly code: WorkspaceGitObservationServiceErrorCode) {
    super(`WORKSPACE_GIT_OBSERVATION_${code}`);
    this.name = 'WorkspaceGitObservationServiceError';
  }
}

interface DurableWorkspaceStore {
  readonly workspaceRepo: {
    findById(workspaceId: string): { readonly rootPath: string } | undefined;
  };
}

interface ObservationCollector {
  collect(input: GitObservationCollectInputV1): Promise<GitObservationCollectOutcomeV1>;
}

interface ObservationPersistence {
  persist(command: GitObservationPersistenceCommandV1): Promise<GitObservationPersistenceResultV1>;
}

interface ObservationReads {
  findById(workspaceId: string, observationId: string): WorkspaceGitObservationRow | undefined;
  findLatestWorkspaceOnly(workspaceId: string): WorkspaceGitObservationRow | undefined;
}

interface WorkspaceGitObservationServiceDependencies {
  readonly store: DurableWorkspaceStore;
  readonly collector: ObservationCollector;
  readonly persistence: ObservationPersistence;
  readonly observations: ObservationReads;
}

const DENY_ALL_CANONICAL_AUTHORITY: GitObservationRuntimeEventContextAuthorityV1 = Object.freeze({
  authorize(): never {
    throw new Error('WORKSPACE_GIT_OBSERVATION_CANONICAL_AUTHORITY_DENIED');
  },
});

function requireNonEmpty(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WorkspaceGitObservationServiceError('INPUT_INVALID');
  }
  return value;
}

/**
 * P6-L1C-M4 explicit on-demand boundary. It owns only durable Workspace
 * resolution and fixed M2 -> Workspace-only M3 composition; M2 retains all
 * Git execution policy and M3 retains atomic persistence.
 */
export class WorkspaceGitObservationService {
  private readonly store: DurableWorkspaceStore;
  private readonly collector: ObservationCollector;
  private readonly persistence: ObservationPersistence;
  private readonly observations: ObservationReads;

  constructor(dependencies: WorkspaceGitObservationServiceDependencies) {
    this.store = dependencies.store;
    this.collector = dependencies.collector;
    this.persistence = dependencies.persistence;
    this.observations = dependencies.observations;
  }

  async observeOnDemand(input: {
    readonly workspaceId: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly observationId: string;
    readonly snapshot: GitObservationSnapshotV1;
  }> {
    const workspaceId = requireNonEmpty(input?.workspaceId);

    let workspace: { readonly rootPath: string } | undefined;
    try {
      workspace = this.store.workspaceRepo.findById(workspaceId);
    } catch {
      throw new WorkspaceGitObservationServiceError('PERSISTENCE_FAILED');
    }
    if (workspace === undefined) {
      throw new WorkspaceGitObservationServiceError('WORKSPACE_NOT_FOUND');
    }

    let outcome: GitObservationCollectOutcomeV1;
    try {
      outcome = await this.collector.collect({
        cwd: workspace.rootPath,
        trigger: 'on_demand',
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      if (error instanceof Error && error.message === GIT_COMMAND_CLEANUP_UNPROVEN_MESSAGE) {
        throw new WorkspaceGitObservationServiceError('CLEANUP_UNPROVEN');
      }
      throw new WorkspaceGitObservationServiceError('COLLECTION_FAILED');
    }

    let persisted: GitObservationPersistenceResultV1;
    try {
      persisted = await this.persistence.persist({
        workspaceId,
        snapshot: outcome.snapshot,
        binding: { subjectKind: 'WORKSPACE_ONLY' },
      });
    } catch {
      throw new WorkspaceGitObservationServiceError('PERSISTENCE_FAILED');
    }

    return {
      observationId: persisted.observationId,
      snapshot: outcome.snapshot,
    };
  }

  getById(input: {
    readonly workspaceId: string;
    readonly observationId: string;
  }): WorkspaceGitObservationRow | undefined {
    const workspaceId = requireNonEmpty(input?.workspaceId);
    const observationId = requireNonEmpty(input?.observationId);
    try {
      return this.observations.findById(workspaceId, observationId);
    } catch {
      throw new WorkspaceGitObservationServiceError('PERSISTENCE_FAILED');
    }
  }

  getLatestWorkspaceOnly(input: {
    readonly workspaceId: string;
  }): WorkspaceGitObservationRow | undefined {
    const workspaceId = requireNonEmpty(input?.workspaceId);
    try {
      return this.observations.findLatestWorkspaceOnly(workspaceId);
    } catch {
      throw new WorkspaceGitObservationServiceError('PERSISTENCE_FAILED');
    }
  }
}

/** Server-local production composition; intentionally not wired into startup. */
export function createWorkspaceGitObservationService(
  store: SqliteStore,
): WorkspaceGitObservationService {
  const collector = new GitObservationCollector();
  const persistence = new GitObservationPersistenceService({
    store,
    factWriter: store.runtimeEventOutboxWriter(),
    eventAuthority: DENY_ALL_CANONICAL_AUTHORITY,
  });
  const observations = new WorkspaceGitObservationRepository(store.getDatabase());
  return new WorkspaceGitObservationService({
    store,
    collector,
    persistence,
    observations,
  });
}
