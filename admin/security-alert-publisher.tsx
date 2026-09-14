import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ChoiceList } from './choice-list';
import { DateTimePicker } from './datetime-picker';

export type AdminRequest = <T>(url: string, init?: RequestInit) => Promise<T>;

type Tool = {
  id: string;
  vendor: string;
  canonicalName: string;
  status: 'active' | 'retired';
};

type IncidentCandidate = {
  matchId: string;
  caseId: string;
  passportVersionId: string;
  basis: string[];
};

type MatchDecision = 'possible' | 'confirmed_affected' | 'not_affected';
type PublisherStep = 'compose' | 'review' | 'done';

const BASIS_LABELS: Record<string, string> = {
  tool_name_match: '工具名稱相符',
  tool_and_version: '工具名稱與版本相符',
  tool_version_unknown: '工具相符，版本未知',
  usage_within_window: '使用時間落在影響區間',
  usage_date_unknown: '使用時間未知（未以時間排除）',
  tool_version: '工具版本相符',
  'tool version': '工具版本相符',
};

function toUtc(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function affectedVersions(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

function basisLabel(value: string): string {
  return BASIS_LABELS[value] ?? value;
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

export function SecurityAlertPublisher({ request, onBack }: { request: AdminRequest; onBack: () => void }) {
  const [tools, setTools] = useState<Tool[]>([]);
  const [loadingTools, setLoadingTools] = useState(true);
  const [toolProductId, setToolProductId] = useState('');
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState<'low' | 'medium' | 'high' | 'critical'>('high');
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceTitle, setSourceTitle] = useState('');
  const [sourcePublishedAt, setSourcePublishedAt] = useState('');
  const [incidentStartAt, setIncidentStartAt] = useState('');
  const [incidentEndAt, setIncidentEndAt] = useState('');
  const [versions, setVersions] = useState('');
  const [internalRationale, setInternalRationale] = useState('');
  const [publicGuidance, setPublicGuidance] = useState('');
  const [incidentId, setIncidentId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<IncidentCandidate[]>([]);
  const [decisions, setDecisions] = useState<Record<string, MatchDecision>>({});
  const [step, setStep] = useState<PublisherStep>('compose');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [publishedCount, setPublishedCount] = useState(0);
  const [notificationCount, setNotificationCount] = useState(0);

  const loadTools = useCallback(async () => {
    setLoadingTools(true);
    try {
      const result = await request<{ tools: Tool[] }>('/admin/v1/tools');
      const activeTools = result.tools.filter((tool) => tool.status === 'active');
      setTools(activeTools);
      setToolProductId((current) => current || activeTools[0]?.id || '');
    } catch {
      setError('工具清單暫時無法載入，請稍後再試。');
    } finally {
      setLoadingTools(false);
    }
  }, [request]);

  useEffect(() => { void loadTools(); }, [loadTools]);

  const counts = useMemo(() => {
    let notify = 0;
    let excluded = 0;
    let confirmedAffected = 0;
    for (const candidate of candidates) {
      const decision = decisions[candidate.matchId] ?? 'possible';
      if (decision === 'not_affected') excluded += 1;
      else {
        notify += 1;
        if (decision === 'confirmed_affected') confirmedAffected += 1;
      }
    }
    return {
      total: candidates.length,
      notify,
      excluded,
      confirmedAffected,
      possible: notify - confirmedAffected,
    };
  }, [candidates, decisions]);

  async function previewMatches(id: string) {
    const result = await request<{ candidates: IncidentCandidate[] }>(
      `/admin/v1/incidents/${encodeURIComponent(id)}/preview-matches`,
      { method: 'POST', body: '{}' },
    );
    setCandidates(result.candidates);
    setDecisions(Object.fromEntries(result.candidates.map((candidate) => [candidate.matchId, 'possible' as const])));
    setConfirmed(false);
  }

  async function createIncident(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const publishedAt = toUtc(sourcePublishedAt);
    if (!publishedAt) {
      setError('請填寫來源公告的發布時間。');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const created = await request<{ id: string }>('/admin/v1/incidents', {
        method: 'POST',
        body: JSON.stringify({
          toolProductId,
          title: title.trim(),
          severity,
          incidentStartAt: toUtc(incidentStartAt),
          incidentEndAt: toUtc(incidentEndAt),
          affectedCriteria: { affectedVersions: affectedVersions(versions) },
          sourceUrl: sourceUrl.trim(),
          sourceTitle: sourceTitle.trim(),
          sourcePublishedAt: publishedAt,
          internalRationale: internalRationale.trim(),
          recommendedActions: { publicGuidance: publicGuidance.trim() },
        }),
      });
      setIncidentId(created.id);
      await previewMatches(created.id);
      setStep('review');
      setNotice('事件草稿已建立。以下是系統預覽的相符案件，尚未通知申請人。');
    } catch {
      setError('事件無法建立或比對，請確認必填欄位與來源網址後再試。');
    } finally {
      setBusy(false);
    }
  }

  async function publishAlerts() {
    if (!incidentId || counts.notify === 0 || !publicGuidance.trim() || !confirmed) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{ alerts: Array<{ id: string }>; notificationJobIds: string[] }>(
        `/admin/v1/incidents/${encodeURIComponent(incidentId)}/confirm-alerts`,
        {
          method: 'POST',
          body: JSON.stringify({
            matches: candidates.map((candidate) => ({
              matchId: candidate.matchId,
              status: decisions[candidate.matchId] ?? 'possible',
              publicGuidance: publicGuidance.trim(),
            })),
          }),
        },
      );
      setPublishedCount(result.alerts.length);
      setNotificationCount(result.notificationJobIds.length);
      setConfirmed(false);
      setStep('done');
      setNotice(`已發布 ${result.alerts.length} 筆資安提醒，並排入 ${result.notificationJobIds.length} 則通知。`);
    } catch {
      setError('資安提醒尚未發布，請重新確認比對結果後再試。');
    } finally {
      setBusy(false);
    }
  }

  function resetComposer() {
    setIncidentId(null);
    setCandidates([]);
    setDecisions({});
    setConfirmed(false);
    setPublishedCount(0);
    setNotificationCount(0);
    setStep('compose');
    setNotice('');
    setError('');
  }

  return (
    <section className="work incident-publisher" aria-labelledby="incident-publisher-title">
      <header className="work-head">
        <div>
          <button type="button" className="data-back" onClick={onBack}>← 返回案件總覽</button>
          <p className="eyebrow">資安事件</p>
          <h1 id="incident-publisher-title">發布資安提醒</h1>
          <p>先建立事件並預覽相符案件，確認後才會通知申請人。預覽≠已通知。</p>
        </div>
      </header>

      <nav className="publisher-steps" aria-label="發布流程">
        <ol>
          <li className={step === 'compose' ? 'is-current' : 'is-done'}><span>1</span>建立事件</li>
          <li className={step === 'review' ? 'is-current' : step === 'done' ? 'is-done' : ''}><span>2</span>預覽與判定</li>
          <li className={step === 'done' ? 'is-current' : ''}><span>3</span>完成發布</li>
        </ol>
      </nav>

      {error && <div className="alert" role="alert">{error}</div>}
      {notice && <div className="toast" role="status">{notice}</div>}

      {step === 'compose' && (
        <form className="incident-form" onSubmit={(event) => void createIncident(event)}>
          <aside className="publisher-callout" aria-label="判斷依據說明">
            <strong>系統如何預覽相符案件</strong>
            <ul>
              <li>系統預覽：比對護照中已確認的 AI 工具名稱（含別名）與本事件指定工具。</li>
              <li>若有填受影響版本：版本未知或落在清單內才會列入預覽。</li>
              <li>若有填影響期間：使用時點落在區間內才會列入；無使用時點則不因時間排除。</li>
              <li>「內部判斷依據」是你留下的人工結論，給後台留痕；預覽清單旁的標籤才是系統自動比對結果。</li>
              <li>預覽只是候補清單；你按下發布後，申請人才會看到「專屬提醒」。</li>
            </ul>
          </aside>

          <fieldset className="publisher-fieldset">
            <legend>基本資訊</legend>
            <div className="field">
              <ChoiceList
                label="受影響工具"
                options={tools.map((tool) => ({ value: tool.id, label: tool.canonicalName, hint: tool.vendor }))}
                value={toolProductId}
                onChange={setToolProductId}
                disabled={loadingTools || busy}
                required
                searchable
                emptyLabel={loadingTools ? '載入工具中…' : '請選擇受影響工具'}
                searchPlaceholder="搜尋工具名稱或廠商"
              />
            </div>
            <div className="field">
              <label htmlFor="incident-title">事件標題</label>
              <input id="incident-title" value={title} maxLength={300} onChange={(event) => setTitle(event.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="incident-severity">嚴重度</label>
              <select id="incident-severity" value={severity} onChange={(event) => setSeverity(event.target.value as typeof severity)}>
                <option value="low">低</option>
                <option value="medium">中</option>
                <option value="high">高</option>
                <option value="critical">重大</option>
              </select>
            </div>
          </fieldset>

          <fieldset className="publisher-fieldset">
            <legend>官方來源</legend>
            <div className="field">
              <label htmlFor="incident-source-url">官方公告網址（HTTPS）</label>
              <input id="incident-source-url" type="url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="incident-source-title">公告名稱</label>
              <input id="incident-source-title" value={sourceTitle} maxLength={300} onChange={(event) => setSourceTitle(event.target.value)} required />
            </div>
            <DateTimePicker
              id="incident-source-published"
              label="公告發布時間"
              value={sourcePublishedAt}
              onChange={setSourcePublishedAt}
              required
              disabled={busy}
            />
          </fieldset>

          <fieldset className="publisher-fieldset">
            <legend>影響範圍（選填，愈完整預覽愈準）</legend>
            <div className="incident-form-grid">
              <DateTimePicker
                id="incident-start"
                label="影響開始時間"
                value={incidentStartAt}
                onChange={setIncidentStartAt}
                disabled={busy}
              />
              <DateTimePicker
                id="incident-end"
                label="影響結束時間"
                value={incidentEndAt}
                onChange={setIncidentEndAt}
                disabled={busy}
              />
            </div>
            <div className="field">
              <label htmlFor="incident-versions">受影響版本</label>
              <textarea id="incident-versions" rows={3} value={versions} onChange={(event) => setVersions(event.target.value)} placeholder="每行或以逗號輸入一個版本；不確定可留空" />
            </div>
          </fieldset>

          <fieldset className="publisher-fieldset">
            <legend>判斷與申請人指引</legend>
            <div className="field">
              <label htmlFor="incident-rationale">內部判斷依據（僅後台可見）</label>
              <p id="incident-rationale-help" className="field-hint">
                此處為承辦團隊之審核紀錄，不會公開給申請人。請具體說明判定受影響之推論過程，例如：官方公告所涵蓋之軟體版本、護照資料流程對照重點，以及針對版本未知案件之處置考量。
              </p>
              <textarea
                id="incident-rationale"
                rows={5}
                maxLength={4000}
                value={internalRationale}
                onChange={(event) => setInternalRationale(event.target.value)}
                required
                aria-describedby="incident-rationale-help"
                placeholder="例如：OpenAI 公告指出 ChatGPT 桌面版 1.2.x 受影響；本事件以工具名稱比對，版本未知者先列入預覽，由承辦再人工排除。"
              />
            </div>
            <div className="field">
              <label htmlFor="incident-guidance">給申請人的處理指引</label>
              <textarea id="incident-guidance" rows={4} maxLength={1000} value={publicGuidance} onChange={(event) => setPublicGuidance(event.target.value)} required placeholder="此內容將呈現於申請人的「專屬提醒」中，請提供具體、可操作的自我檢查或設定變更步驟。" />
            </div>
          </fieldset>

          <button className="secondary" type="submit" disabled={busy || loadingTools || !toolProductId}>
            {busy ? '建立中…' : '建立事件並比對案件'}
          </button>
        </form>
      )}

      {step === 'review' && incidentId && (
        <section className="incident-matches" aria-labelledby="incident-matches-title">
          <div className="incident-matches-head">
            <div>
              <p className="eyebrow">第 2 步 · 預覽候補</p>
              <h2 id="incident-matches-title">確認受影響案件</h2>
              <p>這些案件是系統預覽結果。只有你標成「可能／確認受影響」並發布後，申請人才會收到提醒。</p>
            </div>
            <button type="button" className="secondary" onClick={() => setStep('compose')} disabled={busy}>返回修改事件</button>
          </div>

          <div className="publisher-stats" aria-label="比對統計">
            <div><span>預覽候補</span><strong>{counts.total}</strong></div>
            <div><span>將通知申請人</span><strong>{counts.notify}</strong></div>
            <div><span>其中確認受影響</span><strong>{counts.confirmedAffected}</strong></div>
            <div><span>判定不受影響</span><strong>{counts.excluded}</strong></div>
          </div>

          {candidates.length === 0 ? (
            <p className="publisher-empty">目前沒有符合條件的已送出案件，尚不能發布提醒。可返回調整工具、版本或影響期間後再比對。</p>
          ) : (
            <>
              <ul className="publisher-match-list">
                {candidates.map((candidate) => (
                  <li key={candidate.matchId}>
                    <div>
                      <strong>案件 {shortId(candidate.caseId)}</strong>
                      <span className="publisher-case-id" title={candidate.caseId}>{candidate.caseId}</span>
                      <div className="publisher-basis" aria-label="比對依據">
                        {candidate.basis.map((item) => <span key={`${candidate.matchId}-${item}`}>{basisLabel(item)}</span>)}
                      </div>
                    </div>
                    <label>
                      <span className="sr">案件比對結果</span>
                      <select
                        value={decisions[candidate.matchId] ?? 'possible'}
                        onChange={(event) => setDecisions((current) => ({ ...current, [candidate.matchId]: event.target.value as MatchDecision }))}
                      >
                        <option value="possible">可能受影響（會通知）</option>
                        <option value="confirmed_affected">確認受影響（會通知）</option>
                        <option value="not_affected">不受影響（不通知）</option>
                      </select>
                    </label>
                  </li>
                ))}
              </ul>

              <div className="field">
                <label htmlFor="incident-guidance-review">給申請人的處理指引</label>
                <textarea id="incident-guidance-review" rows={3} maxLength={1000} value={publicGuidance} onChange={(event) => setPublicGuidance(event.target.value)} required />
              </div>

              <label className="confirm">
                <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                我已確認比對結果與給申請人的處理指引，並同意發布提醒。
              </label>

              <button
                className="primary"
                type="button"
                onClick={() => void publishAlerts()}
                disabled={busy || !confirmed || !publicGuidance.trim() || counts.notify === 0}
              >
                {busy ? '發布中…' : `發布 ${counts.notify} 筆資安提醒`}
              </button>
            </>
          )}
        </section>
      )}

      {step === 'done' && (
        <section className="publisher-done" aria-labelledby="publisher-done-title">
          <p className="eyebrow">第 3 步</p>
          <h2 id="publisher-done-title">已完成發布</h2>
          <p>已發布 {publishedCount} 筆資安提醒，並排入 {notificationCount} 則通知。申請人端「專屬提醒」會顯示這些內容；未確認的公開事件仍只出現在工具檢測的公開事件區。</p>
          <div className="publisher-done-actions">
            <button type="button" className="primary" onClick={resetComposer}>建立下一則事件</button>
            <button type="button" className="secondary" onClick={onBack}>返回案件總覽</button>
          </div>
        </section>
      )}
    </section>
  );
}
