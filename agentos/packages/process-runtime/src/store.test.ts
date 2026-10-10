import { describe, expect, it } from 'vitest';
import {
  createRecord,
  InMemoryProcessStore,
  PROCESS_FACTS_RETAINED_MAX,
  PROCESS_FACTS_TERMINAL_SUMMARY_MAX,
} from './store.js';
import type { ProcessRecord } from './store.js';
import type { ProcessId } from './types.js';

function makeRecord(id: string): ProcessRecord {
  return createRecord({
    id: id as ProcessId,
    claim: { key: 'claim-' + id, owner: 'test', epoch: 1 },
    launchRequest: { executable: 'tool', args: [], cwd: '/ws' },
    launchFacts: { executable: 'tool', argCount: 0, redactedArgs: [], envKeys: [] },
    timeoutPolicy: { graceMs: 50 },
    createdAt: 0,
  });
}

describe('InMemoryProcessStore fact retention', () => {
  it('drops the oldest facts past the rolling retention cap', () => {
    const store = new InMemoryProcessStore();
    const record = makeRecord('proc_cap');
    store.insert(record);
    for (let i = 0; i < PROCESS_FACTS_RETAINED_MAX + 5; i += 1) {
      store.appendFact(record, 'process.started', i);
    }
    expect(record.facts).toHaveLength(PROCESS_FACTS_RETAINED_MAX);
    // The five oldest facts (at 0..4) were dropped in order.
    expect(record.facts[0].at).toBe(5);
    expect(record.facts[record.facts.length - 1].at).toBe(
      PROCESS_FACTS_RETAINED_MAX + 4,
    );
  });

  it('trims the fact list to the terminal summary while keeping the terminal fact', () => {
    const store = new InMemoryProcessStore();
    const record = makeRecord('proc_terminal');
    store.insert(record);
    for (let i = 0; i < PROCESS_FACTS_TERMINAL_SUMMARY_MAX + 10; i += 1) {
      store.appendFact(record, 'process.started', i);
    }
    record.state = 'exited';
    expect(store.appendTerminalFact(record, 'process.exited', 1000)).toBe(true);
    expect(record.facts).toHaveLength(PROCESS_FACTS_TERMINAL_SUMMARY_MAX);
    expect(record.facts[record.facts.length - 1].type).toBe('process.exited');
    expect(record.facts[record.facts.length - 1].at).toBe(1000);
    expect(record.facts[0].at).toBe(11);
  });

  it('reuses frozen fact references across snapshots without losing immutability', () => {
    const store = new InMemoryProcessStore();
    const record = makeRecord('proc_snapshot');
    store.insert(record);
    const fact = store.appendFact(record, 'process.started', 1);
    const first = store.snapshotOf(record);
    const second = store.snapshotOf(record);
    // Elements are the same frozen references; the array itself is fresh and
    // frozen per snapshot.
    expect(first.facts[0]).toBe(fact);
    expect(second.facts[0]).toBe(fact);
    expect(first.facts).not.toBe(second.facts);
    expect(Object.isFrozen(first.facts)).toBe(true);
    expect(Object.isFrozen(first.facts[0])).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    // Later facts appear in snapshots taken after the append.
    store.appendFact(record, 'process.stopping', 2);
    expect(store.snapshotOf(record).facts).toHaveLength(2);
    expect(first.facts).toHaveLength(1);
  });
});

describe('InMemoryProcessStore reclamation', () => {
  it('dispose drops the record, the claim index entry and the listeners', () => {
    const store = new InMemoryProcessStore();
    const record = makeRecord('proc_dispose');
    store.insert(record);
    let notifications = 0;
    store.subscribe(record.id, () => {
      notifications += 1;
    });
    expect(store.dispose(record.id)).toBe(true);
    expect(store.getRecord(record.id)).toBeUndefined();
    expect(store.getRecordByClaimKey(record.claimKey)).toBeUndefined();
    // notify() on a disposed identity is a no-op, never a resurrection.
    store.notify(record.id);
    expect(notifications).toBe(0);
    expect(store.dispose(record.id)).toBe(false);
    expect(store.size).toBe(0);
  });

  it('terminalRecordsOlderThan lists only terminal records past the cutoff', () => {
    const store = new InMemoryProcessStore();
    const markTerminal = (record: ProcessRecord, terminalAt: number): void => {
      record.state = 'exited';
      store.appendTerminalFact(record, 'process.exited', terminalAt);
      record.terminal = {
        state: 'exited',
        outcome: 'exit',
        terminationReason: null,
        cancelCausation: null,
        error: null,
        exit: null,
        cleanup: null,
        version: record.version,
        terminalAt,
      };
    };
    const old = makeRecord('proc_old');
    store.insert(old);
    markTerminal(old, 100);
    const fresh = makeRecord('proc_fresh');
    store.insert(fresh);
    markTerminal(fresh, 500);
    const live = makeRecord('proc_live');
    store.insert(live);

    expect(store.terminalRecordsOlderThan(400).map((r) => r.id)).toEqual(['proc_old']);
    expect(store.terminalRecordsOlderThan(600).map((r) => r.id)).toEqual([
      'proc_old',
      'proc_fresh',
    ]);
    expect(store.terminalRecordsOlderThan(0)).toEqual([]);
    expect(live.terminal).toBeNull();
  });
});
