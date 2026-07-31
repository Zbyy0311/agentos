import { createHash } from 'node:crypto';

import {
  M2_PARITY_FIELD_MAPS,
  type AcceptanceDomainId,
  type M2AcceptanceAggregate,
  type M2ParityFieldMap,
} from './M2AcceptanceInventory.js';

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

export type M2ParityAggregate = M2AcceptanceAggregate;

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

function compareStableText(left: string, right: string): number {
  if (left === right) return 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftCodeUnit = left.charCodeAt(index);
    const rightCodeUnit = right.charCodeAt(index);
    if (leftCodeUnit !== rightCodeUnit) return leftCodeUnit - rightCodeUnit;
  }
  return left.length - right.length;
}

type NormalizedProperty = Readonly<{ key: string; value: unknown }>;

type NormalizedInspection =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; reason: string }>;

type NormalizedProperties =
  | Readonly<{ kind: 'array' | 'object'; properties: readonly NormalizedProperty[] }>
  | Readonly<{ reason: string }>;

function invalidInspection(reason: string): NormalizedInspection {
  return { ok: false, reason };
}

function dataEnumerableValue(descriptor: PropertyDescriptor | undefined):
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; reason: string }> {
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return { ok: false, reason: 'accessor_property' };
  if (descriptor.enumerable !== true) return { ok: false, reason: 'non_enumerable_property' };
  return { ok: true, value: descriptor.value };
}

function isCanonicalArrayIndexKey(key: string, length: number): boolean {
  if (key === '0') return length > 0;
  if (!/^[1-9][0-9]*$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function normalizedProperties(value: object): NormalizedProperties {
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return { reason: 'unsupported_object_type' };
  }

  try {
    if (Array.isArray(value)) {
    if (prototype !== Array.prototype) return { reason: 'unsupported_object_type' };
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value') || lengthDescriptor.enumerable !== false) {
      return { reason: 'invalid_array_length' };
    }
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > 0xffffffff) return { reason: 'invalid_array_length' };
    const values = new Map<string, unknown>();
    for (const key of keys) {
      if (typeof key !== 'string') return { reason: 'symbol_keyed_property' };
      if (key === 'length') continue;
      if (!isCanonicalArrayIndexKey(key, length)) return { reason: 'array_custom_property' };
      const property = dataEnumerableValue(Object.getOwnPropertyDescriptor(value, key));
      if (!property.ok) return property;
      values.set(key, property.value);
    }
    const properties: NormalizedProperty[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      if (!values.has(key)) return { reason: 'sparse_array' };
      properties.push({ key, value: values.get(key) });
    }
      return { kind: 'array', properties };
    }

    if (prototype !== Object.prototype && prototype !== null) return { reason: 'unsupported_object_type' };
    const properties: NormalizedProperty[] = [];
    for (const key of keys) {
      if (typeof key !== 'string') return { reason: 'symbol_keyed_property' };
      const property = dataEnumerableValue(Object.getOwnPropertyDescriptor(value, key));
      if (!property.ok) return property;
      properties.push({ key, value: property.value });
    }
    properties.sort((left, right) => compareStableText(left.key, right.key));
    return { kind: 'object', properties };
  } catch {
    return { reason: 'unsupported_object_type' };
  }
}

function validateUint8ArrayProperties(value: Uint8Array): string | undefined {
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return 'unsupported_object_type';
  }
  for (const key of keys) {
    if (typeof key !== 'string') return 'symbol_keyed_property';
    if (!isCanonicalArrayIndexKey(key, value.length)) return 'array_custom_property';
    const property = dataEnumerableValue(Object.getOwnPropertyDescriptor(value, key));
    if (!property.ok) return property.reason;
  }
  return keys.length === value.length ? undefined : 'sparse_array';
}

function inspectNormalizedValue(value: unknown, seen = new Set<object>()): NormalizedInspection {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return { ok: true, value };
  if (typeof value === 'number') return Number.isFinite(value) ? { ok: true, value } : invalidInspection('non_finite_number');
  if (value === undefined) return invalidInspection('undefined_value');
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return invalidInspection('unsupported_primitive');
  if (typeof value !== 'object') return invalidInspection('unsupported_value_type');
  if (value instanceof Uint8Array) {
    try {
      const reason = validateUint8ArrayProperties(value);
      return reason ? invalidInspection(reason) : { ok: true, value: { $bytesSha256: sha256(value) } };
    } catch {
      return invalidInspection('unsupported_object_type');
    }
  }
  if (seen.has(value)) return invalidInspection('cyclic_value');
  seen.add(value);
  try {
    const properties = normalizedProperties(value);
    if ('reason' in properties) return invalidInspection(properties.reason);
    if (properties.kind === 'array') {
      const arrayValue: unknown[] = [];
      for (const property of properties.properties) {
        const nested = inspectNormalizedValue(property.value, seen);
        if (!nested.ok) return nested;
        arrayValue.push(nested.value);
      }
      return { ok: true, value: arrayValue };
    }
    const objectValue: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const property of properties.properties) {
      const nested = inspectNormalizedValue(property.value, seen);
      if (!nested.ok) return nested;
      objectValue[property.key] = nested.value;
    }
    return { ok: true, value: objectValue };
  } catch {
    return invalidInspection('unsupported_object_type');
  } finally {
    seen.delete(value);
  }
}

