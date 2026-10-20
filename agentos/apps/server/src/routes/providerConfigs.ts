import { Router, type Request, type Response } from 'express';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { asyncHandler } from '../utils/asyncHandler.js';
import type { SqliteStore } from '../store/SqliteStore.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { sendProblem } from '../problemDetails.js';
import { ProviderConfigurationRepository, DEFAULT_CAPABILITIES, DEFAULT_TIMEOUT_POLICY, normalizeProviderFallbackPolicy } from '../store/ProviderConfigurationRepository.js';
import { ProviderValidationCacheRepository } from '../store/ProviderValidationCacheRepository.js';
import { ProviderMetricsService, sharedProviderMetricsService } from '../services/ProviderMetricsService.js';
import { createEntityId } from '../store/Identity.js';
import type { ProviderConfiguration } from '../store/ProviderConfigurationRepository.js';
import {
  CodexProviderAdapter,
  CustomCliAdapter,
  KimiCodeProviderAdapter,
  MockProviderAdapter,
  OpenCodeProviderAdapter,
  ProviderRegistry,
  ProviderValidationService,
  computeProviderValidationCacheKey,
  resolveProviderValidationCacheTtlMs,
  resolveFrozenProviderIdentity,
} from '@agentos/agent-core/providers';
import { NodeProcessProbePort } from '@agentos/process-runtime';
import type { ProviderValidationResult } from '@agentos/agent-core/providers';
import { createHash } from 'node:crypto';

// P57 §57.2: 'mock' deliberately stays out of the API-accepted provider types:
// the provider_configurations.provider_type CHECK (migration 003) cannot be
// relaxed without rebuilding the table's foreign-key closure, so mock
// configurations cannot be persisted through the REST API yet. The mock
// adapter is still registered in the default registry (below) for Runtime
// development, E2E and CI, which bind mock providers programmatically.
const VALID_PROVIDER_TYPES = ['codex','claude-code','kimicode','opencode','gemini-cli','custom-cli','remote'] as const;
const VALID_RUNTIME_MODES = ['cli','api','ssh','container'] as const;
const VALID_WORKING_DIRECTORY_MODES = ['workspace','worktree','custom'] as const;
const VALID_APPROVAL_MODES = ['agentos','native','hybrid','disabled'] as const;
const VALID_OUTPUT_MODES = ['structured','parsed-text','raw-stream'] as const;
const VALID_PROMPT_DELIVERIES = ['argument', 'stdin', 'file'] as const;

const FORBIDDEN_SECRET_VALUE_FIELDS = [
  'apiKey',
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'secretValue',
  'credential',
  'credentialValue',
];

function sendValidationError(req: Request, res: Response, message: string): void {
  sendProblem(req, res, { status: 400, code: 'VALIDATION_ERROR', detail: message, errors: [{ code: 'VALIDATION_ERROR', message }] });
}

function sendInternalError(req: Request, res: Response, logContext: string, error: unknown): void {
  console.error(`[provider-configs] ${logContext}`, error);
  sendProblem(req, res, { status: 500, code: 'INTERNAL_ERROR', detail: 'Internal server error' });
}

function findForbiddenSecretField(body: Record<string, unknown>): string | undefined {
  return FORBIDDEN_SECRET_VALUE_FIELDS.find(field => field in body);
}

function validateEnumField(body: Record<string, unknown>, field: string, allowed: readonly string[]): string | undefined {
  if (body[field] === undefined) return undefined;
  const value = body[field];
  if (typeof value !== 'string') return `${field} must be a string`;
  if (!allowed.includes(value)) return `Invalid ${field}: ${value}`;
  return undefined;
}

/** Validates all optional enum fields shared by POST and PUT. Returns the first error message. */
function validateEnumFields(body: Record<string, unknown>): string | undefined {
  return validateEnumField(body, 'providerType', VALID_PROVIDER_TYPES)
    ?? validateEnumField(body, 'runtimeMode', VALID_RUNTIME_MODES)
    ?? validateEnumField(body, 'workingDirectoryMode', VALID_WORKING_DIRECTORY_MODES)
    ?? validateEnumField(body, 'approvalMode', VALID_APPROVAL_MODES)
    ?? validateEnumField(body, 'outputMode', VALID_OUTPUT_MODES)
    ?? validateEnumField(body, 'promptDelivery', VALID_PROMPT_DELIVERIES);
}

