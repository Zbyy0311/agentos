import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_VERSION, nextVersion, VersionConflictError } from './Version.js';

describe('Version — base types', () => {
  it('INITIAL_VERSION is 1', () => {
    assert.equal(INITIAL_VERSION, 1);
  });

  it('nextVersion increments by 1', () => {
    assert.equal(nextVersion(1), 2);
    assert.equal(nextVersion(99), 100);
  });

  it('nextVersion rejects non-safe integers', () => {
    assert.throws(() => nextVersion(0));
    assert.throws(() => nextVersion(-1));
    assert.throws(() => nextVersion(0.5));
    assert.throws(() => nextVersion(NaN));
    assert.throws(() => nextVersion(Infinity));
  });

  it('VersionConflictError has stable fields', () => {
    const err = new VersionConflictError('agent_profiles', 'agent_001', 1);
    assert.equal(err.code, 'VERSION_CONFLICT');
    assert.equal(err.name, 'VersionConflictError');
    assert.equal(err.entityType, 'agent_profiles');
    assert.equal(err.entityId, 'agent_001');
    assert.equal(err.expectedVersion, 1);
    assert.ok(err instanceof Error);
  });
});
