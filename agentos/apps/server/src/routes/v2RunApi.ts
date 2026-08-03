import type {
  AgentSnapshotV1,
  ProviderConfigurationSnapshotV1,
  Run,
  RunSnapshot,
  RunSnapshotPayload,
  RunSnapshotPayloadV2,
  RunStage,
  WorkflowStageSnapshotV1,
  WorkflowStageSnapshotV2,
} from '@agentos/shared';
import { posix, win32 } from 'node:path';
import { V2ValidationError } from './v2Tasks.js';

export type V2RunInclude = 'snapshot' | 'stages';

export class RunSnapshotApiSafetyError extends Error {
  readonly code = 'RUN_SNAPSHOT_FAILED' as const;

  constructor() {
    super('RUN_SNAPSHOT_FAILED');
    this.name = 'RunSnapshotApiSafetyError';
  }
}

export interface BuildV2RunDetailInput {
  run: Run;
  snapshot: RunSnapshot | undefined;
  stages: readonly RunStage[];
  include: ReadonlySet<V2RunInclude>;
}

const ALLOWED_INCLUDES = new Set<V2RunInclude>(['snapshot', 'stages']);
const APPROVED_PLACEHOLDER = /^\$\{[A-Z][A-Z0-9_]*\}$/;
const SENSITIVE_FLAG = /^--(api-key|token|access-token|password|secret|client-secret)(?:\s*=\s*(.*))?$/i;

function validationFailure(): V2ValidationError {
  return new V2ValidationError('invalid include');
}

export function parseV2RunInclude(value: unknown): ReadonlySet<V2RunInclude> {
  if (value === undefined) return new Set<V2RunInclude>();
  if (typeof value !== 'string' || value.length === 0) throw validationFailure();

  const includes = new Set<V2RunInclude>();
  for (const rawToken of value.split(',')) {
    const token = rawToken.trim();
    if (!token || !ALLOWED_INCLUDES.has(token as V2RunInclude)) throw validationFailure();
    includes.add(token as V2RunInclude);
  }
  return includes;
}

function isApprovedPlaceholder(value: string): boolean {
  return APPROVED_PLACEHOLDER.test(value);
}

function rejectUnsafeText(value: string): void {
  if (/-----BEGIN [^-\r\n]*PRIVATE KEY-----/i.test(value)) throw new RunSnapshotApiSafetyError();
  if (/\bAuthorization\s*:/i.test(value) || /\bCookie\s*:/i.test(value)) throw new RunSnapshotApiSafetyError();

  for (const match of value.matchAll(/\bBearer\s+([^\s,;]+)/gi)) {
    if (!isApprovedPlaceholder(match[1] ?? '')) throw new RunSnapshotApiSafetyError();
  }
  for (const match of value.matchAll(/\b(api[_-]?key|token|password|secret|client[_-]?secret)\s*[:=]\s*([^\s,;]+)/gi)) {
    if (!isApprovedPlaceholder(match[2] ?? '')) throw new RunSnapshotApiSafetyError();
  }
  for (const match of value.matchAll(/(?:^|\s)--(api-key|token|access-token|password|secret|client-secret)(?:=\s*|\s+)([^\s,;]+)/gi)) {
    if (!isApprovedPlaceholder(match[2] ?? '')) throw new RunSnapshotApiSafetyError();
  }
}

function scanSensitiveArguments(argsTemplate: readonly string[]): void {
  for (let index = 0; index < argsTemplate.length; index += 1) {
    const match = SENSITIVE_FLAG.exec(argsTemplate[index]!.trim());
    if (!match) continue;
    let value = match[2]?.trim() ?? '';
    if (!value) value = argsTemplate[index + 1]?.trim() ?? '';
    if (!isApprovedPlaceholder(value)) throw new RunSnapshotApiSafetyError();
  }
}

function scanWorkspaceRelativePath(value: string | null): void {
  if (value === null) return;
  if (
    value.length === 0
    || posix.isAbsolute(value)
    || win32.isAbsolute(value)
    || /^[A-Za-z]:/.test(value)
    || value.startsWith('/')
    || value.startsWith('\\')
    || value.split(/[\\/]+/).includes('..')
  ) {
    throw new RunSnapshotApiSafetyError();
  }
}

