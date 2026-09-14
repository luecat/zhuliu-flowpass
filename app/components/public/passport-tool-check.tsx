'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { PublicApiClient } from '../../lib/public-api';
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
    relevantToPassport?: boolean;
  }>;
  impacts: Array<{
    caseId?: string;
    passportTitle?: string;
    status: string;
    severity?: string;
    summary?: string;
    incidentTitle?: string | null;
    guidance: string | null;
    affectedDataKinds?: string[];
  }>;
};

type LoadState = 'loading' | 'ready' | 'error';

function incidentPeriod(start?: string | null, end?: string | null): string | null {
  if (!start) return null;
  return end ? `${formatTaipeiDate(start)} – ${formatTaipeiDate(end)}` : `${formatTaipeiDate(start)} 起`;
}

function verdict(data: PassportToolCheck): { tone: ApplicantCaseTone; title: string; text: string } {
  const openImpacts = data.impacts.filter((item) => item.status !== 'resolved').length;
  const relevant = data.incidents.filter((item) => item.relevantToPassport).length;
  if (openImpacts > 0) {
    return { tone: 'attention', title: `有 ${openImpacts} 則專屬提醒需要你處理`, text: '下方「專屬提醒」只給你看；公開事件則所有人都能查看。' };
  }
  if (relevant > 0) {
    return { tone: 'progress', title: `公開事件中有 ${relevant} 則與你的護照相關`, text: '請先看標示「與你的護照相關」的事件；完整公開清單也列在下方。' };
  }
  if (data.incidents.length > 0) {
    return {
      tone: 'progress',
      title: `目前有 ${data.incidents.length} 則公開資安事件`,
      text: data.tools.length > 0 ? '目前沒有需要你個人處理的專屬提醒，仍可瀏覽下方公開事件。' : '公開事件所有人都能看。確認護照後，若有相關事件會另顯示專屬提醒。',
    };
  }
  if (data.tools.length === 0) {
    return { tone: 'neutral', title: '目前沒有公開資安事件', text: '確認護照後，系統會依你的工具比對，並在有需要時顯示專屬提醒。' };
  }
  return { tone: 'success', title: '目前沒有公開資安事件', text: `已帶入你護照上的 ${data.tools.length} 項工具。之後有新的公開事件會顯示在這裡。` };
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
      .catch(() => {
        if (!active) return;
        setLoadState('error');
      });
    return () => { active = false; };
  }, [api, attempt]);

  const retry = () => { setLoadState('loading'); setAttempt((value) => value + 1); };

  return (
    <section className="tool-status-page" aria-labelledby="tool-check-title">
      <header className="applicant-page-heading">
        <p className="eyebrow">竹流 FlowPass</p>
        <h1 id="tool-check-title">工具安全檢測</h1>
        <p>公開資安事件所有人都能查看；專屬提醒只在與你的護照相關時出現。</p>
      </header>

      {loadState === 'loading' && (
        <div className="applicant-state-card" role="status">
          <span className="applicant-loading-mark" aria-hidden="true" />
          <p>公開事件載入中…</p>
        </div>
      )}

      {loadState === 'error' && (
        <div className="applicant-state-card applicant-state-card--error" role="alert">
          <h2>載入失敗</h2>
          <p>請稍後再試。若剛從 LINE 開啟，也可重新點一次選單「檢測」。</p>
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
              {checkedAt && (
                <dl className="applicant-case-meta">
                  <div><dt>更新時間</dt><dd>{formatTaipeiDate(checkedAt, true)}</dd></div>
                </dl>
              )}
            </section>

            {data.impacts.length > 0 && (
              <section className="applicant-case-section" aria-labelledby="tool-check-impacts">
                <header><h2 id="tool-check-impacts">專屬提醒</h2><p>依你的護照個別判斷，只有你看得到。</p></header>
                <ul className="tool-check-list">
                  {data.impacts.map((item, index) => {
                    const status = securityAlertStatus(item.status);
                    const severity = securitySeverity(item.severity ?? '');
                    const passportTitle = item.passportTitle?.trim() || '你的護照';
                    const whatHappened = item.incidentTitle?.trim() || item.summary?.trim() || null;
                    const caseHref = item.caseId ? `/app/passports/${encodeURIComponent(item.caseId)}` : '/app/passports';
                    return (
                      <li key={`${item.caseId ?? item.status}-${index}`}>
                        <article className="tool-check-card">
                          <div className="tool-check-card-meta">
                            <span className={`applicant-status applicant-status--${status.tone}`}>{status.label}</span>
                            <span className={`applicant-status applicant-status--${severity.tone}`}>影響程度：{severity.label}</span>
                          </div>
                          <h3>{passportTitle}</h3>
                          {whatHappened && <p>{whatHappened}</p>}
                          {item.affectedDataKinds && item.affectedDataKinds.length > 0 && (
                            <p className="tool-check-period">可能相關資料：{item.affectedDataKinds.join('、')}</p>
                          )}
                          <div className="tool-check-actions">
                            <h4>建議你這樣做</h4>
                            <p>{item.guidance ?? '請依指示檢查護照與相關工具設定。'}</p>
                          </div>
                          <Link className="tool-check-inline-link" href={caseHref}>查看此護照 ›</Link>
                        </article>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {data.tools.length > 0 && (
              <section className="applicant-case-section" aria-labelledby="tool-check-tools">
                <header><h2 id="tool-check-tools">使用工具</h2><p>來自你已確認的護照。</p></header>
                <ul className="tool-check-chips">
                  {data.tools.map((tool) => <li key={tool}>{tool}</li>)}
                </ul>
              </section>
            )}

            <section className="applicant-case-section" aria-labelledby="tool-check-incidents">
              <header>
                <h2 id="tool-check-incidents">公開資安事件</h2>
                <p>市府確認過來源的事件會列在這裡，所有人都能查看。</p>
              </header>
              {data.incidents.length === 0 ? (
                <p className="tool-check-empty">目前沒有已發布的公開事件。請持續留意官方公告。</p>
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
                            {item.relevantToPassport && (
                              <span className="applicant-status applicant-status--attention">與你的護照相關</span>
                            )}
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
                              查看來源：{item.sourceTitle ?? '來源'} ↗
                            </a>
                          )}
                        </article>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </>
        );
      })()}
    </section>
  );
}
