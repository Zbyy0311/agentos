import { randomUUID } from 'node:crypto';
import type { ProcessId } from './types.js';

const PREFIX = 'proc_';

/**
 * Allocate the canonical AgentOS Process ID. It is a random proc_* identity,
 * allocated before spawn and never derived from an OS PID.
 */
export function newProcessId(): ProcessId {
  return (PREFIX + randomUUID()) as ProcessId;
}

export function isProcessId(value: unknown): value is ProcessId {
  return typeof value === 'string' && value.startsWith(PREFIX) && value.length > PREFIX.length;
}

