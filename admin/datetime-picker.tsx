import { useEffect, useId, useMemo, useRef, useState } from 'react';

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function parseLocal(value: string): Date | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function toLocalValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date: Date, count: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + count, 1);
}

function formatDisplay(value: string): string {
  const date = parseLocal(value);
  if (!date) return '選擇日期與時間';
  return new Intl.DateTimeFormat('zh-TW', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

export function DateTimePicker({
  id,
  label,
  value,
  onChange,
  required = false,
  disabled = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
}) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = parseLocal(value);
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => startOfMonth(selected ?? new Date()));
  const [hour, setHour] = useState(selected?.getHours() ?? 9);
  const [minute, setMinute] = useState(selected ? selected.getMinutes() - (selected.getMinutes() % 5) : 0);

  useEffect(() => {
    const next = parseLocal(value);
    if (!next) return;
    setMonth(startOfMonth(next));
    setHour(next.getHours());
    setMinute(next.getMinutes() - (next.getMinutes() % 5));
  }, [value]);

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

  const days = useMemo(() => {
    const first = startOfMonth(month);
    const offset = (first.getDay() + 6) % 7; // Monday-first
    const cells: Array<{ date: Date; inMonth: boolean }> = [];
    for (let index = 0; index < 42; index += 1) {
      const date = new Date(first.getFullYear(), first.getMonth(), index - offset + 1);
      cells.push({ date, inMonth: date.getMonth() === first.getMonth() });
    }
    return cells;
  }, [month]);

  function pickDay(date: Date) {
    const next = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute);
    onChange(toLocalValue(next));
  }

  function applyTime(nextHour: number, nextMinute: number) {
    setHour(nextHour);
    setMinute(nextMinute);
    const base = selected ?? new Date();
    onChange(toLocalValue(new Date(base.getFullYear(), base.getMonth(), base.getDate(), nextHour, nextMinute)));
  }

  return (
    <div className={`datetime-picker${disabled ? ' is-disabled' : ''}`} ref={rootRef}>
      <label id={`${id}-label`} htmlFor={id}>{label}</label>
      <button
        id={id}
        type="button"
        className="datetime-picker-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={listId}
        aria-labelledby={`${id}-label`}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="datetime-picker-value">{formatDisplay(value)}</span>
      </button>
      {required && <input className="datetime-picker-required" tabIndex={-1} value={value} required onChange={() => undefined} aria-hidden="true" />}
      {open && (
        <div id={listId} className="datetime-picker-panel" role="dialog" aria-label={label}>
          <div className="datetime-picker-month">
            <button type="button" onClick={() => setMonth((current) => addMonths(current, -1))} aria-label="上個月">‹</button>
            <strong>{month.getFullYear()} 年 {month.getMonth() + 1} 月</strong>
            <button type="button" onClick={() => setMonth((current) => addMonths(current, 1))} aria-label="下個月">›</button>
          </div>
          <div className="datetime-picker-weekdays" aria-hidden="true">
            {WEEKDAYS.map((day) => <span key={day}>{day}</span>)}
          </div>
          <div className="datetime-picker-grid">
            {days.map(({ date, inMonth }) => {
              const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
              const isSelected = Boolean(selected
                && selected.getFullYear() === date.getFullYear()
                && selected.getMonth() === date.getMonth()
                && selected.getDate() === date.getDate());
              return (
                <button
                  key={key}
                  type="button"
                  className={`datetime-picker-day${inMonth ? '' : ' is-outside'}${isSelected ? ' is-selected' : ''}`}
                  onClick={() => pickDay(date)}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>
          <div className="datetime-picker-time">
            <label>
              時
              <select value={hour} onChange={(event) => applyTime(Number(event.target.value), minute)}>
                {Array.from({ length: 24 }, (_, index) => <option value={index} key={index}>{pad(index)}</option>)}
              </select>
            </label>
            <label>
              分
              <select value={minute} onChange={(event) => applyTime(hour, Number(event.target.value))}>
                {Array.from({ length: 12 }, (_, index) => index * 5).map((value) => (
                  <option value={value} key={value}>{pad(value)}</option>
                ))}
              </select>
            </label>
            <button type="button" className="datetime-picker-done" onClick={() => setOpen(false)}>完成</button>
          </div>
        </div>
      )}
    </div>
  );
}