function scanPayload(payload: RunSnapshotPayload): void {
  const values: string[] = [
    payload.capturedAt,
    payload.run.workspaceId,
    payload.run.taskId,
    payload.run.origin,
    payload.run.reason,
    payload.run.parentRunId ?? '',
    payload.run.rootRunId,
    payload.workflow.definitionId,
    payload.workflow.definitionKey,
    payload.workflow.name,
    payload.workflow.definitionHash,
  ];
  if (payload.schemaVersion === 2) {
    values.push(payload.workflow.worktreeMode);
  }
  for (const stage of payload.workflow.stages) {
    values.push(stage.workflowStageKey, stage.name);
    if (stage.agent) {
      values.push(stage.agent.agentId, stage.agent.name, stage.agent.role, stage.agent.roleTitle, stage.agent.systemPrompt, stage.agent.providerConfigId);
    }
    if (stage.provider) {
      values.push(
        stage.provider.providerConfigId,
        stage.provider.name,
        stage.provider.providerType,
        stage.provider.adapterId,
        stage.provider.runtimeMode,
        stage.provider.executable ?? '',
        stage.provider.model ?? '',
        stage.provider.environmentProfileId ?? '',
        stage.provider.secretProfileId ?? '',
        stage.provider.workingDirectoryMode,
        stage.provider.approvalMode,
        stage.provider.outputMode,
      );
      scanSensitiveArguments(stage.provider.argsTemplate);
      rejectUnsafeText(stage.provider.argsTemplate.join(' '));
      scanWorkspaceRelativePath(stage.provider.workspaceRelativeWorkingDirectory);
      values.push(...stage.provider.argsTemplate);
    }
  }
  if (payload.schemaVersion === 2) {
    for (const stage of payload.workflow.stages) values.push(...stage.dependsOn);
  }
  for (const value of values) rejectUnsafeText(value);
}

function cloneAgent(agent: AgentSnapshotV1): AgentSnapshotV1 {
  return {
    agentId: agent.agentId,
    name: agent.name,
    role: agent.role,
    roleTitle: agent.roleTitle,
    systemPrompt: agent.systemPrompt,
    permissions: [...agent.permissions],
    providerConfigId: agent.providerConfigId,
    enabled: agent.enabled,
    version: agent.version,
  };
}

function cloneCapabilities(capabilities: ProviderConfigurationSnapshotV1['capabilities']): ProviderConfigurationSnapshotV1['capabilities'] {
  return {
    sessionResume: capabilities.sessionResume,
    structuredEvents: capabilities.structuredEvents,
    nativeApprovals: capabilities.nativeApprovals,
    subagents: capabilities.subagents,
    toolEvents: capabilities.toolEvents,
    fileEvents: capabilities.fileEvents,
    usageEvents: capabilities.usageEvents,
    reasoningStream: capabilities.reasoningStream,
    interactiveInput: capabilities.interactiveInput,
    pause: capabilities.pause,
    cancellation: capabilities.cancellation,
    modelSelection: capabilities.modelSelection,
    workspaceAwareness: capabilities.workspaceAwareness,
    nativeSandbox: capabilities.nativeSandbox,
    outputContracts: capabilities.outputContracts,
  };
}

function cloneTimeoutPolicy(timeoutPolicy: ProviderConfigurationSnapshotV1['timeoutPolicy']): ProviderConfigurationSnapshotV1['timeoutPolicy'] {
  return {
    discoveryTimeoutMs: timeoutPolicy.discoveryTimeoutMs,
    validationTimeoutMs: timeoutPolicy.validationTimeoutMs,
    startupTimeoutMs: timeoutPolicy.startupTimeoutMs,
    idleTimeoutMs: timeoutPolicy.idleTimeoutMs,
    totalTimeoutMs: timeoutPolicy.totalTimeoutMs,
    cancelGracePeriodMs: timeoutPolicy.cancelGracePeriodMs,
    approvalTimeoutMs: timeoutPolicy.approvalTimeoutMs,
  };
}

function cloneProvider(provider: ProviderConfigurationSnapshotV1): ProviderConfigurationSnapshotV1 {
  return {
    providerConfigId: provider.providerConfigId,
    name: provider.name,
    providerType: provider.providerType,
    adapterId: provider.adapterId,
    runtimeMode: provider.runtimeMode,
    executable: provider.executable,
    argsTemplate: [...provider.argsTemplate],
    model: provider.model,
    environmentProfileId: provider.environmentProfileId,
    secretProfileId: provider.secretProfileId,
    workingDirectoryMode: provider.workingDirectoryMode,
    workspaceRelativeWorkingDirectory: provider.workspaceRelativeWorkingDirectory,
    capabilities: cloneCapabilities(provider.capabilities),
    timeoutPolicy: cloneTimeoutPolicy(provider.timeoutPolicy),
    approvalMode: provider.approvalMode,
    outputMode: provider.outputMode,
    enabled: provider.enabled,
    version: provider.version,
  };
}

