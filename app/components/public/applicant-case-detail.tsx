'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FlowPassPassport } from '../../../shared/passport-contract';
import { PublicApiClient, PublicApiError } from '../../lib/public-api';
import { applicantVisibleCopy } from './applicant-copy';
import { ApplicantPassportSummary } from './applicant-passport-summary';
import { applicantCaseStatus, formatTaipeiDate, formatTwd } from './applicant-case-status';
import { CaseTimeline } from './case-timeline';
import { SafetyCard } from './safety-card';
import { SupplementPanel } from './supplement-panel';
import { CorrectionPanel } from './correction-panel';
import { SecurityAlerts } from './security-alerts';

interface ApplicantCaseData {
  id: string;
  state: string;
  approvedAmountTwd: number | null;
  calculatedAmountTwd?: number | null;
  submittedAt: string | null;
  updatedAt: string;
}

interface SubsidyDerivation {
  explanation: string | null;
  steps: Array<{ label: string; value: string }>;
}

interface PassportData {
  version: { workflowState: string };
  passport: FlowPassPassport;
}

type LoadState = 'loading' | 'ready' | 'error';
type PassportState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: PassportData }
  | { kind: 'missing' }
  | { kind: 'error' };

const FALLBACK_TITLE = '竹流 FlowPass 申請';

