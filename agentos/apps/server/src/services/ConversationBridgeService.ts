import type { Run, Task, V2RunReason, V2TaskPriority } from '@agentos/shared';
import { RunActiveExistsError, RunValidationError, type RunRepository } from '../store/RunRepository.js';
import type { TaskRepository } from '../store/TaskRepository.js';
import type { ConversationRepository, MessageRecord } from '../store/ConversationRepository.js';
import { ConversationRepositoryError } from '../store/ConversationRepository.js';
import {
  WorkspaceAdmissionRepository,
  type AdmissionMutationClass,
  type AdmissionState,
} from '../store/WorkspaceAdmissionRepository.js';
import { inTransaction, type TransactionDatabase } from '../store/Transaction.js';

/**
 * CR-4a explicit Task/Run bridge.
 *
 * Frozen design: docs/implementation/milestones/CR4-schema-authorization.md
 * Product authority: docs/Runtime-Specification lite/09-Conversation-Runtime.md section 9.
 *
 * Frozen rules:
 *
 * - a normal chat Message never creates a Task or Run; only an explicit
 *   create-Task or start-Run call does;
 * - create-Task is idempotent and starts nothing;
 * - canonical runs.task_id is NOT NULL, so start-Run resolves the Message's Task
 *   first and auto-creates one when absent (frozen option (a));
 * - the durable convergence key is the Message binding (cr_messages.task_id /
 *   run_id) re-read inside the transaction, so a retried or concurrent call
 *   returns the SAME Task/Run;
 * - origin stays v2_api because migration 006 CHECK-limits runs.origin and
 *   widening it would require a table rebuild;
 * - the bridge NEVER grants, advances, or fakes admission. It only reports the
 *   observed admission row; effective class and enforcement evidence come from
 *   durable admission state, never from the request body;
 * - archive gates Turn reservation (CR-3) only: Task and Run actions stay
 *   available because archive must never cancel or freeze linked work;
 * - this seam adds no route, transport, UI, or projection.
 */

export type ConversationBridgeErrorCode =
  | 'BRIDGE_INPUT_INVALID'
  | 'BRIDGE_CONVERSATION_NOT_FOUND'
  | 'BRIDGE_MESSAGE_NOT_FOUND'
  | 'BRIDGE_TASK_NOT_FOUND'
  | 'BRIDGE_RUN_NOT_FOUND'
  | 'BRIDGE_CONFLICT'
  | 'BRIDGE_PERSISTENCE_FAILED';

export class ConversationBridgeError extends Error {
  constructor(readonly code: ConversationBridgeErrorCode) {
    super(`CONVERSATION_BRIDGE_${code}`);
    this.name = 'ConversationBridgeError';
  }
}

export type ConversationRequestedIntent = 'READ_ONLY' | 'MODIFYING';

/**
 * Requested intent is an intent only. Effective class and enforcement evidence
 * are read from the durable admission row and are null when no admission exists.
 */
export interface ConversationAdmissionReport {
  readonly requestedIntent: ConversationRequestedIntent | null;
  readonly admissionState: AdmissionState | null;
  readonly effectiveMutationClass: AdmissionMutationClass | null;
  readonly hasEnforcementEvidence: boolean;
}

export interface CreateTaskFromMessageInput {
  readonly workspaceId: string;
  readonly messageId: string;
  readonly createdBy: string;
  readonly title?: string;
  readonly description?: string;
  readonly priority?: V2TaskPriority;
  readonly createdAt: string;
}

export interface CreateTaskFromMessageResult {
  readonly task: Task;
  readonly message: MessageRecord;
  readonly created: boolean;
}

export interface StartRunFromMessageInput {
  readonly workspaceId: string;
  readonly messageId: string;
  readonly createdBy: string;
  readonly objective?: string;
  readonly reason?: V2RunReason;
  readonly requestedIntent?: ConversationRequestedIntent;
  readonly createdAt: string;
}

export interface StartRunFromMessageResult {
  readonly run: Run;
  readonly task: Task;
  readonly message: MessageRecord;
  readonly runCreated: boolean;
  readonly taskCreated: boolean;
  readonly admission: ConversationAdmissionReport;
}

const DEFAULT_TASK_TITLE = 'Conversation task';
const MAX_DERIVED_TITLE_LENGTH = 120;
/**
 * Only reasons that are valid WITHOUT a parent run. `retry`, `resume-fallback`,
 * `review-fix`, and `provider-comparison` require parentRunId lineage and belong to
 * the retry/comparison flows, not to a Message bridge that carries no parent.
 */
