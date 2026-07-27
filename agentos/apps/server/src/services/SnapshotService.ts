import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  AgentPermission,
  AgentSnapshotV1,
  ProviderConfigurationSnapshotV1,
  Run,
  RunSnapshot,
  RunStage,
  RunSnapshotPayloadV1,
  Workspace,
  WorkspaceAgent,
} from '@agentos/shared';
import type { ProviderConfigurationRepository, ProviderConfiguration } from '../store/ProviderConfigurationRepository.js';
import type { RunSnapshotRepository } from '../store/RunSnapshotRepository.js';
import type { RunStageRepository } from '../store/RunStageRepository.js';
import type { AgentSnapshotSourceRecord } from '../store/SqliteStore.js';
import { WorkflowDefinitionResolver, WorkflowNotAvailableError } from './WorkflowDefinitionResolver.js';
import type { WorkflowDefinition } from '@agentos/shared';

export interface ResolvedStageConfiguration {
  workflowStageKey: string;
  name: string;
  sequence: number;
  agent: AgentSnapshotV1 | null;
  provider: ProviderConfigurationSnapshotV1 | null;
  runnerAgent: WorkspaceAgent | null;
}

export interface ResolvedRunConfiguration {
  workflow: WorkflowDefinition;
  stages: readonly ResolvedStageConfiguration[];
  redactionApplied: boolean;
}

export interface SnapshotServiceDeps {
  workflowDefinitionResolver: WorkflowDefinitionResolver;
  runSnapshotRepository: () => RunSnapshotRepository;
  runStageRepository: () => RunStageRepository;
  providerConfigurationRepository: () => ProviderConfigurationRepository;
  findAgentSnapshotSource: (workspaceId: string, agentId: string) => AgentSnapshotSourceRecord | undefined;
  now?: () => string;
}

export class AgentNotAvailableError extends Error {
  readonly code = 'AGENT_NOT_AVAILABLE' as const;

  constructor() {
    super('AGENT_NOT_AVAILABLE');
    this.name = 'AgentNotAvailableError';
  }
}

export class ProviderConfigNotAvailableError extends Error {
  readonly code = 'PROVIDER_CONFIG_NOT_AVAILABLE' as const;

  constructor() {
    super('PROVIDER_CONFIG_NOT_AVAILABLE');
    this.name = 'ProviderConfigNotAvailableError';
  }
}

export class RunSnapshotFailedError extends Error {
  readonly code = 'RUN_SNAPSHOT_FAILED' as const;

  constructor(cause?: unknown) {
    super('RUN_SNAPSHOT_FAILED');
    this.name = 'RunSnapshotFailedError';
    if (cause !== undefined) Object.defineProperty(this, 'cause', { value: cause, enumerable: false });
  }
}

const ALLOWED_PERMISSIONS = new Set<AgentPermission>(['read', 'write', 'review']);
const APPROVED_PLACEHOLDER = /^\$\{[A-Z][A-Z0-9_]*\}$/;

function isApprovedPlaceholder(value: string): boolean {
  return APPROVED_PLACEHOLDER.test(value);
}

function rejectUnsafeValue(value: string): void {
  if (/-----BEGIN [^-\r\n]*PRIVATE KEY-----/i.test(value)) {
    throw new RunSnapshotFailedError();
  }
  if (/\bAuthorization\s*:/i.test(value) || /\bCookie\s*:/i.test(value)) {
    throw new RunSnapshotFailedError();
  }

  const bearer = /\bBearer\s+([^\s,;]+)/gi;
  for (const match of value.matchAll(bearer)) {
    if (!isApprovedPlaceholder(match[1] ?? '')) throw new RunSnapshotFailedError();
  }

  const assignment = /\b(api[_-]?key|token|password|secret|client[_-]?secret)\s*[:=]\s*([^\s,;]+)/gi;
  for (const match of value.matchAll(assignment)) {
    if (!isApprovedPlaceholder(match[2] ?? '')) throw new RunSnapshotFailedError();
  }

  const flag = /(?:^|\s)--(api-key|token|access-token|password|secret|client-secret)(?:=|\s+)([^\s,;]+)/gi;
  for (const match of value.matchAll(flag)) {
    if (!isApprovedPlaceholder(match[2] ?? '')) throw new RunSnapshotFailedError();
  }
}

