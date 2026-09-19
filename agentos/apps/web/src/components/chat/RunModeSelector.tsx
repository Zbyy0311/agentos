import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { RunIntent } from '@agentos/shared';

interface RunModeSelectorProps {
  value: RunIntent;
  disabled: boolean;
  onChange(value: RunIntent): void;
}

const modeOptions: ReadonlyArray<{
  readonly value: RunIntent;
  readonly label: string;
  readonly description: string;
}> = [
  { value: 'ask', label: '询问', description: '回答、解释或讨论，不主动执行外部操作' },
  { value: 'execute', label: '执行', description: '按当前权限执行已明确提出的操作' },
  { value: 'review', label: '审查', description: '分析方案、材料或结果，优先给出审查意见' },
];

const modeLabels: Record<RunIntent, string> = Object.fromEntries(
  modeOptions.map(option => [option.value, option.label]),
) as Record<RunIntent, string>;

export function RunModeSelector({ value, disabled, onChange }: RunModeSelectorProps) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ left: number; bottom: number; width: number }>();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedIndex = Math.max(0, modeOptions.findIndex(option => option.value === value));
  const selected = modeOptions[selectedIndex] ?? modeOptions[1];
  const menuId = useId();

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportPadding = 12;
    const width = Math.min(272, Math.max(0, window.innerWidth - viewportPadding * 2));
    const left = Math.min(
      Math.max(viewportPadding, rect.right - width),
      Math.max(viewportPadding, window.innerWidth - width - viewportPadding),
    );
    setMenuPosition({ left, bottom: Math.max(viewportPadding, window.innerHeight - rect.top + 8), width });
  }, []);

  useEffect(() => {
    if (!open) return;
    updateMenuPosition();
    const updateOnViewportChange = () => updateMenuPosition();
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', updateOnViewportChange);
    window.addEventListener('scroll', updateOnViewportChange, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', updateOnViewportChange);
      window.removeEventListener('scroll', updateOnViewportChange, true);
    };
  }, [open, updateMenuPosition]);

  useEffect(() => {
    if (open) optionRefs.current[selectedIndex]?.focus();
  }, [open, selectedIndex]);

  const selectMode = (next: RunIntent) => {
    onChange(next);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const moveOption = (index: number, offset: number) => {
    const nextIndex = (index + offset + modeOptions.length) % modeOptions.length;
    optionRefs.current[nextIndex]?.focus();
  };

  return <div ref={rootRef} className="relative flex min-w-0 items-center gap-1.5 text-xs">
    <span className="picker-label shrink-0 text-[11px] ui-dim">模式</span>
    <button
      ref={triggerRef}
      type="button"
      aria-label="运行模式"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={menuId}
      disabled={disabled}
      onClick={() => setOpen(current => !current)}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          setOpen(true);
        }
      }}
      className="run-mode-trigger ui-button-ghost inline-flex min-w-[4.5rem] items-center justify-between gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-surface-soft)] px-2.5 py-1.5 text-left text-xs ui-text transition hover:border-[var(--app-border-strong)] focus-visible:border-[var(--app-accent)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="font-medium">{modeLabels[selected.value]}</span>
      <span aria-hidden="true" className={`text-[11px] ui-dim transition-transform ${open ? 'rotate-180' : ''}`}>⌄</span>
    </button>
    {open && <div id={menuId} ref={menuRef} role="listbox" aria-label="运行模式选项" style={menuPosition ? { left: menuPosition.left, bottom: menuPosition.bottom, width: menuPosition.width } : undefined} className="run-mode-menu ui-panel-raised fixed z-50 rounded-xl border p-1.5 shadow-[var(--app-shadow)]" data-positioned={menuPosition ? 'true' : 'false'}>
      <div className="px-2.5 py-1.5">
        <div className="text-xs font-semibold ui-text">运行模式</div>
        <div className="mt-0.5 text-[10px] ui-dim">决定本次消息的处理边界</div>
      </div>
      <div className="space-y-0.5">
        {modeOptions.map((option, index) => {
          const isSelected = option.value === selected.value;
          return <button
            ref={element => { optionRefs.current[index] = element; }}
            key={option.value}
            type="button"
            role="option"
            aria-selected={isSelected}
            tabIndex={isSelected ? 0 : -1}
            onClick={() => selectMode(option.value)}
            onKeyDown={event => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                moveOption(index, event.key === 'ArrowDown' ? 1 : -1);
              } else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                selectMode(option.value);
              }
            }}
            className={`run-mode-option ui-button-ghost flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left ${isSelected ? 'ui-selected' : ''}`}
          >
            <span aria-hidden="true" className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border text-[10px] ${isSelected ? 'border-[var(--app-accent)] bg-[var(--app-accent)] text-white' : 'ui-border text-transparent'}`}>✓</span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-medium ui-text">{option.label}</span>
              <span className="mt-0.5 block text-[10px] leading-4 ui-dim">{option.description}</span>
            </span>
          </button>;
        })}
      </div>
    </div>}
  </div>;
}
