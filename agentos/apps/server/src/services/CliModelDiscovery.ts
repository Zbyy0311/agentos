import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { getCliCapability } from '@agentos/agent-core';
import type {
  AgentModelOption,
  AgentRole,
  ModelDiscoveryResult,
  ThinkingEffort,
} from '@agentos/shared';

const PUBLIC_THINKING_EFFORTS: ThinkingEffort[] = ['auto', 'low', 'medium', 'high', 'max'];
const DEFAULT_CACHE_TTL_MS = 30_000;
const OPENCODE_DISCOVERY_TIMEOUT_MS = 3_000;

type JsonRecord = Record<string, unknown>;

export interface ModelDiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  cacheTtlMs?: number;
  execFile?: CliModelExec;
}

export interface CliModelExec {
  (command: string, args: string[], options: {
    env: NodeJS.ProcessEnv;
    timeout: number;
    maxBuffer: number;
  }): Promise<{ stdout: string; stderr: string }>;
}

export interface ModelDiscoveryInput {
  cliCommand: string;
  role: AgentRole;
  fallbackModels: AgentModelOption[];
  fallbackThinkingEfforts: readonly ThinkingEffort[];
  forceRefresh?: boolean;
}

export interface ModelDiscoveryService {
  discover(input: ModelDiscoveryInput): Promise<ModelDiscoveryResult>;
}

interface CacheEntry {
  expiresAt: number;
  result: ModelDiscoveryResult;
}

interface CodexModelRecord {
  slug?: unknown;
  display_name?: unknown;
  visibility?: unknown;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: unknown;
}

export function normalizeModelOption(input: {
  id: string;
  label?: string;
  thinkingEfforts?: readonly string[];
  defaultThinkingEffort?: string;
}): AgentModelOption {
  const supported = new Set<ThinkingEffort>(['auto']);
  for (const value of input.thinkingEfforts ?? []) {
    if (isThinkingEffort(value)) supported.add(value);
  }
  const thinkingEfforts = PUBLIC_THINKING_EFFORTS.filter(value => supported.has(value));
  const defaultThinkingEffort = isThinkingEffort(input.defaultThinkingEffort)
    && thinkingEfforts.includes(input.defaultThinkingEffort)
    ? input.defaultThinkingEffort
    : thinkingEfforts.includes('medium') ? 'medium' : 'auto';
  return {
    id: input.id.trim(),
    label: input.label?.trim() || input.id.trim(),
    thinkingEfforts,
    defaultThinkingEffort,
  };
}

