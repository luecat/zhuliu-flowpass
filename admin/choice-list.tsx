import { useEffect, useId, useMemo, useRef, useState } from 'react';

export type ChoiceListOption = {
  value: string;
  label: string;
  hint?: string;
};

export function ChoiceList({
  label,
  options,
  value,
  onChange,
  disabled = false,
  required = false,
  emptyLabel = '請選擇',
  searchable = false,
  searchPlaceholder = '輸入名稱搜尋，或直接點選',
}: {
  label: string;
  options: ChoiceListOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  emptyLabel?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
}) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = options.find((option) => option.value === value);

  const filtered = useMemo(() => {
    const normalized = query.normalize('NFKC').trim().toLocaleLowerCase();
    if (!searchable || !normalized) return options;
    return options.filter((option) => {
      const haystack = `${option.label} ${option.hint ?? ''} ${option.value}`;
      return haystack.normalize('NFKC').toLocaleLowerCase().includes(normalized);
    });
  }, [options, query, searchable]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className={`choice-list${disabled ? ' is-disabled' : ''}`} ref={rootRef}>
      <span className="choice-list-label" id={`${listId}-label`}>{label}</span>
      {searchable ? (
        <div className="choice-list-combobox">
          <input
            className="choice-list-search"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-labelledby={`${listId}-label`}
            placeholder={selected ? `${selected.label}${selected.hint ? ` · ${selected.hint}` : ''}` : searchPlaceholder}
            value={open ? query : (selected ? `${selected.label}${selected.hint ? ` · ${selected.hint}` : ''}` : '')}
            disabled={disabled}
            onChange={(event) => {
              setQuery(event.target.value);
              if (!open) setOpen(true);
            }}
            onFocus={() => {
              setOpen(true);
              setQuery('');
            }}
          />
          <button type="button" className="choice-list-chevron" aria-label="開啟選單" disabled={disabled} onClick={() => setOpen((current) => !current)}>▾</button>
        </div>
      ) : (
        <button
          type="button"
          className="choice-list-trigger"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          aria-labelledby={`${listId}-label`}
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
        >
          {selected ? (
            <>
              <span className="choice-list-option-label">{selected.label}</span>
              {selected.hint ? <small className="choice-list-option-hint">{selected.hint}</small> : null}
            </>
          ) : emptyLabel}
        </button>
      )}
      {required && <input className="choice-list-required" tabIndex={-1} value={value} required onChange={() => undefined} aria-hidden="true" />}
      {open && (
        <ul id={listId} className="choice-list-menu" role="listbox" aria-labelledby={`${listId}-label`}>
          {filtered.length === 0 ? (
            <li className="choice-list-empty" role="presentation">沒有相符的選項</li>
          ) : filtered.map((option) => (
            <li key={option.value} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={option.value === value ? 'is-selected' : undefined}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                  setQuery('');
                }}
              >
                <span className="choice-list-option-label">{option.label}</span>
                {option.hint ? <small className="choice-list-option-hint">{option.hint}</small> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
