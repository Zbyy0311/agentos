import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  RuntimeEventConsumptionResult,
  RuntimeEventEnvelope,
  RuntimeEventVisibility,
  UnknownRuntimeEvent,
} from '@agentos/shared';
import type { RuntimeEventRunQuery, RuntimeEventRunQueryResult } from '../store/RuntimeEventRepository.js';
import { RuntimeEventNotifier } from './RuntimeEventNotifier.js';
import { RunStreamService, type RunStreamRepository } from './RunStreamService.js';

const WORKSPACE_ID = 'workspace_p5b';
const RUN_ID = 'run_p5b';

function event(
  sequence: number,
  visibility: RuntimeEventVisibility = 'public',
  runId = RUN_ID,
): RuntimeEventEnvelope {
  return {
    id: `evt_${String(sequence).padStart(26, '0')}`,
    schemaVersion: 1,
    type: 'run.created',
    workspaceId: WORKSPACE_ID,
    runId,
    sequence,
    timestamp: '2026-08-10T00:00:00.000Z',
    source: 'system',
    correlationId: `corr_${sequence}`,
    severity: 'info',
    visibility,
    durability: 'durable',
    payload: visibility === 'restricted' ? { secret: 'restricted-p5b-secret' } : { sequence },
  };
}

function unknownEvent(sequence: number): UnknownRuntimeEvent {
  return {
    ...event(sequence),
    type: 'future.p5b.event',
    kind: 'unknown_runtime_event',
    warning: 'UNKNOWN_EVENT_TYPE',
    raw: { future: true, sequence },
  };
}

class FakeRunStreamRepository implements RunStreamRepository {
  readonly events = new Map<number, RuntimeEventConsumptionResult>();
  beforeHighWatermark?: () => void;

  constructor(initial: Array<RuntimeEventEnvelope | UnknownRuntimeEvent> = []) {
    for (const item of initial) this.add(item);
  }

  add(item: RuntimeEventEnvelope | UnknownRuntimeEvent): void {
    if ('kind' in item && item.kind === 'unknown_runtime_event') {
      this.events.set(item.sequence, { kind: 'unknown', event: item });
    } else {
      this.events.set(item.sequence, { kind: 'known', event: item as RuntimeEventEnvelope });
    }
  }

  getRunHighWatermark(workspaceId: string, runId: string): number {
    this.beforeHighWatermark?.();
    return Math.max(0, ...[...this.events.values()]
      .map(result => result.event)
      .filter(item => item.workspaceId === workspaceId && item.runId === runId)
      .map(item => item.sequence));
  }

  queryByRun(input: RuntimeEventRunQuery): RuntimeEventRunQueryResult {
    const matching = [...this.events.values()]
      .filter(result => result.event.workspaceId === input.workspaceId)
      .filter(result => result.event.runId === input.runId)
      .filter(result => result.event.sequence > input.afterSequence)
      .filter(result => input.beforeSequence === undefined || result.event.sequence < input.beforeSequence)
      .filter(result => input.visibilities === undefined
        || input.visibilities.includes(result.event.visibility as RuntimeEventVisibility))
      .sort((left, right) => left.event.sequence - right.event.sequence);
    return {
      results: matching.slice(0, input.limit),
      hasMore: matching.length > input.limit,
    };
  }

  findDurableByWorkspaceRunAndSequence(workspaceId: string, runId: string, sequence: number) {
    const result = this.events.get(sequence);
    return result?.event.workspaceId === workspaceId && result.event.runId === runId
      ? result
      : undefined;
  }
}

test('P5B-G13/G14/G15 replay, duplicate and out-of-order hints deliver once in strict ASC order', () => {
  const repository = new FakeRunStreamRepository([event(1), event(2), event(3)]);
  const notifier = new RuntimeEventNotifier();
  const service = new RunStreamService(repository, notifier);
  const received: number[] = [];
  service.subscribe({
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    afterSequence: 0,
    onEvent: item => received.push(item.sequence),
    onOverflow: () => assert.fail('unexpected overflow'),
  });
  assert.deepEqual(received, [1, 2, 3]);

  repository.add(event(4));
  repository.add(event(5));
  notifier.publish({ runId: RUN_ID, sequence: 5, eventId: event(5).id });
  notifier.publish({ runId: RUN_ID, sequence: 4, eventId: event(4).id });
  notifier.publish({ runId: RUN_ID, sequence: 5, eventId: event(5).id });
  assert.deepEqual(received, [1, 2, 3, 4, 5]);
});

