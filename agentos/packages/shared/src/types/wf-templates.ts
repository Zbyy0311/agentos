/**
 * Workflow Template catalog contracts (Lite).
 *
 * Freezes the built-in bounded workflow templates required by
 * `docs/Runtime-Specification lite/01-Core-Concepts.md` §9 and
 * `09-Conversation-Runtime.md` §12:
 *
 *   - Single Agent
 *   - Plan -> Implement -> Review
 *   - Parallel Analysis -> Final Synthesis
 *   - optional Security Review
 *
 * A template is a bounded, JSON-serializable structure that instantiates
 * optional Stages. It does not own Run durability, Process control, Events, or
 * recovery, and it does not replace the merged `WorkflowDefinition` schema. It
 * is a pure, deterministic catalog plus validator; no persistence, no API, and
 * no execution wiring are introduced here.
 *
 * A full visual workflow DAG editor is DEFERRED FULL-SCOPE.
 */

/** The four Lite baseline templates. */
export const WORKFLOW_TEMPLATE_KEYS = [
  'single-agent',
  'plan-implement-review',
  'parallel-analysis',
  'security-review',
] as const;
export type WorkflowTemplateKey = (typeof WORKFLOW_TEMPLATE_KEYS)[number];

/** Whether a Stage may intentionally mutate the Workspace. */
export const TEMPLATE_STAGE_MUTATIONS = ['read-only', 'modifying'] as const;
export type TemplateStageMutation = (typeof TEMPLATE_STAGE_MUTATIONS)[number];

export interface WorkflowTemplateStageV1 {
  /** Stable stage key; template data, never a hard-coded Provider or Agent role. */
  readonly key: string;
  /** Deterministic 1-based ordering. */
  readonly sequence: number;
  /** Stage keys that must complete first. */
  readonly dependsOn: readonly string[];
  readonly mutation: TemplateStageMutation;
  /** Role label resolved to an Agent/Provider at instantiation time. */
  readonly roleLabel: string;
}

export interface WorkflowTemplateV1 {
  readonly schemaVersion: 1;
  readonly key: WorkflowTemplateKey;
  readonly name: string;
  readonly description: string;
  /** Bounded Stage count. */
  readonly stages: readonly WorkflowTemplateStageV1[];
  /** Maximum parallel read-only Stages; modifying Stages never parallelize. */
  readonly maxParallelReadOnlyStages: number;
  /** Optional review step that can be appended to another template. */
  readonly optionalSecurityReview: boolean;
}

function stage(
  key: string,
  sequence: number,
  dependsOn: readonly string[],
  mutation: TemplateStageMutation,
  roleLabel: string,
): WorkflowTemplateStageV1 {
  return { key, sequence, dependsOn, mutation, roleLabel };
}

/** Frozen built-in catalog. */
export const WORKFLOW_TEMPLATES_V1: readonly WorkflowTemplateV1[] = Object.freeze([
  Object.freeze({
    schemaVersion: 1,
    key: 'single-agent',
    name: 'Single Agent',
    description: 'One bounded Agent Stage.',
    stages: Object.freeze([
      stage('agent', 1, [], 'modifying', 'single-agent'),
    ]),
    maxParallelReadOnlyStages: 1,
    optionalSecurityReview: false,
  }),
  Object.freeze({
    schemaVersion: 1,
    key: 'plan-implement-review',
    name: 'Plan -> Implement -> Review',
    description: 'Plan first, then a modifying implement Stage, then review.',
    stages: Object.freeze([
      stage('plan', 1, [], 'read-only', 'planner'),
      stage('implement', 2, ['plan'], 'modifying', 'implementer'),
      stage('review', 3, ['implement'], 'read-only', 'reviewer'),
    ]),
    maxParallelReadOnlyStages: 1,
    optionalSecurityReview: true,
  }),
  Object.freeze({
    schemaVersion: 1,
    key: 'parallel-analysis',
    name: 'Parallel Analysis -> Final Synthesis',
    description: 'Parallel read-only analysis Stages followed by one synthesis Stage.',
    stages: Object.freeze([
      stage('analysis-a', 1, [], 'read-only', 'analyst'),
      stage('analysis-b', 2, [], 'read-only', 'analyst'),
      stage('analysis-c', 3, [], 'read-only', 'analyst'),
      stage('synthesis', 4, ['analysis-a', 'analysis-b', 'analysis-c'], 'read-only', 'synthesizer'),
    ]),
    maxParallelReadOnlyStages: 3,
    optionalSecurityReview: true,
  }),
  Object.freeze({
    schemaVersion: 1,
    key: 'security-review',
    name: 'Security Review',
    description: 'One bounded read-only security review Stage.',
    stages: Object.freeze([
      stage('security-review', 1, [], 'read-only', 'security-reviewer'),
    ]),
    maxParallelReadOnlyStages: 1,
    optionalSecurityReview: false,
  }),
]);

export function getWorkflowTemplate(key: WorkflowTemplateKey): WorkflowTemplateV1 | undefined {
  return WORKFLOW_TEMPLATES_V1.find(template => template.key === key);
}

