import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    result[key] = value;
    index += 1;
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const phase = args.phase;
const baseUrl = args['base-url'];
const root = resolve(args.root ?? '');
const setupPath = resolve(args['setup-json'] ?? join(root, 'candidate-setup.json'));
const outputPath = resolve(args['output'] ?? join(root, `candidate-evidence/${phase}.json`));
if (!['pre', 'recovery'].includes(phase)) throw new Error('--phase must be pre or recovery');
if (!baseUrl || !root) throw new Error('--base-url and --root are required');

mkdirSync(resolve(outputPath, '..'), { recursive: true });
const result = {
  schemaVersion: 1,
  phase,
  startedAt: new Date().toISOString(),
  setupPath,
  assertions: [],
  metadata: {},
  errors: [],
};

function jsonValue(value) {
  if (value === undefined) return null;
  try { JSON.stringify(value); return value; } catch { return String(value); }
}

function check({ requirementId, assertionId, description, step, observedObject, actual, expected, checkpoint, why, limits, predicate }) {
  const passed = Boolean(predicate);
  const record = {
    requirementId,
    assertionId,
    description,
    step,
    observedObject,
    actual: jsonValue(actual),
    expected: jsonValue(expected),
    outcome: passed ? 'passed' : 'failed',
    assertionSource: {
      type: 'e2e-checkpoint',
      file: 'scripts/verify-lite-four-row-candidate-evidence.mjs',
      checkpoint,
    },
    why,
    limits,
  };
  result.assertions.push(record);
  if (!passed) result.errors.push(`${requirementId}/${assertionId}: ${description}`);
  return passed;
}

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  let body = null;
  try { body = text.length === 0 ? null : JSON.parse(text); } catch { body = { rawText: text }; }
  return { response, body, rawText: text };
}

async function sleep(milliseconds) {
  await new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
}

async function poll(read, predicate, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await sleep(250);
  }
  return last;
}

function parseSseFrames(buffer, frames) {
  let remaining = buffer;
  while (true) {
    const separator = remaining.indexOf('\n\n');
    if (separator < 0) break;
    const block = remaining.slice(0, separator);
    remaining = remaining.slice(separator + 2);
    const event = {};
    for (const line of block.split('\n')) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const key = line.slice(0, colon);
      const value = line.slice(colon + 1).trimStart();
      if (key === 'event') event.event = value;
      if (key === 'id') event.id = value;
      if (key === 'data') event.data = value;
    }
    if (event.event || event.data) frames.push(event);
  }
  return remaining;
}

