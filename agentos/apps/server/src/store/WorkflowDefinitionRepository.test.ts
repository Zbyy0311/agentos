import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): unknown;
    };
    close(): void;
  };
};

import type { WorkflowDefinitionPayloadV1 } from '@agentos/shared';
import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import {
  M25_LEGACY_DEFINITION_HASH,
  M25_LEGACY_DEFINITION_KEY,
  M25_LEGACY_DEFINITION_NAME,
  M25_LEGACY_WORKFLOW_ID,
  M25_UNBOUND_DEFINITION_HASH,
  M25_UNBOUND_DEFINITION_KEY,
  M25_UNBOUND_DEFINITION_NAME,
  M25_UNBOUND_WORKFLOW_ID,
} from '../migrations/migrations/007-workflow-definitions.js';
import { canonicalizeJson, hashCanonicalJson } from '../snapshots/canonicalJson.js';
import {
  WorkflowDefinitionIntegrityError,
  WorkflowDefinitionRepository,
} from './WorkflowDefinitionRepository.js';

type Db = InstanceType<typeof DatabaseSync>;

const NOW = '2026-01-01T00:00:00.000Z';

function migratedDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
  return db;
}

function payload(
  definitionKey: string,
  version: number,
  name: string,
  stages: WorkflowDefinitionPayloadV1['stages'] = [],
): WorkflowDefinitionPayloadV1 {
  return {
    schemaVersion: 1,
    definitionKey,
    version,
    name,
    executionMode: 'unbound',
    retryPolicy: null,
    stages,
  };
}

