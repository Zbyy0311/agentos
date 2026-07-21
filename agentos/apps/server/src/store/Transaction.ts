export interface TransactionDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
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
  try {
    const result = fn();

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

    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* best-effort rollback */ }
    throw err;
  }
}
