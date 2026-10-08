import type { WorkflowDefinition, WorkflowDefinitionPayload } from '@agentos/shared';
import type { TransactionDatabase } from './Transaction.js';
import { inTransaction } from './Transaction.js';
import { createEntityId } from './Identity.js';
import { WorkflowDefinitionRepository } from './WorkflowDefinitionRepository.js';
import { canonicalizeJson, hashCanonicalJson } from '../snapshots/canonicalJson.js';

/**
 * Workflow Definition write seam (Workflow Template instantiation).
 *
 * `WorkflowDefinitionRepository` is intentionally READ-ONLY — built-in definitions are
 * immutable, and a frozen guard test asserts the repository exposes no mutation API.
 * This separate seam owns the one additive write: persisting a definition compiled from
 * a Workflow Template. It never updates, archives, or deletes a row, so a built-in can
 * never be mutated through it.
 *
 * Frozen design: docs/implementation/milestones/WF-templates-durable-wiring.md.
 * Row columns are derived FROM the payload, and the row is read back through the
 * validating read repository inside the same transaction, so a malformed payload
 * rolls back instead of persisting.
 */

export type WorkflowDefinitionWriteErrorCode =
  | 'DEFINITION_WRITE_INPUT_INVALID'
  | 'DEFINITION_WRITE_REJECTED';

export class WorkflowDefinitionWriteError extends Error {
  constructor(readonly code: WorkflowDefinitionWriteErrorCode, readonly detail?: string) {
    super(detail === undefined ? `WORKFLOW_DEFINITION_WRITE_${code}` : `WORKFLOW_DEFINITION_WRITE_${code}: ${detail}`);
    this.name = 'WorkflowDefinitionWriteError';
  }
}

export interface PersistCompiledDefinitionInput {
  readonly payload: WorkflowDefinitionPayload;
  readonly createdAt: string;
  readonly id?: string;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class WorkflowDefinitionWriter {
  private readonly reads: WorkflowDefinitionRepository;

  constructor(private readonly db: TransactionDatabase, reads?: WorkflowDefinitionRepository) {
    this.reads = reads ?? new WorkflowDefinitionRepository(db);
  }

  persistCompiledDefinition(input: PersistCompiledDefinitionInput): WorkflowDefinition {
    return inTransaction(this.db, () => this.persistCompiledDefinitionWithinTransaction(input));
  }

  /** Transaction-free variant for callers already inside `inTransaction`. */
  persistCompiledDefinitionWithinTransaction(input: PersistCompiledDefinitionInput): WorkflowDefinition {
    if (typeof input !== 'object' || input === null
      || typeof input.payload !== 'object' || input.payload === null
      || !nonBlank(input.createdAt)) {
      throw new WorkflowDefinitionWriteError('DEFINITION_WRITE_INPUT_INVALID');
    }
    const payload = input.payload;
    let canonical: string;
    let definitionHash: string;
    try {
      canonical = canonicalizeJson(payload);
      definitionHash = hashCanonicalJson(payload);
    } catch {
      throw new WorkflowDefinitionWriteError('DEFINITION_WRITE_INPUT_INVALID');
    }
    const id = input.id ?? createEntityId('workflow');
    try {
      this.db.prepare(
        `INSERT INTO workflow_definitions (
          id, definition_key, version, name, definition_json, definition_hash,
          enabled, archived_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
      ).run(
        id,
        String(payload.definitionKey),
        Number(payload.version),
        String(payload.name),
        canonical,
        definitionHash,
        input.createdAt,
        input.createdAt,
      );
    } catch {
      throw new WorkflowDefinitionWriteError('DEFINITION_WRITE_REJECTED');
    }
    // Read back through the validating repository: a malformed row rolls the whole
    // transaction back instead of persisting.
    const persisted = this.reads.findById(id);
    if (persisted === undefined) {
      throw new WorkflowDefinitionWriteError('DEFINITION_WRITE_REJECTED');
    }
    return persisted;
  }
}

