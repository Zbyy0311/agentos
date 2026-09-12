import type { AgentProfile, GroupStopReason } from '@agentos/shared';
import type { ConversationRepository } from '../store/ConversationRepository.js';
import type { GroupInteractionRecord, GroupInteractionRepository } from '../store/GroupInteractionRepository.js';
import { createEntityId } from '../store/Identity.js';
import { BoundedGroupError, BoundedGroupService } from './BoundedGroupService.js';
import type { ConversationStreamService } from './ConversationStreamService.js';
import { ConversationTurnDriver, type ConversationTurnContextOptions } from './ConversationTurnDriver.js';
import {
  resolveGroupSpeakers,
  type GroupSpeakerMember,
  type GroupSpeakerPlan,
  type GroupSpeakerSkip,
} from './GroupSpeakerResolver.js';

/**
 * Controlled Group Conversation — the bounded execution driver.
 *
 * Authorization: `docs/implementation/milestones/CG-orchestration-entry-audit.md`
 * section 5.2 and gates CG-S5..CG-S9.
 *
 * Decision D1=B (template-declared deterministic speaker order), D2=A (the
 * merged CR-3 reply stream is the execution channel), D3 off (no
 * `parallel-read-only`: every speaker is treated as modifying and serialized).
 *
 * The driver owns exactly one bounded walk: resolve the plan, then run each
 * speaker through `ConversationTurnDriver.replyWithTurn` and record the reply
 * through `BoundedGroupService.recordReply`. It never bypasses that recorder, so
 * budgets, stop, and the loop guard remain the only terminators.
 */

export type GroupWalkEnd =
  | 'completed'
  | 'no-speakers'
  | 'provider-failed'
  | 'agent-unavailable'
  | GroupStopReason;

export class GroupTurnDriverError extends Error {
  readonly stopReason?: GroupStopReason;
  constructor(
    readonly code: 'GROUP_WALK_INPUT_INVALID' | 'GROUP_WALK_NOT_ACTIVE',
    options: { readonly stopReason?: GroupStopReason } = {},
  ) {
    super(options.stopReason === undefined ? code : code + ': ' + options.stopReason);
    this.name = 'GroupTurnDriverError';
    if (options.stopReason !== undefined) this.stopReason = options.stopReason;
  }
}

export interface GroupWalkInput {
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly conversationId: string;
  readonly interactionId: string;
  /** The durable user Message this walk answers; every speaker answers the SAME message. */
  readonly sourceMessageId: string;
  readonly mentionedAgentIds?: readonly string[];
  readonly namedAgentIds?: readonly string[];
  readonly orchestratedOrder?: readonly string[];
  readonly signal?: AbortSignal;
  readonly createdAt: string;
}

export interface GroupSpeakerTurnOutcome {
  readonly agentId: string;
  readonly turnId: string;
  readonly messageId: string;
  readonly status: 'final' | 'failed';
  /** Set when the reply was recorded; null when the loop guard or a budget rejected it. */
  readonly replyId: string | null;
}

export interface GroupWalkResult {
  readonly plan: GroupSpeakerPlan;
  readonly speakers: readonly GroupSpeakerTurnOutcome[];
  readonly skipped: readonly GroupSpeakerSkip[];
  readonly endedBy: GroupWalkEnd;
  readonly interaction: GroupInteractionRecord | undefined;
}

export interface GroupTurnDriverOptions {
  /** Fired as soon as the plan is resolved, before any Provider Turn starts. */
  readonly onPlan?: (plan: GroupSpeakerPlan) => void;
  /** Delta sink for the route: (speaker agentId, turnId, messageId, delta, checkpoint cursor). */
  readonly onSpeakerDelta?: (agentId: string, turnId: string, messageId: string, delta: string, cursor: number) => void;
  /** Fired right before a speaker's Provider Turn runs, with its durable ids. */
  readonly onSpeakerTurnStart?: (speaker: { readonly agentId: string; readonly turnId: string; readonly messageId: string }) => void;
  /** Fired as each speaker's Turn settles, so a route can emit per-Turn final events. */
  readonly onSpeakerTurnEnd?: (outcome: GroupSpeakerTurnOutcome) => void;
  /**
   * Runs before each speaker's Turn (and lets a test or a UI stop the
   * interaction between speakers). The driver re-reads the interaction right
   * after this hook, so a `stop` issued here ends the walk with no further Turn.
   */
  readonly beforeSpeaker?: (agentId: string) => void;
  /** Injection point for the Provider runner (tests only). */
  readonly runnerFactory?: ConstructorParameters<typeof ConversationTurnDriver>[3];
}