/** Validates the optional structured fields shared by POST and PUT. Returns the first error message. */
function validateStructuredFields(body: Record<string, unknown>): string | undefined {
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    return 'enabled must be a boolean';
  }
  if (body.argsTemplate !== undefined) {
    if (!Array.isArray(body.argsTemplate) || !body.argsTemplate.every(item => typeof item === 'string')) {
      return 'argsTemplate must be an array of strings';
    }
  }
  for (const field of ['capabilities', 'timeoutPolicy'] as const) {
    if (body[field] !== undefined) {
      const value = body[field];
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return `${field} must be an object`;
      }
    }
  }
  if (body.fallbackPolicy !== undefined) {
    try {
      normalizeProviderFallbackPolicy(body.fallbackPolicy);
    } catch (error) {
      return error instanceof Error ? error.message : 'fallbackPolicy is invalid';
    }
  }
  return undefined;
}

function publicValidationProjection(validation: ProviderValidationResult): Omit<ProviderValidationResult, 'executableResolved'> & { executableFingerprint?: string } {
  const { executableResolved, ...safe } = validation;
  return {
    ...safe,
    ...(executableResolved === undefined ? {} : { executableFingerprint: `sha256:${createHash('sha256').update(executableResolved, 'utf8').digest('hex').slice(0, 16)}` }),
  };
}

/** Returns the trimmed name, or undefined when absent. Sends a 400 when present but invalid. */
function readValidName(req: Request, body: Record<string, unknown>, res: Response, required: boolean): string | undefined {
  if (body.name === undefined) {
    if (required) {
      sendValidationError(req, res, 'Provider name is required');
    }
    return undefined;
  }
  if (typeof body.name !== 'string' || body.name.trim().length === 0) {
    sendValidationError(req, res, 'Provider name must be a non-empty string');
    return undefined;
  }
  return body.name.trim();
}

/** Matches only the provider_configurations UNIQUE(workspace_id, name) constraint, for race-condition fallback mapping. */
function isProviderNameUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint failed:\s*provider_configurations\.workspace_id,\s*provider_configurations\.name/i.test(message);
}

export interface ProviderConfigRouteOptions {
  readonly validationService?: ProviderValidationService;
  readonly validationCache?: ProviderValidationCacheRepository;
  readonly metrics?: ProviderMetricsService;
}

/** Executable mtime (ms) when the configured executable is a stat-able path; null otherwise. */
function resolveExecutableMtimeMs(executable: string | undefined): number | null {
  if (!executable) return null;
  if (!isAbsolute(executable) && !executable.includes('/') && !executable.includes('\\')) return null;
  try {
    return Math.trunc(statSync(executable).mtimeMs);
  } catch {
    return null;
  }
}

function isAuthFailure(validation: ProviderValidationResult): boolean {
  if (validation.authentication === 'unauthenticated' || validation.authentication === 'expired') return true;
  return validation.errors.some(error => /AUTH/i.test(error.code));
}

/**
 * Default provider adapter registry for the provider-config routes. Exported
 * so tests can assert the exact assembly (P57 §57: builtin.mock is registered
 * for Runtime development, E2E and CI, and never spawns a real provider
 * process).
 */
export function createDefaultProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry([
    new KimiCodeProviderAdapter({ probe: new NodeProcessProbePort() }),
    new CodexProviderAdapter({ probe: new NodeProcessProbePort() }),
    new OpenCodeProviderAdapter({ probe: new NodeProcessProbePort() }),
    new CustomCliAdapter({ probe: new NodeProcessProbePort() }),
    new MockProviderAdapter(),
  ]);
}

