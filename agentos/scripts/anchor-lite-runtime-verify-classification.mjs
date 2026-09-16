/**
 * Re-anchor the completed Runtime-Verify classification to one authoritative
 * implementation SHA after a semantic, row-by-row evidence review.
 *
 * This file deliberately does not touch matrix.json, pass-freeze.json, or the
 * promotion ledger. A PASS_CANDIDATE is still only a candidate: promotion is a
 * later, individually receipted operation on the final implementation SHA.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const matrix = JSON.parse(readFileSync(resolve(root, 'docs/implementation/lite-closeout/matrix.json'), 'utf8'));
const source = JSON.parse(readFileSync(resolve(root, 'docs/implementation/lite-closeout/evidence/runtime-verify-classification-ec780.json'), 'utf8'));
const mainSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

const item = (file, name, line) => line === undefined ? { file, name } : { file, name, line };

/**
 * These bundles are the result of the current-source semantic review of the
 * forty rows previously called ASSERTION_GAP. Each entry points at a named
 * test that executes the relevant behavior. The old findings are retained as
 * history below; they are not used as a reason to promote a row.
 */
const currentDirectBundles = {
  'B-CURRENT-TASK-CARDINALITY': [
    item('apps/server/src/services/TaskRunService.test.ts', 'LITE-01-004 a Task supports zero Runs and then multiple independent Runs'),
  ],
  'B-CURRENT-RUN-PROCESS': [
    item('apps/server/src/services/RuntimeInspector.test.ts', 'LITE-01-006 Run and Process records remain independently queryable'),
  ],
  'B-CURRENT-READONLY-LIMITS': [
    item('apps/server/src/services/WorkspaceAdmissionAuthority.test.ts', 'LITE-04-008 concurrent READ_ONLY admission requires a tested technical write denial'),
    item('apps/server/src/services/run-engine/RunEngineProviderDispatcher.test.ts', 'L1D-I17 stale GRANTED READ_ONLY authority cannot reach RunEngine, provider, process, or spawn'),
    item('packages/process-runtime/src/durable-coordinator.test.ts', 'retained cap fails closed BEFORE any byte commit'),
  ],
  'B-CURRENT-WORKTREE-ABSENT': [
    item('apps/server/src/services/run-engine/RunEngineProviderDispatcher.test.ts', 'LITE-02-016 a modifying Run completes when no AgentOS-owned Worktree is available'),
  ],
  'B-CURRENT-EVENT-SCHEMA': [
    item('packages/shared/m3-runtime.test.ts', 'LITE-03-001 rejects illegal payloads and missing Stage envelope association'),
    item('packages/shared/m3-runtime.test.ts', 'LITE-03-001 maps envelope and payload failures to distinct stable errors'),
  ],
  'B-CURRENT-EVENT-PROJECTION': [
    item('apps/server/src/services/RuntimeEventProjector.test.ts', 'LITE-03-012 / LITE-04-012 projects provider events faithfully without invented telemetry'),
  ],
  'B-CURRENT-MEMORY-EVENT': [
    item('packages/shared/mf5-memory-events.test.ts', 'LITE-03-016 Memory selection Events expose bounded explanation fields'),
  ],
  'B-CURRENT-PROVIDER-OUTCOMES': [
    item('apps/server/src/services/run-engine/StageExecutionCoordinator.test.ts', 'LITE-04-002 Mock Provider success: one Session, one Process, completed outcome, durable facts'),
    item('apps/server/src/services/run-engine/StageExecutionCoordinator.test.ts', 'LITE-04-002 Mock Provider auth failure fails closed before claim'),
    item('apps/server/src/services/run-engine/StageExecutionCoordinator.test.ts', 'LITE-04-002 Mock Provider process-start failure compensates durably and never spawns twice'),
    item('apps/server/src/services/run-engine/StageExecutionCoordinator.test.ts', 'LITE-04-002 Mock Provider non-zero exit maps to a stable Provider failure with exited Process evidence'),
    item('apps/server/src/services/run-engine/StageExecutionCoordinator.test.ts', 'LITE-04-002 Mock Provider process crash (non-zero termination) maps to failed Session and exited Process evidence'),
    item('apps/server/src/services/run-engine/RunEngineProviderDispatcher.test.ts', 'P5E composes Dispatcher cancellation, owned Process cleanup, and LTS handoff exactly once'),
  ],
  'B-CURRENT-PROVIDER-SWITCH': [
    item('apps/server/src/store/SqliteStore.test.ts', 'LITE-04-004 switching a Provider preserves the Agent identity and durable History'),
  ],
  'B-CURRENT-DISCONNECT': [
    item('apps/server/src/routes/canonicalRunStream.test.ts', 'LITE-04-005 / P5C-R06 browser disconnect is subscription-only: Run state untouched and lifecycle continues'),
    item('apps/server/src/routes/canonicalRunStream.test.ts', 'P5C-R06 client disconnect unsubscribes the RunStreamService subscription exactly once'),
  ],
  'B-CURRENT-READONLY-CLAIMS': [
    item('packages/shared/p6-l1a-admission.test.ts', 'LITE-04-009 capability and intent claims fail closed unless technical denial is verified'),
  ],
  'B-CURRENT-NATIVE-APPROVAL': [
    item('apps/server/src/services/run-engine/RunEngineProviderDispatcher.test.ts', 'LITE-04-010 / LITE-08-001 / LITE-08-005/006/007: ASK_USER pauses before spawn and one approved original Run continues once'),
    item('packages/agent-core/src/providers/validation.test.ts', 'preserves auth states, reports capability/output mismatches, and never emits generic validation failed'),
  ],
  'B-CURRENT-REDACTION': [
    item('apps/server/src/routes/canonicalRunEvents.test.ts', 'LITE-04-011 / P5A-R22 unsafe persisted Snapshot fails closed without leaking secret/path/SQLite details'),
    item('packages/process-runtime/src/durable-coordinator.test.ts', 'raw secrets never reach the sink or the DB; only scanner output is persisted'),
    item('apps/server/src/routes/runtimeInspector.redaction.test.ts', 'LITE-13-013 the Inspector projection exposes no secret material and a frozen key set'),
  ],
  'B-CURRENT-RECOVERY-PREFLIGHT': [
    item('apps/server/src/taskRecovery.test.ts', 'LITE-05-011 / P6M2b-composition E: no OS probe occurs inside the recovery transaction'),
  ],
  'B-CURRENT-MEMORY-SECRETS': [
    item('apps/server/src/routes/memoryRuntime.test.ts', 'LITE-07-012/LITE-10-016 explicit secret-like save leaves no Entry, FTS, Snapshot, or Event sink'),
    item('apps/server/src/routes/memories.test.ts', 'LITE-07-012/LITE-10-016 legacy Memory rejects unsafe writes and hides unsafe historical text'),
    item('apps/server/src/store/MemoryEntryRepository.test.ts', 'LITE-07-012/LITE-10-016 secret-like Entry text leaves no Entry or FTS row'),
    item('apps/server/src/store/MemoryCandidateRepository.test.ts', 'LITE-07-012/LITE-10-016 secret-like Candidate leaves no Candidate, Entry, or FTS row'),
    item('apps/server/src/store/MemoryContextSnapshotRepository.test.ts', 'LITE-07-012/LITE-10-016 secret-like Snapshot payload leaves no Snapshot sink rows'),
    item('apps/server/src/services/MemoryRetrievalService.test.ts', 'LITE-07-012/LITE-10-016 search excludes an unsafe historical Entry and FTS row'),
    item('apps/server/src/services/MemoryRuntimeEventEmitter.test.ts', 'LITE-07-012/LITE-10-016 secret-like Memory writes emit no Runtime Event or Outbox'),
  ],
  'B-CURRENT-RUNTIME-APPROVAL': [
    item('apps/server/src/services/run-engine/RunEngineProviderDispatcher.test.ts', 'LITE-04-010 / LITE-08-001 / LITE-08-005/006/007: ASK_USER pauses before spawn and one approved original Run continues once'),
    item('apps/server/src/services/run-engine/RunEngineProviderDispatcher.test.ts', 'LITE-08-006/007: reject is terminal, replay-safe, and a changed launch plan cannot execute'),
  ],
  'B-CURRENT-NATIVE-BOUNDARY': [
    item('apps/server/src/services/run-engine/RunEngineProviderDispatcher.test.ts', 'LITE-04-010 / LITE-08-001 / LITE-08-005/006/007: ASK_USER pauses before spawn and one approved original Run continues once'),
    item('packages/agent-core/src/providers/validation.test.ts', 'preserves auth states, reports capability/output mismatches, and never emits generic validation failed'),
  ],
  'B-CURRENT-SCOPE': [
    item('apps/web/src/liteScopeBoundary.test.ts', 'LITE-12-016 no web module implements a deferred product surface'),
    item('apps/web/src/liteScopeBoundary.test.ts', 'LITE-12-016 the workspace shells expose no deferred product entry point'),
  ],
  'B-CURRENT-CONVERSATION-RECONNECT-SWITCH': [
    item('apps/server/src/routes/conversationRuntime.test.ts', 'LITE-00-002 Conversation and Message records survive a restart and a reconnect'),
    item('apps/server/src/store/SqliteStore.test.ts', 'LITE-04-004 switching a Provider preserves the Agent identity and durable History'),
  ],
  'B-CURRENT-PROJECTION': [
    item('apps/server/src/services/ConversationProjectionService.test.ts', 'LITE-09-008 / CR4P-02 a retried Event projection converges on one existing Conversation card'),
    item('apps/server/src/services/ConversationProjectionService.test.ts', 'LITE-09-008 / CR4P-08 a duplicate projection key is detected and then converges'),
    item('apps/web/src/lib/executionTimeline.test.ts', 'LITE-09-008 projects repeated streaming chunks for one execution into one timeline card'),
  ],
  'B-CURRENT-TEMPLATE': [
    item('apps/server/src/services/WorkflowTemplateService.test.ts', 'LITE-09-017 / LITE-01-101 a template instantiates durable Task/Run/Stage primitives'),
  ],
  'B-CURRENT-MIGRATION': [
    item('apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts', 'LITE-10-001 fresh install and supported upgrade both apply the complete registry'),
  ],
  'B-CURRENT-SNAPSHOT': [
    item('apps/server/src/services/TaskRunService.test.ts', 'LITE-10-005 / P3C1-RY-S07 Retry remaps child Snapshot and Stage identities while preserving immutability'),
  ],
  'B-CURRENT-COMPATIBILITY': [
    item('apps/server/src/migrations/__tests__/m2-7-workspace-compatibility.test.ts', 'LITE-10-015 / M27-P5-T012 compatibility read preserves selected Workspace source bytes without Task-domain loss'),
  ],
  'B-CURRENT-API-SHAPES': [
    item('apps/server/src/routes/runLifecycle.test.ts', 'P3C1-R01 canonical URL accepts a live no-key start with the exact 202 operation body'),
    item('apps/server/src/routes/runLifecycle.test.ts', 'P3C1-R16 an expectedVersion mismatch returns 409 VERSION_CONFLICT'),
    item('apps/server/src/routes/runLifecycle.test.ts', 'P3C1-RY01 canonical Retry route accepts a failed Parent and returns HTTP 201'),
    item('apps/server/src/routes/operations.test.ts', 'P5D active Operation cancel uses runtime proof while preserving the frozen HTTP body'),
    item('apps/server/src/routes/operations.test.ts', 'P5D already-terminal Run cannot regress through public active cancellation'),
  ],
  'B-CURRENT-FORCED-ADMISSION': [
    item('apps/server/src/routes/p6-l1a-start-route.test.ts', 'LITE-11-009 a forced READ_ONLY start request creates no admission authority'),
    item('packages/shared/p6-l1a-admission.test.ts', 'LITE-04-009 capability and intent claims fail closed unless technical denial is verified'),
  ],
  'B-CURRENT-SERVER-SCOPE': [
    item('apps/web/src/liteScopeBoundary.test.ts', 'LITE-12-016 no web module implements a deferred product surface'),
    item('apps/server/src/services/ApprovalRegistry.test.ts', 'ApprovalRegistry revokes grants idempotently'),
  ],
  'B-CURRENT-UI-ADMISSION': [
    item('apps/server/src/services/RuntimeInspector.test.ts', 'LITE-12-010 unknown or unavailable admission is projected as modifying'),
    item('apps/server/src/services/RuntimeInspector.test.ts', 'LITE-12-010 only complete verified enforcement is presented as read-only'),
    item('apps/web/src/components/chat/RuntimeInspectorView.test.tsx', 'LITE-12-010 unknown or unavailable read-only enforcement renders modifying'),
  ],
  'B-CURRENT-UI-KEYBOARD': [
    item('apps/web/src/lib/composerKeyboard.test.ts', 'LITE-12-014 Enter submits while Shift+Enter and IME composition stay local'),
    item('apps/web/src/lib/composerKeyboard.test.ts', 'LITE-12-014 keyboard submit prevents the browser newline and restores composer focus'),
    item('apps/web/src/lib/composerKeyboard.test.ts', 'LITE-12-014 disabled submit does not invoke the send callback'),
  ],
  'B-CURRENT-UI-API': [
    item('apps/web/src/lib/directConversation.test.ts', 'DCUX-C01 the client targets the forward runtime surface with correct paths'),
  ],
  'B-CURRENT-INSPECTOR-BOUND': [
    item('apps/web/src/components/chat/RunInspectorPanel.test.ts', 'LITE-13-005 Inspector refresh replaces the bounded projection instead of appending client state'),
    item('apps/server/src/services/RuntimeInspector.test.ts', 'INSP-05 events are ordered and bounded'),
  ],
  'B-CURRENT-HISTORY': [
    item('apps/server/src/services/AgentHistoryService.test.ts', 'LITE-09-103 / CR6-A1 History unifies one Agent across canonical entities and exposes only available references'),
  ],
  'B-CURRENT-WORKBENCH': [
    item('apps/web/src/components/chat/DirectConversationWorkbench.test.tsx', 'LITE-12-101 the workbench exposes Agent selection and Conversation creation controls'),
    item('apps/web/src/lib/workbenchInteractions.test.ts', 'LITE-12-101 workbench actions remain explicit callback intents'),
    item('apps/web/src/lib/composerKeyboard.test.ts', 'LITE-12-014 keyboard submit prevents the browser newline and restores composer focus'),
    item('apps/web/src/components/chat/ConversationRuntimeView.asyncStates.test.tsx', 'LITE-12-007 every state renders without throwing, so no state is unreachable'),
  ],
  'B-CURRENT-INSPECTOR': [
    item('apps/server/src/services/RuntimeInspector.test.ts', 'LITE-13-102 Inspector projects canonical operation identity and version for actions'),
    item('apps/web/src/lib/runtimeInspectorClient.test.ts', 'LITE-13-102 Inspector client encodes the workspace and Run route'),
    item('apps/web/src/lib/runtimeInspectorClient.test.ts', 'LITE-13-102 Inspector client uses versioned action APIs and idempotency keys'),
    item('apps/web/src/components/chat/RuntimeInspectorView.test.tsx', 'LITE-13-102 Inspector action controls are exposed only through callbacks'),
  ],
};

