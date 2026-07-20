import type { AgentProfile } from '@agentos/shared';

interface MentionPickerProps {
  agents: AgentProfile[];
  selectedAgentIds: string[];
  disabled?: boolean;
  onChange(agentIds: string[]): void;
}

export function MentionPicker({ agents, selectedAgentIds, disabled = false, onChange }: MentionPickerProps) {
  const selected = new Set(selectedAgentIds);
  const toggle = (agentId: string) => {
    const next = new Set(selected);
    if (next.has(agentId)) next.delete(agentId); else next.add(agentId);
    onChange([...next]);
  };
  return <div className="mb-2 flex flex-wrap items-center gap-1.5" aria-label="选择 @Agent"><span className="text-xs ui-muted">@Agent</span>{agents.filter(agent => agent.enabled).map(agent => <button key={agent.id} type="button" disabled={disabled} aria-pressed={selected.has(agent.id)} onClick={() => toggle(agent.id)} className={`rounded-lg border px-2 py-1 text-[11px] transition ${selected.has(agent.id) ? 'border-[var(--app-accent)] bg-[var(--app-accent-soft)] ui-accent' : 'ui-border ui-muted hover:border-[var(--app-accent)]'}`}>@{agent.name}</button>)}</div>;
}
