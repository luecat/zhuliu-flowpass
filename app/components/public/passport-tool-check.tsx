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

type LoadState = 'loading' | 'ready' | 'error' | 'unauthenticated';

function incidentPeriod(start?: string | null, end?: string | null): string | null {
  if (!start) return null;
  return end ? `${formatTaipeiDate(start)} – ${formatTaipeiDate(end)}` : `${formatTaipeiDate(start)} 起`;
}

function verdict(data: PassportToolCheck): { tone: ApplicantCaseTone; title: string; text: string } {
  const openImpacts = data.impacts.filter((item) => item.status !== 'resolved').length;
  if (data.tools.length === 0) {
    return { tone: 'neutral', title: '還沒有可以比對的工具', text: '完成申請並確認護照後，系統將自動比對您所使用工具的最新安全通報。' };
  }
  if (openImpacts > 0) {
    return { tone: 'attention', title: `有 ${openImpacts} 則提醒需要你處理`, text: '比對發現您所使用的工具有相關事件通報，請查看下方說明與安全建議作法。' };
  }
  if (data.incidents.length > 0) {
    return { tone: 'progress', title: `你用的工具有 ${data.incidents.length} 則公開事件`, text: '目前初步判定未直接影響您的申請流程，仍建議您參考官方處置建議以策安全。' };
  }
  return { tone: 'success', title: '目前沒有相符的資安事件', text: `已為您比對 ${data.tools.length} 項工具。目前查無相符事件，後續如有新通報將及時通知您。` };
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
        <p>系統將依據已確認的護照，自動比對相關工具的公開事件。</p>
      </header>

      {loadState === 'loading' && (
        <div className="applicant-state-card" role="status">
          <span className="applicant-loading-mark" aria-hidden="true" />
          <p>公開事件比對中…</p>
        </div>
      )}

      {loadState === 'unauthenticated' && (
        <div className="applicant-state-card applicant-state-card--error" role="alert">
          <h2>請先登入</h2>
          <p>檢測功能需讀取紀錄，請由 LINE 選單重新開啟。</p>
        </div>
      )}

      {loadState === 'error' && (
        <div className="applicant-state-card applicant-state-card--error" role="alert">
          <h2>檢測失敗</h2>
          <p>請稍後再試。</p>
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
                <header><h2 id="tool-check-impacts">專屬提醒</h2><p>依據您護照所登記之工具與資料流向個別比對，僅供您個人查閱。</p></header>
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
                <header><h2 id="tool-check-tools">使用工具</h2><p>已自您確認的 AI 資料護照中自動帶入。</p></header>
                <ul className="tool-check-chips">
                  {data.tools.map((tool) => <li key={tool}>{tool}</li>)}
                </ul>
              </section>
            )}

            {data.tools.length > 0 && (
              <section className="applicant-case-section" aria-labelledby="tool-check-incidents">
                <header><h2 id="tool-check-incidents">相關公開事件</h2><p>收錄經主管機關與廠商官方公告之安全性事件，供您參考防範。</p></header>
                {data.incidents.length === 0 ? (
                  <p className="tool-check-empty">目前無相符的公開事件。請持續留意官方公告。</p>
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
            )}
          </>
        );
      })()}
    </section>
  );
}