function stableValue(value: unknown): unknown {
  const inspection = inspectNormalizedValue(value);
  return inspection.ok ? inspection.value : { $malformed: inspection.reason };
}

function stableSerialize(value: unknown): string {
  try {
    return JSON.stringify(stableValue(value));
  } catch {
    return JSON.stringify({ $malformed: 'serialization_error' });
  }
}

function digestValue(value: unknown, present: boolean): string {
  try {
    return sha256(stableSerialize({ present, value: present ? value : null }));
  } catch {
    return sha256(stableSerialize({ present: true, value: 'unsupported_value' }));
  }
}

function normalizedValueError(value: unknown): string | undefined {
  const inspection = inspectNormalizedValue(value);
  return inspection.ok ? undefined : inspection.reason;
}

function ownField(value: unknown, fieldName: string): Readonly<{ present: boolean; value?: unknown }> {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return { present: false };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, fieldName);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return { present: false };
    return { present: true, value: descriptor.value };
  } catch {
    return { present: false };
  }
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

const SAFE_SOURCE_KIND = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function sourceIdentityError(source: M2ParitySourceInput): string | undefined {
  if (source.previousSourceHash !== undefined && !validDigest(source.previousSourceHash)) return 'invalid_previous_source_hash';
  if (typeof source.sourceKind !== 'string' || !SAFE_SOURCE_KIND.test(source.sourceKind)) return 'invalid_source_kind';
  return undefined;
}

function normalizedValueEvidence(
  records: readonly M2ParityRecord[],
  fieldMap: M2ParityFieldMap,
): M2ParityEvidence[] {
  const allowedFields = new Set([...fieldMap.requiredLogicalFields, ...fieldMap.allowedOptionalFields]);
  const evidence: M2ParityEvidence[] = [];
  for (const record of [...records].sort((left, right) => compareStableText(left.recordKey, right.recordKey))) {
    const properties = typeof record.fields === 'object' && record.fields !== null
      ? normalizedProperties(record.fields)
      : { reason: 'unsupported_fields_object' };
    if ('reason' in properties || properties.kind !== 'object') {
      evidence.push(evidenceFor(record.recordKey, 'unknown_field', 'malformed', undefined, undefined, 'unsupported_fields_object'));
      continue;
    }
    const structuralError = normalizedValueError(record.fields);
    if (structuralError) {
      evidence.push(evidenceFor(record.recordKey, 'unknown_field', 'malformed', undefined, undefined, structuralError));
      continue;
    }
    for (const property of properties.properties) {
      const key = property.key;
      if (!allowedFields.has(key)) {
        evidence.push(evidenceFor(record.recordKey, 'unknown_field', 'malformed', undefined, key, 'unknown_field_name'));
        continue;
      }
      const reason = normalizedValueError(property.value);
      if (reason) evidence.push(evidenceFor(record.recordKey, key, 'malformed', undefined, reason, reason));
    }
  }
  return evidence;
}

function redactIdentifier(value: unknown): string {
  if (typeof value !== 'string') return sha256(stableSerialize(value));
  if (/[\\/:]/.test(value) || value.length > 128 || /(^|[\\/])\.\.?([\\/]|$)/.test(value)) return sha256(value);
  return value;
}

function emptyCounts(): Record<M2ParityClassification, number> {
  return Object.fromEntries(CLASSIFICATIONS.map(classification => [classification, 0])) as Record<M2ParityClassification, number>;
}

function fieldMapFor(domainId: AcceptanceDomainId): M2ParityFieldMap {
  return M2_PARITY_FIELD_MAPS[domainId];
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStableText);
}

