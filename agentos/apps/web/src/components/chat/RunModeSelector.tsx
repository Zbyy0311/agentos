import type { RunIntent } from '@agentos/shared';

interface RunModeSelectorProps {
  value: RunIntent;
  disabled: boolean;
  onChange(value: RunIntent): void;
}

const labels: Record<RunIntent, string> = { ask: '询问', execute: '执行', review: '审查' };

export function RunModeSelector({ value, disabled, onChange }: RunModeSelectorProps) {
  return <label className="ui-button-ghost flex items-center gap-1.5 rounded-lg border border-transparent px-2.5 py-1.5 text-xs">
    <span className="shrink-0 text-[11px] ui-dim">模式</span>
    <span className="relative flex items-center">
      <select aria-label="运行模式" value={value} disabled={disabled} onChange={event => onChange(event.target.value as RunIntent)} className="cursor-pointer appearance-none bg-transparent pr-3.5 font-medium ui-text focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50">
        {(Object.keys(labels) as RunIntent[]).map(intent => <option key={intent} value={intent}>{labels[intent]}</option>)}
      </select>
      <span aria-hidden="true" className="pointer-events-none absolute right-0 text-[11px] ui-dim">⌄</span>
    </span>
  </label>;
}
