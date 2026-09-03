'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CoreAnswers } from '../../../shared/case-contract';
import { CORE_ANSWER_LIMITS, unicodeScalarLength } from '../../../shared/case-contract';
import { PublicApiClient, PublicApiError } from '../../lib/public-api';
import { AiWaitingStatus } from './ai-waiting-status';
import { useLiffSession } from './liff-session-provider';

const fields: Array<{ key: keyof CoreAnswers; label: string; hint: string; limit: number }> = [
  { key: 'material', label: '要處理什麼資料？', hint: '只寫資料類型，不要貼上實際內容。', limit: CORE_ANSWER_LIMITS.material },
  { key: 'aiPurpose', label: '想用 AI 做什麼？', hint: '用一句話描述想完成的工作。', limit: CORE_ANSWER_LIMITS.aiPurpose },
  { key: 'sensitiveData', label: '可能包含哪些個資或敏感資料？', hint: '不知道可以填「不確定」，稍後再確認。', limit: CORE_ANSWER_LIMITS.sensitiveData },
  { key: 'destinationAndAudience', label: '完成後要放哪裡、分享給誰？', hint: '請寫預計的工具、位置或對象。', limit: CORE_ANSWER_LIMITS.destinationAndAudience },
];
const initial: CoreAnswers = { material: '', aiPurpose: '', sensitiveData: '', destinationAndAudience: '' };
const AI_PROGRESS_DURATION_SECONDS = 200;
const AI_PROGRESS_TICK_MS = 1_000;
const AI_JOB_POLL_INTERVAL_SECONDS = 20;
interface ApplicantApplicationCase {
  id: string;
  state: string;
  rowVersion: number;
  updatedAt: string;
  answers: CoreAnswers | null;
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
  const [aiFailureMessage, setAiFailureMessage] = useState('');
  const [aiProgressPercent, setAiProgressPercent] = useState(0);
  const [reviewOpen, setReviewOpen] = useState(false);
  const apiRef = useRef<PublicApiClient | null>(null);
  const answersRef = useRef(answers);
  const caseRef = useRef(caseState);
  const pendingRef = useRef<{ answers: CoreAnswers; caseState: { id: string; rowVersion: number } } | null>(null);
  const runnerRef = useRef<Promise<void> | null>(null);
  const current = fields[step];
  const currentCaseId = caseState?.id;
  const totalScalars = useMemo(() => fields.reduce((total, field) => total + unicodeScalarLength(answers[field.key]), 0), [answers]);
  const complete = useMemo(() => fields.every(({ key, limit }) => answers[key].trim().length > 0 && unicodeScalarLength(answers[key]) <= limit) && totalScalars <= CORE_ANSWER_LIMITS.total, [answers, totalScalars]);
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
          if (error instanceof PublicApiError && (error.status === 401 || error.status === 403)) setSessionMessage('登入已失效，請重新開啟申請頁後再試。');
          setSaveStatus(error instanceof PublicApiError && error.status === 409 ? 'conflict' : 'error');
          pendingRef.current = pending;
          break;
        }
      }
    }
  }, []);
  const enqueueSave = useCallback((nextAnswers: CoreAnswers, nextCase: { id: string; rowVersion: number } | null) => {
    if (!nextCase) return;
    pendingRef.current = { answers: nextAnswers, caseState: nextCase };
    if (!runnerRef.current) { const runner = runSaveQueue(); runnerRef.current = runner; void runner.finally(() => { if (runnerRef.current === runner) runnerRef.current = null; }); }
  }, [runSaveQueue]);
  const startAiDraft = useCallback(async () => {
    const api = apiRef.current;
    const currentCase = caseRef.current;
    if (!api || !currentCase || saveStatus !== 'saved' || !complete) return;
    setAiState('queued');
    setAiFailureMessage('');
    setAiProgressPercent(0);
    try {
      const queued = await api.mutate<{ jobId: string; state: string }>(`/api/v1/cases/${encodeURIComponent(currentCase.id)}/ai-drafts`, { method: 'POST', ifMatch: `"${currentCase.rowVersion}"`, body: { operation: 'draft', ...(aiState === 'failed' ? { retry: true } : {}) } });
      if (typeof window !== 'undefined') {
        window.history.replaceState(null, '', `/app/apply?caseId=${encodeURIComponent(currentCase.id)}`);
      }
      for (let elapsedSeconds = 1; ; elapsedSeconds += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, AI_PROGRESS_TICK_MS));
        setAiProgressPercent(elapsedSeconds >= AI_PROGRESS_DURATION_SECONDS ? 99 : Math.floor((elapsedSeconds / AI_PROGRESS_DURATION_SECONDS) * 100));
        if (elapsedSeconds % AI_JOB_POLL_INTERVAL_SECONDS !== 0) continue;
        const job = await api.read<{ state: string; errorCode?: string | null }>(`/api/v1/jobs/${encodeURIComponent(queued.jobId)}`);
        if (job.state === 'completed') { setAiProgressPercent(100); setAiState('completed'); window.dispatchEvent(new CustomEvent('flowpass-passport-ready')); return; }
        if (job.state === 'failed_terminal') {
          setAiFailureMessage(job.errorCode === 'AI_INPUT_INVALID'
            ? '這些回答看起來不像是在描述實際流程，請重新填寫資料類型、用途、個資情況與分享對象。'
            : '');
          setAiState('failed');
          return;
        }
        if (job.state !== 'queued' && job.state !== 'leased') { setAiState('failed'); return; }
      }
    } catch (error) {
      setAiFailureMessage(error instanceof PublicApiError && error.code === 'AI_INPUT_UNSAFE'
        ? '回答中包含像是要操作 AI 或系統的指令。請只填寫實際的資料類型、用途、個資情況與分享對象。'
        : '處理失敗，請重試');
      setAiState('failed');
    }
  }, [aiState, complete, saveStatus]);
  useEffect(() => {
    const api = liffSession.api;
    if (liffSession.status !== 'authenticated' || !api || caseRef.current) return;
    let cancelled = false;
    apiRef.current = api;
    const open = (applicationCase: ApplicantApplicationCase) => {
      if (cancelled) return;
      const state = { id: applicationCase.id, rowVersion: applicationCase.rowVersion };
      caseRef.current = state;
      setCaseState(state);
      if (applicationCase.answers) {
        answersRef.current = applicationCase.answers;
        setAnswers(applicationCase.answers);
        setSaveStatus('saved');
      }
      setSessionReady(true);
    };
    void (async () => {
      const requested = new URLSearchParams(window.location.search).get('caseId');
      if (requested) {
        open(await api.read<ApplicantApplicationCase>(`/api/v1/cases/${encodeURIComponent(requested)}`));
        return;
      }
      const program = await api.read<{ id: string }>('/api/v1/programs/current');
      const created = await api.mutate<{ case: { id: string; rowVersion: number; updatedAt: string } }>('/api/v1/cases', { method: 'POST', body: { programCycleId: program.id } });
      open({ ...created.case, state: 'draft', answers: null });
    })().catch(() => {
      if (!cancelled) setSessionMessage('申請頁暫時無法開啟，請稍後再試。');
    });
    return () => { cancelled = true; };
  }, [liffSession.api, liffSession.status]);
  useEffect(() => {
    const openReview = () => setReviewOpen(true);
    window.addEventListener('flowpass-review-open', openReview);
    return () => window.removeEventListener('flowpass-review-open', openReview);
  }, []);
  useEffect(() => {
    if (!sessionReady || !currentCaseId || !complete) return;
    const timer = window.setTimeout(() => enqueueSave(answersRef.current, caseRef.current), 500);
    return () => window.clearTimeout(timer);
  }, [answers, complete, currentCaseId, enqueueSave, sessionReady]);
  if (reviewOpen) return null;
  if (aiState === 'queued') {
    return <section className="application-wizard application-wizard--waiting" aria-label="正在整理護照"><AiWaitingStatus progressPercent={aiProgressPercent} /></section>;
  }
  return <section className="application-wizard" aria-labelledby={review ? 'review-title' : 'question-title'}>
    {sessionMessage && <p className="pending-note" role="status">{sessionMessage}</p>}
    {!review ? <>
      <p className="question-progress" aria-live="polite">第 {step + 1} 題</p>
      <h1 id="question-title">{current.label}</h1>
      <textarea id={`answer-${current.key}`} value={answers[current.key]} onChange={(event) => update(event.target.value)} placeholder={current.hint} required aria-required="true" aria-invalid={unicodeScalarLength(answers[current.key]) > current.limit} aria-labelledby="question-title" aria-describedby={`hint-${current.key}`} autoFocus />
      <p id={`hint-${current.key}`} className="field-hint">必填 · {unicodeScalarLength(answers[current.key])}/{current.limit}</p>
      {unicodeScalarLength(answers[current.key]) > current.limit && <p role="alert">這一題超過上限，請刪減後再繼續。</p>}
      <div className="wizard-actions"><button type="button" onClick={() => setStep((value) => Math.max(0, value - 1))} disabled={step === 0}>上一題</button>
        {step < fields.length - 1 ? <button type="button" onClick={() => setStep((value) => value + 1)} disabled={!answers[current.key].trim() || unicodeScalarLength(answers[current.key]) > current.limit}>下一題</button> : <button type="button" onClick={() => setReview(true)} disabled={!complete}>檢查答案</button>}</div>
    </> : <>
      <h2 id="review-title">送出前確認</h2><dl>{fields.map(({ key, label }) => <div key={key}><dt>{label}</dt><dd>{answers[key]}</dd></div>)}</dl>
      <p>送出後需回答後續問題。</p>
      <div className="wizard-actions"><button type="button" onClick={() => setReview(false)}>返回修改</button><button type="button" onClick={() => void startAiDraft()} disabled={saveStatus !== 'saved' || aiState === 'completed'}>{aiState === 'completed' ? '已完成' : '下一步'}</button></div>
      {(saveStatus === 'saving' || saveStatus === 'conflict' || saveStatus === 'error' || aiState === 'failed') && <p className="pending-note" role="status">{saveStatus === 'saving' ? '正在儲存資料…' : saveStatus === 'conflict' ? '資料已有更新，請再儲存一次。' : saveStatus === 'error' ? '資料尚未儲存，請稍後再試。' : aiFailureMessage || '處理失敗，請重試'}</p>}
      {(saveStatus === 'conflict' || saveStatus === 'error') && caseState && <button type="button" onClick={() => enqueueSave(answersRef.current, caseRef.current)}>重試儲存</button>}
    </>}
  </section>;
}
