import { useEffect, useRef, useState } from 'react';
import type { AgentModelOption, ModelDiscoverySource, RunIntent, ThinkingEffort } from '@agentos/shared';
import { RunModeSelector } from './RunModeSelector';

interface ComposerControlsProps {
  isGroup: boolean;
  modelOptions: AgentModelOption[];
  model?: string;
  thinkingEffort: ThinkingEffort;
  thinkingEfforts: ThinkingEffort[];
  modelSource?: ModelDiscoverySource;
  disabled: boolean;
  onModelChange(value: string | undefined): void;
  onThinkingEffortChange(value: ThinkingEffort): void;
  runIntent?: RunIntent;
  onRunIntentChange?(value: RunIntent): void;
}

const effortLabels: Record<ThinkingEffort, string> = { auto: '自动', low: '低', medium: '中', high: '高' };
const sourceLabels: Record<ModelDiscoverySource, string> = { live: '实时发现', cache: '本地缓存', config: 'CLI 配置', fallback: '默认能力' };

interface PickerOption { value: string; label: string; detail?: string; }

interface PickerProps {
  label: string;
  value: string;
  displayValue: string;
  options: PickerOption[];
  disabled: boolean;
  widthClass: string;
  ariaLabel: string;
  onChange(value: string): void;
}

function Picker({ label, value, displayValue, options, disabled, widthClass, ariaLabel, onChange }: PickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnKeyDown);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnKeyDown);
    };
  }, [open]);

  return <div ref={rootRef} className="relative min-w-0">
    <button type="button" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} disabled={disabled || options.length === 0} onClick={() => setOpen(current => !current)} className="ui-button-ghost flex max-w-full items-center gap-1.5 rounded-lg border border-transparent px-2.5 py-1.5 text-left text-xs focus-visible:border-[var(--app-accent)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50">
      <span className="shrink-0 text-[11px] ui-dim">{label}</span>
      <span className={`truncate font-medium ui-text ${widthClass}`}>{displayValue}</span>
      <span className={`shrink-0 text-[11px] ui-dim transition-transform ${open ? 'rotate-180' : ''}`}>⌄</span>
    </button>
    {open && <div role="listbox" aria-label={ariaLabel} className={`ui-panel-raised absolute bottom-full right-0 z-50 mb-2 overflow-hidden rounded-xl border p-1.5 shadow-[var(--app-shadow)] ${widthClass === 'max-w-[13rem]' ? 'w-[min(22rem,calc(100vw-2rem))]' : 'w-32'}`}>
      <div className="mb-1 px-2 py-1 text-[10px] font-medium tracking-[0.14em] ui-dim">{label}</div>
      <div className="max-h-64 overflow-y-auto">
        {options.map(option => {
          const selected = option.value === value;
          return <button type="button" role="option" aria-selected={selected} key={option.value} onClick={() => { onChange(option.value); setOpen(false); }} className={`ui-button-ghost flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left ${selected ? 'ui-selected' : ''}`}>
            <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border text-[10px] ${selected ? 'border-[var(--app-accent)] bg-[var(--app-accent)] text-white' : 'ui-border text-transparent'}`}>✓</span>
            <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium ui-text">{option.label}</span>{option.detail && <span className="mt-0.5 block truncate text-[10px] ui-dim">{option.detail}</span>}</span>
          </button>;
        })}
      </div>
    </div>}
  </div>;
}

interface EffortPickerProps { value: ThinkingEffort; efforts: ThinkingEffort[]; disabled: boolean; onChange(value: ThinkingEffort): void; }

function EffortPicker({ value, efforts, disabled, onChange }: EffortPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const currentIndex = Math.max(0, efforts.indexOf(value));
  const currentLabel = effortLabels[value] ?? value;

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnKeyDown);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnKeyDown);
    };
  }, [open]);

  return <div ref={rootRef} className="relative min-w-0">
    <button type="button" aria-label="选择思考强度" aria-haspopup="dialog" aria-expanded={open} disabled={disabled || efforts.length === 0} onClick={() => setOpen(current => !current)} className="ui-button-ghost flex max-w-full items-center gap-1.5 rounded-lg border border-transparent px-2.5 py-1.5 text-left text-xs focus-visible:border-[var(--app-accent)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50">
      <span className="shrink-0 text-[11px] ui-dim">思考</span><span className="font-medium ui-text">{currentLabel}</span><span className={`shrink-0 text-[11px] ui-dim transition-transform ${open ? 'rotate-180' : ''}`}>⌄</span>
    </button>
    {open && <div role="dialog" aria-label="思考强度设置" className="effort-popover ui-panel-raised absolute bottom-full right-0 z-50 mb-2 rounded-xl border p-3 shadow-[var(--app-shadow)]">
      <div className="flex items-center justify-between gap-3"><span className="text-sm font-semibold ui-text">思考强度 · {currentLabel}</span><span className="text-[10px] ui-dim">影响速度与深度</span></div>
      <div className="mt-3 flex items-center justify-between text-[11px] ui-muted"><span>更快</span><span>更深入</span></div>
      <div className="effort-slider mt-1">
        <div className="effort-slider-ticks" style={{ gridTemplateColumns: `repeat(${Math.max(efforts.length, 1)}, minmax(0, 1fr))` }} aria-hidden="true">{efforts.map(effort => <span key={effort} />)}</div>
        <input type="range" min={0} max={Math.max(efforts.length - 1, 0)} step={1} value={currentIndex} disabled={disabled || efforts.length < 2} aria-label={`思考强度，当前为${currentLabel}`} onChange={event => onChange(efforts[Number(event.target.value)] ?? efforts[0])} />
      </div>
      <div className="mt-2 grid gap-1 text-center text-[10px] ui-dim" style={{ gridTemplateColumns: `repeat(${Math.max(efforts.length, 1)}, minmax(0, 1fr))` }}>{efforts.map(effort => <span key={effort}>{effortLabels[effort]}</span>)}</div>
    </div>}
  </div>;
}

export function ComposerControls({ isGroup, modelOptions, model, thinkingEffort, thinkingEfforts, modelSource, disabled, onModelChange, onThinkingEffortChange, runIntent = 'execute', onRunIntentChange = () => undefined }: ComposerControlsProps) {
  if (isGroup) return <div className="ui-panel rounded-lg border px-3 py-1.5 text-xs ui-muted" title="群聊由每个成员自己的 Agent 配置执行"><span className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-[var(--app-accent)]" /><span>按成员配置</span></div>;

  const selectedModel = modelOptions.find(option => option.id === model);
  const modelPickerOptions: PickerOption[] = [{ value: '', label: '默认模型', detail: '使用当前 Agent 默认值' }, ...modelOptions.map(option => ({ value: option.id, label: option.label, detail: option.label !== option.id ? option.id : undefined }))];

  return <div className="flex min-w-0 items-center gap-1.5">
    <RunModeSelector value={runIntent} disabled={disabled} onChange={onRunIntentChange} />
    <Picker label="模型" ariaLabel="选择模型" value={model ?? ''} displayValue={selectedModel?.label ?? '默认模型'} options={modelPickerOptions} disabled={disabled} widthClass="max-w-[13rem]" onChange={value => onModelChange(value || undefined)} />
    <EffortPicker value={thinkingEffort} efforts={thinkingEfforts} disabled={disabled} onChange={onThinkingEffortChange} />
    {modelSource && <span className="hidden text-[10px] ui-dim xl:inline" title={`模型来源：${sourceLabels[modelSource]}`}>{sourceLabels[modelSource]}</span>}
  </div>;
}
