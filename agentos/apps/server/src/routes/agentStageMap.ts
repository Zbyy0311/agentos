import type { AgentStage, AgentRole } from '@agentos/shared';

/**
 * Maps AgentStage (codex_manager, kimi_worker, ...) to workspace AgentRole (codex, kimi, opencode).
 */
export const STAGE_ROLE_MAP: Record<AgentStage, AgentRole> = {
  codex_manager: 'codex',
  kimi_worker: 'kimi',
  opencode_reviewer: 'opencode',
  codex_final_review: 'codex',
};
