'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FlowPassPassport } from '../../../shared/passport-contract';
import { findApprovedAiTool, type ApprovedAiTool } from '../../../shared/approved-ai-tools';
import { followUpTopics } from '../../../shared/follow-up-policy';
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
const REVISION_POLL_INTERVAL_MS = 5_000;
const UNSAFE_ORIGINAL_ANSWERS_MESSAGE = '申請內容包含系統指令或不當要求，無法產生護照。請點下方「放棄這筆、重新填寫」，只描述實際的資料流程。';
const INVALID_ORIGINAL_ANSWERS_MESSAGE = '申請內容不像實際的資料流程，無法產生護照。請點下方「放棄這筆、重新填寫」，重新描述實際的資料類型、用途與分享對象。';

/** Carries the terminal job error so the applicant sees why a revision stopped instead of a generic failure. */
class RevisionJobError extends Error {
  constructor(readonly code: string | null) {
    super('revision failed');
    this.name = 'RevisionJobError';
  }
}

function caseIdFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('caseId');
}

function approvedToolFromFollowUpAnswers(
  questions: AiFollowUpQuestion[],
  answers: AiFollowUpAnswer[],
): ApprovedAiTool | null {
  for (const answer of answers) {
    const question = questions.find((candidate) => candidate.id === answer.questionId);
    if (!question || !followUpTopics(question.questionKey, question.prompt, question.reason).includes('tool')) continue;
    const tool = findApprovedAiTool(answer.answer);
    if (tool) return tool;
  }
  return null;
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
  const [prefilledTool, setPrefilledTool] = useState<ApprovedAiTool | null>(null);
  // The four original answers can no longer be edited once a passport exists; a rejected revision can only start over.
  const [inputBlocked, setInputBlocked] = useState(false);
  const [confirmStartOver, setConfirmStartOver] = useState(false);
  const [startingOver, setStartingOver] = useState(false);
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
      setMessage(error instanceof PublicApiError && error.status === 404 ? '尚無可檢視的申請內容。' : '資料暫時無法載入，請稍後再試。');
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
    setMessage('處理失敗，請稍後再試。');
  }

  function handleRevisionError(error: unknown) {
    setRevisionJobId(null);
    if (error instanceof PublicApiError && error.code === 'AI_INPUT_UNSAFE') {
      setInputBlocked(true);
      setMessage(UNSAFE_ORIGINAL_ANSWERS_MESSAGE);
      return;
    }
    if (error instanceof RevisionJobError && error.code === 'AI_INPUT_INVALID') {
      setInputBlocked(true);
      setMessage(INVALID_ORIGINAL_ANSWERS_MESSAGE);
      return;
    }
    showRevisionFailure();
  }

  async function startRevision(retry = false) {
    if (!caseId) return;
    const current = await api.read<{ rowVersion: number }>(`/api/v1/cases/${encodeURIComponent(caseId)}`);
    const queued = await api.mutate<{ jobId: string }>(`/api/v1/cases/${encodeURIComponent(caseId)}/ai-drafts`, {
      method: 'POST',
      ifMatch: `"${current.rowVersion}"`,
      body: { operation: 'revise', ...(retry ? { retry: true } : {}) },
    });
    await waitForRevision(queued.jobId);
  }

  async function saveFollowUps(answers: AiFollowUpAnswer[], regenerate: boolean) {
    if (!caseId || !data) return;
    const openIds = new Set(data.followUps.filter((question) => question.status === 'open').map((question) => question.id));
    const pendingAnswers = answers.filter((answer) => openIds.has(answer.questionId) && answer.answer.trim());
    const selectedTool = approvedToolFromFollowUpAnswers(data.followUps, answers);
    let stage: 'answers' | 'revision' = 'answers';
    setBusy(true);
    try {
      if (pendingAnswers.length > 0) {
        await api.mutate(`/api/v1/cases/${encodeURIComponent(caseId)}/confirmations`, {
          method: 'POST',
          ifMatch: data.etag,
          body: { passportVersionId: data.version.id, answers: pendingAnswers, declarations: [] },
        });
        if (selectedTool) setPrefilledTool(selectedTool);
      }
      if (!regenerate) {
        await load(caseId);
        // load() clears the banner, so confirm the save only after the refreshed passport is shown.
        setMessage('答案已儲存。確認無誤後請點擊「重新產生護照」。');
        return;
      }
      stage = 'revision';
      await startRevision();
    } catch (error) {
      if (error instanceof PublicApiError && error.code === 'ETAG_MISMATCH') {
        await load(caseId);
        setMessage('申請內容已更新，請重新儲存。');
      } else if (stage === 'revision') {
        handleRevisionError(error);
      } else if (error instanceof PublicApiError && error.code === 'AI_INPUT_UNSAFE') {
        setMessage('追問的回答包含系統指令，請改成實際情況後再儲存。');
      } else if (error instanceof PublicApiError && error.code === 'INVALID_REQUEST') {
        setMessage('答案格式錯誤。若選擇「其他」，請填寫實際內容。');
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
        if (job.state !== 'queued' && job.state !== 'leased') {
          throw new RevisionJobError(job.state === 'failed_terminal' ? job.errorCode ?? null : null);
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
      await startRevision(true);
    } catch (error) { handleRevisionError(error); } finally { setBusy(false); }
  }

  async function startOver() {
    setStartingOver(true);
    try {
      const program = await api.read<{ id: string }>('/api/v1/programs/current');
      await api.mutate('/api/v1/cases', { method: 'POST', body: { programCycleId: program.id, startOver: true } });
      // Reload without a caseId: the fresh draft is now the only active one, and a caseId in the URL
      // would make this panel look up a passport that does not exist yet and show a stray notice.
      window.location.replace('/app/apply');
    } catch (error) {
      setStartingOver(false);
      setMessage(error instanceof PublicApiError && error.code === 'RATE_LIMITED'
        ? '今天建立申請的次數已用完，請明天再試。'
        : '暫時無法重新開始，請稍後再試。');
    }
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
        ? '申請內容已更新，請重新確認。'
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
        ? '必備附件尚未補齊，請確認後再送出。'
        : error instanceof PublicApiError && error.code === 'PASSPORT_NOT_READY'
          ? '請先完成護照確認，再送出申請。'
          : error instanceof PublicApiError && error.code === 'ETAG_MISMATCH'
            ? '申請內容已更新，請重新確認。'
            : '送出失敗，請稍後再試。');
    } finally { setBusy(false); }
  }

  if (!caseId) return null;
  if (submissionComplete) return (
    <section className="passport-review-panel submission-success" aria-labelledby="submission-success-title" role="status">
      <span className="submission-success-mark" aria-hidden="true">✓</span>
      <h2 id="submission-success-title">申請已送出</h2>
      <p>申請資料與流向紀錄皆已保存。請至 LINE 選單的「進度查詢」查看狀態。</p>
      <div className="applicant-actions" style={{ justifyContent: 'center', marginTop: '1.25rem' }}>
        <Link className="primary-action" href="/app/passports">查看申請紀錄</Link>
      </div>
    </section>
  );
  if (!data) return <p className="pending-note" role="status">{message || '申請內容載入中…'}</p>;
  const openFollowUps = data.followUps.filter((question) => question.status === 'open');
  const followUpsReadyToRevise = data.version.workflowState === 'follow_up_required'
    && openFollowUps.length === 0
    && data.followUps.some((question) => question.required && question.status === 'answered');
  if (revisionJobId) return <section className="passport-review-panel passport-review-panel--waiting" aria-label="正在整理護照"><AiWaitingStatus phase={revisionProgressPercent >= 100 ? 'completed' : revisionProgressPercent > 5 ? 'working' : 'queued'} elapsedSeconds={Math.round(revisionProgressPercent * 2)} saved /></section>;
  if (data.version.workflowState === 'confirmed') return (
    <section className="passport-review-panel attachment-workflow" aria-label="附件與送出申請">
      {message && <p className="pending-note" role="status">{message}</p>}
      <section className="application-step-complete" aria-label="申請內容已完成">
        <span aria-hidden="true">✓</span>
        <div><p className="eyebrow">第 1 部分</p><h2>申請內容已完成</h2><p>接著請填寫購買資料並上傳必備附件。</p></div>
      </section>
      <DocumentReview suppliedCaseId={caseId} onSubmit={() => void submitApplication()} submitting={busy} prefilledTool={prefilledTool} />
    </section>
  );
  return (
    <section className="passport-review-panel" aria-label="申請內容">
      {message && <p className="pending-note" role={inputBlocked ? 'alert' : 'status'}>{message}</p>}
      {revisionFailed && !inputBlocked && <button type="button" className="secondary-action" onClick={() => void retryRevision()} disabled={busy}>重新整理</button>}
      <ApplicantPassportSummary passport={data.passport} workflowState={data.version.workflowState} onContinue={data.version.workflowState === 'needs_applicant_confirmation' ? () => void confirmApplication() : undefined} busy={busy} />
      {openFollowUps.length > 0 && !inputBlocked && (
        <AiFollowUpForm
          questions={openFollowUps}
          onSubmit={(answers) => void saveFollowUps(answers, false)}
          onRegenerate={(answers) => void saveFollowUps(answers, true)}
          submitting={busy}
          regenerating={busy}
        />
      )}
      {followUpsReadyToRevise && !inputBlocked && (
        <div className="wizard-actions">
          <button type="button" className="primary-action" disabled={busy} onClick={() => { setBusy(true); void startRevision().catch((error) => handleRevisionError(error)).finally(() => setBusy(false)); }}>
            {busy ? '重新產生中…' : '重新產生護照'}
          </button>
        </div>
      )}
      <div className="wizard-actions">
        {confirmStartOver ? (
          <>
            <p role="alert">放棄後，這筆草稿和已產生的護照都會刪除，需要重新回答四題。</p>
            <button type="button" className="secondary-action" onClick={() => setConfirmStartOver(false)} disabled={startingOver}>取消</button>
            <button type="button" className="primary-action" onClick={() => void startOver()} disabled={startingOver}>{startingOver ? '處理中…' : '確定放棄並重新填寫'}</button>
          </>
        ) : (
          <button type="button" className={inputBlocked ? 'primary-action' : 'secondary-action'} onClick={() => setConfirmStartOver(true)} disabled={busy}>放棄這筆、重新填寫</button>
        )}
      </div>
    </section>
  );
}
