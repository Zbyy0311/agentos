import type { Run, V2RunStatus } from '@agentos/shared';
import {
  LEGACY_PIPELINE_CANCELLED,
  LEGACY_PIPELINE_FAILED,
} from '../services/TaskRunService.js';

/**
 * Pure Bridge helpers (M2.4 §21). Ordering is NOT done here — callers must use
 * RunRepository.findLatestByTask(workspaceId, taskId) to select the latest Run.
 */

export function resolveBridgeRunReason(
  latestRun?: Run,
): { reason: 'initial' } | { reason: 'retry'; parentRunId: string } {
  if (!latestRun) return { reason: 'initial' };
  return { reason: 'retry', parentRunId: latestRun.id };
}

export type LegacyTerminal = 'completed' | 'failed' | 'cancelled';

export interface LegacyTerminalRunUpdate {
  to: V2RunStatus;
  failureCode?: string;
  failureMessage?: string;
}

export function mapLegacyTerminalToRunUpdate(terminal: LegacyTerminal, error?: string): LegacyTerminalRunUpdate {
  switch (terminal) {
    case 'completed':
      return { to: 'completed' };
    case 'failed':
      return { to: 'failed', failureCode: LEGACY_PIPELINE_FAILED, failureMessage: error };
    case 'cancelled':
      return { to: 'cancelled', failureCode: LEGACY_PIPELINE_CANCELLED, failureMessage: error };
  }
}