function cloneStageSnapshot(stage: WorkflowStageSnapshotV1): WorkflowStageSnapshotV1 {
  return {
    workflowStageKey: stage.workflowStageKey,
    name: stage.name,
    sequence: stage.sequence,
    agent: stage.agent ? cloneAgent(stage.agent) : null,
    provider: stage.provider ? cloneProvider(stage.provider) : null,
  };
}

function cloneStageSnapshotV2(stage: WorkflowStageSnapshotV2): WorkflowStageSnapshotV2 {
  return {
    workflowStageKey: stage.workflowStageKey,
    name: stage.name,
    sequence: stage.sequence,
    dependsOn: [...stage.dependsOn],
    agent: stage.agent ? cloneAgent(stage.agent) : null,
    provider: stage.provider ? cloneProvider(stage.provider) : null,
  };
}

function clonePayloadV1(payload: Extract<RunSnapshotPayload, { schemaVersion: 1 }>): Extract<RunSnapshotPayload, { schemaVersion: 1 }> {
  return {
    schemaVersion: payload.schemaVersion,
    capturedAt: payload.capturedAt,
    run: {
      workspaceId: payload.run.workspaceId,
      taskId: payload.run.taskId,
      origin: payload.run.origin,
      reason: payload.run.reason,
      parentRunId: payload.run.parentRunId,
      rootRunId: payload.run.rootRunId,
    },
    workflow: {
      definitionId: payload.workflow.definitionId,
      definitionKey: payload.workflow.definitionKey,
      definitionVersion: payload.workflow.definitionVersion,
      name: payload.workflow.name,
      definitionHash: payload.workflow.definitionHash,
      stages: payload.workflow.stages.map(cloneStageSnapshot),
    },
    security: { redactionApplied: payload.security.redactionApplied },
  };
}

function clonePayloadV2(payload: RunSnapshotPayloadV2): RunSnapshotPayloadV2 {
  return {
    schemaVersion: payload.schemaVersion,
    capturedAt: payload.capturedAt,
    run: {
      workspaceId: payload.run.workspaceId,
      taskId: payload.run.taskId,
      origin: payload.run.origin,
      reason: payload.run.reason,
      parentRunId: payload.run.parentRunId,
      rootRunId: payload.run.rootRunId,
    },
    workflow: {
      definitionId: payload.workflow.definitionId,
      definitionKey: payload.workflow.definitionKey,
      definitionVersion: payload.workflow.definitionVersion,
      name: payload.workflow.name,
      definitionHash: payload.workflow.definitionHash,
      worktreeMode: payload.workflow.worktreeMode,
      stages: payload.workflow.stages.map(cloneStageSnapshotV2),
    },
    security: { redactionApplied: payload.security.redactionApplied },
  };
}

function clonePayload(payload: RunSnapshotPayload): RunSnapshotPayload {
  return payload.schemaVersion === 1 ? clonePayloadV1(payload) : clonePayloadV2(payload);
}

function cloneRunStage(stage: RunStage): RunStage {
  return {
    id: stage.id,
    workspaceId: stage.workspaceId,
    runId: stage.runId,
    runSnapshotId: stage.runSnapshotId,
    workflowStageKey: stage.workflowStageKey,
    name: stage.name,
    sequence: stage.sequence,
    attempt: stage.attempt,
    status: stage.status,
    createdAt: stage.createdAt,
    updatedAt: stage.updatedAt,
    version: stage.version,
  };
}

export function buildV2RunDetailResponse(input: BuildV2RunDetailInput): Record<string, unknown> {
  try {
    const snapshot = input.snapshot;
    if (snapshot && (snapshot.workspaceId !== input.run.workspaceId || snapshot.runId !== input.run.id)) {
      throw new RunSnapshotApiSafetyError();
    }
    if (snapshot && (!Number.isInteger(snapshot.snapshotSchemaVersion) || snapshot.snapshotSchemaVersion < 1)) {
      throw new RunSnapshotApiSafetyError();
    }
    if (snapshot && !/^[0-9a-f]{64}$/.test(snapshot.contentHash)) throw new RunSnapshotApiSafetyError();
    if (snapshot) scanPayload(snapshot.payload);

    const response: Record<string, unknown> = {
      run: structuredClone(input.run),
      snapshotAvailable: snapshot !== undefined,
      snapshotSchemaVersion: snapshot?.snapshotSchemaVersion ?? null,
    };
    if (input.include.has('snapshot')) {
      response.snapshot = snapshot ? clonePayload(snapshot.payload) : null;
      response.contentHash = snapshot?.contentHash ?? null;
    }
    if (input.include.has('stages')) {
      response.stages = snapshot ? input.stages.map(cloneRunStage) : [];
    }
    return response;
  } catch (error) {
    if (error instanceof RunSnapshotApiSafetyError) throw error;
    throw new RunSnapshotApiSafetyError();
  }
}
