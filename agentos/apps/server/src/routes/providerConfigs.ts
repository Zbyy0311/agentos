import { Router, type Request, type Response } from 'express';
import type { SqliteStore } from '../store/SqliteStore.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { ProviderConfigurationRepository, DEFAULT_CAPABILITIES, DEFAULT_TIMEOUT_POLICY } from '../store/ProviderConfigurationRepository.js';
import { createEntityId } from '../store/Identity.js';
import type { ProviderConfiguration } from '../store/ProviderConfigurationRepository.js';
import { KimiCodeProviderAdapter, ProviderRegistry, ProviderValidationService } from '@agentos/agent-core/providers';
import { NodeProcessProbePort } from '@agentos/process-runtime';
import type { ProviderValidationResult } from '@agentos/agent-core/providers';
import { createHash } from 'node:crypto';

const VALID_PROVIDER_TYPES = ['codex','claude-code','kimicode','opencode','gemini-cli','custom-cli','remote'] as const;
const VALID_RUNTIME_MODES = ['cli','api','ssh','container'] as const;
const VALID_WORKING_DIRECTORY_MODES = ['workspace','worktree','custom'] as const;
const VALID_APPROVAL_MODES = ['agentos','native','hybrid','disabled'] as const;
const VALID_OUTPUT_MODES = ['structured','parsed-text','raw-stream'] as const;

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

function sendValidationError(res: Response, message: string): void {
  res.status(400).json({ error: message, code: 'VALIDATION_ERROR' });
}

