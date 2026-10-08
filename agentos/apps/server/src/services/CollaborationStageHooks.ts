import type { CollaborationProgressRole, RunStage } from '@agentos/shared';

export interface CollaborationStagePreparationInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly stage: RunStage;
  readonly workspaceRoot: string;
  readonly worktreePath?: string;
}

export interface CollaborationStagePreparation {
  readonly workspaceRoot: string;
  readonly worktreePath: string;
  readonly promptAddition: string;
}

export interface CollaborationStageCompletionInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly stage: RunStage;
  readonly agentId: string;
  readonly role: CollaborationProgressRole;
  readonly output?: string;
}

/** Narrow bridge used only by the existing canonical collaboration Run. */
export interface CollaborationStageHooks {
  canDispatch?(workspaceId: string, runId: string): boolean;
  beforeStage(input: CollaborationStagePreparationInput): Promise<CollaborationStagePreparation | undefined>;
  completedStage(input: CollaborationStageCompletionInput): Promise<void>;
}
