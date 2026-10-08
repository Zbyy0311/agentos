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
  const buttonClass = (pressed: boolean) => `ui-button-ghost min-w-0 max-w-full rounded-lg border border-transparent px-2.5 py-1.5 text-xs font-medium focus-visible:border-[var(--app-accent)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${pressed ? 'ui-selected' : 'ui-text'}`;

  return <div className="mention-picker-bar flex min-w-0 flex-1 flex-wrap items-center gap-1.5" role="group" aria-label="选择 @Agent">
    <button type="button" disabled={disabled || enabledAgents.length === 0} aria-label="@all" aria-pressed={allSelected} onClick={() => onChange(allSelected ? [] : enabledAgents.map(agent => agent.id))} className={buttonClass(allSelected)}>@all</button>
    {enabledAgents.map(agent => <button key={agent.id} type="button" disabled={disabled} aria-label={`@${agent.name}`} title={`@${agent.name}`} aria-pressed={selected.has(agent.id)} onClick={() => toggle(agent.id)} className={buttonClass(selected.has(agent.id))}>
      <span className="block truncate">@{agent.name}</span>
    </button>)}
  </div>;
}
