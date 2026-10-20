/**
 * §110 ETag / If-Match: optimistic concurrency for mutable resources.
 */

/** Read the strong ETag from a response, stripping the weak `W/` prefix. */
export function readETag(response: Response): string | undefined {
  const value = response.headers.get('etag');
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return trimmed.startsWith('W/') ? trimmed.slice(2).trim() : trimmed;
}

/** Conditional headers for a mutation that must match the last-read ETag. */
export function ifMatchHeaders(etag: string): Record<string, string> {
  return { 'If-Match': etag.startsWith('"') || etag.startsWith('W/') ? etag : `"${etag}"` };
}

/**
 * Tracks the latest ETag observed for a resource so a later mutation can be
 * submitted with If-Match without threading response headers through UI code.
 */
export function createETagTracker() {
  let current: string | undefined;
  return {
    updateFrom(response: Response): string | undefined {
      current = readETag(response) ?? current;
      return current;
    },
    set(etag: string | undefined): void {
      current = etag;
    },
    current(): string | undefined {
      return current;
    },
    headers(): Record<string, string> {
      return current === undefined ? {} : ifMatchHeaders(current);
    },
  };
}
