/**
 * P6-L1B canonical Artifact provenance contract.
 *
 * Migration 016 rebuilds runtime_artifacts into a dual-provenance shape
 * (LEGACY / CANONICAL). A canonical Artifact can exist WITHOUT fabricating an
 * agent_runs row, an executions row, or an agent identity. This type models
 * the additive canonical creation input; the legacy RuntimeArtifact contract
 * and its createRuntimeArtifact path are unchanged.
 */

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
