const REDACTED = '[REDACTED]';

export function redactRuntimeText(value: string, maxCharacters = 2048): string {
  let result = value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/([?&](?:token|api[_-]?key|key|secret)=)[^&\s]+/gi, `$1${REDACTED}`)
    .replace(/((["']?)(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|token)\2\s*[:=]\s*)(["']?)[^\s"'&,}]+\3/gi, `$1$3${REDACTED}$3`)
    .replace(/((?:^|[\s\n])(?:[A-Z][A-Z0-9_]{2,})\s*=\s*)(["']?)[^\s"']+\2/g, `$1$2${REDACTED}$2`);
  if (result.length > maxCharacters) result = `${result.slice(0, maxCharacters)}…[truncated]`;
  return result;
}

export function summarizeToolInput(toolName: string, input: unknown): string {
  const serialized = typeof input === 'string' ? input : JSON.stringify(input) ?? String(input);
  return redactRuntimeText(`${toolName}: ${serialized}`, 512);
}

export const REDACTED_VALUE = REDACTED;
