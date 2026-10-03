import type { AgentProfile, GroupStopReason, RunIntent } from '@agentos/shared';
import type { ConversationRepository } from '../store/ConversationRepository.js';
import type { GroupInteractionRecord, GroupInteractionRepository } from '../store/GroupInteractionRepository.js';
import { createEntityId } from '../store/Identity.js';
import { BoundedGroupService } from './BoundedGroupService.js';
import type { ConversationStreamService } from './ConversationStreamService.js';
import { ConversationTurnDriver, type ConversationTurnContextOptions } from './ConversationTurnDriver.js';
import type { FinalizeStreamInput, FinalizeStreamResult } from './ConversationStreamService.js';
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
    readonly code: 'GROUP_WALK_INPUT_INVALID' | 'GROUP_WALK_NOT_ACTIVE' | 'GROUP_WALK_SOURCE_MISMATCH',
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
  /** The intent of the user request, forwarded to every speaker's generic Prompt contract. */
  readonly intent?: RunIntent;
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
  readonly interactionVersion: number;
  readonly ownerEpoch: number;
}

export interface GroupWalkResult {
  readonly plan: GroupSpeakerPlan;
  readonly speakers: readonly GroupSpeakerTurnOutcome[];
  readonly skipped: readonly GroupSpeakerSkip[];
  readonly endedBy: GroupWalkEnd;
  readonly interaction: GroupInteractionRecord | undefined;
  readonly ownerEpoch?: number;
  readonly eventCursor?: number;
}

