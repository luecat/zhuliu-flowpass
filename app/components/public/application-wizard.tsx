'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CoreAnswers } from '../../../shared/case-contract';
import { CORE_ANSWER_LIMITS, unicodeScalarLength } from '../../../shared/case-contract';
import { bootLineLiffSession, loadLiffBrowserSdk } from '../../lib/liff-client';
import { PublicApiClient, PublicApiError } from '../../lib/public-api';

const fields: Array<{ key: keyof CoreAnswers; label: string; hint: string; limit: number }> = [
  { key: 'material', label: '要處理什麼資料？', hint: '只寫資料類型，不要貼上實際內容。', limit: CORE_ANSWER_LIMITS.material },
  { key: 'aiPurpose', label: '想用 AI 做什麼？', hint: '用一句話描述想完成的工作。', limit: CORE_ANSWER_LIMITS.aiPurpose },
  { key: 'sensitiveData', label: '可能包含哪些個資或敏感資料？', hint: '不知道可以填「不確定」，稍後再確認。', limit: CORE_ANSWER_LIMITS.sensitiveData },
  { key: 'destinationAndAudience', label: '完成後要放哪裡、分享給誰？', hint: '請寫預計的工具、位置或對象。', limit: CORE_ANSWER_LIMITS.destinationAndAudience },
];
const initial: CoreAnswers = { material: '', aiPurpose: '', sensitiveData: '', destinationAndAudience: '' };

export function ApplicationWizard() {
  const [answers, setAnswers] = useState<CoreAnswers>(initial);
  const [step, setStep] = useState(0);
  const [review, setReview] = useState(false);
  const [caseState, setCaseState] = useState<{ id: string; rowVersion: number } | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionMessage, setSessionMessage] = useState(() => process.env.NEXT_PUBLIC_FLOWPASS_LIFF_ID ? '' : '請從 LINE 開啟申請頁；本機預覽不會送出資料。');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'conflict' | 'error'>('idle');
  const [aiState, setAiState] = useState<'idle' | 'queued' | 'completed' | 'failed'>('idle');
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
    try {
      const queued = await api.mutate<{ jobId: string; state: string }>(`/api/v1/cases/${encodeURIComponent(currentCase.id)}/ai-drafts`, { method: 'POST', ifMatch: `"${currentCase.rowVersion}"`, body: { operation: 'draft', ...(aiState === 'failed' ? { retry: true } : {}) } });
      if (typeof window !== 'undefined') {
        window.history.replaceState(null, '', `/app/apply?caseId=${encodeURIComponent(currentCase.id)}`);
        window.dispatchEvent(new CustomEvent('flowpass-case-ready', { detail: { caseId: currentCase.id } }));
      }
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const job = await api.read<{ state: string }>(`/api/v1/jobs/${encodeURIComponent(queued.jobId)}`);
        if (job.state === 'completed') { setAiState('completed'); window.dispatchEvent(new CustomEvent('flowpass-passport-ready')); return; }
        if (job.state === 'failed_terminal') { setAiState('failed'); return; }
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      }
      setAiState('failed');
    } catch { setAiState('failed'); }
  }, [aiState, complete, saveStatus]);
  useEffect(() => {
    const liffId = process.env.NEXT_PUBLIC_FLOWPASS_LIFF_ID;
    if (!liffId) return;
    let cancelled = false;
    const api = new PublicApiClient();
    apiRef.current = api;
    void loadLiffBrowserSdk().then((liff) => bootLineLiffSession({ liff, api, config: { liffId } })).then(async (result) => {
      if (cancelled || result.kind !== 'authenticated') return;
      const program = await api.read<{ id: string }>('/api/v1/programs/current');
      const created = await api.mutate<{ case: { id: string; rowVersion: number } }>('/api/v1/cases', { method: 'POST', body: { programCycleId: program.id } });
      if (!cancelled) { caseRef.current = created.case; setCaseState(created.case); setSessionReady(true); }
    }).catch(() => { if (!cancelled) setSessionMessage('LINE 登入尚未完成，請重新開啟申請頁。'); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!sessionReady || !currentCaseId || !complete) return;
    const timer = window.setTimeout(() => enqueueSave(answersRef.current, caseRef.current), 500);
    return () => window.clearTimeout(timer);
  }, [answers, complete, currentCaseId, enqueueSave, sessionReady]);
  return <section className="application-wizard" aria-labelledby="apply-title">
    <p className="eyebrow">送出申請</p><h1 id="apply-title">四個問題，建立你的申請草稿</h1>{sessionMessage && <p className="pending-note" role="status">{sessionMessage}</p>}
    {!review ? <>
      <p aria-live="polite">第 {step + 1} 題，共 {fields.length}</p>
      <label htmlFor={`answer-${current.key}`}>{current.label}</label>
      <textarea id={`answer-${current.key}`} value={answers[current.key]} onChange={(event) => update(event.target.value)} required aria-required="true" aria-invalid={unicodeScalarLength(answers[current.key]) > current.limit} aria-describedby={`hint-${current.key}`} autoFocus />
      <p id={`hint-${current.key}`} className="field-hint">{current.hint}（必填，Unicode 字元 {unicodeScalarLength(answers[current.key])}/{current.limit}）</p>
      {unicodeScalarLength(answers[current.key]) > current.limit && <p role="alert">這一題超過上限，請刪減後再繼續。</p>}
      <p aria-live="polite">四題合計 Unicode 字元 {totalScalars}/{CORE_ANSWER_LIMITS.total}</p>
      <div className="wizard-actions"><button type="button" onClick={() => setStep((value) => Math.max(0, value - 1))} disabled={step === 0}>上一題</button>
        {step < fields.length - 1 ? <button type="button" onClick={() => setStep((value) => value + 1)} disabled={!answers[current.key].trim() || unicodeScalarLength(answers[current.key]) > current.limit}>下一題</button> : <button type="button" onClick={() => setReview(true)} disabled={!complete}>檢查答案</button>}</div>
    </> : <>
      <h2>送出前確認</h2><dl>{fields.map(({ key, label }) => <div key={key}><dt>{label}</dt><dd>{answers[key]}</dd></div>)}</dl>
      <p>以上內容會保留原文，確認後才會整理護照草稿。</p>
      <div className="wizard-actions"><button type="button" onClick={() => setReview(false)}>返回修改</button><button type="button" onClick={() => void startAiDraft()} disabled={saveStatus !== 'saved' || aiState === 'queued' || aiState === 'completed'}>{aiState === 'queued' ? '正在整理…' : aiState === 'completed' ? '護照已整理' : '整理護照草稿'}</button></div>
      <p className="pending-note" role="status">{saveStatus === 'saving' ? '正在儲存草稿…' : saveStatus === 'saved' && aiState === 'idle' ? '草稿已儲存，可以整理護照。' : saveStatus === 'conflict' ? '草稿版本有更新，請重試儲存。' : saveStatus === 'error' ? '草稿尚未儲存。' : aiState === 'queued' ? '正在整理護照，完成後會顯示審閱畫面。' : aiState === 'completed' ? '護照已整理完成。' : aiState === 'failed' ? '護照整理尚未完成，請稍後重試。' : '請先完成並儲存四題答案。'}</p>
      {(saveStatus === 'conflict' || saveStatus === 'error') && caseState && <button type="button" onClick={() => enqueueSave(answersRef.current, caseRef.current)}>重試儲存</button>}
    </>}
  </section>;
}
