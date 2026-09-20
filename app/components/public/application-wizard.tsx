'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CoreAnswers } from '../../../shared/case-contract';
import { CORE_ANSWER_LIMITS, unicodeScalarLength } from '../../../shared/case-contract';
import {
  RETENTION_DURATION_CHOICES,
  SENSITIVE_DATA_CHOICES,
  isSensitiveNone,
  sensitiveChoiceFromStored,
  type SensitiveDataChoice,
} from '../../../shared/intake-choices';
import {
  approvedAiToolChoiceOptions,
  findApprovedAiTool,
  isOtherChoiceLabel,
} from '../../../shared/approved-ai-tools';
import { PublicApiClient, PublicApiError } from '../../lib/public-api';
import { AiWaitingStatus, type AiWaitingPhase } from './ai-waiting-status';
import { ChoiceList } from './choice-list';
import { useLiffSession } from './liff-session-provider';

type WizardFieldKey = keyof Pick<
  CoreAnswers,
  'material' | 'aiPurpose' | 'sensitiveData' | 'destinationAndAudience' | 'requestedTool' | 'retentionDuration'
>;

type WizardField = {
  key: WizardFieldKey;
  label: string;
  hint: string;
  placeholder?: string;
  limit: number;
  input: 'text' | 'sensitive' | 'tool' | 'retention';
};

const fields: WizardField[] = [
  {
    key: 'material',
    label: '要處理什麼資料？',
    hint: '僅需簡述資料類型（如照片、影片、文字稿），為保護隱私請勿貼上實際內容。',
    placeholder: '例如：社團照片、活動影片或演講文字稿',
    limit: CORE_ANSWER_LIMITS.material,
    input: 'text',
  },
  {
    key: 'aiPurpose',
    label: '想用 AI 做什麼？',
    hint: '以一句話描述預計完成的任務。',
    placeholder: '例如：修圖、剪輯影片、整理文字或產生摘要',
    limit: CORE_ANSWER_LIMITS.aiPurpose,
    input: 'text',
  },
  {
    key: 'sensitiveData',
    label: '是否包含個資或敏感資料？',
    hint: '選「有」時請簡述類型（如人臉、姓名、金鑰）；請勿貼上實際內容。',
    placeholder: '例如：人臉、姓名、金鑰',
    limit: CORE_ANSWER_LIMITS.sensitiveData,
    input: 'sensitive',
  },
  {
    key: 'destinationAndAudience',
    label: '完成後要放哪裡、分享給誰？',
    hint: '填寫預計存放位置或公開分享對象。',
    placeholder: '例如：團隊雲端硬碟、社團內部成員或公開社群平台',
    limit: CORE_ANSWER_LIMITS.destinationAndAudience,
    input: 'text',
  },
  {
    key: 'requestedTool',
    label: '使用的模型／工具？',
    hint: '請從清單選擇實際使用的 AI 工具；若不在清單中可選「其他」自行填寫。',
    limit: CORE_ANSWER_LIMITS.requestedTool,
    input: 'tool',
  },
  {
    key: 'retentionDuration',
    label: '資料保存期限？',
    hint: '請選擇處理完成後，原始或產出檔預計保留多久。',
    limit: CORE_ANSWER_LIMITS.retentionDuration,
    input: 'retention',
  },
];

const initial: CoreAnswers = {
  material: '',
  aiPurpose: '',
  sensitiveData: '',
  destinationAndAudience: '',
  requestedTool: '',
  retentionDuration: '',
  applicantName: '',
};

const AI_JOB_POLL_INTERVAL_SECONDS = 5;
const UNSAFE_INPUT_MESSAGE = '內容包含系統指令，請點「返回修改」刪除相關文字，只描述實際流程後再產生。';

const TOOL_OPTIONS = approvedAiToolChoiceOptions().map((option) => (
  option.value === '__other__'
    ? option
    : { ...option, value: option.label }
));

const RETENTION_OPTIONS = RETENTION_DURATION_CHOICES.map((choice) => ({
  value: isOtherChoiceLabel(choice) ? '__other__' : choice,
  label: choice,
}));

const SENSITIVE_OPTIONS = SENSITIVE_DATA_CHOICES.map((choice) => ({
  value: choice,
  label: choice,
}));

