import type { PreferenceContextKind } from '@agentos/shared';
import type { MemoryEntryRecord } from '../store/MemoryEntryRepository.js';
import type { TransactionDatabase } from '../store/Transaction.js';
import { classifyPreferenceContext } from './PreferenceContextClassifier.js';

interface Binding {
  entry_id: string; entry_workspace_id: string; dimension: string; context_kind: string;
  preferred_value: string; scope: 'workspace' | 'global'; status: string; entry_version: number | null;
}

function matchesTaggedScene(entry: MemoryEntryRecord, scene: PreferenceContextKind): boolean {
  const contextTags = entry.tags.filter(tag => tag.startsWith('context:'));
  return contextTags.length === 0 || contextTags.includes('context:general') || contextTags.includes(`context:${scene}`);
}

function isCanonicalPreferenceEntry(entry: MemoryEntryRecord): boolean {
  return entry.category === 'preference' && entry.authority === 'user-explicit'
    && entry.tags.includes('preference')
    && entry.tags.some(tag => tag.startsWith('dimension:') && tag.length > 'dimension:'.length)
    && entry.tags.some(tag => tag.startsWith('context:') && tag.length > 'context:'.length)
    && entry.tags.some(tag => tag.startsWith('value:') && tag.length > 'value:'.length);
}

function isPreservedManualEntry(entry: MemoryEntryRecord, binding: Binding): boolean {
  return (binding.status === 'revoked' || binding.status === 'rejected')
    && binding.entry_version !== null && entry.version > binding.entry_version
    && entry.workspaceId === binding.entry_workspace_id
    && entry.status === 'active' && isCanonicalPreferenceEntry(entry);
}

/** Confirmed Entries remain authoritative. Bindings only prevent duplicate or contradictory defaults. */
export function filterPreferenceMemory(
  db: TransactionDatabase, entries: readonly MemoryEntryRecord[], workspaceId: string,
  query = '', contextKind?: PreferenceContextKind,
): MemoryEntryRecord[] {
  if (!entries.some(entry => entry.category === 'preference')) return [...entries];
  const scene = contextKind ?? classifyPreferenceContext({ objective: query });
  const retainManualPreference = (entry: MemoryEntryRecord) => entry.category !== 'preference' || matchesTaggedScene(entry, scene);
  // MF-3 remains independently usable against its original persistence schema.
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='preference_confirmations'").get()) {
    return entries.filter(retainManualPreference);
  }
  const bindings = db.prepare(`SELECT entry_id,entry_workspace_id,dimension,context_kind,preferred_value,scope,status,entry_version
    FROM preference_confirmations WHERE entry_id IS NOT NULL AND profile_id = 'default'`).all() as Binding[];
  const byEntry = new Map(bindings.map(row => [row.entry_id, row]));
  const eligible = entries.filter(entry => {
    const binding = byEntry.get(entry.id);
    if (!binding) return retainManualPreference(entry);
    if (isPreservedManualEntry(entry, binding)) return matchesTaggedScene(entry, scene);
    return entry.category === 'preference' && entry.authority === 'user-explicit' && entry.status === 'active'
      && binding.status === 'confirmed' && entry.workspaceId === binding.entry_workspace_id
      && binding.entry_version !== null && entry.scope === binding.scope && entry.version >= binding.entry_version
      && (binding.scope === 'global' || entry.workspaceId === workspaceId)
      && (binding.context_kind === 'general' || binding.context_kind === scene)
      && entry.tags.includes(`dimension:${binding.dimension}`)
      && entry.tags.includes(`context:${binding.context_kind}`)
      && entry.tags.includes(`value:${binding.preferred_value}`);
  });
  const winners = new Map<string, { id: string; priority: number }>();
  for (const entry of eligible) {
    const binding = byEntry.get(entry.id);
    if (!binding || binding.status !== 'confirmed') continue;
    // Scope is the first precedence tier: a workspace general preference beats
    // a global scene-specific one. Scene specificity breaks ties within a scope.
    const priority = (entry.scope === 'workspace' ? 2 : 0) + (binding.context_kind === scene ? 1 : 0);
    const current = winners.get(binding.dimension);
    if (!current || priority > current.priority || (priority === current.priority && entry.id < current.id)) {
      winners.set(binding.dimension, { id: entry.id, priority });
    }
  }
  return eligible.filter(entry => {
    const binding = byEntry.get(entry.id);
    return !binding || binding.status !== 'confirmed' || winners.get(binding.dimension)?.id === entry.id;
  });
}
