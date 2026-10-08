import { ProcessError } from './errors.js';
import type { EnvironmentDiagnostic, LaunchEnvironmentInput } from './types.js';

/**
 * Safe environment construction. The environment starts from an allowlisted
 * safe base; only declared profile values, Run overrides and ephemeral secret
 * references are added. Secret values never enter diagnostics.
 */
export const DEFAULT_BASE_ALLOWLIST = [
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOME',
  'LANG',
  'LC_ALL',
  'NODE_ENV',
] as const;

export const MAX_ENV_TOTAL_BYTES = 32 * 1024;

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_KEY_PATTERN =
  /(?:^|_)(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL|SESSION_?KEY|SESSION|AUTH_?TOKEN|COOKIE|SIGNING_?KEY|PAT|KEY)(?=_|$)/i;

export interface SafeEnvironment {
  readonly env: Readonly<Record<string, string>>;
  readonly diagnostics: readonly EnvironmentDiagnostic[];
}

function assertKeyValueSafe(key: string, value: string, source: string): void {
  if (!ENV_KEY_PATTERN.test(key)) {
    throw new ProcessError(
      'PROCESS_ENVIRONMENT_INVALID',
      'environment key rejected from ' + source,
    );
  }
  if (value.includes('\u0000')) {
    throw new ProcessError(
      'PROCESS_ENVIRONMENT_INVALID',
      'environment value contains NUL from ' + source,
    );
  }
}

export function buildSafeEnvironment(input: LaunchEnvironmentInput = {}): SafeEnvironment {
  const env: Record<string, string> = {};
  const diagnostics: EnvironmentDiagnostic[] = [];

  const base = input.base ?? pickAllowlisted(process.env);
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    assertKeyValueSafe(key, value, 'base');
    if (input.base !== undefined && SECRET_KEY_PATTERN.test(key)) {
      throw new ProcessError(
        'PROCESS_ENVIRONMENT_INVALID',
        'secret-looking environment key must be supplied as an ephemeral secret reference: ' + key,
      );
    }
    env[key] = value;
    diagnostics.push({ key, source: 'base', classification: 'plain' });
  }

  for (const [source, record] of [
    ['profile', input.profile ?? {}],
    ['override', input.overrides ?? {}],
  ] as const) {
    for (const [key, value] of Object.entries(record)) {
      assertKeyValueSafe(key, value, source);
      if (SECRET_KEY_PATTERN.test(key)) {
        throw new ProcessError(
          'PROCESS_ENVIRONMENT_INVALID',
          'secret-looking environment key must be supplied as an ephemeral secret reference: ' + key,
        );
      }
      env[key] = value;
      upsertDiagnostic(diagnostics, { key, source, classification: 'plain' });
    }
  }

  for (const [key, value] of Object.entries(input.secretRefs ?? {})) {
    assertKeyValueSafe(key, value, 'secret-ref');
    env[key] = value;
    upsertDiagnostic(diagnostics, { key, source: 'secret-ref', classification: 'secret-ephemeral' });
  }

  let totalBytes = 0;
  for (const [key, value] of Object.entries(env)) {
    totalBytes += Buffer.byteLength(key) + Buffer.byteLength(value) + 2;
  }
  if (totalBytes > MAX_ENV_TOTAL_BYTES) {
    throw new ProcessError('PROCESS_ENVIRONMENT_INVALID', 'environment size limit exceeded');
  }

  diagnostics.sort((a, b) => a.key.localeCompare(b.key));
  return { env, diagnostics };
}

function pickAllowlisted(host: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of DEFAULT_BASE_ALLOWLIST) {
    const value = host[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function upsertDiagnostic(list: EnvironmentDiagnostic[], entry: EnvironmentDiagnostic): void {
  const index = list.findIndex((d) => d.key === entry.key);
  if (index >= 0) list.splice(index, 1);
  list.push(entry);
}