interface ApplicantApplicationCase {
  id: string;
  state: string;
  rowVersion: number;
  updatedAt: string;
  answers: CoreAnswers | null;
}

function firstIncompleteStep(answers: CoreAnswers): number {
  const index = fields.findIndex(({ key, limit, input }) => !fieldComplete(answers, key, limit, input));
  return index === -1 ? fields.length - 1 : index;
}

function fieldComplete(answers: CoreAnswers, key: WizardFieldKey, limit: number, input: WizardField['input']): boolean {
  const value = answers[key].trim();
  if (!value || unicodeScalarLength(answers[key]) > limit) return false;
  if (input === 'sensitive' && value === '有') return false;
  return true;
}

function sameAnswers(left: CoreAnswers, right: CoreAnswers): boolean {
  return fields.every(({ key }) => left[key] === right[key]);
}

function waitingPhase(state: string): AiWaitingPhase {
  if (state === 'leased') return 'working';
  if (state === 'queued') return 'queued';
  return 'submitted';
}

function toolSelectionFromStored(value: string): { selection: string; other: string } {
  const text = value.trim();
  if (!text) return { selection: '', other: '' };
  if (findApprovedAiTool(text) || TOOL_OPTIONS.some((option) => option.value === text && option.value !== '__other__')) {
    return { selection: findApprovedAiTool(text)?.label ?? text, other: '' };
  }
  return { selection: '__other__', other: text };
}

function retentionSelectionFromStored(value: string): { selection: string; other: string } {
  const text = value.trim();
  if (!text) return { selection: '', other: '' };
  if (RETENTION_DURATION_CHOICES.some((choice) => choice === text && !isOtherChoiceLabel(choice))) {
    return { selection: text, other: '' };
  }
  return { selection: '__other__', other: text };
}

