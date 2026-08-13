import { ProcessError } from './errors.js';
import type { NativeProcessHandle } from './driver.js';
import type { ValidatedLaunch } from './types.js';
import { isTerminalState } from './types.js';
import type {
  ClaimIdentity,
  CleanupResult,
  LaunchRequest,
  ProcessFact,
  ProcessFactType,
  ProcessId,
  ProcessSnapshot,
  ProcessState,
  RedactedLaunchFacts,
  StopReason,
  TerminalResult,
  TimeoutPolicy,
} from './types.js';

/** P0 section 7 transition table, adopted exactly. */
export const ALLOWED_TRANSITIONS: Readonly<Record<ProcessState, readonly ProcessState[]>> = {
  created: ['starting', 'failed', 'unknown'],
  starting: ['running', 'stopping', 'failed', 'unknown'],
  running: ['waiting', 'stopping', 'exited', 'orphaned', 'unknown'],
  waiting: ['running', 'stopping', 'exited', 'orphaned', 'unknown'],
  stopping: ['exited', 'failed', 'orphaned', 'unknown'],
  exited: [],
  failed: [],
  orphaned: ['exited', 'unknown'],
  unknown: ['orphaned', 'failed', 'exited'],
};

export function isTransitionAllowed(from: ProcessState, to: ProcessState): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to);
}

/** Internal mutable record. Mutations happen only under the store lock. */
export interface ProcessRecord {
  readonly id: ProcessId;
  readonly claimKey: string;
  readonly claimOwner: string;
  claimEpoch: number;
  state: ProcessState;
  version: number;
  readonly launchRequest: LaunchRequest;
  validatedLaunch: ValidatedLaunch | null;
  launchFacts: RedactedLaunchFacts;
  readonly timeoutPolicy: TimeoutPolicy;
  readonly createdAt: number;
  startingAt: number | null;
  /** Null while the consumed spawn call is unresolved; never means unspawned. */
  pid: number | null;
  spawnAttempts: number;
  startedAt: number | null;
  readyAt: number | null;
  waitingReason: string | null;
  stopReason: StopReason | null;
  stopIdempotencyKey: string | null;
  stopAcceptedAt: number | null;
  terminal: TerminalResult | null;
  cleanupEvidence: { result: CleanupResult; at: number } | null;
  readonly facts: ProcessFact[];
  /** Set while the single spawn continuation is in flight; duplicates join it. */
  spawnContinuation: Promise<ProcessSnapshot> | null;
  /** Exactly-once guard for the bounded cleanup pipeline. */
  cleanupStarted: boolean;
  /** Native handle is tracked by the registry, mirrored here for lock-time checks. */
  hasHandle: boolean;
}

export type SnapshotListener = (snapshot: ProcessSnapshot) => void;

/**
 * Schema-light in-memory store. Every mutation is serialized through one
 * promise chain, so a compare-and-set is a locked read-check-write and races
 * resolve by arrival order at the lock, never by timer luck.
 */
export class InMemoryProcessStore {
  readonly #records = new Map<ProcessId, ProcessRecord>();
  readonly #claimIndex = new Map<string, ProcessId>();
  readonly #listeners = new Map<ProcessId, Set<SnapshotListener>>();
  #chain: Promise<void> = Promise.resolve();

  /** Serialize one locked critical section. Never hold this across Driver calls. */
  withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.#chain.then(fn);
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  getRecord(id: ProcessId): ProcessRecord | undefined {
    return this.#records.get(id);
  }

  getRecordByClaimKey(key: string): ProcessRecord | undefined {
    const id = this.#claimIndex.get(key);
    return id === undefined ? undefined : this.#records.get(id);
  }

  insert(record: ProcessRecord): void {
    if (this.#records.has(record.id) || this.#claimIndex.has(record.claimKey)) {
      throw new ProcessError('PROCESS_REQUEST_INVALID', 'process identity conflict');
    }
    this.#records.set(record.id, record);
    this.#claimIndex.set(record.claimKey, record.id);
  }

