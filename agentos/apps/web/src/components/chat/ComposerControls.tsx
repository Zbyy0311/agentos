import { useEffect, useRef, useState } from 'react';
import type { AgentModelOption, ModelDiscoverySource, ThinkingEffort } from '@agentos/shared';

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
}

const effortLabels: Record<ThinkingEffort, string> = {
  auto: '自动',
  low: '低',
  medium: '中',
  high: '高',
};

const sourceLabels: Record<ModelDiscoverySource, string> = {
  live: '实时发现',
  cache: '本地缓存',
  config: 'CLI 配置',
  fallback: '默认能力',
};

interface PickerOption {
  value: string;
  label: string;
  detail?: string;
}

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
    <button type="button" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} disabled={disabled || options.length === 0} onClick={() => setOpen(current => !current)} className="flex max-w-full items-center gap-1.5 rounded-lg border border-transparent bg-slate-900/50 px-2.5 py-1.5 text-left text-xs text-slate-300 transition hover:border-slate-700/80 hover:bg-slate-800/80 hover:text-slate-100 focus-visible:border-blue-400 focus-visible:outline-none disabled:cursor-not-allowed disabled:text-slate-600">
      <span className="shrink-0 text-[11px] text-slate-500">{label}</span>
      <span className={`truncate font-medium text-slate-200 ${widthClass}`}>{displayValue}</span>
      <span className={`shrink-0 text-[11px] text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`}>⌄</span>
    </button>
    {open && <div role="listbox" aria-label={ariaLabel} className={`absolute bottom-full right-0 z-50 mb-2 overflow-hidden rounded-xl border border-slate-700/90 bg-[#151d28]/[.98] p-1.5 shadow-2xl shadow-black/40 backdrop-blur-xl ${widthClass === 'max-w-[13rem]' ? 'w-[min(22rem,calc(100vw-2rem))]' : 'w-32'}`}>
      <div className="mb-1 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-slate-600">{label}</div>
      <div className="max-h-64 overflow-y-auto">
        {options.map(option => {
          const selected = option.value === value;
          return <button type="button" role="option" aria-selected={selected} key={option.value} onClick={() => { onChange(option.value); setOpen(false); }} className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition ${selected ? 'bg-blue-500/15 text-blue-100' : 'text-slate-300 hover:bg-white/[0.06] hover:text-slate-100'}`}>
            <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border text-[10px] ${selected ? 'border-blue-400 bg-blue-500 text-white' : 'border-slate-700 text-transparent'}`}>✓</span>
            <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{option.label}</span>{option.detail && <span className="mt-0.5 block truncate text-[10px] text-slate-500">{option.detail}</span>}</span>
          </button>;
        })}
      </div>
    </div>}
  </div>;
}

export function ComposerControls({ isGroup, modelOptions, model, thinkingEffort, thinkingEfforts, modelSource, disabled, onModelChange, onThinkingEffortChange }: ComposerControlsProps) {
  if (isGroup) {
    return <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/30 px-3 py-1.5 text-xs text-slate-500" title="群聊由每个成员自己的 Agent 配置执行">
      <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />
      <span>按成员配置</span>
    </div>;
  }

  const selectedModel = modelOptions.find(option => option.id === model);
  const modelPickerOptions: PickerOption[] = [
    { value: '', label: '默认模型', detail: '使用当前 Agent 默认值' },
    ...modelOptions.map(option => ({ value: option.id, label: option.label, detail: option.label !== option.id ? option.id : undefined })),
  ];

  return <div className="flex min-w-0 items-center gap-1.5">
    <Picker label="模型" ariaLabel="选择模型" value={model ?? ''} displayValue={selectedModel?.label ?? '默认模型'} options={modelPickerOptions} disabled={disabled} widthClass="max-w-[13rem]" onChange={value => onModelChange(value || undefined)} />
    <Picker label="思考" ariaLabel="选择思考强度" value={thinkingEffort} displayValue={effortLabels[thinkingEffort]} options={thinkingEfforts.map(effort => ({ value: effort, label: effortLabels[effort], detail: effort === 'auto' ? '跟随模型自动决定' : `思考强度：${effortLabels[effort]}` }))} disabled={disabled} widthClass="max-w-[4rem]" onChange={value => onThinkingEffortChange(value as ThinkingEffort)} />
    {modelSource && <span className="hidden text-[10px] text-slate-600 xl:inline" title={`模型来源：${sourceLabels[modelSource]}`}>{sourceLabels[modelSource]}</span>}
  </div>;
}
