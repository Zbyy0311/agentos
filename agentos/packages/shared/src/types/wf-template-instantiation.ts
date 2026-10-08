/**
 * Workflow Template instantiation (Lite).
 *
 * Compiles a bounded `WorkflowTemplateV1` plus an explicit role-to-AgentRole
 * binding into the merged `WorkflowDefinitionPayloadV2` shape, so a template can
 * instantiate durable Task/Run/Stage primitives through the existing Workflow
 * Definition contract.
 *
 * Rules (`01-Core-Concepts.md` §9, `09-Conversation-Runtime.md` §12):
 *   - a template never hard-codes an Agent or Provider; the caller supplies the
 *     role binding explicitly, and an unbound role fails closed;
 *   - Stage keys and dependencies come from template data;
 *   - modifying Stages remain serialized by their dependency chain;
 *   - the compiler is pure and deterministic.
 *
 * This module introduces no persistence, API, or execution wiring.
 */

import type { AgentRole, WorkflowDefinitionPayloadV2, WorkflowStageDefinitionV2, WorktreeMode } from './index.js';
import {
  appendOptionalSecurityReview,
  validateWorkflowTemplate,
  type WorkflowTemplateV1,
} from './wf-templates.js';

export type WorkflowTemplateInstantiationErrorCode =
  | 'TEMPLATE_INVALID'
  | 'ROLE_UNBOUND'
  | 'ROLE_INVALID'
  | 'NAME_INVALID'
  | 'WORKTREE_MODE_INVALID';

export class WorkflowTemplateInstantiationError extends Error {
  constructor(
    readonly code: WorkflowTemplateInstantiationErrorCode,
    readonly detail?: string,
  ) {
    super(detail === undefined ? `WORKFLOW_TEMPLATE_${code}` : `WORKFLOW_TEMPLATE_${code}: ${detail}`);
    this.name = 'WorkflowTemplateInstantiationError';
  }
}

const AGENT_ROLES: readonly AgentRole[] = ['codex', 'kimi', 'opencode', 'mimo'];
const WORKTREE_MODES: readonly WorktreeMode[] = ['preferred', 'disabled', 'required'];

export interface InstantiateWorkflowTemplateInput {
  readonly template: WorkflowTemplateV1;
  /** Explicit roleLabel -> AgentRole binding. An unbound role fails closed. */
  readonly roleBindings: Readonly<Record<string, AgentRole>>;
  /** Definition key; defaults to the template key. */
  readonly definitionKey?: string;
  /** Definition version; defaults to 1. */
  readonly version?: number;
  /** Definition name; defaults to the template name. */
  readonly name?: string;
  /** Worktree mode; defaults to `disabled` (Lite does not own a Worktree). */
  readonly worktreeMode?: WorktreeMode;
  /** Append the optional Security Review Stage when the template allows it. */
  readonly includeOptionalSecurityReview?: boolean;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function isAgentRole(value: unknown): value is AgentRole {
  return (AGENT_ROLES as readonly unknown[]).includes(value);
}
function isWorktreeMode(value: unknown): value is WorktreeMode {
  return (WORKTREE_MODES as readonly unknown[]).includes(value);
}

/**
 * Compile a template into a `WorkflowDefinitionPayloadV2`. Deterministic:
 * the same template and bindings always produce the same payload.
 */
export function instantiateWorkflowTemplate(
  input: InstantiateWorkflowTemplateInput,
): WorkflowDefinitionPayloadV2 {
  if (typeof input !== 'object' || input === null || typeof input.template !== 'object' || input.template === null) {
    throw new WorkflowTemplateInstantiationError('TEMPLATE_INVALID');
  }
  const validation = validateWorkflowTemplate(input.template);
  if (!validation.valid) {
    throw new WorkflowTemplateInstantiationError('TEMPLATE_INVALID', validation.reason);
  }

  const template = input.includeOptionalSecurityReview === true
    ? appendOptionalSecurityReview(input.template)
    : input.template;

  const bindings = input.roleBindings;
  if (typeof bindings !== 'object' || bindings === null) {
    throw new WorkflowTemplateInstantiationError('ROLE_UNBOUND');
  }

  const stages: WorkflowStageDefinitionV2[] = [];
  for (const stage of template.stages) {
    const role = bindings[stage.roleLabel];
    if (!isAgentRole(role)) {
      throw new WorkflowTemplateInstantiationError('ROLE_UNBOUND', stage.roleLabel);
    }
    stages.push({
      key: stage.key,
      sequence: stage.sequence,
      agentRole: role,
      dependsOn: [...stage.dependsOn],
    });
  }

  const definitionKey = input.definitionKey ?? template.key;
  if (!nonBlank(definitionKey)) throw new WorkflowTemplateInstantiationError('NAME_INVALID');
  const name = input.name ?? template.name;
  if (!nonBlank(name)) throw new WorkflowTemplateInstantiationError('NAME_INVALID');
  const version = input.version ?? 1;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new WorkflowTemplateInstantiationError('NAME_INVALID');
  }
  const worktreeMode = input.worktreeMode ?? 'disabled';
  if (!isWorktreeMode(worktreeMode)) {
    throw new WorkflowTemplateInstantiationError('WORKTREE_MODE_INVALID');
  }

  return {
    schemaVersion: 2,
    definitionKey,
    version,
    name,
    executionMode: 'unbound',
    retryPolicy: null,
    worktreeMode,
    stages,
  };
}
