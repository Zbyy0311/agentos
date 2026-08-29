import { baselineMigration } from './migrations/001-baseline-schema.js';
import { migration002 } from './migrations/002-add-aggregate-versions.js';
import { migration003 } from './migrations/003-workspace-provider-config.js';
import { migration004 } from './migrations/004-workspace-tombstones.js';
import { migration005 } from './migrations/005-tasks-table.js';
import { migration006 } from './migrations/006-runs-table.js';
import { migration007 } from './migrations/007-workflow-definitions.js';
import { migration008 } from './migrations/008-run-snapshots.js';
import { migration009 } from './migrations/009-run-stages.js';
import { migration010 } from './migrations/010-idempotency-records.js';
import { migration011 } from './migrations/011-legacy-data-migration-foundation.js';
import { migration012 } from './migrations/012-m3-runtime-schema.js';
import { migration013 } from './migrations/013-workflow-creation-metadata-v2.js';
import { migration014 } from './migrations/014-m4-process-runtime-schema.js';
import { migration015 } from './migrations/015-p6-m3b-windows-native-birth-identity.js';
import { migration016 } from './migrations/016-p6-l1-workspace-admission-persistence.js';
import type { Migration } from './types.js';

/**
 * Default migration registry for AgentOS v2.
 * 001: baseline schema (current production DDL)
 * 002: add version columns to mutable aggregates
 * 003: workspaces + provider_configurations tables, provider_config_id FK
 * 004: persistent deleted Workspace tombstones
 * 005: canonical v2 tasks table (M2.4)
 * 006: canonical v2 runs table (M2.4)
 * 007: global immutable built-in workflow definitions
 * 008: one-to-one Task Run snapshots
 * 009: Task-domain initial run stages
 * 010: immutable idempotency records (M2.6)
 * 011: legacy data migration foundation registry + compatibility storage (M2.7)
 * 012: M3 Runtime Event, Operation, Stage, Outbox, Dead Letter and Recovery schema
 * 013: M3 Workflow creation metadata V2 definitions
 * 014: M4 process runtime schema (provider sessions, runtime processes, output references)
 * 015: P6-M3b Windows native process birth identity (additive canonical column)
 * 016: P6-L1B Workspace Admission persistence (admissions, git observations,
 *      runtime_artifacts provenance rebuild, same-Workspace legacy subject key)
 */
export const DEFAULT_REGISTRY_MIGRATIONS: Migration[] = [
  baselineMigration,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
  migration009,
  migration010,
  migration011,
  migration012,
  migration013,
  migration014,
  migration015,
  migration016,
];
