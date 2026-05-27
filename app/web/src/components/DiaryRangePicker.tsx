// app/web/src/components/DiaryRangePicker.tsx
//
// Kid-friendly, right-aligned time-range dropdown for the Diary.
//
// Design:
//   - A pill-shaped trigger button showing the current preset's emoji + label.
//   - Clicking opens a floating listbox (role="listbox") anchored below-right.
//   - Each option is a large tap target (≥ 64px) with an emoji + label.
//   - "Custom range…" reveals two native datetime-local pickers below the list.
//   - Keyboard: Enter/Space opens; Arrow keys navigate options; Enter/Space
//     selects; Escape closes.
//   - Focus is managed: listbox captures focus on open, returns to trigger on close.
//   - Click-outside and Escape both close the popover.
//   - Styled with CSS variables from the theme system; Fredoka font.

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useId,
  KeyboardEvent,
} from 'react';
import { ChevronDown } from 'lucide-react';
import {
  type DiaryPreset,
  type DiaryRange,
  type DiaryRangeState,
  PRESET_OPTIONS,
  epochToLocalDatetimeInput,
  localDatetimeInputToEpoch,
} from '../lib/diaryRange';

export interface DiaryRangePickerProps {
  value: DiaryRangeState;
  onChange: (next: DiaryRangeState) => void;
}