const gapBundleByRequirement = {
  'LITE-01-004': ['B-CURRENT-TASK-CARDINALITY'],
  'LITE-01-006': ['B-CURRENT-RUN-PROCESS'],
  'LITE-01-009': ['B-CURRENT-READONLY-LIMITS'],
  'LITE-02-016': ['B-CURRENT-WORKTREE-ABSENT'],
  'LITE-03-001': ['B-CURRENT-EVENT-SCHEMA'],
  'LITE-03-012': ['B-CURRENT-EVENT-PROJECTION'],
  'LITE-03-016': ['B-CURRENT-MEMORY-EVENT'],
  'LITE-04-002': ['B-CURRENT-PROVIDER-OUTCOMES'],
  'LITE-04-004': ['B-CURRENT-PROVIDER-SWITCH'],
  'LITE-04-005': ['B-CURRENT-DISCONNECT'],
  'LITE-04-009': ['B-CURRENT-READONLY-CLAIMS'],
  'LITE-04-010': ['B-CURRENT-NATIVE-APPROVAL'],
  'LITE-04-011': ['B-CURRENT-REDACTION'],
  'LITE-04-012': ['B-CURRENT-EVENT-PROJECTION'],
  'LITE-05-011': ['B-CURRENT-RECOVERY-PREFLIGHT'],
  'LITE-07-012': ['B-CURRENT-MEMORY-SECRETS'],
  'LITE-08-001': ['B-CURRENT-RUNTIME-APPROVAL'],
  'LITE-08-002': ['B-CURRENT-RUNTIME-APPROVAL'],
  'LITE-08-003': ['B-CURRENT-NATIVE-BOUNDARY'],
  'LITE-08-004': ['B-CURRENT-UI-ADMISSION'],
  'LITE-08-010': ['B-CURRENT-NATIVE-BOUNDARY'],
  'LITE-08-015': ['B-CURRENT-SERVER-SCOPE'],
  'LITE-09-004': ['B-CURRENT-CONVERSATION-RECONNECT-SWITCH'],
  'LITE-09-008': ['B-CURRENT-PROJECTION'],
  'LITE-09-017': ['B-CURRENT-TEMPLATE'],
  'LITE-10-001': ['B-CURRENT-MIGRATION'],
  'LITE-10-005': ['B-CURRENT-SNAPSHOT'],
  'LITE-10-015': ['B-CURRENT-COMPATIBILITY'],
  'LITE-10-016': ['B-CURRENT-MEMORY-SECRETS'],
  'LITE-11-005': ['B-CURRENT-API-SHAPES'],
  'LITE-11-009': ['B-CURRENT-FORCED-ADMISSION'],
  'LITE-11-013': ['B-CURRENT-SERVER-SCOPE'],
  'LITE-12-010': ['B-CURRENT-UI-ADMISSION'],
  'LITE-12-014': ['B-CURRENT-UI-KEYBOARD'],
  'LITE-12-015': ['B-CURRENT-UI-API'],
  'LITE-13-005': ['B-CURRENT-INSPECTOR-BOUND'],
  'LITE-09-103': ['B-CURRENT-HISTORY'],
  'LITE-12-101': ['B-CURRENT-WORKBENCH'],
  'LITE-13-102': ['B-CURRENT-INSPECTOR'],
  'LITE-01-101': ['B-CURRENT-TEMPLATE'],
};

