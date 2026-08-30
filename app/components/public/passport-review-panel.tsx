'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FlowPassPassport } from '../../../shared/passport-contract';
import { PublicApiClient, PublicApiError } from '../../lib/public-api';
import { parseFlowPassJson } from '../../passport-parser';
import { PassportViewer } from '../../passport-viewer';
import { AiFollowUpForm, type AiFollowUpAnswer, type AiFollowUpQuestion } from './ai-follow-up-form';

interface PassportApiData {
  version: { id: string; versionNo: number; workflowState: string };
  passport: FlowPassPassport;
  followUps: AiFollowUpQuestion[];
  etag: string;
}

function caseIdFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('caseId');
}

export function PassportReviewPanel({ caseId: suppliedCaseId }: { caseId?: string } = {}) {
  const [caseId, setCaseId] = useState<string | null>(suppliedCaseId ?? caseIdFromLocation());
  const [data, setData] = useState<PassportApiData | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [revisionJobId, setRevisionJobId] = useState<string | null>(null);
  const [revisionFailed, setRevisionFailed] = useState(false);
  const api = useMemo(() => new PublicApiClient(), []);

  const load = useCallback(async (id: string) => {
    try {
      const next = await api.read<PassportApiData>(`/api/v1/cases/${encodeURIComponent(id)}/passport`);
      setData(next);
      setMessage('');
    } catch (error) {
      setMessage(error instanceof PublicApiError && error.status === 404 ? '目前還沒有可檢視的護照草稿。' : '護照資料暫時無法載入，請稍後再試。');
    }
  }, [api]);

  useEffect(() => {
    const onCaseReady = (event: Event) => {
      const detail = (event as CustomEvent<{ caseId?: unknown }>).detail;
      if (typeof detail?.caseId === 'string' && detail.caseId) setCaseId(detail.caseId);
    };
    window.addEventListener('flowpass-case-ready', onCaseReady);
    const onPassportReady = () => { const id = caseId ?? caseIdFromLocation(); if (id) void load(id); };
    window.addEventListener('flowpass-passport-ready', onPassportReady);
    return () => { window.removeEventListener('flowpass-case-ready', onCaseReady); window.removeEventListener('flowpass-passport-ready', onPassportReady); };
  }, [caseId, load]);

  useEffect(() => {
    if (!caseId) return;
    const timer = window.setTimeout(() => { void load(caseId); }, 0);
    return () => window.clearTimeout(timer);
  }, [caseId, load]);

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
    } catch { setRevisionFailed(true); setMessage('新版護照尚未完成整理，請按「重試整理」。'); } finally { setBusy(false); }
  }

  async function waitForRevision(jobId: string) {
    setRevisionJobId(jobId); setRevisionFailed(false); setMessage('補充資訊已收到，正在重新整理新版護照…');
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const job = await api.read<{ state: string }>(`/api/v1/jobs/${encodeURIComponent(jobId)}`);
      if (job.state === 'completed') { setRevisionJobId(null); await load(caseId!); return; }
      if (job.state === 'failed_terminal') throw new Error('revision failed');
      await new Promise((resolve) => window.setTimeout(resolve, 1_000));
    }
    throw new Error('revision timeout');
  }

  async function retryRevision() {
    if (!caseId) return;
    setBusy(true);
    try {
      const current = await api.read<{ rowVersion: number }>(`/api/v1/cases/${encodeURIComponent(caseId)}`);
      const queued = await api.mutate<{ jobId: string }>(`/api/v1/cases/${encodeURIComponent(caseId)}/ai-drafts`, { method: 'POST', ifMatch: `"${current.rowVersion}"`, body: { operation: 'revise', retry: true } });
      await waitForRevision(queued.jobId);
    } catch { setRevisionFailed(true); setMessage('新版護照尚未完成整理，請稍後再試。'); } finally { setBusy(false); }
  }

  async function confirmOrSubmit() {
    if (!caseId || !data) return;
    setBusy(true);
    try {
      if (data.version.workflowState !== 'confirmed') {
        await api.mutate(`/api/v1/cases/${encodeURIComponent(caseId)}/confirmations`, { method: 'POST', ifMatch: data.etag, body: { passportVersionId: data.version.id, answers: [], declarations: [{ confirmationType: 'passport', targetKey: 'confirm', value: true }] } });
        await load(caseId);
        setMessage('護照已確認，請再次按下「送出申請」。');
        return;
      }
      const currentCase = await api.read<{ rowVersion: number }>(`/api/v1/cases/${encodeURIComponent(caseId)}`);
      await api.mutate(`/api/v1/cases/${encodeURIComponent(caseId)}/submission`, { method: 'POST', ifMatch: `"${currentCase.rowVersion}"`, body: { passportVersionId: data.version.id } });
      setMessage('申請已送出。');
    } catch { setMessage('目前還不能送出，請先完成必要確認或稍後重試。'); } finally { setBusy(false); }
  }

  if (!caseId) return <p className="pending-note" role="status">完成申請草稿後，這裡會顯示護照版本、追問卡片與送出按鈕。</p>;
  if (!data) return <p className="pending-note" role="status">{message || '正在載入護照草稿…'}</p>;
  const result = parseFlowPassJson(JSON.stringify({ passport_draft: data.passport }));
  const canReviewSubmission = data.version.workflowState === 'needs_applicant_confirmation' || data.version.workflowState === 'confirmed';
  return (
    <section className="passport-review-panel" aria-labelledby="passport-review-title">
      <h2 id="passport-review-title">護照草稿</h2>
      {message && <p className="pending-note" role="status">{message}</p>}
      {revisionJobId && <p className="pending-note" role="status">工作編號：{revisionJobId}（不會顯示護照內容）</p>}
      {revisionFailed && <button type="button" onClick={() => void retryRevision()} disabled={busy}>重試整理</button>}
      <PassportViewer result={result} section="flow" />
      <PassportViewer result={result} section="details" workflowState={data.version.workflowState} onSubmit={canReviewSubmission ? () => void confirmOrSubmit() : undefined} canSubmit={!busy} />
      {data.version.workflowState === 'follow_up_required' && <AiFollowUpForm questions={data.followUps.filter((question) => question.status === 'open')} onSubmit={(answers) => void saveFollowUps(answers)} submitting={busy} />}
    </section>
  );
}