function SubsidyExplanation({ caseId }: { caseId: string }) {
  const api = useMemo(() => new PublicApiClient(), []);
  const [derivation, setDerivation] = useState<SubsidyDerivation | null>(null);

  useEffect(() => {
    let active = true;
    void api.read<{ evaluations: Array<{ ruleCode?: string | null; explanation?: string | null; steps?: Array<{ label: string; value: string }> }> }>(`/api/v1/cases/${encodeURIComponent(caseId)}/rules`)
      .then((payload) => {
        if (!active) return;
        const subsidy = payload.evaluations.find((item) => item.ruleCode === 'subsidy_estimate' || item.ruleCode === 'admin_data_recalculation');
        if (!subsidy || !Array.isArray(subsidy.steps) || subsidy.steps.length === 0) {
          setDerivation(null);
          return;
        }
        setDerivation({ explanation: subsidy.explanation ?? null, steps: subsidy.steps });
      })
      .catch(() => { if (active) setDerivation(null); });
    return () => { active = false; };
  }, [api, caseId]);

  if (!derivation) return null;
  return (
    <section className="applicant-case-section" aria-labelledby="subsidy-title">
      <header>
        <h2 id="subsidy-title">金額試算說明</h2>
        <p>{derivation.explanation ?? '金額依公開規則試算，最終結果以人工審核為準。'}</p>
      </header>
      <dl className="applicant-subsidy-steps">
        {derivation.steps.map((step) => (
          <div key={step.label}>
            <dt>{step.label}</dt>
            <dd>{step.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function ApplicantCaseDetail({ caseId }: { caseId: string }) {
  const api = useMemo(() => new PublicApiClient(), []);
  const [caseData, setCaseData] = useState<ApplicantCaseData | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [passport, setPassport] = useState<PassportState>({ kind: 'loading' });

  const loadPassport = useCallback(async () => {
    setPassport({ kind: 'loading' });
    try {
      const data = await api.read<PassportData>(`/api/v1/cases/${encodeURIComponent(caseId)}/passport`);
      setPassport({ kind: 'ready', data });
    } catch (error) {
      setPassport(error instanceof PublicApiError && error.status === 404 ? { kind: 'missing' } : { kind: 'error' });
    }
  }, [api, caseId]);

  const load = useCallback(async () => {
    try {
      const nextCase = await api.read<ApplicantCaseData>(`/api/v1/cases/${encodeURIComponent(caseId)}`);
      setCaseData(nextCase);
      setLoadState('ready');
      if (nextCase.state !== 'awaiting_documents') void loadPassport();
    } catch {
      setLoadState('error');
    }
  }, [api, caseId, loadPassport]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  if (loadState === 'loading') return (
    <section className="applicant-case" aria-label="申請進度">
      <Link className="applicant-back-link" href="/app/passports">‹ 返回紀錄</Link>
      <div className="applicant-state-card" role="status">
        <span className="applicant-loading-mark" aria-hidden="true" />
        <p>處理進度載入中…</p>
      </div>
    </section>
  );

  if (loadState === 'error' || !caseData) return (
    <section className="applicant-case" aria-label="申請進度">
      <Link className="applicant-back-link" href="/app/passports">‹ 返回紀錄</Link>
      <div className="applicant-state-card applicant-state-card--error" role="alert">
        <h1>載入失敗</h1>
        <p>請確認網路連線後再試。</p>
        <button type="button" className="secondary-action" onClick={() => { setLoadState('loading'); void load(); }}>重新載入</button>
      </div>
    </section>
  );

  if (caseData.state === 'awaiting_documents') return (
    <article className="applicant-case applicant-case--supplement-only" aria-label="補充申請資料">
      <Link className="applicant-back-link" href="/app/passports">‹ 返回紀錄</Link>
      <SupplementPanel caseId={caseId} onCompleted={load} />
    </article>
  );

  if (caseData.state === 'returned_for_correction') return (
    <article className="applicant-case applicant-case--supplement-only" aria-label="修正申請內容">
      <Link className="applicant-back-link" href="/app/passports">‹ 返回紀錄</Link>
      <CorrectionPanel caseId={caseId} onCompleted={load} />
    </article>
  );

  const status = applicantCaseStatus(caseData.state);
  const useCase = passport.kind === 'ready' ? passport.data.passport.use_case : null;
  const title = useCase ? applicantVisibleCopy(useCase.title, FALLBACK_TITLE) : FALLBACK_TITLE;
  const purpose = useCase ? applicantVisibleCopy(useCase.purpose, '') : '';

  return (
    <article className="applicant-case">
      <Link className="applicant-back-link" href="/app/passports">‹ 返回紀錄</Link>
      <header className="applicant-page-heading">
        <p className="eyebrow">申請進度</p>
        <h1>{title}</h1>
        {purpose && <p>{purpose}</p>}
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
          {caseData.submittedAt && <div><dt>送出日期</dt><dd>{formatTaipeiDate(caseData.submittedAt)}</dd></div>}
          <div><dt>最後更新</dt><dd>{formatTaipeiDate(caseData.updatedAt, true)}</dd></div>
        </dl>
      </section>

      <SecurityAlerts caseId={caseId} />

      <section className="applicant-case-section" aria-labelledby="timeline-title">
        <header><h2 id="timeline-title">處理進度</h2></header>
        <CaseTimeline caseId={caseId} />
      </section>

      <SubsidyExplanation caseId={caseId} />

      <section className="applicant-case-section" aria-labelledby="flow-title">
        <header><h2 id="flow-title">護照</h2><p>本次申請已確認之資料處理方式。</p></header>
        {passport.kind === 'loading' && <div className="applicant-inline-state" role="status">護照載入中…</div>}
        {passport.kind === 'missing' && <p className="tool-check-empty">尚無可檢視之護照。</p>}
        {passport.kind === 'error' && (
          <div className="applicant-inline-state applicant-inline-state--error" role="alert">
            <p>護照暫時無法載入。</p>
            <button type="button" className="text-action" onClick={() => void loadPassport()}>重新載入</button>
          </div>
        )}
        {passport.kind === 'ready' && (
          <ApplicantPassportSummary passport={passport.data.passport} workflowState={passport.data.version.workflowState} mode="record" />
        )}
      </section>

      {passport.kind === 'ready' && (
        <section className="applicant-case-section" aria-labelledby="safety-card-title">
          <header>
            <h2 id="safety-card-title">安全檢查重點</h2>
            <p>依據資料流向自動產生的檢查重點。</p>
          </header>
          <SafetyCard caseId={caseId} />
        </section>
      )}
    </article>
  );
}
