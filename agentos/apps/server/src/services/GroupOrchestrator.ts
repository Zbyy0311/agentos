import type { Conversation, ConversationMember } from '@agentos/shared';
import { buildGroupTurns, parseDispatchEnvelope, resolveDispatchDecision, type DispatchDecision, type GroupTurn } from './GroupDispatchService.js';

export const MAX_GROUP_HANDOFF_CHARACTERS = 12_000;

export interface GroupHandoff {
  objective: string;
  publicPlan?: string;
  publicConclusion?: string;
  changedFiles: string[];
  artifactTitles: string[];
  failureSummary?: string;
}

export class GroupOrchestrator {
  decide(conversation: Pick<Conversation, 'dispatchMode'>, members: readonly ConversationMember[], mentionedAgentIds: readonly string[]): DispatchDecision {
    return resolveDispatchDecision(conversation, members, mentionedAgentIds);
  }

  turns(decision: DispatchDecision, members: readonly ConversationMember[], prompt: string): GroupTurn[] {
    return buildGroupTurns(decision, members, prompt);
  }

  parseLeaderDecision(output: string, nonce: string, members: readonly ConversationMember[]): DispatchDecision {
    return parseDispatchEnvelope(output, nonce, members);
  }

  sanitizeHandoff(input: GroupHandoff): string {
    const result = {
      objective: input.objective,
      ...(input.publicPlan ? { publicPlan: input.publicPlan } : {}),
      ...(input.publicConclusion ? { publicConclusion: input.publicConclusion } : {}),
      changedFiles: input.changedFiles.slice(0, 100),
      artifactTitles: input.artifactTitles.slice(0, 100),
      ...(input.failureSummary ? { failureSummary: input.failureSummary } : {}),
    };
    const serialized = JSON.stringify(result);
    return serialized.length <= MAX_GROUP_HANDOFF_CHARACTERS ? serialized : serialized.slice(0, MAX_GROUP_HANDOFF_CHARACTERS);
  }
}
