import { baselineMigration } from './migrations/001-baseline-schema.js';
import { migration002 } from './migrations/002-add-aggregate-versions.js';
import { migration003 } from './migrations/003-workspace-provider-config.js';
import { migration004 } from './migrations/004-workspace-tombstones.js';
import { migration005 } from './migrations/005-tasks-table.js';
import { migration006 } from './migrations/006-runs-table.js';
import type { Migration } from './types.js';

/**
 * Default migration registry for AgentOS v2.
 * 001: baseline schema (current production DDL)
 * 002: add version columns to mutable aggregates
 * 003: workspaces + provider_configurations tables, provider_config_id FK
 * 004: persistent deleted Workspace tombstones
 * 005: canonical v2 tasks table (M2.4)
 * 006: canonical v2 runs table (M2.4)
 */
export const DEFAULT_REGISTRY_MIGRATIONS: Migration[] = [
  baselineMigration,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
];
