'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';

export type ChoiceListOption = {
  value: string;
  label: string;
  /** Optional secondary text (e.g. company). */
  hint?: string;
  /** Optional section heading when searchable menus are long. */
  group?: string;
};

type MenuRow =
  | { kind: 'group'; key: string; label: string }
  | { kind: 'option'; key: string; option: ChoiceListOption; optionIndex: number };

/**
 * Custom single-choice listbox with keyboard support. Avoids native <select>
 * chrome that LIFF / mobile browsers often replace inconsistently.
 *
 * When `searchable` is true, the trigger becomes a combobox: applicants can
 * browse the full list or type a few characters to filter matches.
 */
export function ChoiceList({
  label,
  options,
  value,
  onChange,
  disabled = false,
  required = false,
  otherValue = '',
  onOtherChange,
  otherPlaceholder = '請填寫名稱',
  emptyLabel = '請選擇',
  visuallyHiddenLabel = false,
  searchable = false,
  searchPlaceholder = '輸入名稱搜尋，或直接點選',
}: {
  label: string;
  options: ChoiceListOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  otherValue?: string;
  onOtherChange?: (value: string) => void;
  otherPlaceholder?: string;
  emptyLabel?: string;
  visuallyHiddenLabel?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
}) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [query, setQuery] = useState('');
  const selected = options.find((option) => option.value === value);
  const showOther = Boolean(onOtherChange) && (
    value === '__other__'
    || selected?.label.includes('其他')
    || selected?.label.toLowerCase().includes('other')
  );

  const filtered = useMemo(() => {
    const normalized = query.normalize('NFKC').trim().toLocaleLowerCase();
    if (!searchable || !normalized) return options;
    return options.filter((option) => {
      const haystack = `${option.label} ${option.hint ?? ''} ${option.group ?? ''} ${option.value}`;
      return haystack.normalize('NFKC').toLocaleLowerCase().includes(normalized);
    });
  }, [options, query, searchable]);

  const rows = useMemo(() => {
    const next: MenuRow[] = [];
    let lastGroup: string | undefined;
    filtered.forEach((option, optionIndex) => {
      if (option.group && option.group !== lastGroup) {
        lastGroup = option.group;
        next.push({ kind: 'group', key: `group-${option.group}`, label: option.group });
      }
      next.push({ kind: 'option', key: option.value, option, optionIndex });
    });
    return next;
  }, [filtered]);

  useEffect(() => {
    if (!open) return;
    const selectedIndex = Math.max(0, filtered.findIndex((option) => option.value === value));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs the highlighted row to open/filtered/value together; no single render-time comparison captures all three.
    setActiveIndex(selectedIndex);
  }, [open, filtered, value]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  function selectOption(option: ChoiceListOption) {
    onChange(option.value);
    setOpen(false);
    setQuery('');
    // Refocusing the search input would fire onFocus and reopen the menu (and raise the
    // phone keyboard), so searchable menus leave focus where it is.
    if (!searchable) triggerRef.current?.focus();
  }

  function selectIndex(index: number) {
    const option = filtered[index];
    if (!option) return;
    selectOption(option);
  }

  function moveActive(delta: number) {
    if (filtered.length === 0) return;
    setActiveIndex((current) => {
      const next = current + delta;
      if (next < 0) return filtered.length - 1;
      if (next >= filtered.length) return 0;
      return next;
    });
  }

  function onComboboxKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) setOpen(true);
      else moveActive(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) setOpen(true);
      else moveActive(-1);
      return;
    }
    if (event.key === 'Home' && open) {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === 'End' && open) {
      event.preventDefault();
      setActiveIndex(Math.max(0, filtered.length - 1));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      selectIndex(activeIndex);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      setQuery('');
    }
  }

  function onTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(true);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setOpen(true);
      setActiveIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setOpen(true);
      setActiveIndex(Math.max(0, options.length - 1));
    }
  }

  function onListKeyDown(event: React.KeyboardEvent<HTMLUListElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      setQuery('');
      if (searchable) inputRef.current?.focus();
      else triggerRef.current?.focus();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(Math.max(0, filtered.length - 1));
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectIndex(activeIndex);
    }
  }

  return (
    <div className={`choice-list${disabled ? ' is-disabled' : ''}${searchable ? ' is-searchable' : ''}`} ref={rootRef}>
      <span className={visuallyHiddenLabel ? 'sr-only' : 'choice-list-label'} id={`${listId}-label`}>{label}</span>
      {searchable ? (
        <div className="choice-list-combobox">
          <input
            ref={inputRef}
            id={listId}
            type="text"
            role="combobox"
            className="choice-list-search"
            disabled={disabled}
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={`${listId}-menu`}
            aria-labelledby={`${listId}-label`}
            aria-required={required}
            aria-activedescendant={open && filtered[activeIndex] ? `${listId}-option-${activeIndex}` : undefined}
            placeholder={selected ? undefined : searchPlaceholder}
            value={open ? query : (selected?.label ?? '')}
            autoComplete="off"
            onFocus={() => {
              setOpen(true);
              setQuery('');
            }}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
              setActiveIndex(0);
            }}
            onKeyDown={onComboboxKeyDown}
          />
          <button
            type="button"
            className="choice-list-chevron"
            tabIndex={-1}
            aria-label={open ? '收合選單' : '開啟選單'}
            disabled={disabled}
            onClick={() => {
              setOpen((current) => {
                const next = !current;
                if (next) {
                  setQuery('');
                  queueMicrotask(() => inputRef.current?.focus());
                }
                return next;
              });
            }}
          >
            <span aria-hidden="true">{open ? '▴' : '▾'}</span>
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="choice-list-trigger"
          id={listId}
          ref={triggerRef}
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={`${listId}-menu`}
          aria-labelledby={`${listId}-label`}
          aria-required={required}
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
          onKeyDown={onTriggerKeyDown}
        >
          <span>{selected?.label ?? emptyLabel}</span>
          <span aria-hidden="true">{open ? '▴' : '▾'}</span>
        </button>
      )}
      {open && (
        <ul
          className="choice-list-menu"
          id={`${listId}-menu`}
          role="listbox"
          tabIndex={-1}
          aria-labelledby={`${listId}-label`}
          aria-activedescendant={filtered[activeIndex] ? `${listId}-option-${activeIndex}` : undefined}
          onKeyDown={onListKeyDown}
          ref={(node) => { if (!searchable) node?.focus(); }}
        >
          {filtered.length === 0 && (
            <li className="choice-list-empty" role="presentation">沒有相符的選項</li>
          )}
          {rows.map((row) => {
            if (row.kind === 'group') {
              return <li key={row.key} className="choice-list-group" role="presentation">{row.label}</li>;
            }
            const { option, optionIndex } = row;
            return (
              <li
                key={row.key}
                id={`${listId}-option-${optionIndex}`}
                role="option"
                aria-selected={option.value === value}
                className={optionIndex === activeIndex ? 'is-active' : undefined}
              >
                <button
                  type="button"
                  tabIndex={-1}
                  className={option.value === value ? 'is-selected' : undefined}
                  onMouseEnter={() => setActiveIndex(optionIndex)}
                  onClick={() => selectOption(option)}
                >
                  <span className="choice-list-option-label">{option.label}</span>
                  {option.hint ? <small className="choice-list-option-hint">{option.hint}</small> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {showOther && onOtherChange && (
        <label className="choice-list-other">
          <span className="sr-only">其他名稱</span>
          <input
            value={otherValue}
            maxLength={200}
            placeholder={otherPlaceholder}
            disabled={disabled}
            autoComplete="off"
            onChange={(event) => onOtherChange(event.target.value)}
          />
        </label>
      )}
    </div>
  );
}