  /** Locked CAS: expected version plus an allowed source/target pair. */
  transition(record: ProcessRecord, expectedVersion: number, next: ProcessState): number {
    if (record.version !== expectedVersion) {
      throw new ProcessError('PROCESS_REQUEST_INVALID', 'process version conflict');
    }
    if (record.state !== next && !isTransitionAllowed(record.state, next)) {
      throw new ProcessError(
        'PROCESS_REQUEST_INVALID',
        'illegal process state transition',
      );
    }
    record.state = next;
    record.version += 1;
    return record.version;
  }

  appendFact(record: ProcessRecord, type: ProcessFactType, at: number): ProcessFact {
    const fact: ProcessFact = Object.freeze({ type, at, version: record.version });
    record.facts.push(fact);
    return fact;
  }

  /** Terminal facts are appended exactly once; the first terminal CAS wins. */
  appendTerminalFact(record: ProcessRecord, type: ProcessFactType, at: number): boolean {
    if (record.terminal !== null) return false;
    if (!isTerminalState(record.state)) return false;
    this.appendFact(record, type, at);
    return true;
  }

  snapshotOf(record: ProcessRecord): ProcessSnapshot {
    const facts = Object.freeze(record.facts.map((f) => Object.freeze({ ...f })));
    const terminal = record.terminal === null ? null : Object.freeze({
      ...record.terminal,
      error: record.terminal.error === null ? null : Object.freeze({ ...record.terminal.error }),
      exit: record.terminal.exit === null ? null : Object.freeze({ ...record.terminal.exit }),
    });
    return Object.freeze({
      id: record.id,
      claimKey: record.claimKey,
      claimOwner: record.claimOwner,
      claimEpoch: record.claimEpoch,
      state: record.state,
      version: record.version,
      launch: Object.freeze({
        ...record.launchFacts,
        redactedArgs: Object.freeze([...record.launchFacts.redactedArgs]),
        envKeys: Object.freeze([...record.launchFacts.envKeys]),
      }),
      createdAt: record.createdAt,
      startingAt: record.startingAt,
      pid: record.pid,
      spawnAttempts: record.spawnAttempts,
      startedAt: record.startedAt,
      readyAt: record.readyAt,
      stopReason: record.stopReason,
      terminal,
      cleanupEvidence: record.cleanupEvidence === null
        ? null
        : Object.freeze({ ...record.cleanupEvidence }),
      facts,
    });
  }

  subscribe(id: ProcessId, listener: SnapshotListener): () => void {
    let set = this.#listeners.get(id);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(id, set);
    }
    set.add(listener);
    return () => {
      const current = this.#listeners.get(id);
      if (current !== undefined) {
        current.delete(listener);
        if (current.size === 0) this.#listeners.delete(id);
      }
    };
  }

  notify(id: ProcessId): void {
    const set = this.#listeners.get(id);
    if (set === undefined || set.size === 0) return;
    const record = this.#records.get(id);
    if (record === undefined) return;
    const snapshot = this.snapshotOf(record);
    for (const listener of [...set]) listener(snapshot);
  }

  get size(): number {
    return this.#records.size;
  }
}

export interface NewRecordInput {
  readonly id: ProcessId;
  readonly claim: ClaimIdentity;
  readonly launchRequest: LaunchRequest;
  readonly launchFacts: RedactedLaunchFacts;
  readonly timeoutPolicy: TimeoutPolicy;
  readonly createdAt: number;
}

export function createRecord(input: NewRecordInput): ProcessRecord {
  return {
    id: input.id,
    claimKey: input.claim.key,
    claimOwner: input.claim.owner,
    claimEpoch: input.claim.epoch,
    state: 'created',
    version: 0,
    launchRequest: input.launchRequest,
    validatedLaunch: null,
    launchFacts: input.launchFacts,
    timeoutPolicy: input.timeoutPolicy,
    createdAt: input.createdAt,
    startingAt: null,
    pid: null,
    spawnAttempts: 0,
    startedAt: null,
    readyAt: null,
    waitingReason: null,
    stopReason: null,
    stopIdempotencyKey: null,
    stopAcceptedAt: null,
    terminal: null,
    cleanupEvidence: null,
    facts: [],
    spawnContinuation: null,
    cleanupStarted: false,
    hasHandle: false,
  };
}
