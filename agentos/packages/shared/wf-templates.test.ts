import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WORKFLOW_TEMPLATE_KEYS,
  WORKFLOW_TEMPLATES_V1,
  appendOptionalSecurityReview,
  getWorkflowTemplate,
  modifyingStages,
  validateWorkflowCatalog,
  validateWorkflowTemplate,
  type WorkflowTemplateV1,
} from './src/index.ts';

// WFT-01 — the catalog contains exactly the four Lite baseline templates.
test('WFT-01 catalog contains the four Lite baseline templates', () => {
  assert.deepEqual([...WORKFLOW_TEMPLATE_KEYS], [
    'single-agent', 'plan-implement-review', 'parallel-analysis', 'security-review',
  ]);
  assert.equal(WORKFLOW_TEMPLATES_V1.length, 4);
  assert.deepEqual(WORKFLOW_TEMPLATES_V1.map(t => t.key), [...WORKFLOW_TEMPLATE_KEYS]);
});

// WFT-02 — every catalog template validates and the catalog is complete.
test('WFT-02 catalog validates', () => {
  assert.equal(validateWorkflowCatalog().valid, true);
  for (const template of WORKFLOW_TEMPLATES_V1) {
    assert.equal(validateWorkflowTemplate(template).valid, true, template.key);
  }
});

// WFT-03 — Single Agent has one modifying Stage.
test('WFT-03 single agent is one modifying stage', () => {
  const template = getWorkflowTemplate('single-agent');
  assert.ok(template !== undefined);
  assert.equal(template.stages.length, 1);
  assert.equal(template.stages[0].mutation, 'modifying');
  assert.equal(modifyingStages(template).length, 1);
});

// WFT-04 — Plan -> Implement -> Review has exactly one modifying Stage and a
// read-only review.
test('WFT-04 plan-implement-review shape', () => {
  const template = getWorkflowTemplate('plan-implement-review');
  assert.ok(template !== undefined);
  assert.deepEqual(template.stages.map(s => s.key), ['plan', 'implement', 'review']);
  assert.deepEqual(template.stages.map(s => s.mutation), ['read-only', 'modifying', 'read-only']);
  assert.deepEqual(template.stages[1].dependsOn, ['plan']);
  assert.deepEqual(template.stages[2].dependsOn, ['implement']);
  assert.equal(modifyingStages(template).length, 1);
});

// WFT-05 — Parallel Analysis keeps the three analysis Stages read-only and
// parallel, then synthesizes.
test('WFT-05 parallel-analysis shape', () => {
  const template = getWorkflowTemplate('parallel-analysis');
  assert.ok(template !== undefined);
  assert.equal(template.stages.length, 4);
  assert.equal(template.maxParallelReadOnlyStages, 3);
  assert.ok(template.stages.slice(0, 3).every(s => s.mutation === 'read-only'));
  assert.deepEqual(template.stages[3].dependsOn, ['analysis-a', 'analysis-b', 'analysis-c']);
  assert.equal(modifyingStages(template).length, 0);
});

// WFT-06 — no template hard-codes an Agent or Provider name.
test('WFT-06 templates use role labels, not provider names', () => {
  const forbidden = ['codex', 'kimi', 'opencode', 'claude'];
  for (const template of WORKFLOW_TEMPLATES_V1) {
    for (const stage of template.stages) {
      const label = stage.roleLabel.toLowerCase();
      for (const name of forbidden) {
        assert.ok(!label.includes(name), `${template.key}.${stage.key} leaks ${name}`);
      }
    }
  }
});

// WFT-07 — sequence must be contiguous and ascending from 1.
test('WFT-07 non-contiguous sequence rejected', () => {
  const template = getWorkflowTemplate('plan-implement-review') as WorkflowTemplateV1;
  const broken = { ...template, stages: template.stages.map((s, i) => i === 1 ? { ...s, sequence: 5 } : s) };
  assert.deepEqual(validateWorkflowTemplate(broken), { valid: false, reason: 'SEQUENCE_NOT_DETERMINISTIC' });
});