function toSpeakerMember(member: {
  readonly id: string;
  readonly subjectType: 'user' | 'agent';
  readonly subjectId: string;
  readonly role: GroupSpeakerMember['role'];
  readonly replyMode: GroupSpeakerMember['replyMode'];
  readonly status: GroupSpeakerMember['status'];
  readonly joinedAt: string;
}): GroupSpeakerMember {
  return {
    memberId: member.id,
    agentId: member.subjectType === 'agent' ? member.subjectId : null,
    role: member.role,
    replyMode: member.replyMode,
    status: member.status,
    joinedAt: member.joinedAt,
  };
}

function endFromError(error: BoundedGroupError): GroupStopReason {
  return error.stopReason ?? (error.code === 'GROUP_LOOP_GUARD' ? 'loop-guard' : 'budget-total-replies');
}

export class GroupTurnDriver {
  constructor(
    private readonly boundedGroups: BoundedGroupService,
    private readonly interactions: GroupInteractionRepository,
    private readonly conversations: ConversationRepository,
    private readonly stream: ConversationStreamService,
    private readonly getAgent: (workspaceId: string, agentId: string) => AgentProfile | undefined,
    /** LITE-09-101: per-Agent frozen context options handed to each speaker Turn. */
    private readonly turnContext?: ConversationTurnContextOptions,
  ) {}

