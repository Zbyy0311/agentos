import { useEffect, useRef, useState } from 'react';

export interface SelectFieldOption {
  value: string;
  label: string;
  detail?: string;
}

interface SelectFieldProps {
  value: string;
  options: SelectFieldOption[];
  onChange(value: string): void;
  ariaLabel: string;
  disabled?: boolean;
  /** sm: compact row control; md: full-size form field. */
  size?: 'sm' | 'md';
}

/**
 * Form-context dropdown that matches the app's custom listbox style
 * (same visual language as the composer Picker) instead of the native
 * OS-rendered <select> popup. Opens downward; the parent scrolls if needed.
 */
export function SelectField({ value, options, onChange, ariaLabel, disabled = false, size = 'md' }: SelectFieldProps) {
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

  const selected = options.find(option => option.value === value);
  return <div ref={rootRef} className="relative min-w-0">
    <button type="button" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => setOpen(current => !current)} className={`flex w-full items-center justify-between gap-2 border bg-transparent text-left outline-none transition focus-visible:border-[var(--app-accent)] disabled:cursor-not-allowed disabled:opacity-50 ${size === 'md' ? 'rounded-xl ui-border px-3 py-2.5 text-sm ui-text' : 'rounded-lg ui-border px-2 py-1 text-xs ui-text'}`}>
      <span className="min-w-0 flex-1 truncate">{selected?.label ?? value}</span>
      <span aria-hidden="true" className={`shrink-0 ui-dim transition-transform ${open ? 'rotate-180' : ''} ${size === 'md' ? 'text-xs' : 'text-[11px]'}`}>⌄</span>
    </button>
    {open && <div role="listbox" aria-label={ariaLabel} className="ui-panel-raised absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-y-auto rounded-xl border p-1.5 shadow-[var(--app-shadow)]">
      {options.map(option => {
        const isSelected = option.value === value;
        return <button type="button" role="option" aria-selected={isSelected} key={option.value} onClick={() => { onChange(option.value); setOpen(false); }} className={`ui-button-ghost flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left ${isSelected ? 'ui-selected' : ''}`}>
          <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border text-[10px] ${isSelected ? 'border-[var(--app-accent)] bg-[var(--app-accent)] text-white' : 'ui-border text-transparent'}`}>✓</span>
          <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium ui-text">{option.label}</span>{option.detail && <span className="mt-0.5 block truncate text-[10px] ui-dim">{option.detail}</span>}</span>
        </button>;
      })}
    </div>}
  </div>;
}
