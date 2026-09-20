import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { AdminRequest } from './api';
import { ChoiceList } from './choice-list';

type Cycle = { id: string; code: string; name: string; year: number; status: string };
type AgeEligibility = { minAge?: number; maxAge?: number; birthDateFrom?: string; birthDateTo?: string };
type Settings = { softwareBlacklist: string[]; ageEligibility: AgeEligibility };
type SettingsResponse = { ruleVersionId: string; versionNo: number; publishedAt: string | null; settings: Settings };

/** Save rejections name the offending field; anything else falls back to the generic copy. */
const SAVE_ERRORS: Record<string, string> = {
  age_range_inverted: '最小年齡不可大於最大年齡。',
  birth_date_range_inverted: '出生起日不可晚於出生迄日。',
  blacklist_entry_too_long: '黑名單單筆名稱過長（上限 200 字）。',
  invalid_shape: '設定格式不正確，請確認年齡為整數、出生日期為實際存在的日期。',
};

function toLines(entries: readonly string[]): string {
  return entries.join('\n');
}

/** One entry per line, matching how an admin pastes a denylist out of a notice. */
function toEntries(value: string): string[] {
  return value.split('\n').map((entry) => entry.trim()).filter(Boolean);
}

function ageValue(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

function parseAge(value: string): number | undefined | null {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return parsed >= 0 && parsed <= 150 ? parsed : null;
}

export function ProgramSettings({ request, onBack }: { request: AdminRequest; onBack: () => void }) {
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [cycleId, setCycleId] = useState('');
  const [current, setCurrent] = useState<SettingsResponse | null>(null);
  const [blacklist, setBlacklist] = useState('');
  const [minAge, setMinAge] = useState('');
  const [maxAge, setMaxAge] = useState('');
  const [birthDateFrom, setBirthDateFrom] = useState('');
  const [birthDateTo, setBirthDateTo] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const applySettings = useCallback((response: SettingsResponse) => {
    setCurrent(response);
    setBlacklist(toLines(response.settings.softwareBlacklist));
    setMinAge(ageValue(response.settings.ageEligibility.minAge));
    setMaxAge(ageValue(response.settings.ageEligibility.maxAge));
    setBirthDateFrom(response.settings.ageEligibility.birthDateFrom ?? '');
    setBirthDateTo(response.settings.ageEligibility.birthDateTo ?? '');
  }, []);

  const loadCycles = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const data = await request<{ cycles: Cycle[] }>('/admin/v1/program-cycles');
      // Only an active cycle is configurable: a save publishes a new rule version,
      // which is meaningless for a closed cycle and would surface retired or
      // demo programmes in the picker.
      const next = (data.cycles ?? []).filter((cycle) => cycle.status === 'active');
      setCycles(next);
      setCycleId((previous) => previous || next[0]?.id || '');
      if (!next.length) setError('目前沒有進行中的方案年度可設定。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '方案清單無法載入。');
    } finally {
      setLoading(false);
    }
  }, [request]);

  const loadSettings = useCallback(async (id: string) => {
    setLoading(true); setError(''); setNotice('');
    try {
      applySettings(await request<SettingsResponse>(`/admin/v1/program-cycles/${encodeURIComponent(id)}/settings`));
    } catch (cause) {
      setCurrent(null);
      setError(cause instanceof Error ? cause.message : '方案設定無法載入。');
    } finally {
      setLoading(false);
    }
  }, [applySettings, request]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount pattern; setState only runs after the awaited request settles.
  useEffect(() => { void loadCycles(); }, [loadCycles]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- refetch when the selected cycle changes; setState only runs after the awaited request settles.
  useEffect(() => { if (cycleId) void loadSettings(cycleId); }, [cycleId, loadSettings]);

  const options = useMemo(
    () => cycles.map((cycle) => ({ value: cycle.id, label: `${cycle.year} ${cycle.name}`, hint: cycle.code })),
    [cycles],
  );

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!cycleId || saving) return;
    const min = parseAge(minAge); const max = parseAge(maxAge);
    if (min === null || max === null) { setError('年齡請填 0 至 150 的整數，或留空表示不限。'); return; }
    const ageEligibility: AgeEligibility = {
      ...(min === undefined ? {} : { minAge: min }),
      ...(max === undefined ? {} : { maxAge: max }),
      ...(birthDateFrom ? { birthDateFrom } : {}),
      ...(birthDateTo ? { birthDateTo } : {}),
    };
    setSaving(true); setError(''); setNotice('');
    try {
      const response = await request<SettingsResponse>(`/admin/v1/program-cycles/${encodeURIComponent(cycleId)}/settings`, {
        method: 'PUT',
        body: JSON.stringify({ softwareBlacklist: toEntries(blacklist), ageEligibility }),
      });
      applySettings(response);
      setNotice(`設定已儲存，並發布為規則版本 v${response.versionNo}。既有案件仍沿用送件當下的版本。`);
    } catch (cause) {
      const code = (cause as { message?: string }).message ?? '';
      setError(SAVE_ERRORS[code] ?? (cause instanceof Error ? cause.message : '設定儲存失敗。'));
    } finally {
      setSaving(false);
    }
  };

  return <section className="work">
    <header className="work-head">
      <div>
        <button className="data-back" onClick={onBack}>← 返回案件總覽</button>
        <p className="eyebrow">方案規則</p>
        <h1>審核設定</h1>
        <p>設定不予補助的軟體與廠商黑名單，以及本方案的年齡資格。儲存後會發布為新的規則版本，既有案件不受影響。</p>
      </div>
      <button className="secondary" onClick={() => { if (cycleId) void loadSettings(cycleId); }} disabled={loading || saving}>{loading ? '更新中…' : '重新整理'}</button>
    </header>

    {error && <div className="alert" role="alert">{error}</div>}
    {notice && <div className="toast" role="status">{notice}</div>}

    {options.length > 1 && <ChoiceList label="方案年度" options={options} value={cycleId} onChange={setCycleId} disabled={loading || saving} />}

    {loading && !current ? <div className="loading" role="status">正在載入方案設定…</div> : current && <form onSubmit={save}>
      <p className="field-hint">目前生效版本：v{current.versionNo}{current.publishedAt ? `（發布於 ${new Date(current.publishedAt).toLocaleString('zh-TW')}）` : ''}</p>

      <fieldset className="publisher-fieldset">
        <legend>軟體與廠商黑名單</legend>
        <p className="field-hint">一行一筆，軟體名稱或軟體公司名稱皆可。送件時命中任一筆即直接退件，不會進入人工審核。</p>
        <div className="field">
          <label htmlFor="software-blacklist">不予補助清單</label>
          <textarea id="software-blacklist" rows={8} value={blacklist} onChange={(event) => setBlacklist(event.target.value)} disabled={saving} placeholder={'例如：\nBlocked Vendor\n某某科技股份有限公司'} />
        </div>
        <p className="field-hint">目前 {toEntries(blacklist).length} 筆；留空表示不設黑名單。</p>
      </fieldset>

      <fieldset className="publisher-fieldset">
        <legend>年齡資格</legend>
        <p className="field-hint">兩種條件可同時使用，設定的條件都必須符合。留空代表不限。</p>
        <div className="incident-form-grid">
          <div className="field">
            <label htmlFor="min-age">最小年齡（送件時足歲）</label>
            <input id="min-age" inputMode="numeric" value={minAge} onChange={(event) => setMinAge(event.target.value)} disabled={saving} placeholder="不限" />
          </div>
          <div className="field">
            <label htmlFor="max-age">最大年齡（送件時足歲）</label>
            <input id="max-age" inputMode="numeric" value={maxAge} onChange={(event) => setMaxAge(event.target.value)} disabled={saving} placeholder="不限" />
          </div>
          <div className="field">
            <label htmlFor="birth-from">出生日期起（含當日）</label>
            <input id="birth-from" type="date" value={birthDateFrom} onChange={(event) => setBirthDateFrom(event.target.value)} disabled={saving} />
          </div>
          <div className="field">
            <label htmlFor="birth-to">出生日期迄（含當日）</label>
            <input id="birth-to" type="date" value={birthDateTo} onChange={(event) => setBirthDateTo(event.target.value)} disabled={saving} />
          </div>
        </div>
        <p className="field-hint">年齡以送件當下計算，會隨時間變動；出生日期區間則固定鎖住同一批出生年份。</p>
      </fieldset>

      <button className="primary" type="submit" disabled={saving || loading}>{saving ? '儲存中…' : '儲存並發布新版本'}</button>
    </form>}
  </section>;
}
