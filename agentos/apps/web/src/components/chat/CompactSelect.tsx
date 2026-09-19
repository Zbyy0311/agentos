'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';

export interface CompactSelectOption {
  readonly value: string;
  readonly label: string;
  readonly detail?: string;
}

interface CompactSelectProps {
  readonly label: string;
  readonly value: string;
  readonly options: readonly CompactSelectOption[];
  readonly disabled?: boolean;
  readonly ariaLabel?: string;
  readonly onChange?: (value: string) => void;
}

const VIEWPORT_PADDING = 12;
const MENU_GAP = 8;
const MENU_MAX_WIDTH = 360;

export function CompactSelect({ label, value, options, disabled = false, ariaLabel, onChange }: CompactSelectProps) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ left: number; width: number; top?: number; bottom?: number }>();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();
  const selectedIndex = Math.max(0, options.findIndex(option => option.value === value));
  const selected = options[selectedIndex] ?? options[0];

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const width = Math.min(
      MENU_MAX_WIDTH,
      Math.max(rect.width, 220),
      Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2),
    );
    const left = Math.min(
      Math.max(VIEWPORT_PADDING, rect.left),
      Math.max(VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING),
    );
    const menuHeight = menuRef.current?.getBoundingClientRect().height ?? 240;
    const spaceAbove = rect.top - VIEWPORT_PADDING - MENU_GAP;
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_PADDING - MENU_GAP;
    const opensAbove = spaceAbove >= menuHeight || spaceAbove > spaceBelow;

    if (opensAbove) {
      setMenuPosition({ left, width, bottom: Math.max(VIEWPORT_PADDING, window.innerHeight - rect.top + MENU_GAP) });
    } else {
      const top = Math.max(VIEWPORT_PADDING, Math.min(rect.bottom + MENU_GAP, window.innerHeight - menuHeight - VIEWPORT_PADDING));
      setMenuPosition({ left, width, top });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(updateMenuPosition);
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
      window.cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', updateOnViewportChange);
      window.removeEventListener('scroll', updateOnViewportChange, true);
    };
  }, [open, updateMenuPosition]);

  useEffect(() => {
    if (open) optionRefs.current[selectedIndex]?.focus();
  }, [open, selectedIndex]);

  const selectOption = (next: string) => {
    onChange?.(next);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const moveOption = (index: number, offset: number) => {
    if (options.length === 0) return;
    const nextIndex = (index + offset + options.length) % options.length;
    optionRefs.current[nextIndex]?.focus();
  };

  return <div ref={rootRef} className="relative min-w-0 w-full">
    <span className="block text-xs ui-muted">{label}</span>
    <button
      ref={triggerRef}
      type="button"
      aria-label={ariaLabel ?? label}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={menuId}
      disabled={disabled || options.length === 0}
      onClick={() => setOpen(current => !current)}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          setOpen(true);
        }
      }}
      className="compact-select-trigger ui-input mt-1 flex w-full min-w-0 items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs ui-text transition focus-visible:border-[var(--app-accent)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className="min-w-0 truncate font-medium">{selected?.label ?? value}</span>
      <span aria-hidden="true" className={`shrink-0 text-[11px] ui-dim transition-transform ${open ? 'rotate-180' : ''}`}>⌄</span>
    </button>
    {open && <div
      id={menuId}
      ref={menuRef}
      role="listbox"
      aria-label={`${label}选项`}
      style={menuPosition ? { left: menuPosition.left, width: menuPosition.width, top: menuPosition.top, bottom: menuPosition.bottom } : undefined}
      className="compact-select-menu ui-panel-raised fixed z-[60] w-[min(22rem,calc(100vw-1.5rem))] rounded-xl border p-1.5 shadow-[var(--app-shadow)]"
      data-positioned={menuPosition ? 'true' : 'false'}
    >
      <div className="px-2.5 py-1.5 text-[10px] font-medium tracking-[0.08em] ui-dim">选择{label}</div>
      <div className="max-h-[min(55vh,20rem)] overflow-y-auto">
        {options.map((option, index) => {
          const isSelected = option.value === value;
          return <button
            ref={element => { optionRefs.current[index] = element; }}
            key={option.value}
            type="button"
            role="option"
            aria-selected={isSelected}
            tabIndex={isSelected ? 0 : -1}
            onClick={() => selectOption(option.value)}
            onKeyDown={event => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                moveOption(index, event.key === 'ArrowDown' ? 1 : -1);
              } else if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault();
                const nextIndex = event.key === 'Home' ? 0 : options.length - 1;
                optionRefs.current[nextIndex]?.focus();
              } else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                selectOption(option.value);
              }
            }}
            className={`compact-select-option ui-button-ghost flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left ${isSelected ? 'ui-selected' : ''}`}
          >
            <span aria-hidden="true" className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border text-[10px] ${isSelected ? 'border-[var(--app-accent)] bg-[var(--app-accent)] text-white' : 'ui-border text-transparent'}`}>✓</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium ui-text">{option.label}</span>
              {option.detail && <span className="mt-0.5 block truncate text-[10px] ui-dim">{option.detail}</span>}
            </span>
          </button>;
        })}
      </div>
    </div>}
  </div>;
}