const SENSITIVE_ARGUMENT_FLAG = /^--(api-key|token|access-token|password|secret|client-secret)(?:\s*=\s*(.*))?$/i;

function scanSensitiveArguments(argsTemplate: readonly string[]): void {
  for (let index = 0; index < argsTemplate.length; index += 1) {
    const token = argsTemplate[index]!.trim();
    const match = SENSITIVE_ARGUMENT_FLAG.exec(token);
    if (!match) continue;

    let value = match[2]?.trim() ?? '';
    if (value.length === 0) value = argsTemplate[index + 1]?.trim() ?? '';
    if (!isApprovedPlaceholder(value)) throw new RunSnapshotFailedError();
  }
}

function scanSnapshotText(values: readonly string[]): void {
  for (const value of values) rejectUnsafeValue(value);
}

function asWorkspaceRelativeDirectory(workspace: Workspace, provider: ProviderConfiguration): string | null {
  if (provider.workingDirectoryMode !== 'custom') return null;
  if (!provider.customWorkingDirectory) throw new RunSnapshotFailedError();

  const workspaceRoot = resolve(workspace.rootPath);
  const target = resolve(provider.customWorkingDirectory);
  const workspaceRelative = relative(workspaceRoot, target);
  if (
    isAbsolute(workspaceRelative)
    || workspaceRelative === '..'
    || workspaceRelative.startsWith(`..${sep}`)
  ) {
    throw new RunSnapshotFailedError();
  }
  return workspaceRelative || '.';
}

function providerSnapshot(
  workspace: Workspace,
  provider: ProviderConfiguration,
): ProviderConfigurationSnapshotV1 {
  const executable = provider.executable ?? null;
  if (executable === null || executable.length === 0) throw new RunSnapshotFailedError();
  const argsTemplate = provider.argsTemplate ?? [];
  if (!Array.isArray(argsTemplate) || argsTemplate.some(argument => typeof argument !== 'string')) {
    throw new RunSnapshotFailedError();
  }
  scanSensitiveArguments(argsTemplate);
  scanSnapshotText([
    provider.name,
    provider.adapterId,
    executable,
    provider.model ?? '',
    ...argsTemplate,
    argsTemplate.join(' '),
  ]);
  return {
    providerConfigId: provider.id,
    name: provider.name,
    providerType: provider.providerType,
    adapterId: provider.adapterId,
    runtimeMode: provider.runtimeMode,
    executable,
    argsTemplate: [...argsTemplate],
    model: provider.model ?? null,
    environmentProfileId: provider.environmentProfileId ?? null,
    secretProfileId: provider.secretProfileId ?? null,
    workingDirectoryMode: provider.workingDirectoryMode,
    workspaceRelativeWorkingDirectory: asWorkspaceRelativeDirectory(workspace, provider),
    capabilities: structuredClone(provider.capabilities),
    timeoutPolicy: structuredClone(provider.timeoutPolicy),
    approvalMode: provider.approvalMode,
    outputMode: provider.outputMode,
    enabled: provider.enabled,
    version: provider.version,
  };
}

function assertAgentSource(
  workspace: Workspace,
  selected: WorkspaceAgent,
  source: AgentSnapshotSourceRecord | undefined,
): AgentSnapshotSourceRecord {
  if (
    !source
    || source.workspaceId !== workspace.id
    || source.id !== selected.id
    || source.enabled !== true
    || source.role !== selected.role
    || source.version < 1
    || !Array.isArray(source.permissions)
    || source.permissions.length === 0
    || source.permissions.some(permission => !ALLOWED_PERMISSIONS.has(permission))
  ) {
    throw new AgentNotAvailableError();
  }
  if (source.providerConfigId === null) throw new ProviderConfigNotAvailableError();
  return source;
}