export function DiaryRangePicker({
  value,
  onChange,
}: DiaryRangePickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState<number>(0);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const listboxId = useId();
  const triggerId = useId();

  const foundPreset = PRESET_OPTIONS.find((p) => p.id === value.preset);
  const currentPreset = foundPreset ?? { id: 'last24h' as const, label: 'Last 24 hours', emoji: '⏰' };

  // Close on click-outside
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: PointerEvent): void {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [open]);

  // When the listbox opens, focus the currently selected option.
  useEffect(() => {
    if (!open) return;
    const idx = PRESET_OPTIONS.findIndex((p) => p.id === value.preset);
    setFocusedIndex(idx >= 0 ? idx : 0);
    // Defer so the list is in the DOM before we focus it.
    requestAnimationFrame(() => {
      const items = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]');
      items?.[idx >= 0 ? idx : 0]?.focus();
    });
  }, [open, value.preset]);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  function selectPreset(preset: DiaryPreset): void {
    if (preset !== 'custom') {
      onChange({ preset, custom: null });
      close();
    } else {
      // Stay open so the user can fill in the custom pickers.
      onChange({ preset: 'custom', custom: value.custom });
      setOpen(true);
    }
  }

  function handleTriggerKeyDown(e: KeyboardEvent<HTMLButtonElement>): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen((prev) => !prev);
    }
    if (e.key === 'Escape') close();
  }

  function handleOptionKeyDown(
    e: KeyboardEvent<HTMLLIElement>,
    idx: number,
    preset: DiaryPreset,
  ): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.min(idx + 1, PRESET_OPTIONS.length - 1);
      setFocusedIndex(next);
      const items = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]');
      items?.[next]?.focus();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = Math.max(idx - 1, 0);
      setFocusedIndex(prev);
      const items = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]');
      items?.[prev]?.focus();
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      selectPreset(preset);
    }
  }

  // Custom range date picker handlers
  function handleCustomFrom(raw: string): void {
    const from = localDatetimeInputToEpoch(raw);
    if (from === null) return;
    const to = value.custom?.to ?? Date.now();
    onChange({ preset: 'custom', custom: { from, to } });
  }

  function handleCustomTo(raw: string): void {
    const to = localDatetimeInputToEpoch(raw);
    if (to === null) return;
    const from = value.custom?.from ?? Date.now() - 24 * 60 * 60 * 1000;
    onChange({ preset: 'custom', custom: { from, to } });
  }

  const now = Date.now();
  const defaultFrom = epochToLocalDatetimeInput(
    value.custom?.from ?? now - 24 * 60 * 60 * 1000,
  );
  const defaultTo = epochToLocalDatetimeInput(value.custom?.to ?? now);

  return (
    <div
      ref={popoverRef}
      style={{ position: 'relative', display: 'inline-block' }}
    >
      {/* Trigger */}
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={`Diary time range: ${currentPreset.label}`}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={handleTriggerKeyDown}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          minHeight: 44,
          padding: '8px 16px',
          borderRadius: 999,
          background: open
            ? 'color-mix(in srgb, var(--accent) 16%, var(--surface))'
            : 'var(--surface)',
          color: 'var(--text)',
          border: `1.5px solid ${open ? 'var(--accent)' : 'var(--border)'}`,
          boxShadow: open
            ? '0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent)'
            : 'none',
          fontFamily: "'Fredoka', sans-serif",
          fontWeight: 600,
          fontSize: 16,
          cursor: 'pointer',
          transition: 'background 120ms ease, border-color 120ms ease, box-shadow 120ms ease',
          whiteSpace: 'nowrap',
        }}
      >
        <span aria-hidden style={{ fontSize: 18, lineHeight: 1 }}>
          {currentPreset.emoji}
        </span>
        <span>{currentPreset.label}</span>
        <ChevronDown
          aria-hidden
          size={16}
          style={{
            opacity: 0.7,
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 150ms ease',
          }}
        />
      </button>

      {/* Popover */}
      {open && (
        <div
          role="presentation"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            zIndex: 50,
            minWidth: 220,
            background: 'var(--surface)',
            border: '1.5px solid var(--border)',
            borderRadius: 16,
            boxShadow: '0 12px 32px rgba(0, 0, 0, 0.14)',
            overflow: 'hidden',
          }}
        >
          <ul
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-labelledby={triggerId}
            aria-activedescendant={`${listboxId}-opt-${focusedIndex}`}
            style={{
              listStyle: 'none',
              margin: 0,
              padding: '6px 0',
            }}
          >
            {PRESET_OPTIONS.map((option, idx) => {
              const isSelected = value.preset === option.id;
              return (
                <li
                  key={option.id}
                  id={`${listboxId}-opt-${idx}`}
                  role="option"
                  aria-selected={isSelected}
                  tabIndex={-1}
                  onClick={() => selectPreset(option.id)}
                  onKeyDown={(e) => handleOptionKeyDown(e, idx, option.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    minHeight: 64,
                    padding: '10px 20px',
                    fontFamily: "'Fredoka', sans-serif",
                    fontWeight: isSelected ? 600 : 500,
                    fontSize: 17,
                    cursor: 'pointer',
                    background: isSelected
                      ? 'color-mix(in srgb, var(--accent) 14%, var(--surface))'
                      : 'transparent',
                    color: isSelected ? 'var(--accent)' : 'var(--text)',
                    borderLeft: isSelected
                      ? '3px solid var(--accent)'
                      : '3px solid transparent',
                    outline: 'none',
                    transition: 'background 80ms ease',
                  }}
                  onMouseEnter={(e) =>
                    Object.assign(
                      (e.currentTarget as HTMLElement).style,
                      isSelected
                        ? {}
                        : { background: 'color-mix(in srgb, var(--accent) 8%, var(--surface))' },
                    )
                  }
                  onMouseLeave={(e) =>
                    Object.assign(
                      (e.currentTarget as HTMLElement).style,
                      isSelected
                        ? { background: 'color-mix(in srgb, var(--accent) 14%, var(--surface))' }
                        : { background: 'transparent' },
                    )
                  }
                  onFocus={(e) =>
                    Object.assign(
                      (e.currentTarget as HTMLElement).style,
                      { background: 'color-mix(in srgb, var(--accent) 10%, var(--surface))' },
                    )
                  }
                  onBlur={(e) =>
                    Object.assign(
                      (e.currentTarget as HTMLElement).style,
                      isSelected
                        ? { background: 'color-mix(in srgb, var(--accent) 14%, var(--surface))' }
                        : { background: 'transparent' },
                    )
                  }
                >
                  <span aria-hidden style={{ fontSize: 20, lineHeight: 1, width: 24, textAlign: 'center' }}>
                    {option.emoji}
                  </span>
                  <span>{option.label}</span>
                  {isSelected && (
                    <span aria-hidden style={{ marginLeft: 'auto', color: 'var(--accent)', fontSize: 16 }}>
                      ✓
                    </span>
                  )}
                </li>
              );
            })}
          </ul>

          {/* Custom range inputs — only visible when custom is selected */}
          {value.preset === 'custom' && (
            <div
              style={{
                padding: '12px 20px 16px',
                borderTop: '1px solid var(--border)',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <label
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  fontFamily: "'Fredoka', sans-serif",
                  fontWeight: 600,
                  fontSize: 14,
                  color: 'var(--text-muted)',
                }}
              >
                From
                <input
                  type="datetime-local"
                  className="hc-input"
                  defaultValue={defaultFrom}
                  max={defaultTo}
                  onChange={(e) => handleCustomFrom(e.target.value)}
                  style={{ minHeight: 48, fontSize: 15 }}
                  aria-label="Custom range start date and time"
                />
              </label>
              <label
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  fontFamily: "'Fredoka', sans-serif",
                  fontWeight: 600,
                  fontSize: 14,
                  color: 'var(--text-muted)',
                }}
              >
                To
                <input
                  type="datetime-local"
                  className="hc-input"
                  defaultValue={defaultTo}
                  min={defaultFrom}
                  onChange={(e) => handleCustomTo(e.target.value)}
                  style={{ minHeight: 48, fontSize: 15 }}
                  aria-label="Custom range end date and time"
                />
              </label>
              <button
                type="button"
                className="hc-btn hc-btn-primary"
                style={{ minHeight: 52, fontSize: 17, marginTop: 4 }}
                onClick={close}
                disabled={value.custom === null}
              >
                Apply range
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