function recordMap(records: readonly M2ParityRecord[]): Map<string, M2ParityRecord> {
  return new Map([...records].sort((left, right) => compareStableText(left.recordKey, right.recordKey)).map(record => [record.recordKey, record]));
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
  const sourceKind = typeof input.source.sourceKind === 'string' && SAFE_SOURCE_KIND.test(input.source.sourceKind)
    ? input.source.sourceKind
    : typeof input.source.sourceKind === 'string'
      ? sha256(input.source.sourceKind)
      : sha256(stableSerialize(input.source.sourceKind));
  return {
    sourceKey: redactIdentifier(input.source.sourceKey),
    sourceKind,
    scope: redactIdentifier(input.source.scope),
    sourceHash,
    ...(validDigest(input.source.previousSourceHash) ? { previousSourceHash: input.source.previousSourceHash } : {}),
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
    const keyOrder = compareStableText(left.recordKeyDigest, right.recordKeyDigest);
    if (keyOrder !== 0) return keyOrder;
    return compareStableText(left.fieldName, right.fieldName);
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

    const sourceError = sourceIdentityError(input.source);
    if (sourceError) {
      counts.malformed = 1;
      return finish(
        input,
        sourceHash,
        'malformed',
        counts,
        { fieldConsistent: false, contractConsistent: false },
        [evidenceFor('__source__', 'source_identity', 'malformed', undefined, sourceError, 'malformed_source_identity')],
      );
    }

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

    const fieldMap = fieldMapFor(input.domainId);
    const allRecords = [...input.legacyRecords, ...input.canonicalRecords];
    const aggregateEvidence: M2ParityEvidence[] = [];
    if (input.aggregate !== fieldMap.expectedAggregate) {
      aggregateEvidence.push(evidenceFor(
        '__input__',
        'aggregate',
        'conflict',
        fieldMap.expectedAggregate,
        input.aggregate,
        'input_aggregate_mismatch',
      ));
    }
    for (const record of [...allRecords].sort((left, right) => compareStableText(left.recordKey, right.recordKey))) {
      if (record.aggregate !== fieldMap.expectedAggregate) {
        aggregateEvidence.push(evidenceFor(
          record.recordKey,
          'aggregate',
          'conflict',
          fieldMap.expectedAggregate,
          record.aggregate,
          'aggregate_boundary_mismatch',
        ));
      }
    }
    if (aggregateEvidence.length > 0) {
      counts.conflict = aggregateEvidence.length;
      return finish(
        input,
        sourceHash,
        'conflict',
        counts,
        { fieldConsistent: false, contractConsistent: false },
        aggregateEvidence,
      );
    }

    const malformedEvidence: M2ParityEvidence[] = normalizedValueEvidence(allRecords, fieldMap);
    for (const record of [...allRecords].sort((left, right) => compareStableText(left.recordKey, right.recordKey))) {
      for (const fieldName of fieldMap.requiredLogicalFields) {
        const field = ownField(record.fields, fieldName);
        if (!field.present || field.value === undefined) {
          malformedEvidence.push(evidenceFor(
            record.recordKey,
            fieldName,
            'malformed',
            undefined,
            undefined,
            'required_field_missing',
          ));
        }
      }
    }
    if (fieldMap.requiresBehaviorParity && input.behavior === undefined) {
      malformedEvidence.push(evidenceFor(
        '__behavior__',
        'behavior_contract',
        'malformed',
        undefined,
        undefined,
        'required_behavior_digest_missing',
      ));
    } else if (input.behavior !== undefined) {
      if (!validDigest(input.behavior.legacyContractDigest)) {
        malformedEvidence.push(evidenceFor('__behavior__', 'behavior_contract', 'malformed', undefined, 'invalid_legacy_digest', 'invalid_behavior_digest'));
      }
      if (!validDigest(input.behavior.canonicalContractDigest)) {
        malformedEvidence.push(evidenceFor('__behavior__', 'behavior_contract', 'malformed', undefined, 'invalid_canonical_digest', 'invalid_behavior_digest'));
      }
    }
    if (malformedEvidence.length > 0) {
      counts.malformed = malformedEvidence.length;
      return finish(
        input,
        sourceHash,
        'malformed',
        counts,
        { fieldConsistent: false, contractConsistent: false },
        malformedEvidence,
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
    for (const recordKey of [...issueByKey.keys()].sort(compareStableText)) {
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
    const keys = [...new Set([...legacy.keys(), ...canonical.keys()])].sort(compareStableText);
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
        .sort(compareStableText);
      for (const fieldName of fieldNames) {
        const legacyField = ownField(legacyRecord.fields, fieldName);
        const canonicalField = ownField(canonicalRecord.fields, fieldName);
        const legacyHas = legacyField.present;
        const canonicalHas = canonicalField.present;
        const legacyValue = legacyField.value;
        const canonicalValue = canonicalField.value;
        if (!legacyHas || !canonicalHas || stableSerialize(legacyValue) !== stableSerialize(canonicalValue)) {
          evidence.push(evidenceFor(recordKey, fieldName, 'mismatch', legacyValue, canonicalValue, 'field_mismatch'));
        }
      }
    }

    const contractConsistent = !fieldMap.requiresBehaviorParity
      || (
        input.behavior !== undefined
        && validDigest(input.behavior.legacyContractDigest)
        && validDigest(input.behavior.canonicalContractDigest)
        && input.behavior.legacyContractDigest === input.behavior.canonicalContractDigest
      );
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
