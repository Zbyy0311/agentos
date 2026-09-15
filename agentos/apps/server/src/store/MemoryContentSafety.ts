import { redactRuntimeText } from '@agentos/agent-core';

/**
 * Memory does not receive the process runtime's declared secret-pattern list.
 * Use the existing runtime redaction vocabulary as a detection-only gate for
 * user/generated Memory text, while preserving approved `${NAME}` references.
 * A redaction or detector failure is unsafe and therefore rejects the write.
 */

const APPROVED_REFERENCE = /^\$\{[A-Z][A-Z0-9_]*\}$/u;
const REFERENCE_TOKEN = /\$\{[A-Z][A-Z0-9_]*\}/gu;
const APPROVED_SENSITIVE_ASSIGNMENT = /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|token|client[_-]?secret)\s*[:=]\s*\$\{[A-Z][A-Z0-9_]*\}/giu;
const PRIVATE_KEY_HEADER = /-----BEGIN [^-\r\n]*PRIVATE KEY-----/iu;
const AUTHORIZATION_OR_COOKIE_HEADER = /\b(?:Authorization|Cookie)\s*:/iu;
const SENSITIVE_FLAG = /(?:^|\s)--(?:api-key|token|access-token|password|secret|client-secret)(?:=|\s+)([^\s,;]+)/giu;

function stripApprovedReferences(value: string): string {
  return value
    .replace(APPROVED_SENSITIVE_ASSIGNMENT, 'approved-reference')
    .replace(REFERENCE_TOKEN, '');
}

function isApprovedReference(value: string): boolean {
  const quoted = /^(['"])(.*)\1$/u.exec(value);
  return APPROVED_REFERENCE.test(quoted?.[2] ?? value);
}

/**
 * Return false when the text would be changed by the existing runtime
 * redactor, or when it matches the other established sensitive-value forms.
 * This intentionally rejects instead of storing a redacted substitute: the
 * Memory contract forbids the original value from entering any sink.
 */
export function isMemoryTextSafe(value: string): boolean {
  try {
    if (PRIVATE_KEY_HEADER.test(value) || AUTHORIZATION_OR_COOKIE_HEADER.test(value)) {
      return false;
    }

    for (const match of value.matchAll(SENSITIVE_FLAG)) {
      if (!isApprovedReference(match[1] ?? '')) return false;
    }

    const withoutReferences = stripApprovedReferences(value);
    return redactRuntimeText(withoutReferences, Number.MAX_SAFE_INTEGER) === withoutReferences;
  } catch {
    return false;
  }
}

export function areMemoryTextFieldsSafe(values: readonly string[]): boolean {
  return values.every(isMemoryTextSafe);
}
