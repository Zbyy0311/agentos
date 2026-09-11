/**
 * Controlled Group Conversation — the bounded walk stream state (Lite 12 §13).
 *
 * A pure reducer over the walk's SSE events so the view renders a plain object
 * and every state transition is testable without a DOM or a network. The walk
 * is chat-class: it never creates a Task or Run.
 */

export type GroupWalkPhase = 'idle' | 'walking' | 'done' | 'failed';

export type GroupWalkSpeakerStatus = 'started' | 'streaming' | 'final' | 'failed';

export interface GroupWalkSpeakerState {
  readonly agentId: string;
  readonly turnId: string;
  readonly messageId: string;
  readonly status: GroupWalkSpeakerStatus;
  /** Accumulated Provider text for this speaker, from durable checkpoints. */
  readonly content: string;
  readonly replyId: string | null;
}

export interface GroupWalkSkip {
  readonly agentId: string | null;
  readonly reason: string;
}

export interface GroupWalkStreamState {
  readonly phase: GroupWalkPhase;
  readonly interactionId: string | null;
  readonly plannedSpeakers: readonly string[];
  readonly skipped: readonly GroupWalkSkip[];
  readonly terminalReason: string | null;
  readonly speakers: readonly GroupWalkSpeakerState[];
  readonly endedBy: string | null;
  readonly error: string | null;
}

export function emptyGroupWalk(): GroupWalkStreamState {
  return {
    phase: 'idle',
    interactionId: null,
    plannedSpeakers: [],
    skipped: [],
    terminalReason: null,
    speakers: [],
    endedBy: null,
    error: null,
  };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asSpeakerList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function asSkipList(value: unknown): GroupWalkSkip[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
    .map(v => ({ agentId: asString(v.agentId), reason: asString(v.reason) ?? 'unknown' }));
}

function upsertSpeaker(
  speakers: readonly GroupWalkSpeakerState[],
  turnId: string,
  update: (existing: GroupWalkSpeakerState | undefined) => GroupWalkSpeakerState,
): GroupWalkSpeakerState[] {
  const index = speakers.findIndex(speaker => speaker.turnId === turnId);
  if (index === -1) return [...speakers, update(undefined)];
  return speakers.map((speaker, i) => (i === index ? update(speaker) : speaker));
}

/**
 * Apply one walk SSE event. Every event the route emits is one durable state
 * transition; anything else is ignored so an unknown event never corrupts state.
 */
export function applyGroupWalkEvent(
  state: GroupWalkStreamState,
  event: string,
  data: Record<string, unknown>,
): GroupWalkStreamState {
  switch (event) {
    case 'group.plan': {
      return {
        ...state,
        phase: 'walking',
        interactionId: asString(data.interactionId) ?? state.interactionId,
        plannedSpeakers: asSpeakerList(data.speakers),
        skipped: asSkipList(data.skipped),
        terminalReason: asString(data.terminalReason),
        error: null,
      };
    }
    case 'group.turn.start': {
      const agentId = asString(data.agentId) ?? '';
      const turnId = asString(data.turnId) ?? '';
      return {
        ...state,
        speakers: upsertSpeaker(state.speakers, turnId, () => ({
          agentId, turnId, messageId: asString(data.messageId) ?? '', status: 'started', content: '', replyId: null,
        })),
      };
    }
    case 'checkpoint': {
      const turnId = asString(data.turnId);
      const delta = asString(data.delta);
      if (turnId === null || delta === null) return state;
      // A checkpoint never creates a speaker: the turn.start event is the durable
      // reservation, so a delta for an unknown turn is dropped, not phantom-made.
      if (!state.speakers.some(speaker => speaker.turnId === turnId)) return state;
      return {
        ...state,
        speakers: upsertSpeaker(state.speakers, turnId, existing => ({
          agentId: asString(data.agentId) ?? existing?.agentId ?? '',
          turnId,
          messageId: asString(data.messageId) ?? existing?.messageId ?? '',
          status: 'streaming',
          content: (existing?.content ?? '') + delta,
          replyId: existing?.replyId ?? null,
        })),
      };
    }
    case 'group.turn.final':
    case 'group.turn.failed': {
      const turnId = asString(data.turnId);
      if (turnId === null) return state;
      const status: GroupWalkSpeakerStatus = event === 'group.turn.final' ? 'final' : 'failed';
      return {
        ...state,
        speakers: upsertSpeaker(state.speakers, turnId, existing => ({
          agentId: asString(data.agentId) ?? existing?.agentId ?? '',
          turnId,
          messageId: asString(data.messageId) ?? existing?.messageId ?? '',
          status,
          content: existing?.content ?? '',
          replyId: asString(data.replyId),
        })),
      };
    }
    case 'group.error': {
      return {
        ...state,
        phase: 'failed',
        error: asString(data.error) ?? 'GROUP_WALK_FAILED',
      };
    }
    case 'group.done': {
      return {
        ...state,
        phase: state.phase === 'failed' ? 'failed' : 'done',
        endedBy: asString(data.endedBy) ?? state.endedBy,
        interactionId: asString(data.interactionId) ?? state.interactionId,
      };
    }
    default:
      return state;
  }
}