export class CliModelDiscovery implements ModelDiscoveryService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly cacheTtlMs: number;
  private readonly execFile: CliModelExec;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: ModelDiscoveryOptions = {}) {
    this.env = { ...process.env, ...options.env };
    this.now = options.now ?? (() => new Date());
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.execFile = options.execFile ?? execCliFile;
  }

  async discover(input: ModelDiscoveryInput): Promise<ModelDiscoveryResult> {
    const cliKind = getCliCapability(input.cliCommand).cliKind;
    const key = this.cacheKey(cliKind, input.cliCommand);
    const cached = this.cache.get(key);
    const currentTime = this.now().getTime();
    if (!input.forceRefresh && cached && cached.expiresAt > currentTime) {
      return cloneResult(cached.result);
    }

    try {
      const discovered = await this.discoverFromSource(cliKind, input);
      if (discovered.models.length === 0) throw new Error('no visible models found');
      const result: ModelDiscoveryResult = {
        ...discovered,
        cliKind,
        stale: false,
        discoveredAt: this.now().toISOString(),
      };
      this.cache.set(key, { expiresAt: currentTime + this.cacheTtlMs, result });
      return cloneResult(result);
    } catch (error) {
      const warning = `${cliKind} model discovery unavailable; using configured fallback (${safeErrorMessage(error)})`;
      if (cached) {
        const result: ModelDiscoveryResult = {
          ...cloneResult(cached.result),
          stale: true,
          discoveredAt: this.now().toISOString(),
          warning,
        };
        return result;
      }
      return {
        cliKind,
        models: normalizeFallbackModels(input.fallbackModels, input.fallbackThinkingEfforts),
        source: 'fallback',
        stale: true,
        discoveredAt: this.now().toISOString(),
        warning,
      };
    }
  }

  private cacheKey(cliKind: ModelDiscoveryResult['cliKind'], cliCommand: string): string {
    return `${cliKind}:${cliCommand}:${this.env.CODEX_HOME ?? ''}:${this.env.KIMI_CODE_HOME ?? ''}:${this.env.AGENTOS_OPENCODE_MODELS_FILE ?? ''}`;
  }

  private async discoverFromSource(
    cliKind: ModelDiscoveryResult['cliKind'],
    input: ModelDiscoveryInput,
  ): Promise<Pick<ModelDiscoveryResult, 'models' | 'source'>> {
    if (cliKind === 'codex') {
      return { models: await this.readCodexModels(), source: 'cache' };
    }
    if (cliKind === 'kimi') {
      return { models: await this.readKimiModels(), source: 'config' };
    }
    if (cliKind === 'opencode') {
      return await this.readOpenCodeModels(input.cliCommand);
    }
    throw new Error('unsupported CLI kind');
  }

  private async readCodexModels(): Promise<AgentModelOption[]> {
    const cacheFile = this.env.CODEX_MODELS_FILE
      ?? join(this.env.CODEX_HOME ?? join(this.env.USERPROFILE ?? homedir(), '.codex'), 'models_cache.json');
    const payload = asRecord(parseJson(await readFile(cacheFile, 'utf8')));
    if (!payload || !Array.isArray(payload.models)) throw new Error('Codex models cache has no models array');
    return normalizeModels(payload.models.map(value => {
      const model = asRecord(value) as CodexModelRecord;
      const id = asNonEmptyString(model.slug);
      if (!id || model.visibility === 'hidden') return null;
      return normalizeModelOption({
        id,
        label: asNonEmptyString(model.display_name) ?? id,
        thinkingEfforts: extractEfforts(model.supported_reasoning_levels),
        defaultThinkingEffort: asNonEmptyString(model.default_reasoning_level),
      });
    }));
  }

  private async readKimiModels(): Promise<AgentModelOption[]> {
    const configFile = this.env.KIMI_CONFIG_FILE
      ?? join(this.env.KIMI_CODE_HOME ?? join(this.env.USERPROFILE ?? homedir(), '.kimi-code'), 'config.toml');
    const content = await readFile(configFile, 'utf8');
    const models: AgentModelOption[] = [];
    let currentId: string | undefined;
    let currentLabel: string | undefined;
    let currentThinkingEfforts: string[] | undefined;
    let currentDefaultThinkingEffort: string | undefined;
    const flush = () => {
      if (!currentId) return;
      models.push(normalizeModelOption({
        id: currentId,
        label: currentLabel,
        ...(currentThinkingEfforts === undefined ? {} : { thinkingEfforts: currentThinkingEfforts }),
        ...(currentDefaultThinkingEffort === undefined ? {} : { defaultThinkingEffort: currentDefaultThinkingEffort }),
      }));
      currentId = undefined;
      currentLabel = undefined;
      currentThinkingEfforts = undefined;
      currentDefaultThinkingEffort = undefined;
    };
    for (const line of content.split(/\r?\n/)) {
      const section = line.match(/^\s*\[models\.(?:"([^"]+)"|([^\]]+))\]\s*$/);
      if (section) {
        flush();
        currentId = (section[1] ?? section[2]).trim();
        continue;
      }
      if (currentId) {
        const displayName = line.match(/^\s*display_name\s*=\s*"((?:\\.|[^"])*)"\s*$/);
        if (displayName) currentLabel = decodeTomlString(displayName[1]);
        const supportEfforts = line.match(/^\s*support_efforts\s*=\s*(\[.*\])\s*$/);
        if (supportEfforts) currentThinkingEfforts = parseTomlStringArray(supportEfforts[1]);
        const defaultEffort = line.match(/^\s*default_effort\s*=\s*"((?:\\.|[^"])*)"\s*$/);
        if (defaultEffort) currentDefaultThinkingEffort = decodeTomlString(defaultEffort[1]);
        if (/^\s*\[/.test(line)) flush();
      }
    }
    flush();
    return normalizeModels(models);
  }

  private async readOpenCodeModels(
    cliCommand: string,
  ): Promise<Pick<ModelDiscoveryResult, 'models' | 'source'>> {
    let configuredModels: AgentModelOption[] | undefined;
    for (const configFile of openCodeConfigCandidates(this.env)) {
      if (!existsSync(configFile)) continue;
      // OpenCode treats its JSON configuration as JSONC: comments and
      // trailing commas are valid there. Keep strict JSON parsing for data
      // returned by CLIs, but use the config-compatible parser for the file.
      const payload = parseJsonc(await readFile(configFile, 'utf8'));
      const models = normalizeModels(parseOpenCodePayload(payload));
      if (models.length === 0) continue;
      configuredModels = models;
      // A config entry that declares variants is already authoritative for
      // this model. If it only declares model names, continue to the CLI so
      // OpenCode's provider registry can supply the model-specific variants.
      if (hasAdjustableThinkingEffort(models)) return { models, source: 'config' };
      break;
    }

    const options = {
      env: this.env,
      timeout: OPENCODE_DISCOVERY_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    };
    try {
      const jsonOutput = await this.execFile(cliCommand, ['models', '--json'], options);
      const jsonModels = normalizeModels(parseOpenCodePayload(parseJson(jsonOutput.stdout)));
      if (jsonModels.length > 0) return { models: jsonModels, source: 'live' };
    } catch {
      // OpenCode 1.17 exposes a plain-text `models` command instead of --json.
    }
    try {
      const verboseOutput = await this.execFile(cliCommand, ['models', '--verbose'], options);
      const verboseModels = normalizeModels(parseOpenCodeOutput(verboseOutput.stdout));
      if (verboseModels.length > 0) return { models: verboseModels, source: 'live' };
    } catch {
      // Older OpenCode builds may not expose verbose model metadata.
    }
    try {
      const textOutput = await this.execFile(cliCommand, ['models'], options);
      const models = normalizeModels(parseOpenCodeOutput(textOutput.stdout));
      if (models.length > 0) return { models, source: 'live' };
    } catch {
      // Fall through to a name-only config only when all live probes fail.
    }
    if (configuredModels && configuredModels.length > 0) return { models: configuredModels, source: 'config' };
    throw new Error('OpenCode returned no models');
  }
}