function insertDefinition(
  db: Db,
  options: {
    id: string;
    payload: unknown;
    definitionKey?: string;
    version?: number;
    name?: string;
    definitionHash?: string;
    definitionJson?: string;
    enabled?: number;
    archivedAt?: string | null;
  },
): void {
  const definition = options.payload as Record<string, unknown>;
  const definitionJson = options.definitionJson ?? canonicalizeJson(options.payload);
  db.prepare(`
    INSERT INTO workflow_definitions (
      id, definition_key, version, name, definition_json, definition_hash,
      enabled, archived_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    options.id,
    options.definitionKey ?? definition.definitionKey,
    options.version ?? definition.version,
    options.name ?? definition.name,
    definitionJson,
    options.definitionHash ?? hashCanonicalJson(options.payload),
    options.enabled ?? 1,
    options.archivedAt ?? null,
    NOW,
    NOW,
  );
}

function assertIntegrity(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => (
    error instanceof WorkflowDefinitionIntegrityError
    && error.code === 'WORKFLOW_DEFINITION_INTEGRITY_FAILED'
  ));
}

describe('WorkflowDefinitionRepository', () => {
  it('findById returns both built-in Definitions with mapped payloads', () => {
    const db = migratedDb();
    try {
      const repository = new WorkflowDefinitionRepository(db);
      const legacy = repository.findById(M25_LEGACY_WORKFLOW_ID);
      const unbound = repository.findById(M25_UNBOUND_WORKFLOW_ID);
      assert.equal(legacy?.definitionKey, M25_LEGACY_DEFINITION_KEY);
      assert.equal(legacy?.definitionHash, M25_LEGACY_DEFINITION_HASH);
      assert.equal(legacy?.enabled, true);
      assert.equal(unbound?.definitionKey, M25_UNBOUND_DEFINITION_KEY);
      assert.equal(unbound?.definitionHash, M25_UNBOUND_DEFINITION_HASH);
      assert.equal(unbound?.payload.executionMode, 'unbound');
    } finally {
      db.close();
    }
  });

  it('findByKeyVersion performs an exact version lookup', () => {
    const db = migratedDb();
    try {
      const repository = new WorkflowDefinitionRepository(db);
      const result = repository.findByKeyVersion(M25_LEGACY_DEFINITION_KEY, 1);
      assert.equal(result?.name, M25_LEGACY_DEFINITION_NAME);
      assert.equal(repository.findByKeyVersion(M25_LEGACY_DEFINITION_KEY, 99), undefined);
    } finally {
      db.close();
    }
  });

  it('findLatestAvailableByKey selects the highest enabled non-archived version', () => {
    const db = migratedDb();
    try {
      insertDefinition(db, { id: 'workflow_latest_v2', payload: payload(M25_LEGACY_DEFINITION_KEY, 2, 'v2') });
      insertDefinition(db, { id: 'workflow_latest_v3', payload: payload(M25_LEGACY_DEFINITION_KEY, 3, 'v3'), enabled: 0 });
      insertDefinition(db, { id: 'workflow_latest_v4', payload: payload(M25_LEGACY_DEFINITION_KEY, 4, 'v4'), enabled: 0, archivedAt: NOW });
      const result = new WorkflowDefinitionRepository(db).findLatestAvailableByKey(M25_LEGACY_DEFINITION_KEY);
      assert.equal(result?.version, 2);
      assert.equal(result?.name, 'v2');
    } finally {
      db.close();
    }
  });

  it('exact lookup remains readable for disabled and archived definitions', () => {
    const db = migratedDb();
    try {
      insertDefinition(db, { id: 'workflow_disabled', payload: payload('retained', 1, 'disabled'), enabled: 0 });
      insertDefinition(db, { id: 'workflow_archived', payload: payload('retained', 2, 'archived'), enabled: 0, archivedAt: NOW });
      const repository = new WorkflowDefinitionRepository(db);
      assert.equal(repository.findByKeyVersion('retained', 1)?.enabled, false);
      assert.equal(repository.findByKeyVersion('retained', 2)?.archivedAt, NOW);
      assert.equal(repository.findLatestAvailableByKey('retained'), undefined);
    } finally {
      db.close();
    }
  });

  it('rejects row and payload definitionKey, version, and name mismatches', () => {
    const cases = [
      { field: 'definitionKey', row: { definitionKey: 'row-key' } },
      { field: 'version', row: { version: 2 } },
      { field: 'name', row: { name: 'row-name' } },
    ] as const;
    for (const testCase of cases) {
      const db = migratedDb();
      try {
        const definition = payload('payload-key', 1, 'payload-name');
        insertDefinition(db, {
          id: `workflow_mismatch_${testCase.field}`,
          payload: definition,
          ...testCase.row,
        });
        assertIntegrity(() => new WorkflowDefinitionRepository(db).findById(`workflow_mismatch_${testCase.field}`));
      } finally {
        db.close();
      }
    }
  });

  it('rejects hash mismatch and invalid JSON shape', () => {
    const db = migratedDb();
    try {
      const valid = payload('invalid-shape', 1, 'invalid-shape');
      insertDefinition(db, {
        id: 'workflow_bad_hash',
        payload: valid,
        definitionHash: 'a'.repeat(64),
      });
      assertIntegrity(() => new WorkflowDefinitionRepository(db).findById('workflow_bad_hash'));

      const invalid = { schemaVersion: 1, definitionKey: 'invalid-shape-2', version: 1, name: 'invalid-shape-2' };
      insertDefinition(db, { id: 'workflow_bad_shape', payload: invalid });
      assertIntegrity(() => new WorkflowDefinitionRepository(db).findById('workflow_bad_shape'));
    } finally {
      db.close();
    }
  });

  it('rejects duplicate Stage keys and duplicate Stage sequences', () => {
    const cases = [
      [
        { key: 'same', sequence: 1, agentRole: null },
        { key: 'same', sequence: 2, agentRole: null },
      ],
      [
        { key: 'one', sequence: 1, agentRole: null },
        { key: 'two', sequence: 1, agentRole: null },
      ],
    ] as const;
    for (const [index, stages] of cases.entries()) {
      const db = migratedDb();
      try {
        insertDefinition(db, {
          id: `workflow_duplicate_stage_${index}`,
          payload: payload(`duplicate-${index}`, 1, `duplicate-${index}`, [...stages]),
        });
        assertIntegrity(() => new WorkflowDefinitionRepository(db).findById(`workflow_duplicate_stage_${index}`));
      } finally {
        db.close();
      }
    }
  });

  it('rejects non-exact payload and stage shapes', () => {
    const cases: Array<{ id: string; payload: unknown }> = [
      {
        id: 'workflow_extra_payload_field',
        payload: { ...payload('extra-payload', 1, 'extra-payload'), secret: 'must-not-persist' },
      },
      {
        id: 'workflow_extra_stage_field',
        payload: payload('extra-stage', 1, 'extra-stage', [
          { key: 'stage', sequence: 1, agentRole: null, extra: true } as unknown as WorkflowDefinitionPayloadV1['stages'][number],
        ]),
      },
      {
        id: 'workflow_blank_stage_key',
        payload: payload('blank-stage', 1, 'blank-stage', [{ key: '   ', sequence: 1, agentRole: null }]),
      },
      {
        id: 'workflow_padded_stage_key',
        payload: payload('padded-stage', 1, 'padded-stage', [{ key: ' stage', sequence: 1, agentRole: null }]),
      },
    ];
    for (const testCase of cases) {
      const db = migratedDb();
      try {
        insertDefinition(db, testCase);
        assertIntegrity(() => new WorkflowDefinitionRepository(db).findById(testCase.id));
      } finally {
        db.close();
      }
    }
  });

  it('rejects non-canonical stored JSON even when the canonical hash is correct', () => {
    const db = migratedDb();
    try {
      const definition = payload('non-canonical-json', 1, 'non-canonical-json');
      const nonCanonicalJson = JSON.stringify({
        stages: [],
        retryPolicy: null,
        executionMode: 'unbound',
        name: definition.name,
        version: definition.version,
        definitionKey: definition.definitionKey,
        schemaVersion: definition.schemaVersion,
      });
      insertDefinition(db, {
        id: 'workflow_non_canonical_json',
        payload: definition,
        definitionJson: nonCanonicalJson,
        definitionHash: hashCanonicalJson(definition),
      });
      assertIntegrity(() => new WorkflowDefinitionRepository(db).findById('workflow_non_canonical_json'));
    } finally {
      db.close();
    }
  });

  it('does not echo complete definition_json in integrity errors', () => {
    const db = migratedDb();
    try {
      const sensitive = payload('sensitive', 1, 'sensitive');
      (sensitive as unknown as Record<string, unknown>).secret = 'sensitive-definition-content';
      insertDefinition(db, {
        id: 'workflow_sensitive_error',
        payload: sensitive,
        definitionHash: 'b'.repeat(64),
      });
      assert.throws(
        () => new WorkflowDefinitionRepository(db).findById('workflow_sensitive_error'),
        (error: unknown) => error instanceof WorkflowDefinitionIntegrityError
          && !error.message.includes('sensitive-definition-content'),
      );
    } finally {
      db.close();
    }
  });

  it('exposes no mutation API', () => {
    const names = Object.getOwnPropertyNames(WorkflowDefinitionRepository.prototype);
    for (const forbidden of ['insert', 'update', 'archive', 'delete', 'upsert', 'save']) {
      assert.equal(names.includes(forbidden), false, forbidden);
    }
  });
});
