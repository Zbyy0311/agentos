/**
 * P6-L1B canonical Artifact provenance contract.
 *
 * Migration 016 rebuilds runtime_artifacts into a dual-provenance shape
 * (LEGACY / CANONICAL). A canonical Artifact can exist WITHOUT fabricating an
 * agent_runs row, an executions row, or an agent identity. This type models
 * the additive canonical creation input; the legacy RuntimeArtifact contract
 * and its createRuntimeArtifact path are unchanged.
 */

import type { RuntimeArtifactType } from './index.js';

export type RuntimeArtifactProvenanceKind = 'LEGACY' | 'CANONICAL';

export interface CanonicalArtifactProvenance {
  readonly kind: 'CANONICAL';
  /** Owning canonical Run (runs.id); required, same Workspace. */
  readonly canonicalRunId: string;
  /** Optional canonical provenance references (must belong to the Run/Workspace). */
  readonly sourceProcessId?: string;
  readonly sourceOperationId?: string;
  readonly sourceStageId?: string;
}

/**
 * The explicit canonical Artifact read contract. Legacy reads
 * (getRuntimeArtifactRecord) only ever see provenanceKind = 'LEGACY' rows and
 * keep their non-null runId/sourceExecutionId/agentId contract; canonical
 * rows are read through this shape instead, where the optional provenance and
 * agent identity fields are honestly nullable. Nothing here weakens the
 * legacy RuntimeArtifact contract.
 */
export interface CanonicalRuntimeArtifactRecord {
  readonly provenanceKind: 'CANONICAL';
  readonly id: string;
  readonly workspaceId: string;
  readonly canonicalRunId: string;
  readonly agentId: string | null;
  readonly sourceProcessId: string | null;
  readonly sourceOperationId: string | null;
  readonly sourceStageId: string | null;
  readonly type: RuntimeArtifactType;
  readonly title: string;
  readonly summary: string | null;
  readonly originalPath: string | null;
  readonly storageKey: string | null;
  readonly mimeType: string | null;
  readonly sizeBytes: number;
  readonly sha256: string | null;
  readonly contentAvailable: boolean;
  readonly createdAt: string;
}