async function openCanonicalSubscription(runId) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/runs/${runId}/stream`, {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  const state = {
    responseStatus: response.status,
    contentType: response.headers.get('content-type'),
    frames: [],
    abortObserved: false,
    nonAbortError: null,
  };
  const consume = (async () => {
    if (!response.body) throw new Error('canonical stream response has no body');
    const reader = response.body.getReader();
    let buffer = '';
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        buffer += new TextDecoder().decode(next.value, { stream: true }).replaceAll('\r\n', '\n');
        buffer = parseSseFrames(buffer, state.frames);
      }
    } catch (error) {
      if (controller.signal.aborted) state.abortObserved = true;
      else state.nonAbortError = error instanceof Error ? error.message : String(error);
    }
  })();
  return { controller, consume, state };
}

async function inspector(setup) {
  const response = await jsonRequest(`/api/workspaces/${setup.workspaceId}/runtime/runs/${setup.runId}/inspector?maxEvents=1000`);
  if (response.response.status !== 200) throw new Error(`inspector status ${response.response.status}: ${response.rawText}`);
  return response.body.projection;
}

function statusOfProcess(process) {
  return process?.status ?? null;
}

function eventType(event) {
  return event?.type ?? event?.eventType ?? null;
}

function openStreamAssertion(setup, subscription) {
  check({
    requirementId: 'LITE-03-010',
    assertionId: 'LITE-03-010-A1',
    description: 'canonical Event stream subscription was accepted',
    step: 'GET /api/runs/:runId/stream before Run start',
    observedObject: 'HTTP response and SSE subscription',
    actual: { status: subscription.state.responseStatus, contentType: subscription.state.contentType },
    expected: { status: 200, contentTypePrefix: 'text/event-stream' },
    checkpoint: 'canonical-stream-open-before-start',
    why: 'This binds the later disconnect action to the production canonical Run Event subscription route.',
    limits: 'It does not by itself prove Run or Process lifecycle behavior.',
    predicate: subscription.state.responseStatus === 200 && String(subscription.state.contentType).startsWith('text/event-stream'),
  });
}

async function runPre() {
  const setup = JSON.parse(readFileSync(setupPath, 'utf8'));
  result.metadata = {
    workspaceId: setup.workspaceId,
    taskId: setup.taskId,
    runId: setup.runId,
    baselineSha: setup.baselineSha,
    stageIds: setup.stageIds,
    stageKeys: setup.stageKeys,
    routeModels: setup.routeModels,
    modelScopeStatement: setup.modelScopeStatement,
  };

  const subscription = await openCanonicalSubscription(setup.runId);
  openStreamAssertion(setup, subscription);

  const start = await jsonRequest(`/api/runs/${setup.runId}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: '{}',
  });
  const startOperation = start.body?.data?.operation ?? start.body?.operation ?? null;
  check({
    requirementId: 'LITE-00-004',
    assertionId: 'LITE-00-004-A1',
    description: 'canonical Run start was accepted before disconnect',
    step: 'POST /api/runs/:runId/start with {}',
    observedObject: 'Run start HTTP acceptance',
    actual: { status: start.response.status, operation: startOperation },
    expected: { status: 202, operationStatus: 'queued' },
    checkpoint: 'canonical-run-start-accepted',
    why: 'It establishes the same Run and durable start Operation later observed after subscription disconnect.',
    limits: 'Acceptance alone does not prove active Run survival.',
    predicate: start.response.status === 202 && startOperation?.runId === setup.runId,
  });

  const activeProjection = await poll(
    () => inspector(setup),
    projection => projection?.overview?.status === 'running'
      && projection.processes?.some(process => ['starting', 'running'].includes(statusOfProcess(process))),
  );
  const activeProcess = activeProjection?.processes?.find(process => ['starting', 'running'].includes(statusOfProcess(process))) ?? null;
  check({
    requirementId: 'LITE-00-004',
    assertionId: 'LITE-00-004-A2',
    description: 'Run was observed active before subscription disconnect',
    step: 'Poll Runtime Inspector after canonical start',
    observedObject: 'Inspector projection.overview.status',
    actual: activeProjection?.overview?.status ?? null,
    expected: 'running',
    checkpoint: 'runtime-inspector-run-active-before-disconnect',
    why: 'The requirement concerns a Run already in execution when the browser/subscription disconnect occurs.',
    limits: 'This assertion does not prove Process linkage; that is recorded separately for LITE-02-009.',
    predicate: activeProjection?.overview?.status === 'running',
  });
  check({
    requirementId: 'LITE-02-009',
    assertionId: 'LITE-02-009-A1',
    description: 'the Run has a linked active durable Process before disconnect',
    step: 'Poll Runtime Inspector after canonical start',
    observedObject: 'Inspector projection.processes[]',
    actual: activeProcess ? { id: activeProcess.id, runId: activeProcess.runId, status: activeProcess.status, processType: activeProcess.processType } : null,
    expected: { linkedRunId: setup.runId, activeStatus: ['starting', 'running'] },
    checkpoint: 'runtime-inspector-run-and-process-active-before-disconnect',
    why: 'It proves the Process object being protected is the Process belonging to this Run.',
    limits: 'It is a point-in-time observation before the disconnect.',
    predicate: activeProcess?.runId === setup.runId && ['starting', 'running'].includes(statusOfProcess(activeProcess)),
  });

  const frameCountBeforeDisconnect = subscription.state.frames.length;
  check({
    requirementId: 'LITE-03-010',
    assertionId: 'LITE-03-010-A2',
    description: 'the canonical subscription received an actual Event frame before disconnect',
    step: 'Consume the production SSE body while Run starts',
    observedObject: 'SSE frames received by the client',
    actual: { frameCount: frameCountBeforeDisconnect, events: subscription.state.frames.slice(0, 10) },
    expected: { minimumFrameCount: 1 },
    checkpoint: 'canonical-stream-frame-received-before-disconnect',
    why: 'It demonstrates that the tested action is an active Event stream subscription, not merely an unopened HTTP request.',
    limits: 'The frame content is an observed event sample, not a full replay audit.',
    predicate: frameCountBeforeDisconnect > 0,
  });

  const disconnectAction = {
    action: 'AbortController.abort',
    target: 'canonical GET /api/runs/:runId/stream subscription',
    at: new Date().toISOString(),
    runId: setup.runId,
    processId: activeProcess?.id ?? null,
  };
  result.metadata.subscriptionDisconnect = disconnectAction;
  subscription.controller.abort();
  await Promise.race([subscription.consume, sleep(5000)]);
  check({
    requirementId: 'LITE-03-010',
    assertionId: 'LITE-03-010-A3',
    description: 'the client observed its own subscription abort completing',
    step: 'Abort the canonical SSE subscription after active Run/Process observation',
    observedObject: 'SSE reader and AbortController',
    actual: { abortSignal: subscription.controller.signal.aborted, abortObservedByReader: subscription.state.abortObserved, nonAbortError: subscription.state.nonAbortError },
    expected: { abortSignal: true, abortObservedByReader: true, nonAbortError: null },
    checkpoint: 'canonical-stream-client-disconnect-observed',
    why: 'This records the actual subscription-disconnect event used for the causal no-cancellation check.',
    limits: 'It does not claim that every possible browser network failure behaves identically.',
    predicate: subscription.controller.signal.aborted && subscription.state.abortObserved && subscription.state.nonAbortError === null,
  });

  const afterDisconnect = await inspector(setup);
  const afterProcess = afterDisconnect.processes?.find(process => process.id === activeProcess?.id)
    ?? afterDisconnect.processes?.find(process => process.runId === setup.runId);
  const afterEventTypes = afterDisconnect.events?.map(eventType).filter(Boolean) ?? [];
  check({
    requirementId: 'LITE-00-004',
    assertionId: 'LITE-00-004-A3',
    description: 'Run remained active after subscription disconnect',
    step: 'Read Runtime Inspector after AbortController.abort',
    observedObject: 'Inspector projection.overview.status',
    actual: afterDisconnect.overview?.status ?? null,
    expected: 'running',
    checkpoint: 'runtime-inspector-run-active-after-disconnect',
    why: 'It directly observes the same Run after the browser/subscription transport was disconnected.',
    limits: 'It does not prove the Run can complete; the normal lifecycle close is checked separately.',
    predicate: afterDisconnect.overview?.status === 'running',
  });
  check({
    requirementId: 'LITE-02-009',
    assertionId: 'LITE-02-009-A2',
    description: 'the Run-linked Process remained active after subscription disconnect',
    step: 'Read Runtime Inspector after AbortController.abort',
    observedObject: 'Inspector projection.processes[] for the same process id',
    actual: afterProcess ? { id: afterProcess.id, runId: afterProcess.runId, status: afterProcess.status, processType: afterProcess.processType } : null,
    expected: { linkedRunId: setup.runId, activeStatus: ['starting', 'running'] },
    checkpoint: 'runtime-inspector-process-active-after-disconnect',
    why: 'It extends Run survival to the durable Process owner and checks the same Process identity after disconnect.',
    limits: 'It does not claim that a Process survives an explicit cancellation.',
    predicate: afterProcess?.id === activeProcess?.id && afterProcess?.runId === setup.runId && ['starting', 'running'].includes(statusOfProcess(afterProcess)),
  });
  check({
    requirementId: 'LITE-03-010',
    assertionId: 'LITE-03-010-A4',
    description: 'the stream disconnect was not accompanied by a Run cancellation event or cancelled status',
    step: 'Compare post-disconnect Run status and persisted Event projection',
    observedObject: 'Inspector overview plus persisted Runtime Events',
    actual: { runStatus: afterDisconnect.overview?.status ?? null, eventTypes: afterEventTypes },
    expected: { runStatus: 'running', forbiddenEventTypes: ['run.cancelled', 'run.cancellation_requested'] },
    checkpoint: 'canonical-stream-disconnect-no-run-cancellation-observed',
    why: 'The explicit stream action, reader abort receipt, post-action Run status, and event projection together test the causal boundary.',
    limits: 'It establishes absence in this observed interval; it does not prove unrelated later explicit cancellation cannot occur.',
    predicate: afterDisconnect.overview?.status === 'running'
      && !afterEventTypes.some(type => ['run.cancelled', 'run.cancellation_requested'].includes(type)),
  });

  const operationId = setup.cancelOperationId;
  const operationRead = operationId
    ? await jsonRequest(`/api/operations/${operationId}`)
    : { response: { status: 0 }, body: null, rawText: 'missing operation id' };
  const operation = operationRead.body?.data ?? null;
  const cancel = operationId
    ? await jsonRequest(`/api/operations/${operationId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ expectedVersion: operation?.version }),
    })
    : { response: { status: 0 }, body: null, rawText: 'missing operation id' };
  const cancelledProjection = await poll(
    () => inspector(setup),
    projection => projection?.overview?.status === 'cancelled',
  );
  check({
    requirementId: 'LITE-00-004',
    assertionId: 'LITE-00-004-A4',
    description: 'the still-active Run was ended by a separate normal lifecycle cancellation action',
    step: 'GET run.cancel Operation then POST /api/operations/:operationId/cancel with its current version',
    observedObject: 'Operation cancel response and Runtime Inspector terminal Run state',
    actual: { operationReadStatus: operationRead.response.status, operationType: operation?.type ?? null, operationStatusBeforeCancel: operation?.status ?? null, cancelStatus: cancel.response.status, runStatusAfterCancel: cancelledProjection?.overview?.status ?? null },
    expected: { cancelStatus: 200, runStatusAfterCancel: 'cancelled' },
    checkpoint: 'explicit-operation-cancel-after-disconnect',
    why: 'It demonstrates the Run was not ended by the subscription disconnect and could be ended by the ordinary lifecycle action afterward.',
    limits: 'This is an explicit cancellation proof, not proof of successful provider completion.',
    predicate: operationRead.response.status === 200
      && operation?.type === 'run.cancel'
      && cancel.response.status === 200
      && cancelledProjection?.overview?.status === 'cancelled',
  });

  const recoverySeed = await jsonRequest(`/api/workspaces/${setup.workspaceId}/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ agentId: 'codex', title: 'S8 candidate recovery seed' }),
  });
  const conversationId = recoverySeed.body?.conversation?.id;
  check({
    requirementId: 'LITE-00-007',
    assertionId: 'LITE-00-007-A1',
    description: 'a dedicated recovery fixture conversation was created for queued/running/waiting_user states',
    step: 'POST /api/workspaces/:workspaceId/runtime/conversations',
    observedObject: 'Recovery fixture conversation',
    actual: { status: recoverySeed.response.status, conversationId: conversationId ?? null },
    expected: { status: 201, conversationId: 'non-empty' },
    checkpoint: 'recovery-fixture-conversation-created',
    why: 'It provides a real persisted Conversation foreign-key target for the restart recovery rows.',
    limits: 'Conversation creation alone does not prove recovery classification.',
    predicate: recoverySeed.response.status === 201 && typeof conversationId === 'string' && conversationId.length > 0,
  });
  if (!conversationId) throw new Error('recovery fixture conversation was not created');

  const recoveryRows = seedRecoveryRows(root, setup.workspaceId, conversationId);
  result.metadata.recoveryConversationId = conversationId;
  result.metadata.recoveryBefore = recoveryRows;
  check({
    requirementId: 'LITE-00-007',
    assertionId: 'LITE-00-007-A2',
    description: 'recovery input states were recorded before the simulated server restart',
    step: 'Insert and immediately re-read three legacy agent_runs rows',
    observedObject: 'SQLite agent_runs rows before restart',
    actual: recoveryRows,
    expected: { statuses: ['queued', 'running', 'waiting_user'] },
    checkpoint: 'recovery-before-state-recorded-before-server-stop',
    why: 'It records the exact uncertainty states presented to startup recovery instead of inferring them afterward.',
    limits: 'The restart action itself is recorded by the runner and server stdout/stderr receipts.',
    predicate: recoveryRows.length === 3
      && recoveryRows.some(row => row.status === 'queued')
      && recoveryRows.some(row => row.status === 'running')
      && recoveryRows.some(row => row.status === 'waiting_user'),
  });
}