export function createProviderConfigRoutes(
  store: SqliteStore,
  workspaceManager: WorkspaceManager,
  options: ProviderConfigRouteOptions = {},
): Router {
  const router = Router({ mergeParams: true });
  const repo = new ProviderConfigurationRepository(store.getDatabase() as any);
  const validationCache = options.validationCache
    ?? new ProviderValidationCacheRepository(store.getDatabase() as any);
  const metrics = options.metrics ?? sharedProviderMetricsService;
  const validationService = options.validationService
    ?? new ProviderValidationService(createDefaultProviderRegistry());

  router.get('/provider-configs', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) { sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' }); return; }
    try {
      const configs = repo.findByWorkspace(workspace.id);
      res.json({ providerConfigs: configs, workspaceId: workspace.id });
    } catch (error) {
      sendInternalError(req, res, 'list provider configurations failed', error);
    }
  });

  router.get('/provider-configs/:providerConfigId', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) { sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' }); return; }
    try {
      const config = repo.findById(req.params.providerConfigId);
      if (!config || config.workspaceId !== workspace.id) {
        sendProblem(req, res, { status: 404, code: 'PROVIDER_CONFIG_NOT_FOUND', detail: 'Provider configuration not found' }); return;
      }
      res.json({ providerConfig: config, workspaceId: workspace.id });
    } catch (error) {
      sendInternalError(req, res, 'get provider configuration failed', error);
    }
  });

  router.post('/provider-configs/:providerConfigId/validate', asyncHandler(async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) { sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' }); return; }
    try {
      const config = repo.findById(req.params.providerConfigId);
      if (!config || config.workspaceId !== workspace.id) {
        sendProblem(req, res, { status: 404, code: 'PROVIDER_CONFIG_NOT_FOUND', detail: 'Provider configuration not found' }); return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.forceRefresh !== undefined && typeof body.forceRefresh !== 'boolean') {
        return sendValidationError(req, res, 'forceRefresh must be a boolean');
      }
      const forceRefresh = body.forceRefresh === true;

      // 04-Provider-Specification §14.5: reuse a short-term validation cache
      // keyed by config identity + configuration version + executable mtime +
      // environment profile version + adapter version. Any change misses.
      const ttlMs = resolveProviderValidationCacheTtlMs();
      const cacheKey = computeProviderValidationCacheKey({
        providerConfigId: config.id,
        configurationVersion: config.version,
        executableMtimeMs: resolveExecutableMtimeMs(config.executable),
        environmentProfileVersion: null,
        adapterVersion: resolveFrozenProviderIdentity(config)?.adapterVersion ?? config.adapterId,
      });

      let validation: ProviderValidationResult | undefined;
      if (ttlMs > 0 && !forceRefresh) {
        const cachedJson = validationCache.get(cacheKey, new Date().toISOString());
        if (cachedJson !== null) {
          try {
            validation = { ...JSON.parse(cachedJson) as ProviderValidationResult, fromCache: true };
          } catch {
            validation = undefined;
          }
        }
      }

      if (validation === undefined) {
        const startedAt = Date.now();
        validation = await validationService.validate(config, {
          environment: process.env,
          workspaceRoot: workspace.rootPath,
          forceRefresh,
        });
        const latencyMs = Date.now() - startedAt;
        if (ttlMs > 0) {
          validationCache.set({
            workspaceId: workspace.id,
            providerConfigId: config.id,
            cacheKey,
            configurationVersion: config.version,
            resultJson: JSON.stringify(validation),
            now: new Date().toISOString(),
            ttlMs,
          });
        }
        metrics.recordValidation({
          workspaceId: workspace.id,
          providerConfigId: config.id,
          valid: validation.valid,
          authFailure: isAuthFailure(validation),
          fromCache: false,
          latencyMs,
        });
      } else {
        metrics.recordValidation({
          workspaceId: workspace.id,
          providerConfigId: config.id,
          valid: validation.valid,
          authFailure: isAuthFailure(validation),
          fromCache: true,
          latencyMs: 0,
        });
      }
      return res.status(200).json({
        providerConfigId: config.id,
        workspaceId: workspace.id,
        validation: publicValidationProjection(validation),
      });
    } catch {
      // Validation adapters own potentially sensitive probe details; keep them out of
      // both the response and route-level logs when an unexpected exception escapes.
console.error('[provider-configs] validate provider configuration failed');
      sendProblem(req, res, { status: 500, code: 'INTERNAL_ERROR', detail: 'Internal server error' });
      return;
    }
  }));

  router.post('/provider-configs', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) { sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' }); return; }
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (findForbiddenSecretField(body)) {
        sendProblem(req, res, { status: 400, code: 'SECRET_VALUE_NOT_ALLOWED', detail: 'Raw secret values are not accepted; use secretProfileId' }); return;
      }
      const name = readValidName(req, body, res, true);
      if (name === undefined) return;
      const enumError = validateEnumFields(body);
      if (enumError) return sendValidationError(req, res, enumError);
      const structuredError = validateStructuredFields(body);
      if (structuredError) return sendValidationError(req, res, structuredError);

      if (repo.findByWorkspaceAndName(workspace.id, name)) {
        sendProblem(req, res, { status: 409, code: 'PROVIDER_CONFIG_NAME_CONFLICT', detail: 'A provider configuration with this name already exists' });
        return;
      }

      const now = new Date().toISOString();
      const config: ProviderConfiguration = {
        id: createEntityId('provider'),
        workspaceId: workspace.id,
        name,
        providerType: (body.providerType as ProviderConfiguration['providerType'] | undefined) || 'custom-cli',
        adapterId: (body.adapterId as string | undefined) || 'builtin.custom-cli',
        runtimeMode: (body.runtimeMode as ProviderConfiguration['runtimeMode'] | undefined) || 'cli',
        executable: body.executable as string | undefined,
        argsTemplate: body.argsTemplate as string[] | undefined,
        promptDelivery: body.promptDelivery as ProviderConfiguration['promptDelivery'] | undefined,
        ...(body.fallbackPolicy === undefined
          ? {}
          : { fallbackPolicy: normalizeProviderFallbackPolicy(body.fallbackPolicy) }),
        model: body.model as string | undefined,
        environmentProfileId: body.environmentProfileId as string | undefined,
        secretProfileId: body.secretProfileId as string | undefined,
        workingDirectoryMode: (body.workingDirectoryMode as ProviderConfiguration['workingDirectoryMode'] | undefined) || 'workspace',
        customWorkingDirectory: body.customWorkingDirectory as string | undefined,
        capabilities: (body.capabilities as ProviderConfiguration['capabilities'] | undefined) || { ...DEFAULT_CAPABILITIES },
        timeoutPolicy: (body.timeoutPolicy as ProviderConfiguration['timeoutPolicy'] | undefined) || { ...DEFAULT_TIMEOUT_POLICY },
        approvalMode: (body.approvalMode as ProviderConfiguration['approvalMode'] | undefined) || 'agentos',
        outputMode: (body.outputMode as ProviderConfiguration['outputMode'] | undefined) || 'parsed-text',
        enabled: body.enabled !== false,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      const created = repo.insert(config);
      res.status(201).json({ providerConfig: created, workspaceId: workspace.id });
    } catch (error) {
      if (isProviderNameUniqueViolation(error)) {
        sendProblem(req, res, { status: 409, code: 'PROVIDER_CONFIG_NAME_CONFLICT', detail: 'A provider configuration with this name already exists' });
        return;
      }
      sendInternalError(req, res, 'create provider configuration failed', error);
    }
  });

  router.put('/provider-configs/:providerConfigId', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) { sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' }); return; }
    try {
      const existing = repo.findById(req.params.providerConfigId);
      if (!existing || existing.workspaceId !== workspace.id) {
        sendProblem(req, res, { status: 404, code: 'PROVIDER_CONFIG_NOT_FOUND', detail: 'Provider configuration not found' }); return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (findForbiddenSecretField(body)) {
        sendProblem(req, res, { status: 400, code: 'SECRET_VALUE_NOT_ALLOWED', detail: 'Raw secret values are not accepted; use secretProfileId' }); return;
      }
      const expectedVersion = typeof body.expectedVersion === 'number' && Number.isInteger(body.expectedVersion)
        ? body.expectedVersion
        : undefined;
      if (expectedVersion === undefined) {
        return sendValidationError(req, res, 'expectedVersion is required for updates');
      }
      if (existing.version !== expectedVersion) {
        sendProblem(req, res, { status: 409, code: 'VERSION_CONFLICT', detail: `Version conflict: expected ${expectedVersion}, current ${existing.version}` });
        return;
      }
      const name = readValidName(req, body, res, false);
      if (name === undefined && body.name !== undefined) return;
      const enumError = validateEnumFields(body);
      if (enumError) return sendValidationError(req, res, enumError);
      const structuredError = validateStructuredFields(body);
      if (structuredError) return sendValidationError(req, res, structuredError);

      if (name !== undefined) {
        const nameConflict = repo.findByWorkspaceAndName(workspace.id, name);
        if (nameConflict && nameConflict.id !== existing.id) {
          return res.status(409).json({
            error: 'A provider configuration with this name already exists',
            code: 'PROVIDER_CONFIG_NAME_CONFLICT',
          });
        }
      }

      const updated: ProviderConfiguration = {
        ...existing,
        name: name ?? existing.name,
        providerType: (body.providerType as ProviderConfiguration['providerType'] | undefined) ?? existing.providerType,
        adapterId: (body.adapterId as string | undefined) ?? existing.adapterId,
        runtimeMode: (body.runtimeMode as ProviderConfiguration['runtimeMode'] | undefined) ?? existing.runtimeMode,
        executable: body.executable !== undefined ? body.executable as string | undefined : existing.executable,
        argsTemplate: (body.argsTemplate as string[] | undefined) ?? existing.argsTemplate,
        promptDelivery: body.promptDelivery !== undefined
          ? body.promptDelivery as ProviderConfiguration['promptDelivery'] | undefined
          : existing.promptDelivery,
        ...(body.fallbackPolicy !== undefined
          ? { fallbackPolicy: normalizeProviderFallbackPolicy(body.fallbackPolicy) }
          : {}),
        model: body.model !== undefined ? body.model as string | undefined : existing.model,
        environmentProfileId: body.environmentProfileId !== undefined ? body.environmentProfileId as string | undefined : existing.environmentProfileId,
        secretProfileId: body.secretProfileId !== undefined ? body.secretProfileId as string | undefined : existing.secretProfileId,
        workingDirectoryMode: (body.workingDirectoryMode as ProviderConfiguration['workingDirectoryMode'] | undefined) ?? existing.workingDirectoryMode,
        customWorkingDirectory: body.customWorkingDirectory !== undefined ? body.customWorkingDirectory as string | undefined : existing.customWorkingDirectory,
        capabilities: (body.capabilities as ProviderConfiguration['capabilities'] | undefined) ?? existing.capabilities,
        timeoutPolicy: (body.timeoutPolicy as ProviderConfiguration['timeoutPolicy'] | undefined) ?? existing.timeoutPolicy,
        approvalMode: (body.approvalMode as ProviderConfiguration['approvalMode'] | undefined) ?? existing.approvalMode,
        outputMode: (body.outputMode as ProviderConfiguration['outputMode'] | undefined) ?? existing.outputMode,
        enabled: body.enabled !== undefined ? body.enabled as boolean : existing.enabled,
        updatedAt: new Date().toISOString(),
      };
      // Pass the client-provided version directly; repository uses it in the WHERE clause
      // so stale clients are correctly rejected.
      const saved = repo.update(updated, expectedVersion);
      res.json({ providerConfig: saved, workspaceId: workspace.id });
    } catch (error) {
      if (isProviderNameUniqueViolation(error)) {
        sendProblem(req, res, { status: 409, code: 'PROVIDER_CONFIG_NAME_CONFLICT', detail: 'A provider configuration with this name already exists' });
        return;
      }
      if (error instanceof Error && error.message.includes('version conflict')) {
        sendProblem(req, res, { status: 409, code: 'VERSION_CONFLICT', detail: error.message }); return;
      }
      sendInternalError(req, res, 'update provider configuration failed', error);
    }
  });

  router.delete('/provider-configs/:providerConfigId', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) { sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' }); return; }
    try {
      const existing = repo.findById(req.params.providerConfigId);
      if (!existing || existing.workspaceId !== workspace.id) {
        sendProblem(req, res, { status: 404, code: 'PROVIDER_CONFIG_NOT_FOUND', detail: 'Provider configuration not found' }); return;
      }
      const expectedVersion = typeof req.body.expectedVersion === 'number' && Number.isInteger(req.body.expectedVersion)
        ? req.body.expectedVersion
        : undefined;
      if (expectedVersion === undefined) {
        sendProblem(req, res, { status: 400, code: 'VALIDATION_ERROR', detail: 'expectedVersion is required for archive' }); return;
      }
      if (existing.version !== expectedVersion) {
        sendProblem(req, res, { status: 409, code: 'VERSION_CONFLICT', detail: `Version conflict: expected ${expectedVersion}, current ${existing.version}` });
        return;
      }
      // Check if any enabled agent profile references this config
      const db = store.getDatabase();
      const activeRef = db.prepare(`
        SELECT 1 FROM agent_profiles WHERE provider_config_id = ? AND enabled = 1 LIMIT 1
      `).get(existing.id) as undefined | Record<string, unknown>;
      if (activeRef) {
        sendProblem(req, res, { status: 409, code: 'PROVIDER_CONFIG_IN_USE', detail: 'Provider configuration is referenced by an enabled agent and cannot be archived' });
        return;
      }
      repo.archive(existing.id, expectedVersion);
      res.json({ ok: true });
    } catch (error) {
      sendInternalError(req, res, 'archive provider configuration failed', error);
    }
  });

  return router;
}