function normalizeFallbackModels(
  models: AgentModelOption[],
  _thinkingEfforts: readonly ThinkingEffort[],
): AgentModelOption[] {
  if (models.length > 0) {
    return normalizeModels(models.map(model => normalizeModelOption({
      ...model,
      thinkingEfforts: model.thinkingEfforts,
    })));
  }
  return [];
}

function normalizeModels(models: Array<AgentModelOption | null>): AgentModelOption[] {
  const seen = new Set<string>();
  return models.filter((model): model is AgentModelOption => {
    if (!model || !model.id || seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

function hasAdjustableThinkingEffort(models: readonly AgentModelOption[]): boolean {
  return models.some(model => model.thinkingEfforts.some(effort => effort !== 'auto'));
}

function extractEfforts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (typeof item === 'string') return [item];
    const effort = asNonEmptyString(asRecord(item)?.effort);
    return effort ? [effort] : [];
  });
}

function parseOpenCodePayload(payload: unknown): AgentModelOption[] {
  const models: AgentModelOption[] = [];
  const add = (id: string, value: unknown, provider?: string) => {
    const record = asRecord(value);
    const modelId = provider && !id.includes('/') ? `${provider}/${id}` : id;
    models.push(normalizeModelOption({
      id: modelId,
      label: asNonEmptyString(record?.name) ?? asNonEmptyString(record?.displayName) ?? modelId,
      thinkingEfforts: extractOpenCodeEfforts(record),
      defaultThinkingEffort: extractOpenCodeDefaultEffort(record),
    }));
  };
  const record = asRecord(payload);
  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (typeof item === 'string') add(item, undefined);
      else if (asNonEmptyString(asRecord(item)?.id)) add(asNonEmptyString(asRecord(item)!.id)!, item);
    }
    return models;
  }
  const topModels = record?.models;
  if (Array.isArray(topModels)) return parseOpenCodePayload(topModels);
  if (isRecord(topModels)) {
    for (const [id, value] of Object.entries(topModels)) add(id, value);
  }
  for (const providerKey of ['provider', 'providers']) {
    const providers = record?.[providerKey];
    if (!isRecord(providers)) continue;
    for (const [provider, providerValue] of Object.entries(providers)) {
      const providerModels = asRecord(providerValue)?.models;
      if (!isRecord(providerModels)) continue;
      for (const [id, value] of Object.entries(providerModels)) add(id, value, provider);
    }
  }
  return models;
}

function parseOpenCodeOutput(content: string): AgentModelOption[] {
  try {
    const models = parseOpenCodePayload(parseJson(content));
    if (models.length > 0) return models;
  } catch {
    // The output may be pretty JSON blocks rather than one JSON payload.
  }
  const verboseModels = parseOpenCodeVerboseOutput(content);
  if (verboseModels.length > 0) return verboseModels;
  return content
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.includes('/') && !line.startsWith('Error:'))
    .map(id => normalizeModelOption({ id, label: id, thinkingEfforts: ['auto'] }));
}

function extractOpenCodeEfforts(record: JsonRecord | undefined): string[] {
  const variants = record?.variants;
  if (isRecord(variants)) {
    const efforts = Object.entries(variants).flatMap(([name, value]) => {
      const variant = asRecord(value);
      return [asNonEmptyString(variant?.reasoningEffort) ?? name];
    });
    if (efforts.length > 0) return efforts;
  }
  const configured = extractEfforts(record?.thinkingEfforts ?? record?.thinking_efforts);
  return configured.length > 0 ? configured : ['auto'];
}