function seedRecoveryRows(projectRoot, workspaceId, conversationId) {
  const dbPath = join(projectRoot, '.agentos', 'agentos.sqlite');
  if (!existsSync(dbPath)) throw new Error(`database missing: ${dbPath}`);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const now = new Date().toISOString();
  const inserted = [];
  try {
    for (const status of ['queued', 'running', 'waiting_user']) {
      const messageId = `candidate-recovery-message-${status}-${randomUUID()}`;
      const runId = `candidate-recovery-run-${status}-${randomUUID()}`;
      db.prepare('INSERT INTO messages (id, conversation_id, workspace_id, sender_type, sender_agent_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(messageId, conversationId, workspaceId, 'user', null, `candidate recovery ${status}`, now);
      db.prepare('INSERT INTO agent_runs (id, workspace_id, conversation_id, source_message_id, objective, status, result_summary, failure_reason, started_at, completed_at, created_at, updated_at, waiting_question, waiting_execution_id, waiting_agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(runId, workspaceId, conversationId, messageId, `candidate recovery ${status}`, status, null, null, status === 'running' ? now : null, null, now, now, status === 'waiting_user' ? '保留 waiting_user 状态' : null, null, status === 'waiting_user' ? 'codex' : null);
      inserted.push({ id: runId, objective: `candidate recovery ${status}`, status, messageId });
    }
    return db.prepare('SELECT id, objective, status, failure_reason AS failureReason, waiting_question AS waitingQuestion FROM agent_runs WHERE conversation_id = ? AND objective LIKE \'candidate recovery %\' ORDER BY objective')
      .all(conversationId);
  } finally {
    db.close();
  }
}

async function runRecovery() {
  const prePath = resolve(args['pre-json'] ?? join(resolve(outputPath, '..'), 'pre.json'));
  const pre = JSON.parse(readFileSync(prePath, 'utf8'));
  const setup = JSON.parse(readFileSync(setupPath, 'utf8'));
  const conversationId = pre.metadata?.recoveryConversationId;
  if (!conversationId) throw new Error('pre phase did not persist recoveryConversationId');
  result.metadata = {
    workspaceId: setup.workspaceId,
    runId: setup.runId,
    baselineSha: setup.baselineSha,
    recoveryConversationId: conversationId,
    recoveryAction: 'server process stopped after pre phase and a new server process was started before this phase',
    modelScopeStatement: setup.modelScopeStatement,
  };
  const before = pre.metadata?.recoveryBefore ?? [];
  const listRuns = async () => {
    const response = await jsonRequest(`/api/workspaces/${setup.workspaceId}/runs?conversationId=${encodeURIComponent(conversationId)}&limit=100`);
    if (response.response.status !== 200) throw new Error(`recovery list status ${response.response.status}: ${response.rawText}`);
    return response.body.runs ?? [];
  };
  const after = await poll(
    listRuns,
    runs => ['candidate recovery queued', 'candidate recovery running'].every(objective => runs.some(run => run.objective === objective && run.status === 'failed'))
      && runs.some(run => run.objective === 'candidate recovery waiting_user' && run.status === 'waiting_user'),
    30000,
  ) ?? [];
  result.metadata.recoveryAfter = after;
  const byObjective = new Map(after.map(run => [run.objective, run]));
  for (const status of ['queued', 'running']) {
    check({
      requirementId: 'LITE-00-007',
      assertionId: `LITE-00-007-A3-${status}`,
      description: `startup recovery conservatively classified ${status} as failed`,
      step: 'Read legacy runs after server process restart',
      observedObject: `agent_run objective=candidate recovery ${status}`,
      actual: byObjective.get(`candidate recovery ${status}`) ?? null,
      expected: { status: 'failed', completed: false },
      checkpoint: `recovery-after-restart-${status}-classified-failed`,
      why: 'A queued/running execution with no proof of completion is classified as failed rather than guessed completed.',
      limits: 'This fixture does not prove recovery of a live native Process identity.',
      predicate: byObjective.get(`candidate recovery ${status}`)?.status === 'failed'
        && byObjective.get(`candidate recovery ${status}`)?.status !== 'completed',
    });
  }
  check({
    requirementId: 'LITE-00-007',
    assertionId: 'LITE-00-007-A4',
    description: 'waiting_user remained waiting_user after startup recovery',
    step: 'Read legacy runs after server process restart',
    observedObject: 'agent_run objective=candidate recovery waiting_user',
    actual: byObjective.get('candidate recovery waiting_user') ?? null,
    expected: { status: 'waiting_user', completed: false },
    checkpoint: 'recovery-after-restart-waiting-user-preserved',
    why: 'It checks that a user-waiting state was not treated as an interrupted provider execution.',
    limits: 'It does not prove a later user response/resume flow.',
    predicate: byObjective.get('candidate recovery waiting_user')?.status === 'waiting_user'
      && byObjective.get('candidate recovery waiting_user')?.status !== 'completed',
  });
  check({
    requirementId: 'LITE-00-007',
    assertionId: 'LITE-00-007-A5',
    description: 'no recovery input was guessed completed',
    step: 'Compare all recorded recovery rows after restart',
    observedObject: 'three recovery rows and their resulting statuses',
    actual: { before, after: after.map(run => ({ objective: run.objective, status: run.status, failureReason: run.failureReason ?? null })) },
    expected: { completedRows: 0 },
    checkpoint: 'recovery-no-completed-guess',
    why: 'The complete before/after set shows every uncertain input classification and rules out a fabricated completion.',
    limits: 'It is scoped to these three legacy fixture rows.',
    predicate: after.length >= 3 && after.every(run => run.status !== 'completed'),
  });
}

try {
  if (phase === 'pre') await runPre();
  else await runRecovery();
} catch (error) {
  result.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
} finally {
  result.finishedAt = new Date().toISOString();
  const counts = { total: result.assertions.length, passed: 0, failed: 0, skipped: 0 };
  for (const assertion of result.assertions) counts[assertion.outcome] += 1;
  result.counts = counts;
  if (counts.failed > 0 || counts.skipped > 0) process.exitCode = 1;
  result.rawExitCode = process.exitCode ?? 0;
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ phase, counts, errors: result.errors.length, outputPath })}\n`);
}
