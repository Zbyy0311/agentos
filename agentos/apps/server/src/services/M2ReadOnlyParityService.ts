import { createHash } from 'node:crypto';

import type { AcceptanceDomainId } from './M2AcceptanceInventory.js';

export type M2ParityClassification =
  | 'equal'
  | 'missing_legacy'
  | 'missing_canonical'
  | 'mismatch'
  | 'malformed'
  | 'duplicate'
  | 'tombstone'
  | 'conflict'
  | 'changed_source';

export type M2ParityAggregate =
  | 'task-domain'
  | 'conversation'
  | 'workspace'
  | 'agent-profile'
  | 'provider-configuration'
  | 'legacy-task-item'
  | 'migration-evidence'
  | 'operational';

export interface M2ParityRecord {
  readonly recordKey: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly aggregate: M2ParityAggregate;
}

export interface M2ParitySourceInput {
  readonly sourceKey: string;
  readonly sourceKind: string;
  readonly scope: string;
  readonly sourceBytes: Uint8Array;
  readonly previousSourceHash?: string;
  readonly canonicalDatabaseOpaqueId: string;
}

export interface M2ParityBehaviorInput {
  readonly legacyContractDigest: string;
  readonly canonicalContractDigest: string;
}

export interface M2ParityInput {
  readonly domainId: AcceptanceDomainId;
  readonly aggregate: M2ParityAggregate;
  readonly source: M2ParitySourceInput;
  readonly legacyRecords: readonly M2ParityRecord[];
  readonly canonicalRecords: readonly M2ParityRecord[];
  readonly behavior?: M2ParityBehaviorInput;
  readonly sourceStatus?: 'valid' | 'malformed';
  readonly duplicateRecordKeys?: readonly string[];
  readonly tombstoneRecordKeys?: readonly string[];
  readonly conflictRecordKeys?: readonly string[];
}

export interface M2ParityEvidence {
  readonly recordKeyDigest: string;
  readonly fieldName: string;
  readonly classification: M2ParityClassification;
  readonly expectedValueDigest: string;
  readonly actualValueDigest: string;
  readonly redactedReason: string;
  readonly safeCount: number;
}

export interface M2ParityResult {
  readonly domainId: AcceptanceDomainId;
  readonly aggregate: M2ParityAggregate;
  readonly source: {
    readonly sourceKey: string;
    readonly sourceKind: string;
    readonly scope: string;
    readonly sourceHash: string;
    readonly previousSourceHash?: string;
    readonly canonicalDatabaseOpaqueId: string;
  };
  readonly classification: M2ParityClassification;
  readonly counts: Readonly<Record<M2ParityClassification, number>>;
  readonly behavior: {
    readonly fieldConsistent: boolean;
    readonly contractConsistent: boolean;
  };
  readonly evidence: readonly M2ParityEvidence[];
  readonly comparisonHash: string;
}

const CLASSIFICATIONS: readonly M2ParityClassification[] = [
  'equal',
  'missing_legacy',
  'missing_canonical',
  'mismatch',
  'malformed',
  'duplicate',
  'tombstone',
  'conflict',
  'changed_source',
];

const SUMMARY_PRIORITY: readonly M2ParityClassification[] = [
  'changed_source',
  'malformed',
  'duplicate',
  'conflict',
  'tombstone',
  'mismatch',
  'missing_legacy',
  'missing_canonical',
  'equal',
];

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === undefined) return { $undefined: true };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    return { $number: String(value) };
  }
  if (typeof value === 'bigint') return { $bigint: String(value) };
  if (value instanceof Uint8Array) return { $bytesSha256: sha256(value) };
  if (typeof value === 'object') {
    if (seen.has(value)) throw new Error('M2_PARITY_INPUT_CYCLE');
    seen.add(value);
    if (Array.isArray(value)) {
      const result = value.map(item => stableValue(item, seen));
      seen.delete(value);
      return result;
    }
    const objectValue = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(objectValue).sort()) {
      result[key] = stableValue(objectValue[key], seen);
    }
    seen.delete(value);
    return result;
  }
  return { $type: typeof value };
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function digestValue(value: unknown, present: boolean): string {
  return sha256(stableSerialize({ present, value: present ? value : null }));
}

function redactIdentifier(value: string): string {
  if (/[\\/:]/.test(value) || value.length > 128) return sha256(value);
  return value;
}

function emptyCounts(): Record<M2ParityClassification, number> {
  return Object.fromEntries(CLASSIFICATIONS.map(classification => [classification, 0])) as Record<M2ParityClassification, number>;
}

