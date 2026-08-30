'use client';

import { useState } from 'react';

export interface AiFollowUpQuestion {
  id: string;
  questionKey: string;
  passportVersionId: string;
  versionNo: number;
  prompt: string;
  reason: string;
  answerSchema: { type?: string; choices?: string[]; maxLength?: number };
  required: boolean;
  relatedNodeIds: string[];
  priority: 'high' | 'medium' | 'low';
  status: 'open' | 'answered' | 'superseded';
  answer?: string;
}

export interface AiFollowUpAnswer {
  questionId: string;
  answer: string;
}

export function AiFollowUpForm({
  questions,
  onSubmit,
  submitting = false,
}: {
  questions: AiFollowUpQuestion[];
  onSubmit: (answers: AiFollowUpAnswer[]) => void;
  submitting?: boolean;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries(questions.map((question) => [question.id, question.answer ?? ''])));
  const [error, setError] = useState<string | null>(null);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const missing = questions.some((question) => question.required && !answers[question.id]?.trim());
    if (missing) {
      setError('請完成所有必填追問。');
      return;
    }
    setError(null);
    // Optional cards are display-only for this revision command. The server
    // intentionally accepts only required questions so a browser cannot widen
    // the model input contract by submitting an optional answer.
    onSubmit(questions.filter((question) => question.required).map((question) => ({ questionId: question.id, answer: answers[question.id] ?? '' })));
  }

  if (questions.length === 0) return null;

  return (
    <form className="ai-follow-up-form" onSubmit={submit} aria-describedby={error ? 'ai-follow-up-error' : undefined}>
      <div className="ai-follow-up-heading">
        <p className="eyebrow">補充幾個細節</p>
        <h2>讓護照更貼近你的實際流程</h2>
        <p>每張卡片都說明為什麼需要這個答案，逐張填寫即可。</p>
      </div>
      {questions.map((question, index) => (
        <article className="ai-follow-up-card" data-testid="ai-follow-up-card" key={question.id}>
          <div className="ai-follow-up-meta"><span>Q{String(index + 1).padStart(2, '0')}</span><span>{question.priority === 'high' ? '高優先' : question.priority === 'medium' ? '中優先' : '低優先'}</span>{question.required && <b>必填</b>}</div>
          <h3>{question.prompt}</h3>
          <p className="ai-follow-up-reason">為什麼需要：{question.reason}</p>
          <label htmlFor={`follow-up-${question.id}`}>{question.prompt}</label>
          {question.answerSchema.type === 'single_choice' && Array.isArray(question.answerSchema.choices) ? (
            <select id={`follow-up-${question.id}`} value={answers[question.id] ?? ''} disabled={!question.required} aria-required={question.required} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}>
              <option value="">請選擇</option>
              {question.answerSchema.choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
            </select>
          ) : question.answerSchema.type === 'multi_choice' && Array.isArray(question.answerSchema.choices) ? (
            <fieldset disabled={!question.required}>
              <legend className="sr-only">{question.prompt}</legend>
              {question.answerSchema.choices.map((choice) => {
                let selected: string[] = [];
                try { const parsed = JSON.parse(answers[question.id] ?? '[]'); if (Array.isArray(parsed)) selected = parsed.filter((item): item is string => typeof item === 'string'); } catch { /* empty selection */ }
                return <label key={choice}><input type="checkbox" checked={selected.includes(choice)} onChange={(event) => setAnswers((current) => { let currentSelected: string[] = []; try { const parsed = JSON.parse(current[question.id] ?? '[]'); if (Array.isArray(parsed)) currentSelected = parsed.filter((item): item is string => typeof item === 'string'); } catch { /* empty selection */ } const next = event.target.checked ? [...new Set([...currentSelected, choice])] : currentSelected.filter((item) => item !== choice); return { ...current, [question.id]: JSON.stringify(next) }; })} />{choice}</label>;
              })}
            </fieldset>
          ) : question.answerSchema.type === 'boolean' ? (
            <select id={`follow-up-${question.id}`} value={answers[question.id] ?? ''} disabled={!question.required} aria-required={question.required} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}>
              <option value="">請選擇</option><option value="true">是</option><option value="false">否</option>
            </select>
          ) : question.answerSchema.type === 'date' ? (
            <input id={`follow-up-${question.id}`} type="date" value={answers[question.id] ?? ''} disabled={!question.required} aria-required={question.required} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} />
          ) : (
            <textarea id={`follow-up-${question.id}`} value={answers[question.id] ?? ''} maxLength={question.answerSchema.maxLength ?? 4_000} aria-required={question.required} disabled={!question.required} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} rows={3} />
          )}
          {!question.required && <small>此項為參考資訊，會在需要時再由系統提出。</small>}
        </article>
      ))}
      {error && <p id="ai-follow-up-error" role="alert">{error}</p>}
      <button className="primary-action" type="submit" disabled={submitting}>{submitting ? '儲存中…' : '儲存追問答案'}</button>
    </form>
  );
}
