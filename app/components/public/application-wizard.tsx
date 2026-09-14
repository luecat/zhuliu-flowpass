'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CoreAnswers } from '../../../shared/case-contract';
import { CORE_ANSWER_LIMITS, unicodeScalarLength } from '../../../shared/case-contract';
import { PublicApiClient, PublicApiError } from '../../lib/public-api';
import { AiWaitingStatus, type AiWaitingPhase } from './ai-waiting-status';
import { useLiffSession } from './liff-session-provider';

const fields: Array<{ key: keyof CoreAnswers; label: string; hint: string; placeholder: string; limit: number }> = [
  { key: 'material', label: '要處理什麼資料？', hint: '僅需簡述資料類型（如照片、影片、文字稿），為保護隱私請勿貼上實際內容。', placeholder: '例如：社團照片、活動影片或演講文字稿', limit: CORE_ANSWER_LIMITS.material },
  { key: 'aiPurpose', label: '想用 AI 做什麼？', hint: '以一句話描述預計完成的任務。', placeholder: '例如：修圖、剪輯影片、整理文字或產生摘要', limit: CORE_ANSWER_LIMITS.aiPurpose },
  { key: 'sensitiveData', label: '可能包含哪些個資或敏感資料？', hint: '勾選可能包含的敏感個資，例如人臉、姓名或金融帳號；若不確定請填「不確定」。', placeholder: '例如：人臉、姓名、金鑰；不確定可填「不確定」', limit: CORE_ANSWER_LIMITS.sensitiveData },
  { key: 'destinationAndAudience', label: '完成後要放哪裡、分享給誰？', hint: '填寫預計使用的工具、存放位置或公開分享對象。', placeholder: '例如：團隊雲端硬碟、社團內部成員或公開社群平台', limit: CORE_ANSWER_LIMITS.destinationAndAudience },
];
const initial: CoreAnswers = { material: '', aiPurpose: '', sensitiveData: '', destinationAndAudience: '', applicantName: '' };
const AI_JOB_POLL_INTERVAL_SECONDS = 5;
interface ApplicantApplicationCase {
  id: string;
  state: string;
  rowVersion: number;
  updatedAt: string;
  answers: CoreAnswers | null;
}

function firstIncompleteStep(answers: CoreAnswers): number {
  const index = fields.findIndex(({ key, limit }) => !answers[key].trim() || unicodeScalarLength(answers[key]) > limit);
  return index === -1 ? fields.length - 1 : index;
}

function fieldComplete(answers: CoreAnswers, key: keyof CoreAnswers, limit: number): boolean {
  return answers[key].trim().length > 0 && unicodeScalarLength(answers[key]) <= limit;
}

function waitingPhase(state: string): AiWaitingPhase {
  if (state === 'leased') return 'working';
  if (state === 'queued') return 'queued';
  return 'submitted';
}