function expectedAggregate(domainId: AcceptanceDomainId): M2ParityAggregate | undefined {
  if (domainId === 'task_domain_task_run') return 'task-domain';
  if (domainId === 'conversation_runtime') return 'conversation';
  return undefined;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function recordMap(records: readonly M2ParityRecord[]): Map<string, M2ParityRecord> {
  return new Map([...records].sort((left, right) => left.recordKey.localeCompare(right.recordKey)).map(record => [record.recordKey, record]));
}

function duplicateKeys(records: readonly M2ParityRecord[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const record of records) {
    if (seen.has(record.recordKey)) duplicates.add(record.recordKey);
    seen.add(record.recordKey);
  }
  return [...duplicates];
}

function evidenceFor(
  recordKey: string,
  fieldName: string,
  classification: M2ParityClassification,
  expected: unknown,
  actual: unknown,
  redactedReason: string,
): M2ParityEvidence {
  return {
    recordKeyDigest: sha256(recordKey),
    fieldName,
    classification,
    expectedValueDigest: digestValue(expected, expected !== undefined),
    actualValueDigest: digestValue(actual, actual !== undefined),
    redactedReason,
    safeCount: 1,
  };
}

function makeSource(input: M2ParityInput, sourceHash: string): M2ParityResult['source'] {
  return {
    sourceKey: redactIdentifier(input.source.sourceKey),
    sourceKind: input.source.sourceKind,
    scope: redactIdentifier(input.source.scope),
    sourceHash,
    ...(input.source.previousSourceHash === undefined ? {} : { previousSourceHash: input.source.previousSourceHash }),
    canonicalDatabaseOpaqueId: redactIdentifier(input.source.canonicalDatabaseOpaqueId),
  };
}

function finish(
  input: M2ParityInput,
  sourceHash: string,
  classification: M2ParityClassification,
  counts: Record<M2ParityClassification, number>,
  behavior: M2ParityResult['behavior'],
  evidence: readonly M2ParityEvidence[],
): M2ParityResult {
  const orderedEvidence = [...evidence].sort((left, right) => {
    const keyOrder = left.recordKeyDigest.localeCompare(right.recordKeyDigest);
    if (keyOrder !== 0) return keyOrder;
    return left.fieldName.localeCompare(right.fieldName);
  });
  const result: Omit<M2ParityResult, 'comparisonHash'> = {
    domainId: input.domainId,
    aggregate: input.aggregate,
    source: makeSource(input, sourceHash),
    classification,
    counts: Object.freeze({ ...counts }),
    behavior: Object.freeze({ ...behavior }),
    evidence: Object.freeze(orderedEvidence.map(item => Object.freeze({ ...item }))),
  };
  const comparisonHash = sha256(stableSerialize(result));
  return Object.freeze({ ...result, comparisonHash });
}

function summaryClassification(counts: Readonly<Record<M2ParityClassification, number>>): M2ParityClassification {
  return SUMMARY_PRIORITY.find(classification => counts[classification] > 0) ?? 'equal';
}

export class M2ReadOnlyParityService {
  compare(input: M2ParityInput): M2ParityResult {
    const sourceHash = sha256(input.source.sourceBytes);
    const counts = emptyCounts();

    if (input.source.previousSourceHash !== undefined && input.source.previousSourceHash !== sourceHash) {
      counts.changed_source = 1;
      return finish(
        input,
        sourceHash,
        'changed_source',
        counts,
        { fieldConsistent: false, contractConsistent: false },
        [evidenceFor('__source__', 'source_hash', 'changed_source', input.source.previousSourceHash, sourceHash, 'source_hash_changed')],
      );
    }

    if (input.sourceStatus === 'malformed') {
      counts.malformed = 1;
      return finish(
        input,
        sourceHash,
        'malformed',
        counts,
        { fieldConsistent: false, contractConsistent: false },
        [evidenceFor('__source__', 'source', 'malformed', undefined, undefined, 'malformed_source')],
      );
    }

    const allRecords = [...input.legacyRecords, ...input.canonicalRecords];
    const expected = expectedAggregate(input.domainId);
    const invalidAggregateKeys = sortedUnique(
      allRecords
        .filter(record => record.aggregate !== input.aggregate || (expected !== undefined && record.aggregate !== expected))
        .map(record => record.recordKey),
    );
    if (invalidAggregateKeys.length > 0) {
      counts.conflict = invalidAggregateKeys.length;
      return finish(
        input,
        sourceHash,
        'conflict',
        counts,
        { fieldConsistent: false, contractConsistent: false },
        invalidAggregateKeys.map(recordKey => evidenceFor(
          recordKey,
          'aggregate',
          'conflict',
          expected,
          input.aggregate,
          'aggregate_boundary_mismatch',
        )),
      );
    }

    const duplicateRecordKeyList = sortedUnique([
      ...(input.duplicateRecordKeys ?? []),
      ...duplicateKeys(input.legacyRecords),
      ...duplicateKeys(input.canonicalRecords),
    ]);
    const tombstoneKeys = sortedUnique(input.tombstoneRecordKeys ?? []);
    const conflictKeys = sortedUnique(input.conflictRecordKeys ?? []);
    const issueByKey = new Map<string, M2ParityClassification>();
    for (const recordKey of duplicateRecordKeyList) issueByKey.set(recordKey, 'duplicate');
    for (const recordKey of conflictKeys) if (!issueByKey.has(recordKey)) issueByKey.set(recordKey, 'conflict');
    for (const recordKey of tombstoneKeys) if (!issueByKey.has(recordKey)) issueByKey.set(recordKey, 'tombstone');

    const evidence: M2ParityEvidence[] = [];
    for (const recordKey of [...issueByKey.keys()].sort((left, right) => left.localeCompare(right))) {
      const classification = issueByKey.get(recordKey) as 'duplicate' | 'conflict' | 'tombstone';
      counts[classification] += 1;
      evidence.push(evidenceFor(
        recordKey,
        'record_key',
        classification,
        undefined,
        undefined,
        classification === 'duplicate'
          ? 'duplicate_record_key'
          : classification === 'tombstone'
            ? 'tombstone_record'
            : 'conflict_record',
      ));
    }

    const legacy = recordMap(input.legacyRecords);
    const canonical = recordMap(input.canonicalRecords);
    const keys = [...new Set([...legacy.keys(), ...canonical.keys()])].sort((left, right) => left.localeCompare(right));
    let fieldConsistent = true;
    for (const recordKey of keys) {
      const issue = issueByKey.get(recordKey);
      if (issue !== undefined) continue;
      const legacyRecord = legacy.get(recordKey);
      const canonicalRecord = canonical.get(recordKey);
      if (legacyRecord === undefined) {
        counts.missing_legacy += 1;
        fieldConsistent = false;
        evidence.push(evidenceFor(recordKey, 'record', 'missing_legacy', undefined, canonicalRecord?.fields, 'missing_legacy_record'));
        continue;
      }
      if (canonicalRecord === undefined) {
        counts.missing_canonical += 1;
        fieldConsistent = false;
        evidence.push(evidenceFor(recordKey, 'record', 'missing_canonical', legacyRecord.fields, undefined, 'missing_canonical_record'));
        continue;
      }
      const legacyFields = stableSerialize(legacyRecord.fields);
      const canonicalFields = stableSerialize(canonicalRecord.fields);
      if (legacyFields === canonicalFields) {
        counts.equal += 1;
        continue;
      }
      counts.mismatch += 1;
      fieldConsistent = false;
      const fieldNames = [...new Set([...Object.keys(legacyRecord.fields), ...Object.keys(canonicalRecord.fields)])]
        .sort((left, right) => left.localeCompare(right));
      for (const fieldName of fieldNames) {
        const legacyHas = Object.prototype.hasOwnProperty.call(legacyRecord.fields, fieldName);
        const canonicalHas = Object.prototype.hasOwnProperty.call(canonicalRecord.fields, fieldName);
        const legacyValue = legacyHas ? legacyRecord.fields[fieldName] : undefined;
        const canonicalValue = canonicalHas ? canonicalRecord.fields[fieldName] : undefined;
        if (!legacyHas || !canonicalHas || stableSerialize(legacyValue) !== stableSerialize(canonicalValue)) {
          evidence.push(evidenceFor(recordKey, fieldName, 'mismatch', legacyValue, canonicalValue, 'field_mismatch'));
        }
      }
    }

    const contractConsistent = input.behavior === undefined
      || input.behavior.legacyContractDigest === input.behavior.canonicalContractDigest;
    if (!contractConsistent) {
      counts.mismatch += 1;
      evidence.push(evidenceFor(
        '__behavior__',
        'behavior_contract',
        'mismatch',
        input.behavior?.legacyContractDigest,
        input.behavior?.canonicalContractDigest,
        'behavior_contract_mismatch',
      ));
    }
    const finalClassification = summaryClassification(counts);
    return finish(
      input,
      sourceHash,
      finalClassification,
      counts,
      { fieldConsistent, contractConsistent },
      evidence,
    );
  }
}
