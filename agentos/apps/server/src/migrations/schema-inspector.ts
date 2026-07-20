import type { MinimalDatabaseSync } from './types.js';
import type { MigrationDiagnostics } from './types.js';

/**
 * Describes the structural requirements for a legacy database baseline.
 */
export interface BaselineSchema {
  tables: Array<{
    name: string;
    columns: Array<{ name: string; type: string; notnull: boolean; pk: boolean }>;
    indexes: Array<{
      name: string;
      unique: boolean;
      columns: string[];
    }>;
  }>;
  triggers: string[];
  ftsTables: string[];
}

function escapeSqlIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Inspect a live SQLite database and return its structural description.
 */
export function inspectSchema(db: MinimalDatabaseSync): BaselineSchema {
  const tables: BaselineSchema['tables'] = [];

  const allTables = db.prepare(`SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name`).all() as Array<{ name: string; type: string }>;

  for (const { name } of allTables) {
    if (name.startsWith('_') || name.startsWith('sqlite_')) continue; // internal

    const colRows = db.prepare(`PRAGMA table_info(${escapeSqlIdent(name)})`).all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
    const columns = colRows.map(r => ({
      name: r.name,
      type: r.type.toUpperCase(),
      notnull: r.notnull === 1,
      pk: r.pk > 0,
    }));

    const idxRows = db.prepare(`PRAGMA index_list(${escapeSqlIdent(name)})`).all() as Array<{ name: string; unique: number; origin: string }>;
    const indexes: BaselineSchema['tables'][0]['indexes'] = [];
    for (const idx of idxRows) {
      if (idx.origin === 'pk') continue; // skip primary key indexes
      const infoRows = db.prepare(`PRAGMA index_info(${escapeSqlIdent(idx.name)})`).all() as Array<{ name: string }>;
      indexes.push({
        name: idx.name,
        unique: idx.unique === 1,
        columns: infoRows.map(r => r.name),
      });
    }

    tables.push({ name, columns, indexes });
  }

  const triggerRows = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name`).all() as Array<{ name: string }>;
  const triggers = triggerRows.map(r => r.name);

  const ftsRows = db.prepare(`SELECT name FROM sqlite_master WHERE sql LIKE '%VIRTUAL TABLE%' AND sql LIKE '%fts5%' ORDER BY name`).all() as Array<{ name: string }>;
  const ftsTables = ftsRows.map(r => r.name);

  return { tables, triggers, ftsTables };
}

/**
 * Compare a live database structure against an expected baseline.
 * Returns diagnostics only — does NOT modify the database.
 */
export function compareToBaseline(
  actual: BaselineSchema,
  expected: BaselineSchema,
): MigrationDiagnostics {
  const diag: MigrationDiagnostics = {
    missingTables: [],
    unexpectedCriticalTables: [],
    missingColumns: [],
    incompatibleColumns: [],
    missingIndexes: [],
    incompatibleIndexes: [],
    missingTriggers: [],
  };

  const actualMap = new Map(actual.tables.map(t => [t.name, t]));
  const expectedMap = new Map(expected.tables.map(t => [t.name, t]));

  // Check missing tables
  for (const exp of expected.tables) {
    if (!actualMap.has(exp.name)) {
      diag.missingTables.push(exp.name);
    }
  }

  // Check unexpected tables (critical = non-underscore, non-fts content tables)
  const expectedNames = new Set(expected.tables.map(t => t.name));
  const expectedFts = new Set(expected.ftsTables);
  for (const act of actual.tables) {
    if (!expectedNames.has(act.name) && !expectedFts.has(act.name)) {
      diag.unexpectedCriticalTables.push(act.name);
    }
  }

  // Check columns and indexes per table
  for (const exp of expected.tables) {
    const act = actualMap.get(exp.name);
    if (!act) continue;

    const actColMap = new Map(act.columns.map(c => [c.name, c]));
    for (const ec of exp.columns) {
      const ac = actColMap.get(ec.name);
      if (!ac) {
        diag.missingColumns.push({ table: exp.name, column: ec.name });
      } else if (normalizeType(ac.type) !== normalizeType(ec.type)) {
        diag.incompatibleColumns.push({ table: exp.name, column: ec.name, expected: ec.type, actual: ac.type });
      }
    }

    const actIdxMap = new Map(act.indexes.map(i => [i.name, i]));
    for (const ei of exp.indexes) {
      const ai = actIdxMap.get(ei.name);
      if (!ai) {
        diag.missingIndexes.push({ table: exp.name, index: ei.name });
      } else if (ai.unique !== ei.unique) {
        diag.incompatibleIndexes.push({ table: exp.name, index: ei.name, issue: `unique=${ai.unique}, expected=${ei.unique}` });
      }
    }
  }

  // Check triggers
  const expTriggerSet = new Set(expected.triggers);
  for (const t of actual.triggers) {
    if (expTriggerSet.has(t)) continue;
    // Don't flag unknown triggers as errors unless they affect core tables
  }
  for (const et of expected.triggers) {
    if (!actual.triggers.includes(et)) {
      diag.missingTriggers.push(et);
    }
  }

  return diag;
}

const TYPE_ALIASES = new Map<string, string>([
  ['INT', 'INTEGER'], ['INT2', 'INTEGER'], ['INT8', 'INTEGER'],
  ['TINYINT', 'INTEGER'], ['SMALLINT', 'INTEGER'], ['MEDIUMINT', 'INTEGER'],
  ['BIGINT', 'INTEGER'], ['UNSIGNED BIG INT', 'INTEGER'],
  ['BOOLEAN', 'INTEGER'],
  ['CHARACTER', 'TEXT'], ['VARYING CHARACTER', 'TEXT'], ['NCHAR', 'TEXT'],
  ['NATIVE CHARACTER', 'TEXT'], ['NVARCHAR', 'TEXT'], ['CLOB', 'TEXT'],
  ['BLOB', 'NONE'], ['DOUBLE', 'REAL'], ['DOUBLE PRECISION', 'REAL'],
  ['FLOAT', 'REAL'], ['NUMERIC', 'REAL'], ['DECIMAL', 'REAL'],
]);

function normalizeType(t: string): string {
  const upper = t.toUpperCase().replace(/\(.*\)/g, '').trim();
  return TYPE_ALIASES.get(upper) || upper;
}

export function isSchemaCompatible(diag: MigrationDiagnostics): boolean {
  return diag.missingTables.length === 0
    && diag.missingColumns.length === 0
    && diag.incompatibleColumns.length === 0
    && diag.missingIndexes.length === 0
    && diag.incompatibleIndexes.length === 0
    && diag.missingTriggers.length === 0;
}