const REASONS: readonly V2RunReason[] = ['initial', 'manual'];
const PRIORITIES: readonly V2TaskPriority[] = ['low', 'normal', 'high', 'critical'];
const REQUESTED_INTENTS: readonly ConversationRequestedIntent[] = ['READ_ONLY', 'MODIFYING'];

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Deterministic, bounded title derived from Message content; never a secret scan bypass. */
export function deriveTaskTitleFromMessage(content: string): string {
  const firstLine = content.split(/\r?\n/, 1)[0]?.replace(/\s+/g, ' ').trim() ?? '';
  if (firstLine.length === 0) return DEFAULT_TASK_TITLE;
  return firstLine.length > MAX_DERIVED_TITLE_LENGTH
    ? firstLine.slice(0, MAX_DERIVED_TITLE_LENGTH)
    : firstLine;
}

export class ConversationBridgeService {
  private readonly admissions: WorkspaceAdmissionRepository;

  constructor(
    private readonly db: TransactionDatabase,
    private readonly conversations: ConversationRepository,
    private readonly tasks: TaskRepository,
    private readonly runs: RunRepository,
    admissions?: WorkspaceAdmissionRepository,
  ) {
    this.admissions = admissions ?? new WorkspaceAdmissionRepository(db);
  }

  createTaskFromMessage(input: CreateTaskFromMessageInput): CreateTaskFromMessageResult {
    try {
      return inTransaction(this.db, () => this.createTaskFromMessageWithinTransaction(input));
    } catch (error) {
      throw this.publicError(error);
    }
  }

  /** Transaction-free variant for callers already inside `inTransaction`. */
  createTaskFromMessageWithinTransaction(input: CreateTaskFromMessageInput): CreateTaskFromMessageResult {
    this.assertCreateTaskInput(input);
    const message = this.requireMessage(input.workspaceId, input.messageId);
    this.requireConversation(input.workspaceId, message.conversationId);
    if (message.taskId !== null) {
      const existing = this.requireTask(input.workspaceId, message.taskId);
      return { task: existing, message, created: false };
    }
    const task = this.tasks.insert({
      workspaceId: input.workspaceId,
      title: input.title ?? deriveTaskTitleFromMessage(message.content),
      sourceConversationId: message.conversationId,
      sourceMessageId: message.id,
      createdBy: input.createdBy,
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
    });
    const bound = this.conversations.bindMessageReferencesWithinTransaction({
      workspaceId: input.workspaceId,
      messageId: message.id,
      expectedVersion: message.version,
      taskId: task.id,
      boundAt: input.createdAt,
    });
    return { task, message: bound, created: true };
  }

  startRunFromMessage(input: StartRunFromMessageInput): StartRunFromMessageResult {
    try {
      return inTransaction(this.db, () => this.startRunFromMessageWithinTransaction(input));
    } catch (error) {
      throw this.publicError(error);
    }
  }

  /** Transaction-free variant for callers already inside `inTransaction`. */
  startRunFromMessageWithinTransaction(input: StartRunFromMessageInput): StartRunFromMessageResult {
    this.assertStartRunInput(input);
    const message = this.requireMessage(input.workspaceId, input.messageId);
    this.requireConversation(input.workspaceId, message.conversationId);
    const requestedIntent = input.requestedIntent ?? null;
    if (message.runId !== null) {
      const existingRun = this.requireRun(input.workspaceId, message.runId);
      const existingTask = this.requireTask(input.workspaceId, existingRun.taskId);
      return {
        run: existingRun,
        task: existingTask,
        message,
        runCreated: false,
        taskCreated: false,
        admission: this.reportAdmission(input.workspaceId, existingRun.id, requestedIntent),
      };
    }
    let task: Task;
    let taskCreated = false;
    if (message.taskId !== null) {
      task = this.requireTask(input.workspaceId, message.taskId);
    } else {
      task = this.tasks.insert({
        workspaceId: input.workspaceId,
        title: deriveTaskTitleFromMessage(message.content),
        sourceConversationId: message.conversationId,
        sourceMessageId: message.id,
        createdBy: input.createdBy,
      });
      taskCreated = true;
    }
    const run = this.runs.insert({
      workspaceId: input.workspaceId,
      taskId: task.id,
      origin: 'v2_api',
      reason: input.reason ?? 'initial',
      createdBy: input.createdBy,
      ...(input.objective === undefined ? {} : { objective: input.objective }),
    });
    const bound = this.conversations.bindMessageReferencesWithinTransaction({
      workspaceId: input.workspaceId,
      messageId: message.id,
      expectedVersion: message.version,
      taskId: task.id,
      runId: run.id,
      boundAt: input.createdAt,
    });
    return {
      run,
      task,
      message: bound,
      runCreated: true,
      taskCreated,
      admission: this.reportAdmission(input.workspaceId, run.id, requestedIntent),
    };
  }