// WFT-08 — unknown or non-prior dependencies rejected.
test('WFT-08 dependency validation', () => {
  const template = getWorkflowTemplate('plan-implement-review') as WorkflowTemplateV1;
  const unknownDep = {
    ...template,
    stages: [{ ...template.stages[0], dependsOn: ['nope'] }, template.stages[1], template.stages[2]],
  };
  assert.deepEqual(validateWorkflowTemplate(unknownDep), { valid: false, reason: 'DEPENDENCY_NOT_PRIOR' });
});

// WFT-09 — invalid vocabulary and empty stages rejected.
test('WFT-09 structural validation', () => {
  const template = getWorkflowTemplate('single-agent') as WorkflowTemplateV1;
  assert.deepEqual(validateWorkflowTemplate(null), { valid: false, reason: 'NOT_OBJECT' });
  assert.deepEqual(validateWorkflowTemplate({ ...template, schemaVersion: 2 }), { valid: false, reason: 'SCHEMA_VERSION_INVALID' });
  assert.deepEqual(validateWorkflowTemplate({ ...template, key: 'nope' }), { valid: false, reason: 'KEY_INVALID' });
  assert.deepEqual(validateWorkflowTemplate({ ...template, name: '  ' }), { valid: false, reason: 'NAME_INVALID' });
  assert.deepEqual(validateWorkflowTemplate({ ...template, stages: [] }), { valid: false, reason: 'STAGES_EMPTY' });
  assert.deepEqual(
    validateWorkflowTemplate({ ...template, stages: [{ ...template.stages[0], mutation: 'maybe' }] }),
    { valid: false, reason: 'STAGE_INVALID' },
  );
  assert.deepEqual(validateWorkflowTemplate({ ...template, maxParallelReadOnlyStages: 0 }), { valid: false, reason: 'PARALLEL_LIMIT_INVALID' });
});

// WFT-10 — independent modifying Stages are rejected (single-writer rule).
test('WFT-10 independent modifying stages rejected', () => {
  const broken = {
    schemaVersion: 1,
    key: 'plan-implement-review',
    name: 'Broken',
    description: 'two independent writers',
    stages: [
      { key: 'a', sequence: 1, dependsOn: [], mutation: 'modifying', roleLabel: 'x' },
      { key: 'b', sequence: 2, dependsOn: [], mutation: 'modifying', roleLabel: 'y' },
    ],
    maxParallelReadOnlyStages: 1,
    optionalSecurityReview: false,
  };
  assert.deepEqual(validateWorkflowTemplate(broken), { valid: false, reason: 'MODIFYING_STAGE_PARALLELIZED' });
});

// WFT-11 — serialized modifying Stages are allowed.
test('WFT-11 serialized modifying stages allowed', () => {
  const serial = {
    schemaVersion: 1,
    key: 'plan-implement-review',
    name: 'Serial',
    description: 'serialized writers',
    stages: [
      { key: 'a', sequence: 1, dependsOn: [], mutation: 'modifying', roleLabel: 'x' },
      { key: 'b', sequence: 2, dependsOn: ['a'], mutation: 'modifying', roleLabel: 'y' },
    ],
    maxParallelReadOnlyStages: 1,
    optionalSecurityReview: false,
  };
  assert.equal(validateWorkflowTemplate(serial).valid, true);
});

// WFT-12 — optional Security Review appends a read-only final Stage.
test('WFT-12 append optional security review', () => {
  const template = getWorkflowTemplate('plan-implement-review') as WorkflowTemplateV1;
  const extended = appendOptionalSecurityReview(template);
  assert.equal(extended.stages.length, 4);
  const review = extended.stages[3];
  assert.equal(review.key, 'security-review');
  assert.equal(review.mutation, 'read-only');
  assert.deepEqual([...review.dependsOn], ['review']);
  assert.equal(validateWorkflowTemplate(extended).valid, true);
  // The original is unchanged.
  assert.equal(template.stages.length, 3);
  // A template without the optional flag is returned unchanged.
  const single = getWorkflowTemplate('single-agent') as WorkflowTemplateV1;
  assert.equal(appendOptionalSecurityReview(single), single);
});

// WFT-13 — lookup by key.
test('WFT-13 lookup by key', () => {
  assert.equal(getWorkflowTemplate('security-review')?.name, 'Security Review');
  assert.equal(getWorkflowTemplate('nope' as never), undefined);
});
