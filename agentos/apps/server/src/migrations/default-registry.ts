import { baselineMigration } from './migrations/001-baseline-schema.js';
import { migration002 } from './migrations/002-add-aggregate-versions.js';
import type { Migration } from './types.js';

/**
 * Default migration registry for AgentOS v2.
 * 001: baseline schema (current production DDL)
 * 002: add version columns to mutable aggregates
 */
export const DEFAULT_REGISTRY_MIGRATIONS: Migration[] = [
  baselineMigration,
  migration002,
];
