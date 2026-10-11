import type { SecretMatchKind, SecretTextDetector } from './EventRedactionService.js';

/**
 * 07-Memory-Runtime.md §76 invariant 10: Secrets must never enter the
 * ordinary Memory Store. Unlike the Event path — which redacts before
 * persistence — Memory write paths DETECT and REJECT: a hit means the write
 * is refused, never sanitized and stored.
 *
 * Detection reuses the EventRedactionService's two lanes (workspace-known
 * secret values and the high-confidence generic patterns). The matched
 * secret value is never copied into violations, errors, or problem details.
 */

export const MEMORY_SECRET_DETECTED_CODE = 'MEMORY_SECRET_DETECTED';

export type MemorySecretField = 'title' | 'summary' | 'content' | 'tags';

export interface MemorySecretSource {
  readonly title?: string;
  readonly summary?: string;
  readonly content?: string;
  readonly tags?: readonly string[];
}

export interface MemorySecretViolation {
  readonly field: MemorySecretField;
  readonly kind: SecretMatchKind;
}

export class MemorySecretDetectedError extends Error {
  readonly code = MEMORY_SECRET_DETECTED_CODE;
  constructor(readonly violations: readonly MemorySecretViolation[]) {
    super(MEMORY_SECRET_DETECTED_CODE);
    this.name = 'MemorySecretDetectedError';
  }
}

export function detectMemorySecretViolations(
  detector: SecretTextDetector,
  workspaceId: string,
  source: MemorySecretSource,
): MemorySecretViolation[] {
  const violations: MemorySecretViolation[] = [];
  const check = (field: MemorySecretField, text: string | undefined): void => {
    if (text === undefined) return;
    const kind = detector.detectSecretInText(workspaceId, text);
    if (kind !== undefined) violations.push({ field, kind });
  };
  check('title', source.title);
  check('summary', source.summary);
  check('content', source.content);
  for (const tag of source.tags ?? []) check('tags', tag);
  return violations;
}

/**
 * Route-facing problem detail. Names only the FIELD category, never the
 * suspected secret value.
 */
export function formatMemorySecretDetail(violations: readonly MemorySecretViolation[]): string {
  const fields = [...new Set(violations.map(violation => violation.field))];
  return `${fields.join('/')} 疑似包含密钥`;
}

export function assertNoMemorySecrets(
  detector: SecretTextDetector,
  workspaceId: string,
  source: MemorySecretSource,
): void {
  const violations = detectMemorySecretViolations(detector, workspaceId, source);
  if (violations.length > 0) throw new MemorySecretDetectedError(violations);
}
