'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FlowPassPassport } from '../../../shared/passport-contract';
import { PublicApiClient, PublicApiError } from '../../lib/public-api';
import { AiWaitingStatus } from './ai-waiting-status';
import { ApplicantPassportSummary } from './applicant-passport-summary';
import { AiFollowUpForm, type AiFollowUpAnswer, type AiFollowUpQuestion } from './ai-follow-up-form';
import { DocumentReview } from './document-review';

interface PassportApiData {
  version: { id: string; versionNo: number; workflowState: string };
  passport: FlowPassPassport;
  followUps: AiFollowUpQuestion[];
  etag: string;
}

const REVISION_PROGRESS_DURATION_SECONDS = 200;
const REVISION_POLL_INTERVAL_MS = 20_000;

function caseIdFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('caseId');
}

export function PassportReviewPanel({ caseId: suppliedCaseId }: { caseId?: string } = {}) {
  const [caseId, setCaseId] = useState<string | null>(suppliedCaseId ?? caseIdFromLocation());
  const [data, setData] = useState<PassportApiData | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [submissionComplete, setSubmissionComplete] = useState(false);
  const [revisionJobId, setRevisionJobId] = useState<string | null>(null);
  const [revisionFailed, setRevisionFailed] = useState(false);
  const [revisionProgressPercent, setRevisionProgressPercent] = useState(0);
  const revisionRunRef = useRef(0);
  const revisionCountdownTimerRef = useRef<number | null>(null);
  const api = useMemo(() => new PublicApiClient(), []);

  const load = useCallback(async (id: string) => {
    try {
      const currentCase = await api.read<{ state?: string }>(`/api/v1/cases/${encodeURIComponent(id)}`);
      if (typeof currentCase.state === 'string' && currentCase.state !== 'draft') {
        setSubmissionComplete(true);
        setMessage('');
        window.history.replaceState(null, '', '/app/apply');
        window.dispatchEvent(new CustomEvent('flowpass-review-open'));
        return;
      }
      const next = await api.read<PassportApiData>(`/api/v1/cases/${encodeURIComponent(id)}/passport`);
      setData(next);
      setSubmissionComplete(false);
      setMessage('');
      window.dispatchEvent(new CustomEvent('flowpass-review-open'));
    } catch (error) {
      setMessage(error instanceof PublicApiError && error.status === 404 ? '目前還沒有可檢視的申請內容。' : '護照資料暫時無法載入，請稍後再試。');
    }
  }, [api]);

  useEffect(() => {
    const onPassportReady = () => {
      const id = caseId ?? caseIdFromLocation();
      if (!id) return;
      if (id === caseId) void load(id);
      else setCaseId(id);
    };
    window.addEventListener('flowpass-passport-ready', onPassportReady);
    return () => { window.removeEventListener('flowpass-passport-ready', onPassportReady); };
  }, [caseId, load]);

  useEffect(() => {
    if (!caseId) return;
    const timer = window.setTimeout(() => { void load(caseId); }, 0);
    return () => window.clearTimeout(timer);
  }, [caseId, load]);

  useEffect(() => () => {
    revisionRunRef.current += 1;
    if (revisionCountdownTimerRef.current !== null) {
      window.clearInterval(revisionCountdownTimerRef.current);
      revisionCountdownTimerRef.current = null;
    }
  }, []);

  function showRevisionFailure() {
    setRevisionJobId(null);
    setRevisionFailed(true);
    setMessage('處理失敗，請重試');
  }

  async function saveFollowUps(answers: AiFollowUpAnswer[]) {
    if (!caseId || !data) return;
    setBusy(true);
    try {
      const queued = await api.mutate<{ revisionJobId?: string; jobState?: string }>(`/api/v1/cases/${encodeURIComponent(caseId)}/confirmations`, { method: 'POST', ifMatch: data.etag, body: { passportVersionId: data.version.id, answers, declarations: [] } });
      if (queued.revisionJobId) {
        await waitForRevision(queued.revisionJobId);
        return;
      }
      await load(caseId);
    } catch (error) {
      if (error instanceof PublicApiError && error.code === 'AI_INPUT_UNSAFE') {
        setMessage('追問回答中包含像是要操作 AI 或系統的指令，請改為實際情況後再儲存。');
      } else {
        showRevisionFailure();
      }
    } finally { setBusy(false); }
  }

  async function waitForRevision(jobId: string) {
    const targetCaseId = caseId;
    if (!targetCaseId) throw new Error('revision case missing');
    const runId = revisionRunRef.current + 1;
    revisionRunRef.current = runId;
    const startedAt = Date.now();
    setRevisionJobId(jobId);
    setRevisionFailed(false);
    setRevisionProgressPercent(0);
    setMessage('');
    const countdownTimer = window.setInterval(() => {
      if (revisionRunRef.current !== runId) return;
      const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1_000));
      setRevisionProgressPercent(elapsedSeconds >= REVISION_PROGRESS_DURATION_SECONDS ? 99 : Math.floor((elapsedSeconds / REVISION_PROGRESS_DURATION_SECONDS) * 100));
    }, 1_000);
    revisionCountdownTimerRef.current = countdownTimer;

    try {
      while (revisionRunRef.current === runId) {
        await new Promise((resolve) => window.setTimeout(resolve, REVISION_POLL_INTERVAL_MS));
        if (revisionRunRef.current !== runId) return;
        const job = await api.read<{ state?: unknown; errorCode?: string | null }>(`/api/v1/jobs/${encodeURIComponent(jobId)}`);
        if (job.state === 'completed') {
          setRevisionProgressPercent(100);
          await load(targetCaseId);
          setRevisionJobId(null);
          return;
        }
        if (job.state === 'failed_terminal' && job.errorCode === 'AI_INPUT_INVALID') {
          setMessage('這些回答看起來不像是在描述實際流程，請重新填寫資料類型、用途、個資情況與分享對象。');
        }
        if (job.state !== 'queued' && job.state !== 'leased') {
          throw new Error('revision failed');
        }
      }
    } finally {
      window.clearInterval(countdownTimer);
      if (revisionCountdownTimerRef.current === countdownTimer) {
        revisionCountdownTimerRef.current = null;
      }
    }
  }

  async function retryRevision() {
    if (!caseId) return;
    setBusy(true);
    try {
      const current = await api.read<{ rowVersion: number }>(`/api/v1/cases/${encodeURIComponent(caseId)}`);
      const queued = await api.mutate<{ jobId: string }>(`/api/v1/cases/${encodeURIComponent(caseId)}/ai-drafts`, { method: 'POST', ifMatch: `"${current.rowVersion}"`, body: { operation: 'revise', retry: true } });
      await waitForRevision(queued.jobId);
    } catch { showRevisionFailure(); } finally { setBusy(false); }
  }

  async function confirmApplication() {
    if (!caseId || !data) return;
    setBusy(true);
    try {
      await api.mutate<{ passportVersionId: string }>(`/api/v1/cases/${encodeURIComponent(caseId)}/confirmations`, { method: 'POST', ifMatch: data.etag, body: { passportVersionId: data.version.id, answers: [], declarations: [{ confirmationType: 'passport', targetKey: 'confirm', value: true }] } });
      await load(caseId);
      setMessage('');
    } catch (error) {
      await load(caseId);
      setMessage(error instanceof PublicApiError && error.code === 'ETAG_MISMATCH'
        ? '申請內容剛剛有更新，已重新載入，請再確認一次。'
        : '內容尚未確認，請稍後再試。');
    } finally { setBusy(false); }
  }

  async function submitApplication() {
    if (!caseId || !data || data.version.workflowState !== 'confirmed') return;
    setBusy(true);
    try {
      const currentCase = await api.read<{ rowVersion: number; state?: string }>(`/api/v1/cases/${encodeURIComponent(caseId)}`);
      if (currentCase.state && currentCase.state !== 'draft') {
        setSubmissionComplete(true);
      } else {
        await api.mutate(`/api/v1/cases/${encodeURIComponent(caseId)}/submission`, { method: 'POST', ifMatch: `"${currentCase.rowVersion}"`, body: { passportVersionId: data.version.id } });
        setSubmissionComplete(true);
      }
      setMessage('');
      window.history.replaceState(null, '', '/app/apply');
    } catch (error) {
      try {
        const currentCase = await api.read<{ state?: string }>(`/api/v1/cases/${encodeURIComponent(caseId)}`);
        if (currentCase.state && currentCase.state !== 'draft') {
          setSubmissionComplete(true);
          setMessage('');
          window.history.replaceState(null, '', '/app/apply');
          return;
        }
      } catch { /* retain the original submission error */ }
      await load(caseId);
      setMessage(error instanceof PublicApiError && error.code === 'DOCUMENT_NOT_READY'
        ? '必要附件或資料尚未完成，請確認後再正式送出。'
        : error instanceof PublicApiError && error.code === 'ETAG_MISMATCH'
          ? '申請內容剛剛有更新，已重新載入，請再試一次。'
          : '正式送出失敗，請稍後再試。');
    } finally { setBusy(false); }
  }

  if (!caseId) return null;
  if (submissionComplete) return (
    <section className="passport-review-panel submission-success" aria-labelledby="submission-success-title" role="status">
      <span className="submission-success-mark" aria-hidden="true">✓</span>
      <h2 id="submission-success-title">申請已正式送出</h2>
      <p>申請資料與護照版本都已保存，可以前往護照紀錄查看後續進度。</p>
      <a className="primary-action" href={`/app/passports/${encodeURIComponent(caseId)}`}>查看申請進度</a>
    </section>
  );
  if (!data) return <p className="pending-note" role="status">{message || '正在載入申請內容…'}</p>;
  if (revisionJobId) return <section className="passport-review-panel passport-review-panel--waiting" aria-label="正在整理護照"><AiWaitingStatus progressPercent={revisionProgressPercent} /></section>;
  if (data.version.workflowState === 'confirmed') return (
    <section className="passport-review-panel attachment-workflow" aria-label="附件與正式送出">
      {message && <p className="pending-note" role="status">{message}</p>}
      <section className="application-step-complete" aria-label="申請內容已完成">
        <span aria-hidden="true">✓</span>
        <div><p className="eyebrow">第 1 部分</p><h2>申請內容已完成</h2><p>接下來填寫購買資料並上傳必要附件。</p></div>
      </section>
      <DocumentReview suppliedCaseId={caseId} onSubmit={() => void submitApplication()} submitting={busy} />
    </section>
  );
  return (
    <section className="passport-review-panel" aria-label="申請內容">
      {message && <p className="pending-note" role="status">{message}</p>}
      {revisionFailed && <button type="button" onClick={() => void retryRevision()} disabled={busy}>重試整理</button>}
      <ApplicantPassportSummary passport={data.passport} workflowState={data.version.workflowState} onContinue={data.version.workflowState === 'needs_applicant_confirmation' ? () => void confirmApplication() : undefined} busy={busy} />
      {data.version.workflowState === 'follow_up_required' && <AiFollowUpForm questions={data.followUps.filter((question) => question.status === 'open')} onSubmit={(answers) => void saveFollowUps(answers)} submitting={busy} />}
    </section>
  );
}