function agentSnapshot(source: AgentSnapshotSourceRecord): AgentSnapshotV1 {
  scanSnapshotText([source.name, source.roleTitle, source.systemPrompt]);
  return {
    agentId: source.id,
    name: source.name,
    role: source.role,
    roleTitle: source.roleTitle,
    systemPrompt: source.systemPrompt,
    permissions: [...source.permissions],
    providerConfigId: source.providerConfigId!,
    enabled: source.enabled,
    version: source.version,
  };
}

function runnerAgent(
  source: AgentSnapshotSourceRecord,
  provider: ProviderConfigurationSnapshotV1,
  selected: WorkspaceAgent,
): WorkspaceAgent {
  return {
    id: source.id,
    name: source.name,
    role: source.role,
    enabled: true,
    cliCommand: provider.executable!,
    cliArgs: [...provider.argsTemplate],
    ...(provider.model === null ? {} : { model: provider.model }),
    thinkingEffort: selected.thinkingEffort ?? 'auto',
    providerConfigId: provider.providerConfigId,
  };
}

function mapPersistedStage(stage: ResolvedStageConfiguration): {
  workflowStageKey: string;
  sequence: number;
} {
  return { workflowStageKey: stage.workflowStageKey, sequence: stage.sequence };
}

export class SnapshotService {
  private readonly now: () => string;

