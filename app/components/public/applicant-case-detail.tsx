'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FlowPassPassport } from '../../../shared/passport-contract';
import { PublicApiClient, PublicApiError } from '../../lib/public-api';
import { ApplicantPassportSummary } from './applicant-passport-summary';
import { applicantCaseStatus, formatTaipeiDate, formatTwd } from './applicant-case-status';
import { CaseTimeline } from './case-timeline';
import type { PassportCard } from './passport-list';
import { SupplementPanel } from './supplement-panel';

interface ApplicantCaseData {
  id: string;
  state: string;
  approvedAmountTwd: number | null;
  submittedAt: string | null;
  updatedAt: string;
}

interface PassportData {
  version: { workflowState: string };
  passport: FlowPassPassport;
}

type LoadState = 'loading' | 'ready' | 'error';

function ApplicantPassportRecord({ caseId }: { caseId: string }) {
  const api = useMemo(() => new PublicApiClient(), []);
  const [data, setData] = useState<PassportData | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    try {
      const value = await api.read<PassportData>(`/api/v1/cases/${encodeURIComponent(caseId)}/passport`);
      setData(value);
      setMissing(false);
      setLoadState('ready');
    } catch (error) {
      setMissing(error instanceof PublicApiError && error.status === 404);
      setLoadState('error');
    }
  }, [api, caseId]);

  useEffect(() => {
    void api.read<PassportData>(`/api/v1/cases/${encodeURIComponent(caseId)}/passport`)
      .then((value) => { setData(value); setMissing(false); setLoadState('ready'); })
      .catch((error) => { setMissing(error instanceof PublicApiError && error.status === 404); setLoadState('error'); });
  }, [api, caseId]);

  if (loadState === 'loading') return <div className="applicant-inline-state" role="status">正在載入資料流向…</div>;
  if (loadState === 'error') return (
    <div className="applicant-inline-state applicant-inline-state--error" role="alert">
      <p>{missing ? '目前沒有可查看的資料流向內容。' : '資料流向暫時無法載入。'}</p>
      {!missing && <button type="button" className="text-action" onClick={() => { setLoadState('loading'); setMissing(false); void load(); }}>重新載入</button>}
    </div>
  );
  if (!data) return null;
  return <ApplicantPassportSummary passport={data.passport} workflowState={data.version.workflowState} mode="record" />;
}

export function ApplicantCaseDetail({ caseId }: { caseId: string }) {
  const api = useMemo(() => new PublicApiClient(), []);
  const [caseData, setCaseData] = useState<ApplicantCaseData | null>(null);
  const [card, setCard] = useState<PassportCard | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');

  const load = useCallback(async () => {
    try {
      const nextCase = await api.read<ApplicantCaseData>(`/api/v1/cases/${encodeURIComponent(caseId)}`);
      setCaseData(nextCase);
      if (nextCase.state === 'awaiting_documents') setCard(null);
      else {
        const records = await api.read<{ passports: PassportCard[] }>('/api/v1/passports').catch(() => ({ passports: [] }));
        setCard(records.passports.find((item) => item.id === caseId) ?? null);
      }
      setLoadState('ready');
    } catch {
      setLoadState('error');
    }
  }, [api, caseId]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  if (loadState === 'loading') return (
    <section className="applicant-case" aria-label="申請進度">
      <Link className="applicant-back-link" href="/app/passports">‹ 返回申請紀錄</Link>
      <div className="applicant-state-card" role="status">
        <span className="applicant-loading-mark" aria-hidden="true" />
        <p>正在載入申請進度…</p>
      </div>
    </section>
  );

  if (loadState === 'error' || !caseData) return (
    <section className="applicant-case" aria-label="申請進度">
      <Link className="applicant-back-link" href="/app/passports">‹ 返回申請紀錄</Link>
      <div className="applicant-state-card applicant-state-card--error" role="alert">
        <h1>暫時無法載入申請進度</h1>
        <p>請確認網路連線後再試一次。</p>
        <button type="button" className="secondary-action" onClick={() => { setLoadState('loading'); void load(); }}>重新載入</button>
      </div>
    </section>
  );

  if (caseData.state === 'awaiting_documents') return (
    <article className="applicant-case applicant-case--supplement-only" aria-label="補充申請資料">
      <Link className="applicant-back-link" href="/app/passports">‹ 返回申請紀錄</Link>
      <SupplementPanel caseId={caseId} onCompleted={load} />
    </article>
  );

  const status = applicantCaseStatus(caseData.state);
  return (
    <article className="applicant-case">
      <Link className="applicant-back-link" href="/app/passports">‹ 返回申請紀錄</Link>
      <header className="applicant-page-heading">
        <p className="eyebrow">申請進度</p>
        <h1>{card?.programName ?? '竹流 FlowPass 申請'}</h1>
      </header>

      <section className={`applicant-status-card applicant-status-card--${status.tone}`} aria-labelledby="current-status-title">
        <span className={`applicant-status applicant-status--${status.tone}`}>目前狀態</span>
        <h2 id="current-status-title">{status.label}</h2>
        <p>{status.description}</p>
        {caseData.approvedAmountTwd !== null && (
          <div className="applicant-approved-amount">
            <span>核定金額</span>
            <strong>{formatTwd(caseData.approvedAmountTwd)}</strong>
          </div>
        )}
        <dl className="applicant-case-meta">
          <div><dt>最後更新</dt><dd>{formatTaipeiDate(caseData.updatedAt, true)}</dd></div>
        </dl>
      </section>

      <section className="applicant-case-section" aria-labelledby="timeline-title">
        <header><h2 id="timeline-title">處理進度</h2><p>只顯示與你有關的重要更新。</p></header>
        <CaseTimeline caseId={caseId} />
      </section>

      <section className="applicant-case-section" aria-labelledby="flow-title">
        <header><h2 id="flow-title">資料流向</h2><p>這是本次申請已確認的資料使用方式。</p></header>
        <ApplicantPassportRecord caseId={caseId} />
      </section>
    </article>
  );
}
