import { useEffect, useRef, useState } from 'react';

export interface PickerOption { value: string; label: string; detail?: string; }

export interface PickerProps {
  label: string;
  value: string;
  displayValue: string;
  options: PickerOption[];
  disabled: boolean;
  widthClass: string;
  /** Dropdown menu width override; defaults derive from widthClass. */
  menuWidthClass?: string;
  ariaLabel: string;
  onChange(value: string): void;
}

export function Picker({ label, value, displayValue, options, disabled, widthClass, menuWidthClass, ariaLabel, onChange }: PickerProps) {
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
    {open && <div role="listbox" aria-label={ariaLabel} className={`ui-panel-raised absolute bottom-full right-0 z-50 mb-2 overflow-hidden rounded-xl border p-1.5 shadow-[var(--app-shadow)] ${menuWidthClass ?? (widthClass === 'max-w-[13rem]' ? 'w-[min(22rem,calc(100vw-2rem))]' : 'w-32')}`}>
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