export function ApplicationWizard() {
  const liffSession = useLiffSession();
  const [answers, setAnswers] = useState<CoreAnswers>(initial);
  const [step, setStep] = useState(0);
  const [review, setReview] = useState(false);
  const [caseState, setCaseState] = useState<{ id: string; rowVersion: number } | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionMessage, setSessionMessage] = useState('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'conflict' | 'error'>('idle');
  const [aiState, setAiState] = useState<'idle' | 'queued' | 'completed' | 'failed'>('idle');
  const [aiPhase, setAiPhase] = useState<AiWaitingPhase>('submitted');
  const [aiFailureMessage, setAiFailureMessage] = useState('');
  const [aiElapsedSeconds, setAiElapsedSeconds] = useState(0);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [resumedDraft, setResumedDraft] = useState(false);
  const apiRef = useRef<PublicApiClient | null>(null);
  const answersRef = useRef(answers);
  const caseRef = useRef(caseState);
  const pendingRef = useRef<{ answers: CoreAnswers; caseState: { id: string; rowVersion: number } } | null>(null);
  const runnerRef = useRef<Promise<void> | null>(null);
  const current = fields[step];
  const currentCaseId = caseState?.id;
  const totalScalars = useMemo(() => fields.reduce((total, field) => total + unicodeScalarLength(answers[field.key]), 0), [answers]);
  const complete = useMemo(() => fields.every(({ key, limit }) => fieldComplete(answers, key, limit)) && totalScalars <= CORE_ANSWER_LIMITS.total, [answers, totalScalars]);
  const hasPartialDraft = useMemo(() => fields.some(({ key, limit }) => fieldComplete(answers, key, limit)), [answers]);
  const update = (value: string) => { const next = { ...answersRef.current, [current.key]: value }; answersRef.current = next; setAnswers(next); };
  const runSaveQueue = useCallback(async () => {
    let conflictRetries = 0;
    while (pendingRef.current) {
      const pending = pendingRef.current; pendingRef.current = null;
      const api = apiRef.current;
      if (!api) return;
      setSaveStatus('saving');
      try {
        const saved = await api.mutate<{ case: { rowVersion: number } }>(`/api/v1/cases/${pending.caseState.id}/answers`, { method: 'PUT', ifMatch: `"${pending.caseState.rowVersion}"`, body: pending.answers });
        const next = { ...pending.caseState, rowVersion: saved.case.rowVersion }; caseRef.current = next; setCaseState(next); setSaveStatus('saved'); conflictRetries = 0;
      } catch (error) {
        if (error instanceof PublicApiError && error.status === 409 && conflictRetries < 1) {
          conflictRetries += 1; setSaveStatus('conflict');
          try { const currentCase = await api.read<{ rowVersion: number }>(`/api/v1/cases/${pending.caseState.id}`); const refreshed = { ...pending.caseState, rowVersion: currentCase.rowVersion }; caseRef.current = refreshed; setCaseState(refreshed); pendingRef.current = { answers: answersRef.current, caseState: refreshed }; } catch { setSaveStatus('error'); }
        } else {
          if (error instanceof PublicApiError && (error.status === 401 || error.status === 403)) setSessionMessage('登入已失效，請重新開啟申請頁。');
          setSaveStatus(error instanceof PublicApiError && error.status === 409 ? 'conflict' : 'error');
          pendingRef.current = pending;
          break;
        }
      }
    }
  }, []);
  const enqueueSave = useCallback((nextAnswers: CoreAnswers, nextCase: { id: string; rowVersion: number } | null) => {
    if (!nextCase) return;
    if (!fields.some(({ key, limit }) => fieldComplete(nextAnswers, key, limit))) return;
    pendingRef.current = { answers: nextAnswers, caseState: nextCase };
    if (!runnerRef.current) { const runner = runSaveQueue(); runnerRef.current = runner; void runner.finally(() => { if (runnerRef.current === runner) runnerRef.current = null; }); }
  }, [runSaveQueue]);
  const openPassportReview = useCallback((caseId: string) => {
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', `/app/apply?caseId=${encodeURIComponent(caseId)}`);
    }
    setReviewOpen(true);
    setAiState('completed');
    window.dispatchEvent(new CustomEvent('flowpass-passport-ready'));
  }, []);
  const pollAiJob = useCallback(async (api: PublicApiClient, jobId: string, caseId: string) => {
    setAiState('queued');
    setAiFailureMessage('');
    setAiElapsedSeconds(0);
    setAiPhase('submitted');
    for (let elapsedSeconds = 1; ; elapsedSeconds += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      setAiElapsedSeconds(elapsedSeconds);
      if (elapsedSeconds % AI_JOB_POLL_INTERVAL_SECONDS !== 0) continue;
      const job = await api.read<{ state: string; errorCode?: string | null }>(`/api/v1/jobs/${encodeURIComponent(jobId)}`);
      setAiPhase(waitingPhase(job.state));
      if (job.state === 'completed') {
        setAiPhase('completed');
        setAiState('completed');
        window.dispatchEvent(new CustomEvent('flowpass-passport-ready'));
        openPassportReview(caseId);
        return;
      }
      if (job.state === 'failed_terminal') {
        setAiFailureMessage(job.errorCode === 'AI_INPUT_INVALID'
          ? '內容缺乏具體流程，請重新描述實際的資料類型、用途與分享對象。'
          : job.errorCode === 'MODEL_UNAVAILABLE' || job.errorCode === 'AI_ADAPTER_UNAVAILABLE'
            ? '系統暫時無法使用，請稍後再試。'
            : '處理失敗，請稍後再試。');
        setAiState('failed');
        return;
      }
      if (job.state !== 'queued' && job.state !== 'leased') {
        setAiFailureMessage('處理失敗，請稍後再試。');
        setAiState('failed');
        return;
      }
    }
  }, [openPassportReview]);
  const startAiDraft = useCallback(async () => {
    const api = apiRef.current;
    const currentCase = caseRef.current;
    if (!api || !currentCase || saveStatus !== 'saved' || !complete) return;
    setAiState('queued');
    setAiFailureMessage('');
    setAiElapsedSeconds(0);
    setAiPhase('submitted');
    try {
      try {
        await api.read(`/api/v1/cases/${encodeURIComponent(currentCase.id)}/passport`);
        openPassportReview(currentCase.id);
        return;
      } catch (error) {
        if (!(error instanceof PublicApiError && error.status === 404)) throw error;
      }
      const refreshed = await api.read<{ rowVersion: number }>(`/api/v1/cases/${encodeURIComponent(currentCase.id)}`);
      const matched = { ...currentCase, rowVersion: refreshed.rowVersion };
      caseRef.current = matched;
      setCaseState(matched);
      const queued = await api.mutate<{ jobId: string; state: string }>(`/api/v1/cases/${encodeURIComponent(matched.id)}/ai-drafts`, { method: 'POST', ifMatch: `"${matched.rowVersion}"`, body: { operation: 'draft', ...(aiState === 'failed' ? { retry: true } : {}) } });
      if (typeof window !== 'undefined') {
        window.history.replaceState(null, '', `/app/apply?caseId=${encodeURIComponent(matched.id)}`);
      }
      setAiPhase(waitingPhase(queued.state));
      await pollAiJob(api, queued.jobId, matched.id);
    } catch (error) {
      setAiFailureMessage(error instanceof PublicApiError && error.code === 'AI_INPUT_UNSAFE'
        ? '內容包含系統指令，請僅填寫實際流程。'
        : error instanceof PublicApiError && error.code === 'ETAG_MISMATCH'
          ? '資料已更新，請重新點擊「產生資料流向草稿」。'
          : error instanceof PublicApiError && error.code === 'RATE_LIMITED'
            ? '整理次數已達上限，請稍後再試。'
            : '處理失敗，請稍後再試。');
      setAiState('failed');
    }
  }, [aiState, complete, openPassportReview, pollAiJob, saveStatus]);
  useEffect(() => {
    const api = liffSession.api;
    if (liffSession.status !== 'authenticated' || !api || caseRef.current) return;
    let cancelled = false;
    apiRef.current = api;
    const open = async (applicationCase: ApplicantApplicationCase, options: { resumed?: boolean } = {}) => {
      if (cancelled) return;
      const state = { id: applicationCase.id, rowVersion: applicationCase.rowVersion };
      caseRef.current = state;
      setCaseState(state);
      if (applicationCase.answers) {
        answersRef.current = applicationCase.answers;
        setAnswers(applicationCase.answers);
        setStep(firstIncompleteStep(applicationCase.answers));
        setSaveStatus('saved');
        if (options.resumed || fields.some(({ key }) => applicationCase.answers?.[key]?.trim())) {
          setResumedDraft(true);
        }
      }
      setSessionReady(true);
      if (typeof window !== 'undefined') {
        window.history.replaceState(null, '', `/app/apply?caseId=${encodeURIComponent(applicationCase.id)}`);
      }
      try {
        await api.read(`/api/v1/cases/${encodeURIComponent(applicationCase.id)}/passport`);
        if (!cancelled) openPassportReview(applicationCase.id);
        return;
      } catch {
        /* draft without passport yet */
      }
      try {
        const active = await api.read<{ jobId: string; state: string }>(`/api/v1/cases/${encodeURIComponent(applicationCase.id)}/ai-drafts`);
        if (!cancelled && (active.state === 'queued' || active.state === 'leased')) {
          setAiPhase(waitingPhase(active.state));
          void pollAiJob(api, active.jobId, applicationCase.id);
        }
      } catch {
        /* no active AI job to resume */
      }
    };
    void (async () => {
      const params = new URLSearchParams(window.location.search);
      const requested = params.get('caseId');
      if (requested) {
        await open(await api.read<ApplicantApplicationCase>(`/api/v1/cases/${encodeURIComponent(requested)}`), { resumed: true });
        return;
      }
      const program = await api.read<{ id: string }>('/api/v1/programs/current');
      const reuseFromCaseId = params.get('reuseFrom');
      const created = await api.mutate<{ case: { id: string; rowVersion: number; updatedAt: string }; reused?: boolean }>('/api/v1/cases', {
        method: 'POST',
        body: {
          programCycleId: program.id,
          ...(reuseFromCaseId ? { reuseFromCaseId } : {}),
        },
      });
      const full = await api.read<ApplicantApplicationCase>(`/api/v1/cases/${encodeURIComponent(created.case.id)}`);
      await open(full, { resumed: Boolean(full.answers) });
    })().catch((error) => {
      if (cancelled) return;
      if (error instanceof PublicApiError && error.code === 'RATE_LIMITED') {
        setSessionMessage('今天建立申請的次數已用完，請明天再試，或從申請紀錄打開未完成的草稿。');
        return;
      }
      setSessionMessage('申請頁暫時無法開啟，請稍後再試。');
    });
    return () => { cancelled = true; };
  }, [liffSession.api, liffSession.status, openPassportReview, pollAiJob]);
  useEffect(() => {
    const openReview = () => setReviewOpen(true);
    window.addEventListener('flowpass-review-open', openReview);
    return () => window.removeEventListener('flowpass-review-open', openReview);
  }, []);
  useEffect(() => {
    if (!sessionReady || !currentCaseId || !hasPartialDraft) return;
    const timer = window.setTimeout(() => enqueueSave(answersRef.current, caseRef.current), 500);
    return () => window.clearTimeout(timer);
  }, [answers, currentCaseId, enqueueSave, hasPartialDraft, sessionReady]);
  if (reviewOpen) return null;
  if (aiState === 'queued') {
    return (
      <section className="application-wizard application-wizard--waiting" aria-label="正在整理資料流向">
        <AiWaitingStatus phase={aiPhase} elapsedSeconds={aiElapsedSeconds} saved />
      </section>
    );
  }
  if (liffSession.status === 'authenticated' && !sessionReady && !sessionMessage) {
    return (
      <section className="application-wizard" aria-busy="true">
        <div className="applicant-state-card" role="status">
          <span className="applicant-loading-mark" aria-hidden="true" />
          <p>正在準備申請頁…</p>
        </div>
      </section>
    );
  }
  return <section className="application-wizard" aria-labelledby={review ? 'review-title' : 'question-title'}>
    {sessionMessage && <p className="pending-note" role="status">{sessionMessage}</p>}
    {(sessionReady || liffSession.status !== 'authenticated') && !sessionMessage && <>
      {resumedDraft && <p className="pending-note" role="status">已載入未完成的草稿內容</p>}
      {!review ? <>
        <p className="question-progress" aria-live="polite">第 {step + 1} / {fields.length} 題</p>
        <h1 id="question-title">{current.label}</h1>
        <textarea id={`answer-${current.key}`} value={answers[current.key]} onChange={(event) => update(event.target.value)} placeholder={current.placeholder} required aria-required="true" aria-invalid={unicodeScalarLength(answers[current.key]) > current.limit} aria-labelledby="question-title" aria-describedby={`hint-${current.key} guidance-${current.key}`} autoFocus />
        <p id={`guidance-${current.key}`} className="field-guidance">{current.hint}</p>
        <p id={`hint-${current.key}`} className="field-hint">必填 · {unicodeScalarLength(answers[current.key])}/{current.limit}{saveStatus === 'saving' ? ' · 儲存中' : saveStatus === 'saved' && hasPartialDraft ? ' · 已儲存' : saveStatus === 'error' ? ' · 儲存失敗' : ''}</p>
        {unicodeScalarLength(answers[current.key]) > current.limit && <p role="alert">字數已超過上限，請精簡內容後再繼續。</p>}
        <div className="wizard-actions"><button type="button" onClick={() => setStep((value) => Math.max(0, value - 1))} disabled={step === 0}>上一題</button>
          {step < fields.length - 1 ? <button type="button" onClick={() => setStep((value) => value + 1)} disabled={!answers[current.key].trim() || unicodeScalarLength(answers[current.key]) > current.limit}>下一題</button> : <button type="button" onClick={() => setReview(true)} disabled={!complete}>檢查答案</button>}</div>
      </> : <>
        <h2 id="review-title">送出前確認</h2><dl>{fields.map(({ key, label }) => <div key={key}><dt>{label}</dt><dd>{answers[key]}</dd></div>)}</dl>
        <p>確認後會產生資料流向草稿，之後還需回答追問並上傳附件。</p>
        <div className="wizard-actions"><button type="button" onClick={() => setReview(false)}>返回修改</button><button type="button" onClick={() => void startAiDraft()} disabled={saveStatus !== 'saved' || aiState === 'completed'}>{aiState === 'completed' ? '已完成' : '產生資料流向草稿'}</button></div>
        {(saveStatus === 'saving' || saveStatus === 'conflict' || saveStatus === 'error' || aiState === 'failed') && (
          <p className="pending-note" role="status">
            {saveStatus === 'saving'
              ? '儲存中'
              : saveStatus === 'conflict'
                ? '資料版本不一致，請點擊重試'
                : saveStatus === 'error'
                  ? '儲存失敗，請點擊重試'
                  : aiFailureMessage || '處理失敗，請稍後再試。'}
          </p>
        )}
        {(saveStatus === 'conflict' || saveStatus === 'error') && caseState && (
          <button type="button" className="secondary-action" onClick={() => enqueueSave(answersRef.current, caseRef.current)}>
            重試儲存
          </button>
        )}
      </>}
    </>}
  </section>;
}
