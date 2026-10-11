import { REDACTION_MARKER } from '@agentos/process-runtime';

const MIN_KNOWN_SECRET_LENGTH = 8;

/**
 * High-confidence generic secret shapes used as a fallback when no known
 * secret value has been registered for a Workspace. Kept deliberately small:
 * every pattern must be specific enough that ordinary event text is never
 * replaced.
 */
const GENERIC_SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
];

export interface EventRedactionResult {
  readonly value: unknown;
  readonly redactedFields: number;
}

export interface EventPayloadRedactor {
  redactPayload(workspaceId: string, value: unknown): EventRedactionResult;
}

export function isEventPayloadRedactor(value: unknown): value is EventPayloadRedactor {
  return typeof value === 'object' && value !== null
    && typeof (value as { redactPayload?: unknown }).redactPayload === 'function';
}

/**
 * Workspace-scoped secret registry + JSON-level redactor for Runtime Event
 * persistence. Spec 03-Event-Model §57/§79 invariant 12: Secrets must be
 * redacted before an Event is persisted. Known secret values (registered at
 * launch time from the Provider launch plan's redactedEnvironmentKeys) are
 * replaced exactly; the generic patterns below catch common shapes otherwise.
 */
export class EventRedactionService implements EventPayloadRedactor {
  readonly #secretsByWorkspace = new Map<string, Set<string>>();

  registerSecrets(workspaceId: string, values: readonly string[]): void {
    if (workspaceId.trim().length === 0) return;
    let secrets = this.#secretsByWorkspace.get(workspaceId);
    for (const value of values) {
      if (typeof value !== 'string' || value.length < MIN_KNOWN_SECRET_LENGTH) continue;
      if (secrets === undefined) {
        secrets = new Set();
        this.#secretsByWorkspace.set(workspaceId, secrets);
      }
      secrets.add(value);
    }
  }

  clearWorkspace(workspaceId: string): void {
    this.#secretsByWorkspace.delete(workspaceId);
  }

  redactPayload(workspaceId: string, value: unknown): EventRedactionResult {
    const secrets = this.#secretsByWorkspace.get(workspaceId);
    let redactedFields = 0;
    const visit = (current: unknown): unknown => {
      if (typeof current === 'string') {
        const redacted = this.#redactString(current, secrets);
        if (redacted !== current) redactedFields += 1;
        return redacted;
      }
      if (Array.isArray(current)) {
        return current.map(visit);
      }
      if (typeof current === 'object' && current !== null) {
        const out: Record<string, unknown> = {};
        for (const [key, field] of Object.entries(current)) {
          out[key] = visit(field);
        }
        return out;
      }
      return current;
    };
    return { value: visit(value), redactedFields };
  }

  #redactString(text: string, secrets: Set<string> | undefined): string {
    let out = text;
    if (secrets !== undefined) {
      for (const secret of secrets) {
        if (secret.length === 0 || !out.includes(secret)) continue;
        out = out.split(secret).join(REDACTION_MARKER);
      }
    }
    for (const pattern of GENERIC_SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(out)) {
        out = out.replace(pattern, REDACTION_MARKER);
      }
    }
    return out;
  }
}

export const eventRedactionService = new EventRedactionService();