export function ApplicationWizard() {
  const liffSession = useLiffSession();
  const [answers, setAnswers] = useState<CoreAnswers>(initial);
  const [step, setStep] = useState(0);
  const [review, setReview] = useState(false);
  const [caseState, setCaseState] = useState<{ id: string; rowVersion: number } | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionMessage, setSessionMessage] = useState('');
  /** Non-blocking note: unlike sessionMessage, the form stays on screen. */
  const [noticeMessage, setNoticeMessage] = useState('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'conflict' | 'error'>('idle');
  const [aiState, setAiState] = useState<'idle' | 'queued' | 'completed' | 'failed'>('idle');
  const [aiPhase, setAiPhase] = useState<AiWaitingPhase>('submitted');
  const [aiFailureMessage, setAiFailureMessage] = useState('');
  // Answers that produced the last failure: the message only applies to them, and unsafe input must change before retrying.
  const [failedAnswers, setFailedAnswers] = useState<{ answers: CoreAnswers; unsafe: boolean } | null>(null);
  const [aiElapsedSeconds, setAiElapsedSeconds] = useState(0);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [resumedDraft, setResumedDraft] = useState(false);
  const [toolOther, setToolOther] = useState('');
  const [retentionOther, setRetentionOther] = useState('');
  const [toolSelection, setToolSelection] = useState('');
  const [retentionSelection, setRetentionSelection] = useState('');
  const [sensitiveChoice, setSensitiveChoice] = useState<SensitiveDataChoice | ''>('');
  const apiRef = useRef<PublicApiClient | null>(null);
  const answersRef = useRef(answers);
  const caseRef = useRef(caseState);
  const pendingRef = useRef<{ answers: CoreAnswers; caseState: { id: string; rowVersion: number } } | null>(null);
  const runnerRef = useRef<Promise<void> | null>(null);
  const current = fields[step];
  const currentCaseId = caseState?.id;
  const totalScalars = useMemo(() => fields.reduce((total, field) => total + unicodeScalarLength(answers[field.key]), 0), [answers]);
  const complete = useMemo(
    () => fields.every(({ key, limit, input }) => fieldComplete(answers, key, limit, input)) && totalScalars <= CORE_ANSWER_LIMITS.total,
    [answers, totalScalars],
  );
  const hasPartialDraft = useMemo(
    () => fields.some(({ key, limit, input }) => fieldComplete(answers, key, limit, input)),
    [answers],
  );
  const failureStillApplies = aiState === 'failed' && (failedAnswers === null || sameAnswers(failedAnswers.answers, answers));
  const blockedByUnsafeInput = Boolean(failedAnswers?.unsafe) && failureStillApplies;
  const sensitiveDetail = sensitiveChoice === '有' ? answers.sensitiveData : '';
  const mayNeedFollowUp = !isSensitiveNone(answers.sensitiveData);

  const applyAnswers = useCallback((next: CoreAnswers) => {
    answersRef.current = next;
    setAnswers(next);
  }, []);

  const updateField = useCallback((key: WizardFieldKey, value: string) => {
    applyAnswers({ ...answersRef.current, [key]: value });
  }, [applyAnswers]);

  const hydrateChoiceState = useCallback((next: CoreAnswers) => {
    setSensitiveChoice(sensitiveChoiceFromStored(next.sensitiveData));
    const tool = toolSelectionFromStored(next.requestedTool);
    setToolSelection(tool.selection);
    setToolOther(tool.other);
    const retention = retentionSelectionFromStored(next.retentionDuration);
    setRetentionSelection(retention.selection);
    setRetentionOther(retention.other);
  }, []);

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
    if (!fields.some(({ key, limit, input }) => fieldComplete(nextAnswers, key, limit, input))) return;
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
      try {
        const job = await api.read<{ state: string }>(`/api/v1/jobs/${encodeURIComponent(jobId)}`);
        setAiPhase(waitingPhase(job.state));
        if (job.state === 'completed') {
          openPassportReview(caseId);
          return;
        }
        if (job.state === 'failed_terminal' || job.state === 'cancelled') {
          setAiState('failed');
          setAiFailureMessage('處理失敗，請稍後再試。');
          return;
        }
      } catch {
        setAiState('failed');
        setAiFailureMessage('處理失敗，請稍後再試。');
        return;
      }
    }
  }, [openPassportReview]);
  const startAiDraft = useCallback(async () => {
    const api = apiRef.current;
    const currentCase = caseRef.current;
    if (!api || !currentCase || saveStatus !== 'saved' || !complete || blockedByUnsafeInput) return;
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
      const queued = await api.mutate<{ jobId: string; state: string }>(`/api/v1/cases/${encodeURIComponent(matched.id)}/ai-drafts`, {
        method: 'POST',
        ifMatch: `"${matched.rowVersion}"`,
        body: { operation: 'draft', ...(aiState === 'failed' ? { retry: true } : {}) },
      });
      setFailedAnswers(null);
      if (typeof window !== 'undefined') {
        window.history.replaceState(null, '', `/app/apply?caseId=${encodeURIComponent(matched.id)}`);
      }
      setAiPhase(waitingPhase(queued.state));
      await pollAiJob(api, queued.jobId, matched.id);
    } catch (error) {
      const unsafe = error instanceof PublicApiError && error.code === 'AI_INPUT_UNSAFE';
      setAiFailureMessage(unsafe
        ? UNSAFE_INPUT_MESSAGE
        : error instanceof PublicApiError && error.code === 'ETAG_MISMATCH'
          ? '資料已更新，請重新點擊「產生資料流向草稿」。'
          : error instanceof PublicApiError && error.code === 'RATE_LIMITED'
            ? '整理次數已達上限，請稍後再試。'
            : '處理失敗，請稍後再試。');
      setFailedAnswers({ answers: answersRef.current, unsafe });
      setAiState('failed');
    }
  }, [aiState, blockedByUnsafeInput, complete, openPassportReview, pollAiJob, saveStatus]);

  useEffect(() => {
    let cancelled = false;
    if (liffSession.status !== 'authenticated' || !liffSession.api) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronises derived readiness with the LIFF session before the fetch below runs.
      setSessionReady(false);
      return;
    }
    const api = liffSession.api;
    apiRef.current = api;
    void (async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const caseId = params.get('caseId');
        let application: ApplicantApplicationCase | null = null;
        if (caseId) {
          try {
            application = await api.read<ApplicantApplicationCase>(`/api/v1/cases/${encodeURIComponent(caseId)}`);
          } catch (error) {
            if (!(error instanceof PublicApiError && error.code === 'DRAFT_EXPIRED')) throw error;
            setNoticeMessage('先前的草稿閒置過久已清除，請重新填寫。');
          }
        }
        if (!application) {
          const program = await api.read<{ id: string }>('/api/v1/programs/current');
          const reuseFromCaseId = params.get('reuseFrom');
          const created = await api.mutate<{ case: { id: string; rowVersion: number; updatedAt: string } }>('/api/v1/cases', {
            method: 'POST',
            body: {
              programCycleId: program.id,
              ...(reuseFromCaseId ? { reuseFromCaseId } : {}),
            },
          });
          application = await api.read<ApplicantApplicationCase>(`/api/v1/cases/${encodeURIComponent(created.case.id)}`);
          window.history.replaceState(null, '', `/app/apply?caseId=${encodeURIComponent(created.case.id)}`);
        }
        if (cancelled || !application) return;
        if (application.state !== 'draft') {
          openPassportReview(application.id);
          return;
        }
        const nextCase = { id: application.id, rowVersion: application.rowVersion };
        caseRef.current = nextCase;
        setCaseState(nextCase);
        if (application.answers) {
          applyAnswers(application.answers);
          hydrateChoiceState(application.answers);
          setStep(firstIncompleteStep(application.answers));
          setResumedDraft(fields.some(({ key, limit, input }) => fieldComplete(application!.answers!, key, limit, input)));
        }
        try {
          const active = await api.read<{ jobId: string; state: string } | null>(`/api/v1/cases/${encodeURIComponent(application.id)}/ai-drafts`);
          if (active?.jobId && (active.state === 'queued' || active.state === 'leased')) {
            await pollAiJob(api, active.jobId, application.id);
            return;
          }
        } catch {
          /* no active draft job */
        }
        try {
          await api.read(`/api/v1/cases/${encodeURIComponent(application.id)}/passport`);
          openPassportReview(application.id);
          return;
        } catch {
          /* still drafting */
        }
        setSessionReady(true);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof PublicApiError && error.code === 'RATE_LIMITED') {
          setSessionMessage('今天建立申請的次數已用完，請明天再試，或從申請紀錄打開未完成的草稿。');
          return;
        }
        setSessionMessage('申請頁暫時無法開啟，請稍後再試。');
      }
    })();
    return () => { cancelled = true; };
  }, [applyAnswers, hydrateChoiceState, liffSession.api, liffSession.status, openPassportReview, pollAiJob]);
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
  const saveNote = saveStatus === 'saving'
    ? '儲存中'
    : saveStatus === 'conflict'
      ? '資料版本不一致，請點擊重試'
      : saveStatus === 'error'
        ? '儲存失敗，請點擊重試'
        : '';
  const currentComplete = fieldComplete(answers, current.key, current.limit, current.input);
  return <section className="application-wizard" aria-labelledby={review ? 'review-title' : 'question-title'}>
    {sessionMessage && <p className="pending-note" role="status">{sessionMessage}</p>}
    {(sessionReady || liffSession.status !== 'authenticated') && !sessionMessage && <>
      {noticeMessage && <p className="pending-note" role="status">{noticeMessage}</p>}
      {resumedDraft && <p className="pending-note" role="status">已載入未完成的草稿內容</p>}
      {!review ? <>
        <p className="question-progress" aria-live="polite">第 {step + 1} / {fields.length} 題</p>
        <h1 id="question-title">{current.label}</h1>
        {current.input === 'text' && (
          <textarea
            id={`answer-${current.key}`}
            value={answers[current.key]}
            onChange={(event) => updateField(current.key, event.target.value)}
            placeholder={current.placeholder}
            required
            aria-required="true"
            aria-invalid={unicodeScalarLength(answers[current.key]) > current.limit}
            aria-labelledby="question-title"
            aria-describedby={`hint-${current.key} guidance-${current.key}`}
            autoFocus
          />
        )}
        {current.input === 'sensitive' && (
          <>
            <ChoiceList
              label={current.label}
              visuallyHiddenLabel
              options={SENSITIVE_OPTIONS}
              value={sensitiveChoice}
              required
              onChange={(value) => {
                const choice = value as SensitiveDataChoice;
                setSensitiveChoice(choice);
                if (choice === '有') {
                  const kept = answersRef.current.sensitiveData;
                  const previous = sensitiveChoiceFromStored(kept);
                  updateField('sensitiveData', previous === '有' ? kept : '');
                  return;
                }
                updateField('sensitiveData', choice);
              }}
            />
            {sensitiveChoice === '有' && (
              <textarea
                id="answer-sensitive-detail"
                value={sensitiveDetail}
                onChange={(event) => updateField('sensitiveData', event.target.value)}
                placeholder={current.placeholder}
                required
                aria-required="true"
                aria-invalid={unicodeScalarLength(sensitiveDetail) > current.limit}
                aria-labelledby="question-title"
                aria-describedby={`hint-${current.key} guidance-${current.key}`}
                autoFocus
              />
            )}
          </>
        )}
        {current.input === 'tool' && (
          <ChoiceList
            label={current.label}
            visuallyHiddenLabel
            options={TOOL_OPTIONS}
            value={toolSelection}
            required
            searchable
            searchPlaceholder="輸入名稱搜尋，或直接點選分類清單"
            otherValue={toolOther}
            otherPlaceholder="請填寫工具名稱（不適用中港澳工具）"
            onChange={(value) => {
              setToolSelection(value);
              if (value === '__other__') {
                updateField('requestedTool', toolOther);
              } else {
                setToolOther('');
                updateField('requestedTool', value);
              }
            }}
            onOtherChange={(value) => {
              setToolOther(value);
              updateField('requestedTool', value);
            }}
          />
        )}
        {current.input === 'retention' && (
          <ChoiceList
            label={current.label}
            visuallyHiddenLabel
            options={RETENTION_OPTIONS}
            value={retentionSelection}
            required
            otherValue={retentionOther}
            otherPlaceholder="請填寫實際保存期限"
            onChange={(value) => {
              setRetentionSelection(value);
              if (value === '__other__') {
                updateField('retentionDuration', retentionOther);
              } else {
                setRetentionOther('');
                updateField('retentionDuration', value);
              }
            }}
            onOtherChange={(value) => {
              setRetentionOther(value);
              updateField('retentionDuration', value);
            }}
          />
        )}
        <p id={`guidance-${current.key}`} className="field-guidance">{current.hint}</p>
        <p id={`hint-${current.key}`} className="field-hint">
          必填
          {current.input === 'text' || (current.input === 'sensitive' && sensitiveChoice === '有')
            ? ` · ${unicodeScalarLength(answers[current.key])}/${current.limit}`
            : ''}
          {saveStatus === 'saving' ? ' · 儲存中' : saveStatus === 'saved' && answers[current.key].trim() ? ' · 已儲存' : saveStatus === 'error' ? ' · 儲存失敗' : ''}
        </p>
        {unicodeScalarLength(answers[current.key]) > current.limit && <p role="alert">字數已超過上限，請精簡內容後再繼續。</p>}
        <div className="wizard-actions"><button type="button" onClick={() => setStep((value) => Math.max(0, value - 1))} disabled={step === 0}>上一題</button>
          {step < fields.length - 1 ? <button type="button" onClick={() => setStep((value) => value + 1)} disabled={!currentComplete}>下一題</button> : <button type="button" onClick={() => setReview(true)} disabled={!complete}>檢查答案</button>}</div>
      </> : <>
        <h2 id="review-title">送出前確認</h2><dl>{fields.map(({ key, label }) => <div key={key}><dt>{label}</dt><dd>{answers[key]}</dd></div>)}</dl>
        <p>
          {mayNeedFollowUp
            ? '確認後會產生資料流向草稿，之後可能還需回答追問並上傳附件。'
            : '確認後會產生資料流向草稿，之後再上傳附件即可。'}
        </p>
        {/* Keep status above the buttons so it stays visible on short mobile screens. */}
        {saveNote
          ? <p className="pending-note" role="status">{saveNote}</p>
          : failureStillApplies && <p className="pending-note" role="alert">{aiFailureMessage || '處理失敗，請稍後再試。'}</p>}
        <div className="wizard-actions"><button type="button" onClick={() => setReview(false)}>返回修改</button><button type="button" onClick={() => void startAiDraft()} disabled={saveStatus !== 'saved' || aiState === 'completed' || blockedByUnsafeInput}>{aiState === 'completed' ? '已完成' : '產生資料流向草稿'}</button></div>
        {(saveStatus === 'conflict' || saveStatus === 'error') && caseState && (
          <button type="button" className="secondary-action" onClick={() => enqueueSave(answersRef.current, caseRef.current)}>
            重試儲存
          </button>
        )}
      </>}
    </>}
  </section>;
}
