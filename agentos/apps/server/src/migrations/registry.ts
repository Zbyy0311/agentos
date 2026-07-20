import type { Migration } from './types.js';
import { MigrationError } from './errors.js';

export class MigrationRegistry {
  private readonly _migrations: readonly Migration[];

  constructor(migrations: Migration[]) {
    const ids = new Set<string>();
    for (const m of migrations) {
      if (!m.id || m.id.trim().length === 0) {
        throw new MigrationError('MIGRATION_DUPLICATE_ID', `Migration ID must not be empty`);
      }
      if (!/^\d+$/.test(m.id)) {
        throw new MigrationError('MIGRATION_DUPLICATE_ID', `Migration ID must be numeric: ${m.id}`);
      }
      if (ids.has(m.id)) {
        throw new MigrationError('MIGRATION_DUPLICATE_ID', `Duplicate migration ID: ${m.id}`);
      }
      ids.add(m.id);
    }
    this._migrations = [...migrations].sort((a, b) => a.id.localeCompare(b.id));
  }

  get all(): readonly Migration[] {
    return this._migrations;
  }

  get size(): number {
    return this._migrations.length;
  }
}
