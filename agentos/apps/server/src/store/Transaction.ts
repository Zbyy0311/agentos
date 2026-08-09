export interface TransactionDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
}

export type AfterCommitCallback = () => void;

const afterCommitQueues = new WeakMap<TransactionDatabase, AfterCommitCallback[]>();

export function isTransactionActive(db: TransactionDatabase): boolean {
  return afterCommitQueues.has(db);
}

export function registerAfterCommit(
  db: TransactionDatabase,
  callback: AfterCommitCallback,
): boolean {
  const queue = afterCommitQueues.get(db);
  if (!queue) return false;
  queue.push(callback);
  return true;
}

/**
 * Execute a synchronous callback inside BEGIN IMMEDIATE / COMMIT.
 * On failure: ROLLBACK, re-throws with preserved cause.
 */
export function inTransaction<T>(
  db: TransactionDatabase,
  fn: () => T,
): T {
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (err) {
    throw err; // lock acquisition failures pass through
  }

  const afterCommit: AfterCommitCallback[] = [];
  afterCommitQueues.set(db, afterCommit);

  let result: T;
  try {
    result = fn();

    // Reject async callbacks — they'd COMMIT before the promise settles.
    if (
      typeof result === 'object' &&
      result !== null &&
      'then' in result &&
      typeof (result as Record<string, unknown>).then === 'function'
    ) {
      throw new TypeError(
        'inTransaction only supports synchronous callbacks. An async function was passed.',
      );
    }
  } catch (err) {
    afterCommitQueues.delete(db);
    try { db.exec('ROLLBACK'); } catch { /* best-effort rollback */ }
    throw err;
  }

  try {
    db.exec('COMMIT');
  } catch (err) {
    afterCommitQueues.delete(db);
    try { db.exec('ROLLBACK'); } catch { /* best-effort rollback */ }
    throw err;
  }

  afterCommitQueues.delete(db);
  for (const callback of afterCommit) {
    try {
      callback();
    } catch {
      // The transaction is already permanently committed. A notification
      // callback is isolated from both the caller and later callbacks.
    }
  }
  return result;
}
