export const MAX_DIAGNOSTIC_LINE_CHARS = 64 * 1024;
export const MAX_DIAGNOSTIC_EVENT_CHARS = 256 * 1024;

const REDACTED = '[REDACTED]';
const SENSITIVE_ENV_NAME = /(?:secret|token|password|passwd|passphrase|api[_-]?key|private[_-]?key|credential|authorization|cookie|connection[_-]?string|database[_-]?(?:url|uri|dsn)|(?:redis|postgres|mysql|mongo(?:db)?)[_-]?(?:url|uri|dsn))/i;
const CREDENTIAL_FIELD = /((?:["']?)(?:authorization|proxy-authorization|www-authenticate|x-[\w-]*(?:api[-_]?key|auth(?:orization)?|token|secret|credential)[\w-]*|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|passphrase|password|passwd|secret|credential|token|cookie|set-cookie|connection[_-]?string|database[_-]?(?:url|uri|dsn)|(?:redis|postgres|mysql|mongo(?:db)?)[_-]?(?:url|uri|dsn))["']?\s*[:=]\s*)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;]+)/gi;
const SENSITIVE_HEADER = /(^|\r?\n)([ \t]*(?:authorization|proxy-authorization|www-authenticate|cookie|set-cookie|x-[\w-]*(?:api[-_]?key|auth(?:orization)?|token|secret|credential))[ \t]*:[ \t]*)[^\r\n]*/gi;
const TOKEN_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
  /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g,
];
const URL_PASSWORD = /([a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:)[^@/\s]+(@)/gi;

/**
 * Build one redactor per process so the server file logger and launcher worker
 * apply the same policy to the actual credential values inherited at startup.
 */
export function createDiagnosticRedactor(environment = process.env) {
  const sensitiveValues = [...new Set(Object.entries(environment)
    .filter(([name, value]) => SENSITIVE_ENV_NAME.test(name) && typeof value === 'string' && value.length > 0)
    .map(([, value]) => value))]
    .sort((left, right) => right.length - left.length);
  let insidePrivateKey = false;

  return input => {
    let safe = String(input ?? '');
    if (safe.length > MAX_DIAGNOSTIC_EVENT_CHARS) {
      updatePrivateKeyBoundaryState(safe, next => { insidePrivateKey = next; });
      return '[diagnostic event omitted: size limit]';
    }

    for (const value of sensitiveValues) safe = replaceConfiguredValue(safe, value);
    safe = redactPrivateKeyLines(safe, () => insidePrivateKey, next => { insidePrivateKey = next; })
      .replace(SENSITIVE_HEADER, '$1$2[REDACTED]')
      .replace(CREDENTIAL_FIELD, (_match, label, value) => {
        if (value.startsWith('"') && value.endsWith('"')) return `${label}"[REDACTED]"`;
        if (value.startsWith("'") && value.endsWith("'")) return `${label}'[REDACTED]'`;
        return `${label}[REDACTED]`;
      })
      .replace(URL_PASSWORD, '$1[REDACTED]$2');
    for (const pattern of TOKEN_PATTERNS) safe = safe.replace(pattern, '[REDACTED_TOKEN]');

    const bounded = boundDiagnosticLines(safe);
    return bounded.length <= MAX_DIAGNOSTIC_EVENT_CHARS
      ? bounded
      : '[diagnostic event omitted: sanitized size limit]';
  };
}

function redactPrivateKeyLines(text, getInside, setInside) {
  return text.split(/(\r?\n)/).map((part, index) => {
    if (index % 2 === 1) return part;
    let line = part;
    if (getInside()) {
      if (line.length === 0) return line;
      const end = /-----END [A-Z0-9 ]*PRIVATE KEY-----/i.exec(line);
      if (!end) return '[REDACTED_PRIVATE_KEY]';
      setInside(false);
      return '[REDACTED_PRIVATE_KEY]' + line.slice(end.index + end[0].length);
    }
    const begin = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i.exec(line);
    if (!begin) return line;
    const end = /-----END [A-Z0-9 ]*PRIVATE KEY-----/i.exec(line.slice(begin.index + begin[0].length));
    if (end) {
      const suffix = line.slice(begin.index + begin[0].length + end.index + end[0].length);
      return line.slice(0, begin.index) + '[REDACTED_PRIVATE_KEY]' + suffix;
    }
    setInside(true);
    return line.slice(0, begin.index) + '[REDACTED_PRIVATE_KEY]';
  }).join('');
}

function updatePrivateKeyBoundaryState(text, setInside) {
  const delimiters = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|-----END [A-Z0-9 ]*PRIVATE KEY-----/gi;
  for (const match of text.matchAll(delimiters)) setInside(/^-----BEGIN/i.test(match[0]));
}

function boundDiagnosticLines(text) {
  return text.split(/(\r?\n)/).map((part, index) => {
    if (index % 2 === 1 || part.length <= MAX_DIAGNOSTIC_LINE_CHARS) return part;
    return '[long diagnostic line omitted]';
  }).join('');
}

function replaceConfiguredValue(text, value) {
  if (value.length <= 3) {
    // Bare short values are redacted exactly. Distinctive mixed-case/digit
    // values match standalone tokens; ambiguous words only match reason/cause
    // fields, avoiding unrelated prose such as "Error: no runtime".
    const parts = text.split(/(\r?\n)/);
    for (let index = 0; index < parts.length; index += 2) {
      const line = parts[index];
      const trimmed = line.trim();
      const unquoted = trimmed.length >= 2 &&
        ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
        ? trimmed.slice(1, -1)
        : trimmed;
      if (unquoted === value) parts[index] = line.replace(value, REDACTED);
    }
    let safe = parts.join('');
    if (/^[A-Za-z0-9_]+$/.test(value) && /[A-Z0-9]/.test(value) && /[a-z]/.test(value)) {
      const tokenBoundary = new RegExp('(^|[^A-Za-z0-9_])' + value + '(?=$|[^A-Za-z0-9_])', 'g');
      safe = safe.replace(tokenBoundary, '$1' + REDACTED);
    } else if (/^[A-Za-z0-9_]+$/.test(value)) {
      const structuredField = /(?:["']?(?:reason|cause)["']?\s*[:=]\s*["']?)([A-Za-z0-9_]+)/gi;
      safe = safe.replace(structuredField, (match, fieldValue) => fieldValue === value
        ? match.slice(0, match.length - fieldValue.length) + REDACTED
        : match);
    }
    return safe;
  }

  if (/^[A-Za-z0-9_]+$/.test(value)) {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tokenBoundary = new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`, 'g');
    return text.replace(tokenBoundary, `$1${REDACTED}`);
  }
  return text.split(value).join(REDACTED);
}
