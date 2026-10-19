/**
 * §109 Idempotency: mutating retries must carry a stable, unique key so the
 * server can deduplicate replayed submissions.
 */

function randomUUID(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
    const nibble = Math.floor(Math.random() * 16);
    return (char === 'x' ? nibble : (nibble & 0x3) | 0x8).toString(16);
  });
}

/** Generate a fresh idempotency key, optionally namespaced by operation scope. */
export function newIdempotencyKey(scope?: string): string {
  const uuid = randomUUID();
  return scope && scope.length > 0 ? `${scope}:${uuid}` : uuid;
}

/** Headers carrying the idempotency key for a mutating request. */
export function idempotencyHeaders(key: string): Record<string, string> {
  return { 'Idempotency-Key': key };
}
