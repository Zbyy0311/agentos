import { resolve } from 'node:path';

export function resolveProjectRoot(moduleDirectory: string, configuredRoot = process.env.AGENTOS_PROJECT_ROOT): string {
  return configuredRoot ? resolve(configuredRoot) : resolve(moduleDirectory, '..', '..', '..');
}