  /**
   * Run one bounded walk over the resolved speaker plan.
   *
   * Each speaker runs strictly one at a time (CG-S9), and the interaction is
   * re-read before every speaker so a `stop` issued mid-walk takes effect
   * before the next Provider call (CG-S5).
   */
  async run(input: GroupWalkInput, options: GroupTurnDriverOptions = {}): Promise<GroupWalkResult> {
    const conversation = this.conversations.findConversationById(input.workspaceId, input.conversationId);
    if (conversation === undefined
      || conversation.kind !== 'group'
      || conversation.status !== 'active') {
      throw new GroupTurnDriverError('GROUP_WALK_INPUT_INVALID');
    }
    const source = this.conversations.findMessageById(input.workspaceId, input.sourceMessageId);
    if (source === undefined
      || source.conversationId !== input.conversationId
      || source.senderType !== 'user'
      || source.status === 'deleted') {
      throw new GroupTurnDriverError('GROUP_WALK_INPUT_INVALID');
    }
    const interaction = this.boundedGroups.findInteraction(input.workspaceId, input.interactionId);
    if (interaction === undefined || interaction.conversationId !== input.conversationId) {
      throw new GroupTurnDriverError('GROUP_WALK_INPUT_INVALID');
    }
    if (interaction.status !== 'active') {
      throw new GroupTurnDriverError('GROUP_WALK_NOT_ACTIVE', {
        ...(interaction.stopReason === null ? {} : { stopReason: interaction.stopReason }),
      });
    }

    const plan = resolveGroupSpeakers({
      conversationKind: conversation.kind,
      conversationStatus: conversation.status,
      replyMode: conversation.replyMode,
      members: this.conversations.listMembers(input.workspaceId, input.conversationId).map(toSpeakerMember),
      ...(input.mentionedAgentIds === undefined ? {} : { mentionedAgentIds: input.mentionedAgentIds }),
      ...(input.namedAgentIds === undefined ? {} : { namedAgentIds: input.namedAgentIds }),
      ...(input.orchestratedOrder === undefined ? {} : { orchestratedOrder: input.orchestratedOrder }),
      replyAgentIds: this.interactions.listReplies(interaction.id).map(reply => reply.agentId),
      budget: {
        maxAgentsPerTurn: interaction.maxAgentsPerTurn,
        maxRepliesPerAgent: interaction.maxRepliesPerAgent,
        maxTotalReplies: interaction.maxTotalReplies,
      },
    });
    options.onPlan?.(plan);
    if (plan.speakers.length === 0) {
      return {
        plan, speakers: [], skipped: plan.skipped,
        endedBy: plan.terminalReason ?? 'no-speakers',
        interaction,
      };
    }
    const outcomes: GroupSpeakerTurnOutcome[] = [];
    let previousAgentId: string | undefined;
    const driver = new ConversationTurnDriver(
      this.conversations, this.stream, this.getAgent, options.runnerFactory, this.turnContext,
    );

    for (const speaker of plan.speakers) {
      options.beforeSpeaker?.(speaker.agentId);
      const current = this.boundedGroups.findInteraction(input.workspaceId, input.interactionId);
      if (current === undefined || current.status !== 'active') {
        return {
          plan, speakers: outcomes, skipped: plan.skipped,
          endedBy: current?.stopReason ?? 'user-stop',
          interaction: current,
        };
      }

      const turnId = createEntityId('turn');
      const responseMessageId = createEntityId('message');
      options.onSpeakerTurnStart?.({ agentId: speaker.agentId, turnId, messageId: responseMessageId });
      const result = await driver.replyWithTurn({
        workspaceId: input.workspaceId,
        workspaceRoot: input.workspaceRoot,
        conversationId: input.conversationId,
        agentId: speaker.agentId,
        sourceMessageId: input.sourceMessageId,
        content: source.content,
        turnId,
        responseMessageId,
        onDelta: (delta, cursor) => options.onSpeakerDelta?.(speaker.agentId, turnId, responseMessageId, delta, cursor),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        createdAt: input.createdAt,
      });

      if (result.turn.status !== 'final') {
        // CG-S7: a failed Turn writes no interaction reply and moves no budget.
        const failedOutcome: GroupSpeakerTurnOutcome = { agentId: speaker.agentId, turnId, messageId: responseMessageId, status: 'failed', replyId: null };
        outcomes.push(failedOutcome);
        options.onSpeakerTurnEnd?.(failedOutcome);
        return {
          plan, speakers: outcomes, skipped: plan.skipped, endedBy: 'provider-failed',
          interaction: this.boundedGroups.findInteraction(input.workspaceId, input.interactionId),
        };
      }

      let replyId: string | null = null;
      try {
        const recorded = this.boundedGroups.recordReply({
          workspaceId: input.workspaceId,
          interactionId: input.interactionId,
          agentId: speaker.agentId,
          messageId: responseMessageId,
          content: result.content,
          ...(previousAgentId === undefined ? {} : { hopFromAgentId: previousAgentId }),
          turnId,
          createdAt: input.createdAt,
        });
        replyId = recorded.reply.id;
      } catch (error) {
        if (error instanceof BoundedGroupError
          && (error.code === 'GROUP_LOOP_GUARD' || error.code === 'GROUP_BUDGET_EXCEEDED'
            || error.code === 'GROUP_INTERACTION_TERMINATED')) {
          // The budget or loop guard ended the interaction BEFORE recording, so
          // this reply is not part of the interaction's durable accounting.
          const refusedOutcome: GroupSpeakerTurnOutcome = { agentId: speaker.agentId, turnId, messageId: responseMessageId, status: 'final', replyId: null };
          outcomes.push(refusedOutcome);
          options.onSpeakerTurnEnd?.(refusedOutcome);
          return {
            plan, speakers: outcomes, skipped: plan.skipped, endedBy: endFromError(error),
            interaction: this.boundedGroups.findInteraction(input.workspaceId, input.interactionId),
          };
        }
        throw error;
      }

      outcomes.push({ agentId: speaker.agentId, turnId, messageId: responseMessageId, status: 'final', replyId });
      options.onSpeakerTurnEnd?.(outcomes[outcomes.length - 1]!);
      previousAgentId = speaker.agentId;
      const after = this.boundedGroups.findInteraction(input.workspaceId, input.interactionId);
      if (after === undefined || after.status !== 'active') {
        return {
          plan, speakers: outcomes, skipped: plan.skipped,
          endedBy: after?.stopReason ?? 'completed',
          interaction: after,
        };
      }
    }

    return {
      plan, speakers: outcomes, skipped: plan.skipped, endedBy: 'completed',
      interaction: this.boundedGroups.findInteraction(input.workspaceId, input.interactionId),
    };
  }
}