export interface GroupTurnDriverOptions {
  /** Fired as soon as the plan is resolved, before any Provider Turn starts. */
  readonly onPlan?: (plan: GroupSpeakerPlan, state?: { readonly interactionVersion: number; readonly ownerEpoch: number; readonly eventCursor: number }) => void;
  /** Delta sink for the route: (speaker agentId, turnId, messageId, delta, checkpoint cursor). */
  readonly onSpeakerDelta?: (agentId: string, turnId: string, messageId: string, delta: string, checkpointCursor: number, eventCursor: number) => void;
  /** Fired right before a speaker's Provider Turn runs, with its durable ids. */
  readonly onSpeakerTurnStart?: (speaker: { readonly agentId: string; readonly turnId: string; readonly messageId: string; readonly interactionVersion: number; readonly ownerEpoch: number; readonly eventCursor: number }) => void;
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
  readonly roleTitle?: GroupSpeakerMember['roleTitle'];
  readonly model?: GroupSpeakerMember['model'];
  readonly thinkingEffort?: GroupSpeakerMember['thinkingEffort'];
  readonly additionalInstructions?: GroupSpeakerMember['additionalInstructions'];
  readonly settingsVersion?: GroupSpeakerMember['settingsVersion'];
}): GroupSpeakerMember {
  return {
    memberId: member.id,
    agentId: member.subjectType === 'agent' ? member.subjectId : null,
    role: member.role,
    replyMode: member.replyMode,
    status: member.status,
    joinedAt: member.joinedAt,
    ...(member.roleTitle === undefined ? {} : { roleTitle: member.roleTitle }),
    ...(member.model === undefined ? {} : { model: member.model }),
    ...(member.thinkingEffort === undefined ? {} : { thinkingEffort: member.thinkingEffort }),
    ...(member.additionalInstructions === undefined ? {} : { additionalInstructions: member.additionalInstructions }),
    ...(member.settingsVersion === undefined ? {} : { settingsVersion: member.settingsVersion }),
  };
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
    if (interaction.integrityStatus !== 'valid') throw new GroupTurnDriverError('GROUP_WALK_NOT_ACTIVE');
    if (interaction.sourceMessageId !== input.sourceMessageId) {
      throw new GroupTurnDriverError('GROUP_WALK_SOURCE_MISMATCH');
    }
    if (interaction.status !== 'active') {
      throw new GroupTurnDriverError('GROUP_WALK_NOT_ACTIVE', {
        ...(interaction.stopReason === null ? {} : { stopReason: interaction.stopReason }),
      });
    }

    const frozenMembers = this.conversations.listMembers(input.workspaceId, input.conversationId)
      .map(member => toSpeakerMember({ ...member, settingsVersion: conversation.settingsVersion }));
    const memberByAgentId = new Map(
      frozenMembers.filter((member): member is GroupSpeakerMember & { agentId: string } => member.agentId !== null)
        .map(member => [member.agentId, member]),
    );
    const plan = resolveGroupSpeakers({
      conversationKind: conversation.kind,
      conversationStatus: conversation.status,
      replyMode: conversation.replyMode,
      members: frozenMembers,
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
    const owner = this.boundedGroups.claimExecution({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      interactionId: input.interactionId,
      sourceMessageId: input.sourceMessageId,
      participantAgentIds: plan.speakers.map(speaker => speaker.agentId),
      ...(plan.speakers.length === 0 ? { allowEmptyParticipants: true } : {}),
      ownerId: createEntityId('event'),
      createdAt: input.createdAt,
    });
    const ownerController = new AbortController();
    const forwardAbort = (): void => ownerController.abort(input.signal?.reason);
    if (input.signal?.aborted) forwardAbort();
    else input.signal?.addEventListener('abort', forwardAbort, { once: true });
    const stopPoll = setInterval(() => {
      if (this.boundedGroups.isExecutionStopRequested(input.workspaceId, input.interactionId, owner.ownerId, owner.ownerEpoch)) {
        ownerController.abort(new Error('GROUP_USER_STOP'));
      }
    }, 30);
    stopPoll.unref?.();
    const planEvent = this.boundedGroups.appendExecutionEvent({
      workspaceId: input.workspaceId, interactionId: input.interactionId,
      ownerId: owner.ownerId, ownerEpoch: owner.ownerEpoch, eventType: 'group.plan',
      payload: { speakers: plan.speakers.map(speaker => speaker.agentId), skipped: plan.skipped }, updatedAt: input.createdAt,
    });
    options.onPlan?.(plan, { interactionVersion: interaction.version, ownerEpoch: owner.ownerEpoch, eventCursor: planEvent.cursor });

    const outcomes: GroupSpeakerTurnOutcome[] = [];
    let previousAgentId: string | undefined;
    const driver = new ConversationTurnDriver(
      this.conversations, this.stream, this.getAgent, options.runnerFactory, this.turnContext,
    );
    try {
      for (const speaker of plan.speakers) {
        options.beforeSpeaker?.(speaker.agentId);
        const current = this.boundedGroups.findInteraction(input.workspaceId, input.interactionId);
        if (current === undefined || current.status !== 'active' || ownerController.signal.aborted) {
          const latest = current ?? this.boundedGroups.findInteraction(input.workspaceId, input.interactionId);
          if (latest !== undefined) this.boundedGroups.completeExecution({
            workspaceId: input.workspaceId, interactionId: input.interactionId,
            ownerId: owner.ownerId, ownerEpoch: owner.ownerEpoch, completedAt: input.createdAt,
            reason: latest.stopReason ?? 'stopped-before-turn',
          });
          return {
            plan, speakers: outcomes, skipped: plan.skipped,
            endedBy: latest?.stopReason ?? 'user-stop',
            interaction: this.boundedGroups.findInteraction(input.workspaceId, input.interactionId),
            ownerEpoch: owner.ownerEpoch,
          };
        }

        const turnId = createEntityId('turn');
        const responseMessageId = createEntityId('message');
        const state = this.boundedGroups.setExecutionCurrentTurn({
          workspaceId: input.workspaceId, interactionId: input.interactionId,
          ownerId: owner.ownerId, ownerEpoch: owner.ownerEpoch, agentId: speaker.agentId,
          turnId, messageId: responseMessageId, updatedAt: input.createdAt,
        });
        const frozenMember = memberByAgentId.get(speaker.agentId);
        const runtimeOverrides = frozenMember === undefined
          ? undefined
          : {
            ...(frozenMember.model === undefined ? {} : { model: frozenMember.model }),
            ...(frozenMember.thinkingEffort === undefined ? {} : { thinkingEffort: frozenMember.thinkingEffort }),
          };
        options.onSpeakerTurnStart?.({
          agentId: speaker.agentId, turnId, messageId: responseMessageId,
          interactionVersion: current.version, ownerEpoch: owner.ownerEpoch, eventCursor: state.eventCursor,
        });
        let replyId: string | null = null;
        let result: Awaited<ReturnType<ConversationTurnDriver['replyWithTurn']>>;
        try {
          result = await driver.replyWithTurn({
            workspaceId: input.workspaceId,
            workspaceRoot: input.workspaceRoot,
            conversationId: input.conversationId,
            interactionId: input.interactionId,
            agentId: speaker.agentId,
            intent: input.intent ?? 'execute',
            sourceMessageId: input.sourceMessageId,
            content: source.content,
            turnId,
            responseMessageId,
            ...(runtimeOverrides === undefined || Object.keys(runtimeOverrides).length === 0 ? {} : { runtimeOverrides }),
            ...(frozenMember?.additionalInstructions === undefined ? {} : { additionalInstructions: frozenMember.additionalInstructions }),
            ...(frozenMember?.roleTitle === undefined ? {} : { groupRoleTitle: frozenMember.roleTitle }),
            ...(frozenMember?.settingsVersion === undefined ? {} : { groupSettingsVersion: frozenMember.settingsVersion }),
            onDelta: (delta, checkpointCursor) => {
              const event = this.boundedGroups.appendExecutionEvent({
                workspaceId: input.workspaceId, interactionId: input.interactionId,
                ownerId: owner.ownerId, ownerEpoch: owner.ownerEpoch, eventType: 'group.checkpoint',
                payload: { agentId: speaker.agentId, turnId, messageId: responseMessageId, checkpointCursor, delta },
                updatedAt: input.createdAt,
              });
              options.onSpeakerDelta?.(speaker.agentId, turnId, responseMessageId, delta, checkpointCursor, event.cursor);
            },
            signal: ownerController.signal,
            requireOwnedProcess: process.platform === 'win32',
            onNativeProcessStarted: ({ invocationId, pid, nativeBirthIdentity }) => {
              this.interactions.recordProviderProcessStarted({
                workspaceId: input.workspaceId,
                interactionId: input.interactionId,
                ownerId: owner.ownerId,
                ownerEpoch: owner.ownerEpoch,
                turnId,
                agentId: speaker.agentId,
                invocationId,
                pid,
                nativeBirthIdentity,
                startedAt: new Date().toISOString(),
              });
            },
            groupFinalizer: (finalization: FinalizeStreamInput, finalize: (input: FinalizeStreamInput) => FinalizeStreamResult) => {
              if (finalization.outcome === 'final') {
                const atomic = this.boundedGroups.finalizeExecutionReply({
                  workspaceId: input.workspaceId, interactionId: input.interactionId,
                  agentId: speaker.agentId, messageId: responseMessageId, turnId,
                  content: finalization.content ?? '', createdAt: finalization.updatedAt,
                  ...(previousAgentId === undefined ? {} : { hopFromAgentId: previousAgentId }),
                  ownerId: owner.ownerId, ownerEpoch: owner.ownerEpoch,
                  expectedTurnVersion: finalization.expectedTurnVersion,
                  expectedMessageVersion: finalization.expectedMessageVersion,
                }, finalization, finalize);
                if (atomic.kind === 'recorded') replyId = atomic.result.reply.id;
                return atomic.finalization;
              }
              return this.boundedGroups.finalizeExecutionFailure({
                workspaceId: input.workspaceId, interactionId: input.interactionId,
                ownerId: owner.ownerId, ownerEpoch: owner.ownerEpoch,
                eventType: 'group.turn.failed',
                terminalReason: finalization.failureCode ?? finalization.outcome,
                updatedAt: finalization.updatedAt,
              }, finalize, finalization);
            },
            createdAt: input.createdAt,
          });
        } catch (error) {
          this.boundedGroups.failExecution({
            workspaceId: input.workspaceId, interactionId: input.interactionId,
            ownerId: owner.ownerId, ownerEpoch: owner.ownerEpoch,
            reason: error instanceof Error ? error.message : String(error), updatedAt: input.createdAt,
          });
          const latest = this.boundedGroups.findInteraction(input.workspaceId, input.interactionId);
          const failedOutcome: GroupSpeakerTurnOutcome = {
            agentId: speaker.agentId, turnId, messageId: responseMessageId, status: 'failed', replyId: null,
            interactionVersion: latest?.version ?? interaction.version, ownerEpoch: owner.ownerEpoch,
          };
          outcomes.push(failedOutcome);
          options.onSpeakerTurnEnd?.(failedOutcome);
          return {
            plan, speakers: outcomes, skipped: plan.skipped,
            endedBy: latest?.stopReason ?? 'provider-failed', interaction: latest, ownerEpoch: owner.ownerEpoch,
          };
        }

        const latest = this.boundedGroups.findInteraction(input.workspaceId, input.interactionId);
        const settledOutcome: GroupSpeakerTurnOutcome = {
          agentId: speaker.agentId, turnId, messageId: responseMessageId,
          status: result.turn.status === 'final' ? 'final' : 'failed', replyId,
          interactionVersion: latest?.version ?? interaction.version, ownerEpoch: owner.ownerEpoch,
        };
        outcomes.push(settledOutcome);
        options.onSpeakerTurnEnd?.(settledOutcome);
        if (result.turn.status !== 'final') {
          return {
            plan, speakers: outcomes, skipped: plan.skipped,
            endedBy: latest?.stopReason ?? 'provider-failed', interaction: latest, ownerEpoch: owner.ownerEpoch,
          };
        }
        previousAgentId = speaker.agentId;
        if (latest === undefined || latest.status !== 'active') {
          const completed = this.boundedGroups.completeExecution({
            workspaceId: input.workspaceId, interactionId: input.interactionId,
            ownerId: owner.ownerId, ownerEpoch: owner.ownerEpoch, completedAt: input.createdAt,
            reason: latest?.stopReason ?? 'interaction-terminal',
          });
          return {
            plan, speakers: outcomes, skipped: plan.skipped,
            endedBy: latest?.stopReason ?? 'completed', interaction: completed, ownerEpoch: owner.ownerEpoch,
          };
        }
      }

      const completed = this.boundedGroups.completeExecution({
        workspaceId: input.workspaceId, interactionId: input.interactionId,
        ownerId: owner.ownerId, ownerEpoch: owner.ownerEpoch, completedAt: input.createdAt,
        reason: plan.speakers.length === 0 ? plan.terminalReason ?? 'no-speakers' : 'speakers-complete',
      });
      const completedOwner = this.boundedGroups.findExecutionOwner(input.workspaceId, input.interactionId);
      return {
        plan, speakers: outcomes, skipped: plan.skipped,
        endedBy: completed.stopReason !== null && completed.stopReason !== 'completed'
          ? completed.stopReason : plan.speakers.length === 0 ? plan.terminalReason ?? 'no-speakers' : 'completed',
        interaction: completed,
        ownerEpoch: owner.ownerEpoch, eventCursor: completedOwner?.eventCursor,
      };
    } finally {
      clearInterval(stopPoll);
      input.signal?.removeEventListener('abort', forwardAbort);
    }
  }
}
