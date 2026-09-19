export interface MentionAgent {
  readonly id: string;
  readonly name: string;
  readonly enabled?: boolean;
}

interface MentionPickerProps {
  agents: readonly MentionAgent[];
  selectedAgentIds: string[];
  disabled?: boolean;
  onChange(agentIds: string[]): void;
}

export function MentionPicker({ agents, selectedAgentIds, disabled = false, onChange }: MentionPickerProps) {
  const selected = new Set(selectedAgentIds);
  const enabledAgents = agents.filter(agent => agent.enabled !== false);
  const allSelected = enabledAgents.length > 0 && enabledAgents.every(agent => selected.has(agent.id));
  const toggle = (agentId: string) => {
    const next = new Set(selected);
    if (next.has(agentId)) next.delete(agentId); else next.add(agentId);
    onChange([...next]);
  };
  return <div className="mention-picker-bar mx-auto mb-2 flex w-full max-w-4xl flex-wrap items-center gap-1.5" aria-label="选择 @Agent"><button type="button" disabled={disabled || enabledAgents.length === 0} aria-label="@all" aria-pressed={allSelected} onClick={() => onChange(allSelected ? [] : enabledAgents.map(agent => agent.id))} className={`rounded-lg border px-2 py-1 text-[11px] transition ${allSelected ? 'border-[var(--app-accent)] bg-[var(--app-accent-soft)] ui-accent' : 'ui-border ui-muted hover:border-[var(--app-accent)]'}`}>@all</button>{enabledAgents.map(agent => <button key={agent.id} type="button" disabled={disabled} aria-pressed={selected.has(agent.id)} onClick={() => toggle(agent.id)} className={`rounded-lg border px-2 py-1 text-[11px] transition ${selected.has(agent.id) ? 'border-[var(--app-accent)] bg-[var(--app-accent-soft)] ui-accent' : 'ui-border ui-muted hover:border-[var(--app-accent)]'}`}>@{agent.name}</button>)}</div>;
}