const formerGapIds = source.assertionGapRows.map(row => row.id);
const missingMappings = formerGapIds.filter(id => gapBundleByRequirement[id] === undefined);
if (missingMappings.length > 0) throw new Error(`current semantic review did not classify: ${missingMappings.join(',')}`);
const extraMappings = Object.keys(gapBundleByRequirement).filter(id => !formerGapIds.includes(id));
if (extraMappings.length > 0) throw new Error(`current semantic review mapped non-gap rows: ${extraMappings.join(',')}`);

const candidateRows = [
  ...source.candidateRows,
  ...formerGapIds.map(id => ({ id, assertionBundles: gapBundleByRequirement[id] })),
];
const allCandidateIds = new Set(candidateRows.map(row => row.id));
if (allCandidateIds.size !== 179) throw new Error(`expected 179 classified Runtime-Verify rows, got ${allCandidateIds.size}`);

const classification = structuredClone(source);
classification.authority = {
  ...classification.authority,
  mainSha,
  matrixVersion: matrix.matrixVersion,
  matrixStatus: matrix.status,
  classificationStartedAfter: 'PR #186 merge commit f466ab3c, main CI run 35025602704, and the current evidence-gap review',
};
classification.assertionBundles = { ...source.assertionBundles, ...currentDirectBundles };
classification.candidateRows = candidateRows;
classification.assertionGapRows = [];
classification.implementationGapRows = [];
classification.unresolvedRows = [];
classification.classificationCounts = {
  PASS_CANDIDATE: candidateRows.length,
  ASSERTION_GAP: 0,
  IMPLEMENTATION_GAP: 0,
  UNRESOLVED: 0,
  classifiedRuntimeVerifyRows: candidateRows.length,
};
classification.semanticReview = {
  method: '条款 → 当前生产实现 → 当前命名测试实际断言；不复用旧 finding 作为 PASS 理由。',
  sourceClassification: 'runtime-verify-classification-ec780.json',
  formerAssertionGapRows: formerGapIds.map(id => ({
    id,
    from: 'ASSERTION_GAP',
    to: 'PASS_CANDIDATE',
    assertionBundles: gapBundleByRequirement[id],
    reason: '当前实现和命名测试已找到直接行为断言；旧 finding 仅作为历史审计记录保留。',
  })),
  implementationGapRows: [],
  unresolvedRows: [],
};
classification.policy = {
  ...classification.policy,
  matrixEdited: false,
  passPromoted: false,
  nextAction: '在唯一最终实现 SHA 上，为 179 条 PASS_CANDIDATE 逐条生成原始收据和直接断言映射；DEFERRED 行与 pass-freeze 不变。',
  deferredRowsUnaffected: true,
};

const output = resolve(root, 'docs/implementation/lite-closeout/evidence/runtime-verify-classification-' + mainSha.slice(0, 8) + '.json');
writeFileSync(output, `${JSON.stringify(classification, null, 2)}\n`);
console.log(JSON.stringify({
  output,
  mainSha,
  matrixVersion: matrix.matrixVersion,
  counts: classification.classificationCounts,
  formerAssertionGapsReclassified: formerGapIds.length,
}));