test('P5B-G16/G17/G18 public/internal and unknown records survive while restricted payload stays hidden', () => {
  const repository = new FakeRunStreamRepository([
    unknownEvent(1),
    event(2, 'restricted'),
    event(3, 'internal'),
  ]);
  const notifier = new RuntimeEventNotifier();
  const received: Array<RuntimeEventEnvelope | UnknownRuntimeEvent> = [];
  new RunStreamService(repository, notifier).subscribe({
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    afterSequence: 0,
    onEvent: item => received.push(item),
    onOverflow: () => assert.fail('unexpected overflow'),
  });
  assert.deepEqual(received.map(item => item.sequence), [1, 3]);
  assert.equal((received[0] as UnknownRuntimeEvent).kind, 'unknown_runtime_event');
  assert.equal(JSON.stringify(received).includes('restricted-p5b-secret'), false);
});

test('P5B-G19/G20 subscriber failure and unsubscribe are isolated', () => {
  const repository = new FakeRunStreamRepository();
  const notifier = new RuntimeEventNotifier();
  const service = new RunStreamService(repository, notifier);
  const first: number[] = [];
  const second: number[] = [];
  service.subscribe({
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    afterSequence: 0,
    onEvent: item => {
      first.push(item.sequence);
      throw new Error('subscriber failed');
    },
    onOverflow: () => assert.fail('unexpected overflow'),
  });
  const unsubscribeSecond = service.subscribe({
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    afterSequence: 0,
    onEvent: item => second.push(item.sequence),
    onOverflow: () => assert.fail('unexpected overflow'),
  });
  repository.add(event(1));
  notifier.publish({ runId: RUN_ID, sequence: 1, eventId: event(1).id });
  repository.add(event(2));
  notifier.publish({ runId: RUN_ID, sequence: 2, eventId: event(2).id });
  unsubscribeSecond();
  unsubscribeSecond();
  repository.add(event(3));
  notifier.publish({ runId: RUN_ID, sequence: 3, eventId: event(3).id });
  assert.deepEqual(first, [1]);
  assert.deepEqual(second, [1, 2]);
});

test('P5B-G21/G22 buffering is bounded at 256 and overflow reports the resumable cursor once', () => {
  const repository = new FakeRunStreamRepository();
  const notifier = new RuntimeEventNotifier();
  repository.beforeHighWatermark = () => {
    for (let sequence = 1; sequence <= 257; sequence += 1) {
      notifier.publish({
        runId: RUN_ID,
        sequence,
        eventId: `evt_${String(sequence).padStart(26, '0')}`,
      });
    }
  };
  const overflow: number[] = [];
  const received: number[] = [];
  new RunStreamService(repository, notifier).subscribe({
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    afterSequence: 7,
    onEvent: item => received.push(item.sequence),
    onOverflow: cursor => overflow.push(cursor),
  });
  assert.deepEqual(overflow, [7]);
  assert.deepEqual(received, []);
  notifier.publish({ runId: RUN_ID, sequence: 258, eventId: 'evt_00000000000000000000000258' });
  assert.deepEqual(overflow, [7]);
});

test('P5B-G23 a new notifier/service replays durable history after process-local state is lost', () => {
  const repository = new FakeRunStreamRepository([event(1), event(2)]);
  const oldNotifier = new RuntimeEventNotifier();
  const oldReceived: number[] = [];
  const unsubscribe = new RunStreamService(repository, oldNotifier).subscribe({
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    afterSequence: 0,
    onEvent: item => oldReceived.push(item.sequence),
    onOverflow: () => assert.fail('unexpected overflow'),
  });
  unsubscribe();

  const restartedReceived: number[] = [];
  new RunStreamService(repository, new RuntimeEventNotifier()).subscribe({
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    afterSequence: 1,
    onEvent: item => restartedReceived.push(item.sequence),
    onOverflow: () => assert.fail('unexpected overflow'),
  });
  assert.deepEqual(oldReceived, [1, 2]);
  assert.deepEqual(restartedReceived, [2]);
});

test('P5B hint integrity mismatch fails closed without cross-Workspace delivery', () => {
  const repository = new FakeRunStreamRepository();
  const notifier = new RuntimeEventNotifier();
  const received: number[] = [];
  new RunStreamService(repository, notifier).subscribe({
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    afterSequence: 0,
    onEvent: item => received.push(item.sequence),
    onOverflow: () => assert.fail('unexpected overflow'),
  });
  repository.add(event(1));
  notifier.publish({ runId: RUN_ID, sequence: 1, eventId: 'evt_wrong' });
  notifier.publish({ runId: RUN_ID, sequence: 1, eventId: event(1).id });
  assert.deepEqual(received, []);
});
