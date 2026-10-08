import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WORKFLOW_TEMPLATES_V1,
  WorkflowTemplateInstantiationError,
  getWorkflowTemplate,
  instantiateWorkflowTemplate,
  type WorkflowTemplateV1,
} from './src/index.ts';

const BINDINGS = {
  'single-agent': 'codex',
  planner: 'codex',
  implementer: 'kimi',
  reviewer: 'opencode',
  analyst: 'opencode',
  synthesizer: 'codex',
  'security-reviewer': 'mimo',
} as const;

function expectCode(error: unknown, code: WorkflowTemplateInstantiationError['code']): boolean {
  assert.ok(error instanceof WorkflowTemplateInstantiationError);
  assert.equal(error.code, code);
  return true;
}

// WFI-01 — Single Agent compiles to one Stage.
test('WFI-01 single agent compiles', () => {
  const payload = instantiateWorkflowTemplate({ template: getWorkflowTemplate('single-agent') as WorkflowTemplateV1, roleBindings: BINDINGS });
  assert.equal(payload.schemaVersion, 2);
  assert.equal(payload.definitionKey, 'single-agent');
  assert.equal(payload.executionMode, 'unbound');
  assert.equal(payload.worktreeMode, 'disabled');
  assert.equal(payload.stages.length, 1);
  assert.deepEqual(payload.stages[0], { key: 'agent', sequence: 1, agentRole: 'codex', dependsOn: [] });
});

// WFI-02 — Plan -> Implement -> Review keeps order and dependencies.
test('WFI-02 plan-implement-review compiles', () => {
  const payload = instantiateWorkflowTemplate({ template: getWorkflowTemplate('plan-implement-review') as WorkflowTemplateV1, roleBindings: BINDINGS });
  assert.deepEqual(payload.stages.map(s => s.key), ['plan', 'implement', 'review']);
  assert.deepEqual(payload.stages.map(s => s.agentRole), ['codex', 'kimi', 'opencode']);
  assert.deepEqual(payload.stages[1].dependsOn, ['plan']);
  assert.deepEqual(payload.stages[2].dependsOn, ['implement']);
});

// WFI-03 — Parallel Analysis keeps the synthesis dependency on all analyses.
test('WFI-03 parallel-analysis compiles', () => {
  const payload = instantiateWorkflowTemplate({ template: getWorkflowTemplate('parallel-analysis') as WorkflowTemplateV1, roleBindings: BINDINGS });
  assert.equal(payload.stages.length, 4);
  assert.deepEqual(payload.stages[3].dependsOn, ['analysis-a', 'analysis-b', 'analysis-c']);
});

// WFI-04 — optional Security Review appends a bound final Stage.
test('WFI-04 optional security review', () => {
  const payload = instantiateWorkflowTemplate({
    template: getWorkflowTemplate('plan-implement-review') as WorkflowTemplateV1,
    roleBindings: BINDINGS,
    includeOptionalSecurityReview: true,
  });
  assert.equal(payload.stages.length, 4);
  assert.equal(payload.stages[3].key, 'security-review');
  assert.equal(payload.stages[3].agentRole, 'mimo');
  assert.deepEqual(payload.stages[3].dependsOn, ['review']);
});

// WFI-05 — an unbound role fails closed.
test('WFI-05 unbound role fails closed', () => {
  assert.throws(
    () => instantiateWorkflowTemplate({
      template: getWorkflowTemplate('plan-implement-review') as WorkflowTemplateV1,
      roleBindings: { planner: 'codex' },
    }),
    (error: unknown) => expectCode(error, 'ROLE_UNBOUND'),
  );
});

// WFI-06 — an invalid role value fails closed.
test('WFI-06 invalid role fails closed', () => {
  assert.throws(
    () => instantiateWorkflowTemplate({
      template: getWorkflowTemplate('single-agent') as WorkflowTemplateV1,
      roleBindings: { 'single-agent': 'gpt' as never },
    }),
    (error: unknown) => expectCode(error, 'ROLE_UNBOUND'),
  );
});

// WFI-07 — overrides apply deterministically.
test('WFI-07 definition overrides', () => {
  const payload = instantiateWorkflowTemplate({
    template: getWorkflowTemplate('single-agent') as WorkflowTemplateV1,
    roleBindings: BINDINGS,
    definitionKey: 'my-workflow',
    version: 3,
    name: 'My Workflow',
    worktreeMode: 'preferred',
  });
  assert.equal(payload.definitionKey, 'my-workflow');
  assert.equal(payload.version, 3);
  assert.equal(payload.name, 'My Workflow');
  assert.equal(payload.worktreeMode, 'preferred');
});

// WFI-08 — invalid input and worktree mode fail closed.
test('WFI-08 invalid input fails closed', () => {
  assert.throws(
    () => instantiateWorkflowTemplate({ template: null as never, roleBindings: BINDINGS }),
    (error: unknown) => expectCode(error, 'TEMPLATE_INVALID'),
  );
  assert.throws(
    () => instantiateWorkflowTemplate({
      template: getWorkflowTemplate('single-agent') as WorkflowTemplateV1,
      roleBindings: BINDINGS,
      worktreeMode: 'nope' as never,
    }),
    (error: unknown) => expectCode(error, 'WORKTREE_MODE_INVALID'),
  );
  assert.throws(
    () => instantiateWorkflowTemplate({
      template: getWorkflowTemplate('single-agent') as WorkflowTemplateV1,
      roleBindings: BINDINGS,
      version: 0,
    }),
    (error: unknown) => expectCode(error, 'NAME_INVALID'),
  );
});

// WFI-09 — compilation is deterministic and does not mutate the template.
test('WFI-09 deterministic and non-mutating', () => {
  const template = getWorkflowTemplate('plan-implement-review') as WorkflowTemplateV1;
  const first = instantiateWorkflowTemplate({ template, roleBindings: BINDINGS });
  const second = instantiateWorkflowTemplate({ template, roleBindings: BINDINGS });
  assert.deepEqual(first, second);
  assert.equal(template.stages.length, 3);
  // The compiled payload is not the template object.
  assert.ok(!('optionalSecurityReview' in first));
});

// WFI-10 — every catalog template compiles with a full binding.
test('WFI-10 every template compiles', () => {
  for (const template of WORKFLOW_TEMPLATES_V1) {
    const payload = instantiateWorkflowTemplate({ template, roleBindings: BINDINGS });
    assert.equal(payload.stages.length, template.stages.length, template.key);
    assert.ok(payload.stages.every(stage => stage.agentRole !== null), template.key);
  }
});
