import { createHash } from 'node:crypto';

/**
 * Canonical JSON serialization and SHA-256 hashing for M2.5 snapshots.
 *
 * Frozen behavior contract (docs/implementation/milestones/M2.5-stage-workflow-snapshot-plan.md §8):
 * - object keys sorted recursively by Unicode code-point lexical order (NOT default UTF-16 sort);
 * - array order preserved; sparse holes rejected;
 * - supported: null, boolean, string, finite number, Array, plain Object;
 * - rejected: undefined, function, symbol, bigint, circular references, Date, Map, Set,
 *   class instances, non-plain objects, symbol-keyed properties, accessor properties;
 * - output uses standard JSON string escaping, no insignificant whitespace, no newlines,
 *   and never depends on original object insertion order;
 * - hash = SHA-256 over the UTF-8 bytes of the canonical JSON, lowercase 64-char hex.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Compare two strings by Unicode code point (iterating code points, not UTF-16 units). */
function compareByCodePoint(a: string, b: string): number {
  const aPoints = Array.from(a, (ch) => ch.codePointAt(0)!);
  const bPoints = Array.from(b, (ch) => ch.codePointAt(0)!);
  const len = Math.min(aPoints.length, bPoints.length);
  for (let i = 0; i < len; i++) {
    if (aPoints[i] !== bPoints[i]) return aPoints[i] - bPoints[i];
  }
  return aPoints.length - bPoints.length;
}

function serialize(value: unknown, path: string, stack: Set<object>): string {
  if (value === null) return 'null';

  const kind = typeof value;

  if (kind === 'boolean') return value ? 'true' : 'false';
  if (kind === 'string') return JSON.stringify(value);
  if (kind === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`canonicalJson: non-finite number at ${path}`);
    }
    return JSON.stringify(value);
  }
  if (kind === 'undefined' || kind === 'function' || kind === 'symbol' || kind === 'bigint') {
    throw new TypeError(`canonicalJson: unsupported type ${kind} at ${path}`);
  }

  const asObject = value as object;
  if (stack.has(asObject)) {
    throw new TypeError(`canonicalJson: circular reference at ${path}`);
  }
  stack.add(asObject);
  try {
    if (Array.isArray(value)) {
      const parts: string[] = [];
      for (let i = 0; i < value.length; i++) {
        if (!(i in value)) {
          throw new TypeError(`canonicalJson: sparse array hole at ${path}[${i}]`);
        }
        parts.push(serialize(value[i], `${path}[${i}]`, stack));
      }
      return `[${parts.join(',')}]`;
    }

    if (!isPlainObject(value)) {
      throw new TypeError(`canonicalJson: non-plain object at ${path}`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(`canonicalJson: symbol-keyed property at ${path}`);
    }
    const keys = Object.keys(value);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        throw new TypeError(`canonicalJson: accessor property "${key}" at ${path}`);
      }
    }
    keys.sort(compareByCodePoint);
    const parts = keys.map(
      (key) => `${JSON.stringify(key)}:${serialize(value[key], `${path}.${key}`, stack)}`,
    );
    return `{${parts.join(',')}}`;
  } finally {
    stack.delete(asObject);
  }
}

/** Serialize a supported JSON value into its canonical form. */
export function canonicalizeJson(value: unknown): string {
  return serialize(value, '$', new Set());
}

/** SHA-256 (lowercase 64-char hex) over the UTF-8 bytes of the canonical JSON. */
export function hashCanonicalJson(value: unknown): string {
  const canonical = canonicalizeJson(value);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