function sendInternalError(res: Response, logContext: string, error: unknown): void {
  console.error(`[provider-configs] ${logContext}`, error);
  res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
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
    ?? validateEnumField(body, 'outputMode', VALID_OUTPUT_MODES);
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
function readValidName(body: Record<string, unknown>, res: Response, required: boolean): string | undefined {
  if (body.name === undefined) {
    if (required) {
      sendValidationError(res, 'Provider name is required');
    }
    return undefined;
  }
  if (typeof body.name !== 'string' || body.name.trim().length === 0) {
    sendValidationError(res, 'Provider name must be a non-empty string');
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
}

export function createProviderConfigRoutes(
  store: SqliteStore,
  workspaceManager: WorkspaceManager,
  options: ProviderConfigRouteOptions = {},
): Router {
  const router = Router({ mergeParams: true });
  const repo = new ProviderConfigurationRepository(store.getDatabase() as any);
  const validationService = options.validationService
    ?? new ProviderValidationService(new ProviderRegistry([new KimiCodeProviderAdapter({ probe: new NodeProcessProbePort() })]));

  router.get('/provider-configs', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found', code: 'WORKSPACE_NOT_FOUND' });
    try {
      const configs = repo.findByWorkspace(workspace.id);
      res.json({ providerConfigs: configs, workspaceId: workspace.id });
    } catch (error) {
      sendInternalError(res, 'list provider configurations failed', error);
    }
  });

  router.get('/provider-configs/:providerConfigId', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found', code: 'WORKSPACE_NOT_FOUND' });
    try {
      const config = repo.findById(req.params.providerConfigId);
      if (!config || config.workspaceId !== workspace.id) {
        return res.status(404).json({ error: 'Provider configuration not found', code: 'PROVIDER_CONFIG_NOT_FOUND' });
      }
      res.json({ providerConfig: config, workspaceId: workspace.id });
    } catch (error) {
      sendInternalError(res, 'get provider configuration failed', error);
    }
  });

  router.post('/provider-configs/:providerConfigId/validate', async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found', code: 'WORKSPACE_NOT_FOUND' });
    try {
      const config = repo.findById(req.params.providerConfigId);
      if (!config || config.workspaceId !== workspace.id) {
        return res.status(404).json({ error: 'Provider configuration not found', code: 'PROVIDER_CONFIG_NOT_FOUND' });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.forceRefresh !== undefined && typeof body.forceRefresh !== 'boolean') {
        return sendValidationError(res, 'forceRefresh must be a boolean');
      }
      const validation = await validationService.validate(config, {
        environment: process.env,
        workspaceRoot: workspace.rootPath,
        forceRefresh: body.forceRefresh === true,
      });
      return res.status(200).json({
        providerConfigId: config.id,
        workspaceId: workspace.id,
        validation: publicValidationProjection(validation),
      });
    } catch {
      // Validation adapters own potentially sensitive probe details; keep them out of
      // both the response and route-level logs when an unexpected exception escapes.
      console.error('[provider-configs] validate provider configuration failed');
      return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  router.post('/provider-configs', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found', code: 'WORKSPACE_NOT_FOUND' });
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (findForbiddenSecretField(body)) {
        return res.status(400).json({ error: 'Raw secret values are not accepted; use secretProfileId', code: 'SECRET_VALUE_NOT_ALLOWED' });
      }
      const name = readValidName(body, res, true);
      if (name === undefined) return;
      const enumError = validateEnumFields(body);
      if (enumError) return sendValidationError(res, enumError);
      const structuredError = validateStructuredFields(body);
      if (structuredError) return sendValidationError(res, structuredError);

      if (repo.findByWorkspaceAndName(workspace.id, name)) {
        return res.status(409).json({
          error: 'A provider configuration with this name already exists',
          code: 'PROVIDER_CONFIG_NAME_CONFLICT',
        });
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
        return res.status(409).json({
          error: 'A provider configuration with this name already exists',
          code: 'PROVIDER_CONFIG_NAME_CONFLICT',
        });
      }
      sendInternalError(res, 'create provider configuration failed', error);
    }
  });

  router.put('/provider-configs/:providerConfigId', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found', code: 'WORKSPACE_NOT_FOUND' });
    try {
      const existing = repo.findById(req.params.providerConfigId);
      if (!existing || existing.workspaceId !== workspace.id) {
        return res.status(404).json({ error: 'Provider configuration not found', code: 'PROVIDER_CONFIG_NOT_FOUND' });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (findForbiddenSecretField(body)) {
        return res.status(400).json({ error: 'Raw secret values are not accepted; use secretProfileId', code: 'SECRET_VALUE_NOT_ALLOWED' });
      }
      const expectedVersion = typeof body.expectedVersion === 'number' && Number.isInteger(body.expectedVersion)
        ? body.expectedVersion
        : undefined;
      if (expectedVersion === undefined) {
        return sendValidationError(res, 'expectedVersion is required for updates');
      }
      if (existing.version !== expectedVersion) {
        return res.status(409).json({
          error: `Version conflict: expected ${expectedVersion}, current ${existing.version}`,
          code: 'VERSION_CONFLICT',
        });
      }
      const name = readValidName(body, res, false);
      if (name === undefined && body.name !== undefined) return;
      const enumError = validateEnumFields(body);
      if (enumError) return sendValidationError(res, enumError);
      const structuredError = validateStructuredFields(body);
      if (structuredError) return sendValidationError(res, structuredError);

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
        return res.status(409).json({
          error: 'A provider configuration with this name already exists',
          code: 'PROVIDER_CONFIG_NAME_CONFLICT',
        });
      }
      if (error instanceof Error && error.message.includes('version conflict')) {
        return res.status(409).json({ error: error.message, code: 'VERSION_CONFLICT' });
      }
      sendInternalError(res, 'update provider configuration failed', error);
    }
  });

  router.delete('/provider-configs/:providerConfigId', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found', code: 'WORKSPACE_NOT_FOUND' });
    try {
      const existing = repo.findById(req.params.providerConfigId);
      if (!existing || existing.workspaceId !== workspace.id) {
        return res.status(404).json({ error: 'Provider configuration not found', code: 'PROVIDER_CONFIG_NOT_FOUND' });
      }
      const expectedVersion = typeof req.body.expectedVersion === 'number' && Number.isInteger(req.body.expectedVersion)
        ? req.body.expectedVersion
        : undefined;
      if (expectedVersion === undefined) {
        return res.status(400).json({ error: 'expectedVersion is required for archive', code: 'VALIDATION_ERROR' });
      }
      if (existing.version !== expectedVersion) {
        return res.status(409).json({
          error: `Version conflict: expected ${expectedVersion}, current ${existing.version}`,
          code: 'VERSION_CONFLICT',
        });
      }
      // Check if any enabled agent profile references this config
      const db = store.getDatabase();
      const activeRef = db.prepare(`
        SELECT 1 FROM agent_profiles WHERE provider_config_id = ? AND enabled = 1 LIMIT 1
      `).get(existing.id) as undefined | Record<string, unknown>;
      if (activeRef) {
        return res.status(409).json({
          error: 'Provider configuration is referenced by an enabled agent and cannot be archived',
          code: 'PROVIDER_CONFIG_IN_USE',
        });
      }
      repo.archive(existing.id, expectedVersion);
      res.json({ ok: true });
    } catch (error) {
      sendInternalError(res, 'archive provider configuration failed', error);
    }
  });

  return router;
}
