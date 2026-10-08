import { createHash } from 'node:crypto';
import type { RuntimeArtifactService } from './RuntimeArtifactService.js';
import { redactRuntimeText } from '@agentos/agent-core';
import { isArtifactConclusion, type ArtifactCompletionConclusion } from '../store/ArtifactCompletionRepository.js';

export interface CanonicalArtifactResultInput {
  workspaceId: string; runId: string; stageId: string; stageAttempt: number;
  operationId: string; agentId: string; output: string | undefined;
}

export const ARTIFACT_RESULT_INSTRUCTION = '\nIf this stage actually completes a review or test, return only JSON ' +
  '{"agentosArtifact":{"version":1,"type":"review|test","conclusion":"approved|changes_requested|pass|fail","summary":"bounded evidence"}}. ' +
  'Use review with approved/changes_requested or test with pass/fail. Never claim completion or pass without evidence; ' +
  'otherwise respond normally. This is an unapproved Memory candidate, not execution authorization.';

/** Explicit final output contract; stage names and exit codes are not verdicts. */
export function parseArtifactResult(output: unknown): {
  type: 'review' | 'test'; conclusion: ArtifactCompletionConclusion; summary: string;
} | undefined {
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > 16384) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).join() !== 'agentosArtifact') return undefined;
  const result = (parsed as { agentosArtifact?: unknown }).agentosArtifact;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const row = result as Record<string, unknown>;
  if (Object.keys(row).sort().join() !== 'conclusion,summary,type,version' || row.version !== 1 ||
      !isArtifactConclusion(row.type, row.conclusion) || typeof row.summary !== 'string' ||
      !row.summary.trim() || Buffer.byteLength(row.summary, 'utf8') > 8192) return undefined;
  return { type: row.type as 'review' | 'test', conclusion: row.conclusion, summary: redactRuntimeText(row.summary, 8192) };
}

export class CanonicalArtifactResultService {
  constructor(private readonly artifacts: RuntimeArtifactService) {}
  async capture(input: CanonicalArtifactResultInput): Promise<string[]> {
    const result = parseArtifactResult(input.output);
    if (!result) return [];
    const sourceKey = 'canonical-result:' + createHash('sha256')
      .update(JSON.stringify([input.workspaceId, input.runId, input.stageId, input.stageAttempt])).digest('hex');
    const artifact = await this.artifacts.createCanonicalCompleted({ ...input, ...result, sourceKey });
    return [artifact.id];
  }
}
