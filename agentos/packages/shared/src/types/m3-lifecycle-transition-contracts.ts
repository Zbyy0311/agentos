import type { M3RunStatus } from './m3-run-status.js';
import type { M3StageStatus } from './m3-runtime.js';
import type { M3RuntimeEventType } from './m3-runtime.js';

export type M3TransitionFrom = M3RunStatus | M3StageStatus | null;

export interface M3TransitionEventContract {
  readonly aggregate: 'run' | 'stage';
  readonly from: M3TransitionFrom;
  readonly to: M3RunStatus | M3StageStatus;
  readonly primaryEvent: M3RuntimeEventType;
  readonly terminal: boolean;
}

export interface M3MultiEventOrderingContract {
  readonly name:
    | 'startup-completion'
    | 'approval-failure'
    | 'approval-cancellation'
    | 'run-cancellation'
    | 'run-completion';
  readonly events: readonly M3RuntimeEventType[];
}

function freezeTransitionContracts(
  contracts: readonly M3TransitionEventContract[],
): readonly M3TransitionEventContract[] {
  return Object.freeze(contracts.map(contract => Object.freeze({ ...contract })));
}

function freezeEventSequence(events: readonly M3RuntimeEventType[]): readonly M3RuntimeEventType[] {
  return Object.freeze([...events]);
}

export const M3_RUN_TRANSITION_EVENT_CONTRACTS = freezeTransitionContracts([
  { aggregate: 'run', from: null, to: 'queued', primaryEvent: 'run.created', terminal: false },
  { aggregate: 'run', from: 'queued', to: 'starting', primaryEvent: 'run.dequeued', terminal: false },
  { aggregate: 'run', from: 'queued', to: 'cancelled', primaryEvent: 'run.cancelled', terminal: true },
  { aggregate: 'run', from: 'starting', to: 'running', primaryEvent: 'run.started', terminal: false },
  { aggregate: 'run', from: 'starting', to: 'failed', primaryEvent: 'run.failed', terminal: true },
  { aggregate: 'run', from: 'starting', to: 'cancelled', primaryEvent: 'run.cancelled', terminal: true },
  { aggregate: 'run', from: 'running', to: 'waiting_approval', primaryEvent: 'approval.required', terminal: false },
  { aggregate: 'run', from: 'running', to: 'paused', primaryEvent: 'run.paused', terminal: false },
  { aggregate: 'run', from: 'running', to: 'completed', primaryEvent: 'run.completed', terminal: true },
  { aggregate: 'run', from: 'running', to: 'failed', primaryEvent: 'run.failed', terminal: true },
  { aggregate: 'run', from: 'running', to: 'cancelled', primaryEvent: 'run.cancelled', terminal: true },
  { aggregate: 'run', from: 'waiting_approval', to: 'running', primaryEvent: 'approval.resolved', terminal: false },
  { aggregate: 'run', from: 'waiting_approval', to: 'failed', primaryEvent: 'run.failed', terminal: true },
  { aggregate: 'run', from: 'waiting_approval', to: 'cancelled', primaryEvent: 'run.cancelled', terminal: true },
  { aggregate: 'run', from: 'paused', to: 'running', primaryEvent: 'run.resumed', terminal: false },
  { aggregate: 'run', from: 'paused', to: 'failed', primaryEvent: 'run.failed', terminal: true },
  { aggregate: 'run', from: 'paused', to: 'cancelled', primaryEvent: 'run.cancelled', terminal: true },
]);

export const M3_STAGE_TRANSITION_EVENT_CONTRACTS = freezeTransitionContracts([
  { aggregate: 'stage', from: null, to: 'pending', primaryEvent: 'stage.created', terminal: false },
  { aggregate: 'stage', from: 'pending', to: 'ready', primaryEvent: 'stage.ready', terminal: false },
  { aggregate: 'stage', from: 'pending', to: 'skipped', primaryEvent: 'stage.skipped', terminal: true },
  { aggregate: 'stage', from: 'pending', to: 'cancelled', primaryEvent: 'stage.cancelled', terminal: true },
  { aggregate: 'stage', from: 'ready', to: 'starting', primaryEvent: 'stage.starting', terminal: false },
  { aggregate: 'stage', from: 'ready', to: 'cancelled', primaryEvent: 'stage.cancelled', terminal: true },
  { aggregate: 'stage', from: 'starting', to: 'running', primaryEvent: 'stage.started', terminal: false },
  { aggregate: 'stage', from: 'starting', to: 'failed', primaryEvent: 'stage.failed', terminal: true },
  { aggregate: 'stage', from: 'starting', to: 'cancelled', primaryEvent: 'stage.cancelled', terminal: true },
  { aggregate: 'stage', from: 'running', to: 'waiting_approval', primaryEvent: 'approval.required', terminal: false },
  { aggregate: 'stage', from: 'running', to: 'paused', primaryEvent: 'stage.paused', terminal: false },
  { aggregate: 'stage', from: 'running', to: 'completed', primaryEvent: 'stage.completed', terminal: true },
  { aggregate: 'stage', from: 'running', to: 'failed', primaryEvent: 'stage.failed', terminal: true },
  { aggregate: 'stage', from: 'running', to: 'cancelled', primaryEvent: 'stage.cancelled', terminal: true },
  { aggregate: 'stage', from: 'waiting_approval', to: 'running', primaryEvent: 'approval.resolved', terminal: false },
  { aggregate: 'stage', from: 'waiting_approval', to: 'failed', primaryEvent: 'stage.failed', terminal: true },
  { aggregate: 'stage', from: 'waiting_approval', to: 'cancelled', primaryEvent: 'stage.cancelled', terminal: true },
  { aggregate: 'stage', from: 'paused', to: 'running', primaryEvent: 'stage.resumed', terminal: false },
  { aggregate: 'stage', from: 'paused', to: 'cancelled', primaryEvent: 'stage.cancelled', terminal: true },
]);

export const M3_MULTI_EVENT_ORDERING_CONTRACTS: readonly M3MultiEventOrderingContract[] = Object.freeze([
  Object.freeze({ name: 'startup-completion', events: freezeEventSequence(['stage.started', 'run.started']) }),
  Object.freeze({ name: 'approval-failure', events: freezeEventSequence(['approval.resolved', 'stage.failed', 'run.failed']) }),
  Object.freeze({ name: 'approval-cancellation', events: freezeEventSequence(['approval.resolved', 'stage.cancelled', 'run.cancelled']) }),
  Object.freeze({ name: 'run-cancellation', events: freezeEventSequence(['stage.cancelled', 'run.cancelled']) }),
  Object.freeze({ name: 'run-completion', events: freezeEventSequence(['stage.completed', 'run.completed']) }),
]);

export const M3_RUN_TERMINAL_STATUSES: readonly M3RunStatus[] = Object.freeze([
  'completed',
  'failed',
  'cancelled',
]);

export const M3_STAGE_TERMINAL_STATUSES: readonly M3StageStatus[] = Object.freeze([
  'completed',
  'failed',
  'cancelled',
  'skipped',
]);

export function getM3RunTransitionEventContract(
  from: M3RunStatus | null,
  to: M3RunStatus,
): M3TransitionEventContract | undefined {
  return M3_RUN_TRANSITION_EVENT_CONTRACTS.find(
    contract => contract.from === from && contract.to === to,
  );
}

export function getM3StageTransitionEventContract(
  from: M3StageStatus | null,
  to: M3StageStatus,
): M3TransitionEventContract | undefined {
  return M3_STAGE_TRANSITION_EVENT_CONTRACTS.find(
    contract => contract.from === from && contract.to === to,
  );
}
