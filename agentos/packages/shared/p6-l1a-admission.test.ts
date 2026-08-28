import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WorkspaceAdmissionBindingError,
  assertSubjectBelongsToWorkspace,
  classifyMutationClass,
  LEGACY_ADMISSION_OBSERVABILITY_EXCEPTION,
  type GrantedAdmissionSubject,
  type MutationClassificationInput,
  type WorkspaceAdmissionSubject,
} from './src/index.ts';

const baseClassification: MutationClassificationInput = {
  requested: 'READ_ONLY',
  declaredModifyingAction: false,
  declaredExternalSideEffect: false,
  evidence: { status: 'verified', source: 'test', boundaryId: 'b', qualificationId: 'q' },
};

// L1A-01 — CANONICAL_RUN subject union accepts a canonical ID only.
test('L1A-01 CANONICAL_RUN subject union accepts canonical ID only', () => {
  const subject: WorkspaceAdmissionSubject = {
    subjectKind: 'CANONICAL_RUN',
    canonicalRunId: 'run-1',
  };
  assert.equal(subject.subjectKind, 'CANONICAL_RUN');
  // @ts-expect-error legacyRunId is not valid on a CANONICAL_RUN subject
  const bad: WorkspaceAdmissionSubject = { subjectKind: 'CANONICAL_RUN', legacyRunId: 'x' };
  void bad;
});

// L1A-02 — LEGACY_AGENT_RUN subject union accepts a legacy ID only.
test('L1A-02 LEGACY_AGENT_RUN subject union accepts legacy ID only', () => {
  const subject: WorkspaceAdmissionSubject = {
    subjectKind: 'LEGACY_AGENT_RUN',
    legacyRunId: 'agent-run-1',
  };
  assert.equal(subject.subjectKind, 'LEGACY_AGENT_RUN');
  // @ts-expect-error canonicalRunId is not valid on a LEGACY_AGENT_RUN subject
  const bad: WorkspaceAdmissionSubject = { subjectKind: 'LEGACY_AGENT_RUN', canonicalRunId: 'x' };
  void bad;
});

// L1A-03 — illegal dual/empty subject shape is rejected at the type level.
test('L1A-03 illegal dual/empty subject shape rejected', () => {
  // @ts-expect-error a dual-ID shape is not a valid WorkspaceAdmissionSubject
  const dual: WorkspaceAdmissionSubject = {
    subjectKind: 'CANONICAL_RUN',
    canonicalRunId: 'a',
    legacyRunId: 'b',
  };
  void dual;
  // @ts-expect-error an empty subject (no subject ID) is not valid
  const empty: WorkspaceAdmissionSubject = { subjectKind: 'CANONICAL_RUN' };
  void empty;
});

test('L1A-03b granted subject union enforces exactly one subject ID', () => {
  const granted: GrantedAdmissionSubject = {
    admissionId: 'adm-1',
    workspaceId: 'ws-1',
    subjectKind: 'CANONICAL_RUN',
    canonicalRunId: 'run-1',
  };
  assert.equal(granted.canonicalRunId, 'run-1');
  // @ts-expect-error legacy granted subject cannot carry canonicalRunId
  const bad: GrantedAdmissionSubject = {
    admissionId: 'adm-2',
    workspaceId: 'ws-1',
    subjectKind: 'LEGACY_AGENT_RUN',
    canonicalRunId: 'run-1',
  };
  void bad;
});

// Same-Workspace validation contract: globally unique IDs are not authority.
test('same-workspace subject validation fails closed on mismatch', () => {
  const subject: WorkspaceAdmissionSubject = {
    subjectKind: 'CANONICAL_RUN',
    canonicalRunId: 'run-1',
  };
  assert.doesNotThrow(() => assertSubjectBelongsToWorkspace(subject, 'ws-1', 'ws-1'));
  assert.throws(
    () => assertSubjectBelongsToWorkspace(subject, 'ws-2', 'ws-1'),
    WorkspaceAdmissionBindingError,
  );
});

// L1A-04 — requested MODIFYING -> effective MODIFYING.
test('L1A-04 requested MODIFYING resolves MODIFYING', () => {
  assert.equal(
    classifyMutationClass({ ...baseClassification, requested: 'MODIFYING' }),
    'MODIFYING',
  );
});

// L1A-05..L1A-12 — READ_ONLY only when technical write-denial is verified.
test('L1A-05 READ_ONLY + no enforcement -> MODIFYING', () => {
  assert.equal(
    classifyMutationClass({ ...baseClassification, evidence: { status: 'unsupported' } }),
    'MODIFYING',
  );
});

test('L1A-06 READ_ONLY + unknown evidence -> MODIFYING', () => {
  assert.equal(
    classifyMutationClass({ ...baseClassification, evidence: { status: 'unknown' } }),
    'MODIFYING',
  );
});

test('L1A-07 READ_ONLY + prompt-only declaration -> MODIFYING', () => {
  assert.equal(
    classifyMutationClass({ ...baseClassification, evidence: { status: 'prompt-only' } }),
    'MODIFYING',
  );
});

test('L1A-08 READ_ONLY + provider-native Worktree only -> MODIFYING', () => {
  assert.equal(
    classifyMutationClass({ ...baseClassification, evidence: { status: 'native-worktree' } }),
    'MODIFYING',
  );
});

test('L1A-09 READ_ONLY + nativeSandbox label only -> MODIFYING', () => {
  assert.equal(
    classifyMutationClass({ ...baseClassification, evidence: { status: 'sandbox-label' } }),
    'MODIFYING',
  );
});

test('L1A-10 READ_ONLY + verified technical denial + no side effects -> READ_ONLY', () => {
  assert.equal(classifyMutationClass(baseClassification), 'READ_ONLY');
});

test('L1A-11 declared modifying action overrides READ_ONLY request', () => {
  assert.equal(
    classifyMutationClass({ ...baseClassification, declaredModifyingAction: true }),
    'MODIFYING',
  );
});

test('L1A-12 declared external action overrides READ_ONLY request', () => {
  assert.equal(
    classifyMutationClass({ ...baseClassification, declaredExternalSideEffect: true }),
    'MODIFYING',
  );
});

test('L1A evidence unavailable -> MODIFYING', () => {
  assert.equal(
    classifyMutationClass({ ...baseClassification, evidence: { status: 'unavailable' } }),
    'MODIFYING',
  );
});

test('L1A evidence provider-assertion -> MODIFYING', () => {
  assert.equal(
    classifyMutationClass({ ...baseClassification, evidence: { status: 'provider-assertion' } }),
    'MODIFYING',
  );
});

// Legacy observability exception frozen contract.
test('legacy admission observability exception is frozen', () => {
  assert.equal(LEGACY_ADMISSION_OBSERVABILITY_EXCEPTION.canonicalRunMayEmitCanonicalEvents, true);
  assert.equal(LEGACY_ADMISSION_OBSERVABILITY_EXCEPTION.legacyAgentRunUsesCanonicalRunId, false);
  assert.equal(LEGACY_ADMISSION_OBSERVABILITY_EXCEPTION.legacyRequiresFakeCanonicalRun, false);
  assert.equal(LEGACY_ADMISSION_OBSERVABILITY_EXCEPTION.legacyTelemetryIsAdmissionAuthority, false);
});