  constructor(private readonly deps: SnapshotServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  resolveUnbound(workspaceId: string): ResolvedRunConfiguration {
    try {
      return {
        workflow: this.deps.workflowDefinitionResolver.resolveUnboundTaskRun(),
        stages: [],
        redactionApplied: false,
      };
    } catch (error) {
      if (error instanceof WorkflowNotAvailableError) throw error;
      throw new RunSnapshotFailedError(error);
    }
  }

  resolveLegacy(workspace: Workspace): ResolvedRunConfiguration {
    try {
      const workspaceAgentIds = new Set<string>();
      for (const agent of workspace.agents) {
        if (typeof agent.id !== 'string' || !agent.id.trim() || workspaceAgentIds.has(agent.id)) {
          throw new AgentNotAvailableError();
        }
        workspaceAgentIds.add(agent.id);
      }
      const workflow = this.deps.workflowDefinitionResolver.resolveLegacyPipeline();
      const agents = new Map<string, {
        snapshot: AgentSnapshotV1;
        provider: ProviderConfigurationSnapshotV1;
        runner: WorkspaceAgent;
      }>();
      const stages: ResolvedStageConfiguration[] = [];

      for (const workflowStage of workflow.payload.stages) {
        if (!workflowStage.agentRole) throw new RunSnapshotFailedError();
        const selected = workspace.agents.find(
          agent => agent.role === workflowStage.agentRole && agent.enabled,
        );
        if (!selected) throw new AgentNotAvailableError();

        let binding = agents.get(selected.id);
        if (!binding) {
          const source = assertAgentSource(
            workspace,
            selected,
            this.deps.findAgentSnapshotSource(workspace.id, selected.id),
          );
          const providerId = source.providerConfigId;
          if (!providerId) throw new ProviderConfigNotAvailableError();
          const provider = this.deps.providerConfigurationRepository().findById(providerId);
          if (
            !provider
            || provider.workspaceId !== workspace.id
            || provider.enabled !== true
            || provider.archivedAt !== undefined
            || provider.version < 1
          ) {
            throw new ProviderConfigNotAvailableError();
          }
          const providerSnapshotValue = providerSnapshot(workspace, provider);
          const agentSnapshotValue = agentSnapshot(source);
          binding = {
            snapshot: agentSnapshotValue,
            provider: providerSnapshotValue,
            runner: runnerAgent(source, providerSnapshotValue, selected),
          };
          agents.set(selected.id, binding);
        }
        if (
          binding.snapshot.agentId !== selected.id
          || binding.snapshot.role !== workflowStage.agentRole
          || binding.runner.id !== selected.id
          || binding.runner.role !== workflowStage.agentRole
        ) {
          throw new AgentNotAvailableError();
        }
        stages.push({
          workflowStageKey: workflowStage.key,
          name: workflowStage.key,
          sequence: workflowStage.sequence,
          agent: structuredClone(binding.snapshot),
          provider: structuredClone(binding.provider),
          runnerAgent: structuredClone(binding.runner),
        });
      }

      return { workflow, stages, redactionApplied: false };
    } catch (error) {
      if (error instanceof AgentNotAvailableError || error instanceof ProviderConfigNotAvailableError) throw error;
      if (error instanceof WorkflowNotAvailableError) throw error;
      if (error instanceof RunSnapshotFailedError) throw error;
      throw new RunSnapshotFailedError(error);
    }
  }

  persistResolvedRun(
    run: Run,
    resolved: ResolvedRunConfiguration,
  ): { snapshot: RunSnapshot; stages: RunStage[] } {
    try {
      const capturedAt = this.now();
      const payload: RunSnapshotPayloadV1 = {
        schemaVersion: 1,
        capturedAt,
        run: {
          workspaceId: run.workspaceId,
          taskId: run.taskId,
          origin: run.origin,
          reason: run.reason,
          parentRunId: run.parentRunId ?? null,
          rootRunId: run.rootRunId,
        },
        workflow: {
          definitionId: resolved.workflow.id,
          definitionKey: resolved.workflow.definitionKey,
          definitionVersion: resolved.workflow.version,
          name: resolved.workflow.name,
          definitionHash: resolved.workflow.definitionHash,
          stages: resolved.stages.map(stage => ({
            workflowStageKey: stage.workflowStageKey,
            name: stage.name,
            sequence: stage.sequence,
            agent: stage.agent ? structuredClone(stage.agent) : null,
            provider: stage.provider ? structuredClone(stage.provider) : null,
          })),
        },
        security: { redactionApplied: resolved.redactionApplied },
      };
      scanSnapshotText(
        payload.workflow.stages.flatMap(stage => [
          stage.name,
          ...(stage.agent ? [stage.agent.name, stage.agent.roleTitle, stage.agent.systemPrompt] : []),
          ...(stage.provider
            ? [stage.provider.name, stage.provider.adapterId, stage.provider.executable ?? '', stage.provider.model ?? '', ...stage.provider.argsTemplate]
            : []),
        ]),
      );
      const snapshot = this.deps.runSnapshotRepository().insert({
        workspaceId: run.workspaceId,
        runId: run.id,
        workflowDefinitionId: resolved.workflow.id,
        payload,
      });
      const stages: RunStage[] = [];
      for (const stage of resolved.stages) {
        const materialized = mapPersistedStage(stage);
        stages.push(this.deps.runStageRepository().insertInitial({
          workspaceId: run.workspaceId,
          runId: run.id,
          runSnapshotId: snapshot.id,
          workflowStageKey: materialized.workflowStageKey,
          sequence: materialized.sequence,
        }));
      }
      return { snapshot, stages };
    } catch (error) {
      if (error instanceof RunSnapshotFailedError) throw error;
      throw new RunSnapshotFailedError(error);
    }
  }

  buildLegacyRunnerWorkspace(
    workspace: Workspace,
    resolved: ResolvedRunConfiguration,
  ): Workspace {
    const projectedAgents: WorkspaceAgent[] = [];
    const seen = new Set<string>();
    for (const stage of [...resolved.stages].sort((left, right) => left.sequence - right.sequence)) {
      const agent = stage.runnerAgent;
      if (!agent || seen.has(agent.id)) continue;
      seen.add(agent.id);
      projectedAgents.push(structuredClone(agent));
    }
    const projected = structuredClone(workspace);
    projected.agents = projectedAgents;
    return projected;
  }
}