  /** Read-only view of the single admission authority's durable state. */
  reportAdmission(
    workspaceId: string,
    runId: string,
    requestedIntent: ConversationRequestedIntent | null = null,
  ): ConversationAdmissionReport {
    const row = this.admissions.findBySubject(workspaceId, {
      subjectKind: 'CANONICAL_RUN',
      canonicalRunId: runId,
    });
    if (row === undefined) {
      return {
        requestedIntent,
        admissionState: null,
        effectiveMutationClass: null,
        hasEnforcementEvidence: false,
      };
    }
    return {
      requestedIntent,
      admissionState: row.state,
      effectiveMutationClass: row.effectiveMutationClass,
      hasEnforcementEvidence: row.enforcementEvidenceJson !== null,
    };
  }

  private requireMessage(workspaceId: string, messageId: string): MessageRecord {
    const message = this.conversations.findMessageById(workspaceId, messageId);
    if (message === undefined) throw new ConversationBridgeError('BRIDGE_MESSAGE_NOT_FOUND');
    return message;
  }

  private requireConversation(workspaceId: string, conversationId: string): void {
    if (this.conversations.findConversationById(workspaceId, conversationId) === undefined) {
      throw new ConversationBridgeError('BRIDGE_CONVERSATION_NOT_FOUND');
    }
  }

  private requireTask(workspaceId: string, taskId: string): Task {
    const task = this.tasks.findById(workspaceId, taskId);
    if (task === undefined) throw new ConversationBridgeError('BRIDGE_TASK_NOT_FOUND');
    return task;
  }

  private requireRun(workspaceId: string, runId: string): Run {
    const run = this.runs.findById(workspaceId, runId);
    if (run === undefined) throw new ConversationBridgeError('BRIDGE_RUN_NOT_FOUND');
    return run;
  }

  private assertCreateTaskInput(input: CreateTaskFromMessageInput): void {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.messageId)
      || !nonBlank(input.createdBy) || !nonBlank(input.createdAt)
      || (input.title !== undefined && !nonBlank(input.title))
      || (input.description !== undefined && typeof input.description !== 'string')
      || (input.priority !== undefined && !PRIORITIES.includes(input.priority))) {
      throw new ConversationBridgeError('BRIDGE_INPUT_INVALID');
    }
  }

  private assertStartRunInput(input: StartRunFromMessageInput): void {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.messageId)
      || !nonBlank(input.createdBy) || !nonBlank(input.createdAt)
      || (input.objective !== undefined && typeof input.objective !== 'string')
      || (input.reason !== undefined && !REASONS.includes(input.reason))
      || (input.requestedIntent !== undefined && !REQUESTED_INTENTS.includes(input.requestedIntent))) {
      throw new ConversationBridgeError('BRIDGE_INPUT_INVALID');
    }
  }

  private publicError(error: unknown): ConversationBridgeError {
    if (error instanceof ConversationBridgeError) return error;
    if (error instanceof ConversationRepositoryError) {
      if (error.code === 'MESSAGE_NOT_FOUND') return new ConversationBridgeError('BRIDGE_MESSAGE_NOT_FOUND');
      if (error.code === 'MESSAGE_NOT_TRANSITIONABLE') return new ConversationBridgeError('BRIDGE_CONFLICT');
      return new ConversationBridgeError('BRIDGE_PERSISTENCE_FAILED');
    }
    if (error instanceof RunValidationError) {
      return new ConversationBridgeError('BRIDGE_INPUT_INVALID');
    }
    if (error instanceof RunActiveExistsError) {
      // One active Run per Task is a durable invariant, not a transport failure.
      return new ConversationBridgeError('BRIDGE_CONFLICT');
    }
    return new ConversationBridgeError('BRIDGE_PERSISTENCE_FAILED');
  }
}
