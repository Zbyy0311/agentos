import { instantiateWorkflowTemplate } from '@agentos/shared';
import type { AgentRole, Run, RunSnapshot, RunStage, RunSnapshotPayloadV2, Task, WorkflowDefinition, Workspace } from '@agentos/shared';
import type { WorkflowTemplateV1 } from '@agentos/shared';
import type { WorkflowDefinitionRepository } from '../store/WorkflowDefinitionRepository.js';
import { WorkflowDefinitionWriter } from '../store/WorkflowDefinitionWriter.js';
import type { RunRepository } from '../store/RunRepository.js';
import type { TaskRepository } from '../store/TaskRepository.js';
import type { RunSnapshotRepository } from '../store/RunSnapshotRepository.js';
import type { RunStageRepository } from '../store/RunStageRepository.js';
import type { ProviderConfigurationRepository } from '../store/ProviderConfigurationRepository.js';
import type { AgentSnapshotSourceRecord } from '../store/SqliteStore.js';
import { SnapshotService } from './SnapshotService.js';
import { WorkflowDefinitionResolver } from './WorkflowDefinitionResolver.js';
import { inTransaction, type TransactionDatabase } from '../store/Transaction.js';

/**
 * Workflow Template durable wiring (09-Conversation-Runtime.md section 12).
 *
 * Frozen design: docs/implementation/milestones/WF-templates-durable-wiring.md (option A).
 *
 * A template compiles to a V2 definition, the definition is persisted as an immutable
 * row, its Stages are bound to workspace Agents and enabled Providers, and durable
 * Task/Run/Snapshot/Stage primitives are created — all in ONE transaction. A template
 * never hard-codes an Agent or Provider (the caller binds roles), an unbound role
 * fails closed before anything is persisted, and the Run goes through the same
 * admission path as any canonical Run (no bypass).
 */

export type WorkflowTemplateServiceErrorCode =
  | 'INPUT_INVALID'
  | 'TEMPLATE_COMPILE_FAILED'
  | 'TEMPLATE_BINDING_FAILED'
  | 'TEMPLATE_PERSIST_FAILED';

export class WorkflowTemplateServiceError extends Error {
  constructor(readonly code: WorkflowTemplateServiceErrorCode, readonly detail?: string) {
    super(detail === undefined ? `WORKFLOW_TEMPLATE_SERVICE_${code}` : `WORKFLOW_TEMPLATE_SERVICE_${code}: ${detail}`);
    this.name = 'WorkflowTemplateServiceError';
  }
}

export interface InstantiateTemplateRunInput {
  readonly workspace: Workspace;
  readonly template: WorkflowTemplateV1;
  /** Explicit roleLabel -> AgentRole binding; an unbound role fails closed. */
  readonly roleBindings: Readonly<Record<string, AgentRole>>;
  readonly createdBy: string;
  readonly taskTitle?: string;
  readonly objective?: string;
  readonly includeOptionalSecurityReview?: boolean;
  readonly createdAt: string;
}

export interface InstantiateTemplateRunResult {
  readonly definition: WorkflowDefinition;
  readonly task: Task;
  readonly run: Run;
  readonly snapshot: RunSnapshot<RunSnapshotPayloadV2>;
  readonly stages: readonly RunStage[];
}

export interface WorkflowTemplateServiceDeps {
  readonly store: { getDatabase(): TransactionDatabase };
  readonly workflowDefinitionRepository: () => WorkflowDefinitionRepository;
  readonly taskRepository: () => TaskRepository;
  readonly runRepository: () => RunRepository;
  readonly runSnapshotRepository: () => RunSnapshotRepository;
  readonly runStageRepository: () => RunStageRepository;
  readonly providerConfigurationRepository: () => ProviderConfigurationRepository;
  readonly findAgentSnapshotSource: (workspaceId: string, agentId: string) => AgentSnapshotSourceRecord | undefined;
  readonly createTaskId?: () => string;
  readonly createRunId?: () => string;
  readonly createDefinitionId?: () => string;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class WorkflowTemplateService {
  private readonly db: TransactionDatabase;
  private readonly snapshotService: SnapshotService;
  private readonly resolver: WorkflowDefinitionResolver;
  private readonly definitionWriter: WorkflowDefinitionWriter;

  constructor(private readonly deps: WorkflowTemplateServiceDeps) {
    this.db = deps.store.getDatabase();
    this.resolver = new WorkflowDefinitionResolver(deps.workflowDefinitionRepository());
    this.definitionWriter = new WorkflowDefinitionWriter(this.db, deps.workflowDefinitionRepository());
    this.snapshotService = new SnapshotService({
      workflowDefinitionResolver: this.resolver,
      runSnapshotRepository: () => deps.runSnapshotRepository(),
      runStageRepository: () => deps.runStageRepository(),
      providerConfigurationRepository: () => deps.providerConfigurationRepository(),
      findAgentSnapshotSource: (workspaceId, agentId) => deps.findAgentSnapshotSource(workspaceId, agentId),
    });
  }

  /**
   * Compile a template and create its durable Task, Run, Snapshot, and Stages in one
   * transaction. Nothing is persisted when compilation or Stage binding fails.
   */
  instantiateTemplateRun(input: InstantiateTemplateRunInput): InstantiateTemplateRunResult {
    if (typeof input !== 'object' || input === null
      || typeof input.workspace !== 'object' || input.workspace === null
      || typeof input.template !== 'object' || input.template === null
      || typeof input.roleBindings !== 'object' || input.roleBindings === null
      || !nonBlank(input.createdBy) || !nonBlank(input.createdAt)) {
      throw new WorkflowTemplateServiceError('INPUT_INVALID');
    }
    let payload;
    try {
      payload = instantiateWorkflowTemplate({
        template: input.template,
        roleBindings: input.roleBindings,
        ...(input.includeOptionalSecurityReview === undefined
          ? {} : { includeOptionalSecurityReview: input.includeOptionalSecurityReview }),
      });
    } catch (error) {
      // Unbound role and invalid template both fail closed here, before any write.
      throw new WorkflowTemplateServiceError(
        'TEMPLATE_COMPILE_FAILED',
        error instanceof Error ? error.message : String(error),
      );
    }
    try {
      return inTransaction(this.db, () => {
        const definition = this.definitionWriter.persistCompiledDefinitionWithinTransaction({
          payload,
          createdAt: input.createdAt,
          ...(this.deps.createDefinitionId === undefined ? {} : { id: this.deps.createDefinitionId() }),
        });
        const resolved = this.snapshotService.resolveDefinition(input.workspace, definition);
        const task = this.deps.taskRepository().insert({
          workspaceId: input.workspace.id,
          title: input.taskTitle ?? `${definition.name} run`,
          createdBy: input.createdBy,
        });
        const run = this.deps.runRepository().insert({
          workspaceId: input.workspace.id,
          taskId: task.id,
          origin: 'v2_api',
          createdBy: input.createdBy,
          ...(input.objective === undefined ? {} : { objective: input.objective }),
        });
        const persisted = this.snapshotService.persistResolvedRun(run, resolved);
        return { definition, task, run, snapshot: persisted.snapshot, stages: persisted.stages };
      });
    } catch (error) {
      if (error instanceof WorkflowTemplateServiceError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      if (detail.includes('AGENT_NOT_AVAILABLE') || detail.includes('PROVIDER_CONFIG_NOT_AVAILABLE')) {
        throw new WorkflowTemplateServiceError('TEMPLATE_BINDING_FAILED', detail);
      }
      throw new WorkflowTemplateServiceError('TEMPLATE_PERSIST_FAILED', detail);
    }
  }
}
