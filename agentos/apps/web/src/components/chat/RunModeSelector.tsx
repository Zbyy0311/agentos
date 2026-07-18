import type { RunIntent } from '@agentos/shared';

interface RunModeSelectorProps {
  value: RunIntent;
  disabled: boolean;
  onChange(value: RunIntent): void;
}

const labels: Record<RunIntent, string> = { ask: '询问', execute: '执行', review: '审查' };

export function RunModeSelector({ value, disabled, onChange }: RunModeSelectorProps) {
  return <label className="flex items-center gap-1.5 text-xs ui-dim">
    <span>模式</span>
    <select aria-label="运行模式" value={value} disabled={disabled} onChange={event => onChange(event.target.value as RunIntent)} className="rounded-lg border ui-border bg-transparent px-2 py-1 text-xs ui-text">
      {(Object.keys(labels) as RunIntent[]).map(intent => <option key={intent} value={intent}>{labels[intent]}</option>)}
    </select>
  </label>;
}