export type WorkflowTemplateValidationError =
  | 'NOT_OBJECT'
  | 'SCHEMA_VERSION_INVALID'
  | 'KEY_INVALID'
  | 'NAME_INVALID'
  | 'STAGES_EMPTY'
  | 'STAGE_INVALID'
  | 'SEQUENCE_NOT_DETERMINISTIC'
  | 'DEPENDENCY_UNKNOWN'
  | 'DEPENDENCY_NOT_PRIOR'
  | 'PARALLEL_LIMIT_INVALID'
  | 'MODIFYING_STAGE_PARALLELIZED';

export interface WorkflowTemplateValidationResult {
  readonly valid: boolean;
  readonly reason?: WorkflowTemplateValidationError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Deterministic, fail-closed template validation.
 *
 * Rejects: unknown schema/key, empty Stages, non-contiguous or non-ascending
 * sequences, unknown or non-prior dependencies, a modifying Stage that could
 * parallelize, and an invalid parallel limit. A template never hard-codes an
 * Agent or Provider name.
 */
export function validateWorkflowTemplate(input: unknown): WorkflowTemplateValidationResult {
  if (!isRecord(input)) return { valid: false, reason: 'NOT_OBJECT' };
  if (input.schemaVersion !== 1) return { valid: false, reason: 'SCHEMA_VERSION_INVALID' };
  if (!(WORKFLOW_TEMPLATE_KEYS as readonly unknown[]).includes(input.key)) {
    return { valid: false, reason: 'KEY_INVALID' };
  }
  if (!nonBlank(input.name)) return { valid: false, reason: 'NAME_INVALID' };
  const stages = input.stages;
  if (!Array.isArray(stages) || stages.length === 0) return { valid: false, reason: 'STAGES_EMPTY' };

  const seen = new Set<string>();
  let expectedSequence = 1;
  for (const raw of stages) {
    if (!isRecord(raw)) return { valid: false, reason: 'STAGE_INVALID' };
    if (!nonBlank(raw.key) || !nonBlank(raw.roleLabel)
      || !(TEMPLATE_STAGE_MUTATIONS as readonly unknown[]).includes(raw.mutation)
      || !Array.isArray(raw.dependsOn)) {
      return { valid: false, reason: 'STAGE_INVALID' };
    }
    if (raw.sequence !== expectedSequence) {
      return { valid: false, reason: 'SEQUENCE_NOT_DETERMINISTIC' };
    }
    for (const dependency of raw.dependsOn) {
      if (!nonBlank(dependency)) return { valid: false, reason: 'STAGE_INVALID' };
      if (!seen.has(dependency)) return { valid: false, reason: 'DEPENDENCY_NOT_PRIOR' };
    }
    seen.add(raw.key);
    expectedSequence += 1;
  }

  const limit = input.maxParallelReadOnlyStages;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1) {
    return { valid: false, reason: 'PARALLEL_LIMIT_INVALID' };
  }
  // Modifying Stages are serialized by Workspace admission; a template must not
  // allow more than one to be eligible at once.
  const modifying = (stages as Array<Record<string, unknown>>).filter(s => s.mutation === 'modifying');
  if (modifying.length > 1) {
    const modifyingKeys = new Set(modifying.map(s => s.key as string));
    const hasIndependentModifyingPair = modifying.some(left =>
      modifying.some(right =>
        left !== right
        && !(left.dependsOn as string[]).some(dep => modifyingKeys.has(dep))
        && !(right.dependsOn as string[]).some(dep => modifyingKeys.has(dep)),
      ),
    );
    if (hasIndependentModifyingPair) {
      return { valid: false, reason: 'MODIFYING_STAGE_PARALLELIZED' };
    }
  }
  return { valid: true };
}

/** Validate the frozen catalog itself; used by tests and future loaders. */
export function validateWorkflowCatalog(): WorkflowTemplateValidationResult {
  const seenKeys = new Set<string>();
  for (const template of WORKFLOW_TEMPLATES_V1) {
    const result = validateWorkflowTemplate(template);
    if (!result.valid) return result;
    if (seenKeys.has(template.key)) return { valid: false, reason: 'KEY_INVALID' };
    seenKeys.add(template.key);
  }
  if (seenKeys.size !== WORKFLOW_TEMPLATE_KEYS.length) {
    return { valid: false, reason: 'KEY_INVALID' };
  }
  return { valid: true };
}

/** Modifying Stages in a template, in deterministic order. */
export function modifyingStages(
  template: WorkflowTemplateV1,
): readonly WorkflowTemplateStageV1[] {
  return template.stages.filter(s => s.mutation === 'modifying');
}

/**
 * Append the optional Security Review as a final read-only Stage that depends on
 * every current leaf Stage. Returns a new template; the input is not mutated.
 */
export function appendOptionalSecurityReview(
  template: WorkflowTemplateV1,
): WorkflowTemplateV1 {
  if (!template.optionalSecurityReview) return template;
  const leafKeys = template.stages
    .filter(candidate => !template.stages.some(other => other.dependsOn.includes(candidate.key)))
    .map(candidate => candidate.key);
  const sequence = template.stages.length + 1;
  const review = stage('security-review', sequence, leafKeys, 'read-only', 'security-reviewer');
  return {
    ...template,
    stages: Object.freeze([...template.stages, Object.freeze(review)]),
  };
}
