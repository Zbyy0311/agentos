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
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* best-effort rollback */ }
    throw err;
  }
}