function extractOpenCodeDefaultEffort(record: JsonRecord | undefined): string | undefined {
  return asNonEmptyString(record?.defaultThinkingEffort)
    ?? asNonEmptyString(record?.default_thinking_effort)
    ?? asNonEmptyString(record?.defaultVariant)
    ?? asNonEmptyString(record?.default_variant);
}

/** Parse the pretty JSON blocks emitted by `opencode models --verbose`. */
function parseOpenCodeVerboseOutput(content: string): AgentModelOption[] {
  const models: AgentModelOption[] = [];
  for (const value of extractJsonObjects(content)) {
    const record = asRecord(value);
    const id = asNonEmptyString(record?.id);
    if (!id) continue;
    const provider = asNonEmptyString(record?.providerID)
      ?? asNonEmptyString(record?.providerId)
      ?? asNonEmptyString(record?.provider);
    models.push(normalizeModelOption({
      id: provider && !id.includes('/') ? `${provider}/${id}` : id,
      label: asNonEmptyString(record?.name) ?? asNonEmptyString(record?.displayName),
      thinkingEfforts: extractOpenCodeEfforts(record),
      defaultThinkingEffort: extractOpenCodeDefaultEffort(record),
    }));
  }
  return models;
}

function extractJsonObjects(content: string): unknown[] {
  const values: unknown[] = [];
  for (let start = 0; start < content.length; start += 1) {
    if (content[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let end = start; end < content.length; end += 1) {
      const character = content[end];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') { inString = true; continue; }
      if (character === '{') depth += 1;
      else if (character === '}') depth -= 1;
      if (depth !== 0) continue;
      try { values.push(parseJson(content.slice(start, end + 1))); } catch { /* continue scanning */ }
      start = end;
      break;
    }
  }
  return values;
}

function openCodeConfigCandidates(env: NodeJS.ProcessEnv): string[] {
  const explicit = [env.AGENTOS_OPENCODE_MODELS_FILE, env.AGENTOS_OPENCODE_CONFIG].filter(Boolean) as string[];
  const xdg = env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.json') : undefined;
  const appData = env.APPDATA ? join(env.APPDATA, 'opencode', 'opencode.json') : undefined;
  const profile = env.USERPROFILE ?? homedir();
  return [...explicit, xdg, appData, join(profile, '.config', 'opencode', 'opencode.json'), join(profile, '.opencode', 'opencode.json')]
    .filter((value): value is string => Boolean(value))
    .map(value => isAbsolute(value) ? value : join(profile, value));
}

function parseJson(content: string): unknown {
  return JSON.parse(content) as unknown;
}

/** Parse the JSONC dialect accepted by OpenCode configuration files. */
function parseJsonc(content: string): unknown {
  return JSON.parse(stripJsoncComments(content)) as unknown;
}

function stripJsoncComments(content: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    const next = content[index + 1];

    if (inLineComment) {
      if (character === '\n' || character === '\r') {
        inLineComment = false;
        output += character;
      } else {
        output += ' ';
      }
      continue;
    }

    if (inBlockComment) {
      if (character === '*' && next === '/') {
        inBlockComment = false;
        output += '  ';
        index += 1;
      } else {
        output += character === '\n' || character === '\r' ? character : ' ';
      }
      continue;
    }

    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') {
      inString = true;
      output += character;
    } else if (character === '/' && next === '/') {
      inLineComment = true;
      output += '  ';
      index += 1;
    } else if (character === '/' && next === '*') {
      inBlockComment = true;
      output += '  ';
      index += 1;
    } else {
      output += character;
    }
  }

  return stripJsoncTrailingCommas(output);
}

function stripJsoncTrailingCommas(content: string): string {
  let output = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === ',') {
      let next = index + 1;
      while (next < content.length && /\s/.test(content[next])) next += 1;
      if (content[next] === '}' || content[next] === ']') continue;
    }
    output += character;
  }

  return output;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isThinkingEffort(value: unknown): value is ThinkingEffort {
  return value === 'auto' || value === 'low' || value === 'medium' || value === 'high' || value === 'max';
}

function parseTomlStringArray(value: string): string[] {
  const body = value.trim().replace(/^\[/, '').replace(/\]$/, '');
  return [...body.matchAll(/"((?:\\.|[^"])*)"/g)].map(match => decodeTomlString(match[1]));
}

function decodeTomlString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.replace(/[\r\n]/g, ' ').slice(0, 160) : 'unknown error';
}

function cloneResult(result: ModelDiscoveryResult): ModelDiscoveryResult {
  return {
    ...result,
    models: result.models.map(model => ({ ...model, thinkingEfforts: [...model.thinkingEfforts] })),
  };
}

function execCliFile(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
