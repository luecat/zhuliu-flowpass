'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { PublicApiClient, PublicApiError } from '../../lib/public-api';
import { formatTaipeiDate, securityAlertStatus, securitySeverity, type ApplicantCaseTone } from './applicant-case-status';

type PassportToolCheck = {
  tools: string[];
  incidents: Array<{
    toolName: string;
    vendor: string | null;
    title: string;
    severity: string;
    incidentStartAt?: string | null;
    incidentEndAt?: string | null;
    sourceTitle: string | null;
    sourceUrl: string | null;
    publishedAt?: string | null;
    recommendedActions: string[];
  }>;
  impacts: Array<{
    status: string;
    guidance: string | null;
  }>;
};

type LoadState = 'loading' | 'ready' | 'error' | 'unauthenticated';

function incidentPeriod(start?: string | null, end?: string | null): string | null {
  if (!start) return null;
  return end ? `${formatTaipeiDate(start)} – ${formatTaipeiDate(end)}` : `${formatTaipeiDate(start)} 起`;
}

function verdict(data: PassportToolCheck): { tone: ApplicantCaseTone; title: string; text: string } {
  const openImpacts = data.impacts.filter((item) => item.status !== 'resolved').length;
  if (data.tools.length === 0) {
    return { tone: 'neutral', title: '還沒有可以比對的工具', text: '送出申請、確認資料流向後，這裡會自動比對你用的 AI 工具。' };
  }
  if (openImpacts > 0) {
    return { tone: 'attention', title: `有 ${openImpacts} 則提醒需要你處理`, text: '比對後發現你的資料流向可能受到影響，請依下方步驟檢查。' };
  }
  if (data.incidents.length > 0) {
    return { tone: 'progress', title: `你用的工具有 ${data.incidents.length} 則公開事件`, text: '目前沒有判定與你的申請相關，仍建議看一下處置建議。' };
  }
  return { tone: 'success', title: '目前沒有相符的資安事件', text: `已比對你的 ${data.tools.length} 項工具。沒有事件不代表絕對安全，之後有新事件會再通知你。` };
}

export function PassportToolCheck() {
  const api = useMemo(() => new PublicApiClient(), []);
  const [attempt, setAttempt] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [data, setData] = useState<PassportToolCheck | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api.read<PassportToolCheck>('/api/v1/tool-status')
      .then((result) => {
        if (!active) return;
        setData(result);
        setCheckedAt(new Date().toISOString());
        setLoadState('ready');
      })
      .catch((error) => {
        if (!active) return;
        setLoadState(error instanceof PublicApiError && error.status === 401 ? 'unauthenticated' : 'error');
      });
    return () => { active = false; };
  }, [api, attempt]);

  const retry = () => { setLoadState('loading'); setAttempt((value) => value + 1); };

  return (
    <section className="tool-status-page" aria-labelledby="tool-check-title">
      <header className="applicant-page-heading">
        <p className="eyebrow">竹流 FlowPass</p>
        <h1 id="tool-check-title">工具安全檢測</h1>
        <p>用你已確認的資料流向，比對市府整理的 AI 工具公開資安事件。不用自己輸入工具名稱。</p>
      </header>

      {loadState === 'loading' && (
        <div className="applicant-state-card" role="status">
          <span className="applicant-loading-mark" aria-hidden="true" />
          <p>正在比對你的工具…</p>
        </div>
      )}

      {loadState === 'unauthenticated' && (
        <div className="applicant-state-card applicant-state-card--error" role="alert">
          <h2>登入已失效</h2>
          <p>請從 LINE 選單重新開啟「工具安全檢測」。</p>
        </div>
      )}

      {loadState === 'error' && (
        <div className="applicant-state-card applicant-state-card--error" role="alert">
          <h2>暫時無法比對</h2>
          <p>可能是網路不穩，請再試一次。</p>
          <button type="button" className="secondary-action" onClick={retry}>再試一次</button>
        </div>
      )}

      {loadState === 'ready' && data && (() => {
        const summary = verdict(data);
        return (
          <>
            <section className={`applicant-status-card applicant-status-card--${summary.tone}`} aria-labelledby="tool-check-verdict">
              <span className={`applicant-status applicant-status--${summary.tone}`}>檢測結果</span>
              <h2 id="tool-check-verdict">{summary.title}</h2>
              <p>{summary.text}</p>
              {data.tools.length === 0 ? (
                <Link className="secondary-action tool-check-link" href="/app/passports">查看申請紀錄</Link>
              ) : checkedAt && (
                <dl className="applicant-case-meta">
                  <div><dt>比對時間</dt><dd>{formatTaipeiDate(checkedAt, true)}</dd></div>
                </dl>
              )}
            </section>

            {data.impacts.length > 0 && (
              <section className="applicant-case-section" aria-labelledby="tool-check-impacts">
                <header><h2 id="tool-check-impacts">給你的提醒</h2><p>依你的資料流向個別判斷，只有你看得到。</p></header>
                <ul className="tool-check-list">
                  {data.impacts.map((item, index) => {
                    const status = securityAlertStatus(item.status);
                    return (
                      <li key={`${item.status}-${index}`} className="tool-check-card">
                        <span className={`applicant-status applicant-status--${status.tone}`}>{status.label}</span>
                        <p>{item.guidance ?? '請依處置建議檢查你的資料流向。'}</p>
                        <Link className="tool-check-inline-link" href="/app/passports">到申請紀錄查看 ›</Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {data.tools.length > 0 && (
              <section className="applicant-case-section" aria-labelledby="tool-check-tools">
                <header><h2 id="tool-check-tools">比對的工具</h2><p>來自你已確認的資料流向。</p></header>
                <ul className="tool-check-chips">
                  {data.tools.map((tool) => <li key={tool}>{tool}</li>)}
                </ul>
              </section>
            )}

            {data.tools.length > 0 && (
              <section className="applicant-case-section" aria-labelledby="tool-check-incidents">
                <header><h2 id="tool-check-incidents">相關公開事件</h2><p>市府確認過來源的事件才會列在這裡。</p></header>
                {data.incidents.length === 0 ? (
                  <p className="tool-check-empty">目前沒有與你工具相符的公開事件。</p>
                ) : (
                  <ul className="tool-check-list">
                    {data.incidents.map((item) => {
                      const severity = securitySeverity(item.severity);
                      const period = incidentPeriod(item.incidentStartAt, item.incidentEndAt);
                      return (
                        <li key={`${item.toolName}-${item.title}`}>
                          <article className="tool-check-card">
                            <div className="tool-check-card-meta">
                              <span className={`applicant-status applicant-status--${severity.tone}`}>{severity.label}</span>
                              <span>{item.toolName}{item.vendor && item.vendor !== item.toolName ? ` · ${item.vendor}` : ''}</span>
                            </div>
                            <h3>{item.title}</h3>
                            {period && <p className="tool-check-period">發生期間：{period}</p>}
                            {item.recommendedActions.length > 0 && (
                              <div className="tool-check-actions">
                                <h4>建議你這樣做</h4>
                                <ul>
                                  {item.recommendedActions.map((action) => <li key={action}>{action}</li>)}
                                </ul>
                              </div>
                            )}
                            {item.sourceUrl && (
                              <a className="tool-check-inline-link" href={item.sourceUrl} target="_blank" rel="noopener noreferrer">
                                查看來源：{item.sourceTitle ?? '原始公告'} ↗
                              </a>
                            )}
                          </article>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            )}
          </>
        );
      })()}
    </section>
  );
}
