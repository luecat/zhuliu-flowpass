'use client';

import { useState } from 'react';
import { followUpApplicantCopy } from './applicant-copy';
import { securityTipsForSelections } from './security-choice-tips';
import { ChoiceList } from './choice-list';
import {
  APPROVED_AI_TOOL_OTHER_LABEL,
  approvedAiToolChoiceOptions,
  filterAllowedChoiceLabels,
  isBlockedAiToolLabel,
  isOtherChoiceLabel,
} from '../../../shared/approved-ai-tools';

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

function submittedAnswers(questions: AiFollowUpQuestion[], answers: Record<string, string>): AiFollowUpAnswer[] {
  return questions
    .filter((question) => Boolean(answers[question.id]?.trim()))
    .map((question) => ({ questionId: question.id, answer: answers[question.id] ?? '' }));
}

function missingRequiredAnswer(
  questions: AiFollowUpQuestion[],
  answers: Record<string, string>,
  choiceSelections: Record<string, string>,
  otherAnswers: Record<string, string>,
): boolean {
  return questions.some((question) => {
    if (!question.required) return false;
    const selection = choiceSelections[question.id];
    if (selection === '__other__') return !otherAnswers[question.id]?.trim();
    return !answers[question.id]?.trim();
  });
}

function hasBlockedToolAnswer(questions: AiFollowUpQuestion[], answers: Record<string, string>): boolean {
  return questions.some((question) => {
    const answer = answers[question.id] ?? '';
    return Boolean(answer) && isBlockedAiToolLabel(answer);
  });
}

function selectedValues(question: AiFollowUpQuestion, raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  if (question.answerSchema.type === 'multi_choice') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }
  return [raw];
}

function isToolQuestion(questionKey: string, prompt: string, copyPrompt: string): boolean {
  return /工具|tool/i.test(`${questionKey} ${prompt} ${copyPrompt}`);
}

function choiceOptions(
  choices: string[] | undefined,
  toolQuestion: boolean,
): Array<{ value: string; label: string; hint?: string; group?: string }> {
  if (toolQuestion) {
    return approvedAiToolChoiceOptions().map((option) => (
      option.value === '__other__'
        ? option
        : { ...option, value: option.label }
    ));
  }
  const allowed = filterAllowedChoiceLabels(choices ?? []);
  const withOther = allowed.some((choice) => isOtherChoiceLabel(choice))
    ? allowed
    : [...allowed, APPROVED_AI_TOOL_OTHER_LABEL];
  return withOther.map((choice) => ({
    value: isOtherChoiceLabel(choice) ? '__other__' : choice,
    label: isOtherChoiceLabel(choice) ? APPROVED_AI_TOOL_OTHER_LABEL : choice,
  }));
}

export function AiFollowUpForm({
  questions,
  onSubmit,
  onRegenerate,
  submitting = false,
  regenerating = false,
}: {
  questions: AiFollowUpQuestion[];
  onSubmit: (answers: AiFollowUpAnswer[]) => void | Promise<void>;
  onRegenerate?: (answers: AiFollowUpAnswer[]) => void | Promise<void>;
  submitting?: boolean;
  regenerating?: boolean;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries(questions.map((question) => [question.id, question.answer ?? ''])));
  const [otherAnswers, setOtherAnswers] = useState<Record<string, string>>({});
  const [choiceSelections, setChoiceSelections] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const busy = submitting || regenerating;

  async function saveAnswers(mode: 'save' | 'regenerate') {
    if (missingRequiredAnswer(questions, answers, choiceSelections, otherAnswers)) {
      setError('請完成所有必填問題。');
      return;
    }
    if (hasBlockedToolAnswer(questions, answers)) {
      setError('本補助不適用中港澳開發之 AI 工具，請更換選項。');
      return;
    }
    setError(null);
    const payload = submittedAnswers(questions, answers);
    if (mode === 'regenerate' && onRegenerate) {
      await onRegenerate(payload);
      return;
    }
    await onSubmit(payload);
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void saveAnswers(onRegenerate ? 'regenerate' : 'save');
  }

  if (questions.length === 0) return null;

  return (
    <form className="ai-follow-up-form" onSubmit={submit} aria-describedby={error ? 'ai-follow-up-error' : undefined}>
      <div className="ai-follow-up-heading">
        <p className="eyebrow">補充資料細節</p>
        <h2>確認護照細節</h2>
        <p>回答下方問題後點擊「繼續」，系統會儲存答案並重新產生護照。</p>
      </div>
      {questions.map((question, index) => {
        const copy = followUpApplicantCopy(question.questionKey, question.prompt, question.reason);
        const tips = securityTipsForSelections(selectedValues(question, answers[question.id]));
        const toolQuestion = question.answerSchema.type === 'single_choice'
          && isToolQuestion(question.questionKey, question.prompt, copy.prompt);
        const options = choiceOptions(question.answerSchema.choices, toolQuestion);
        return (
          <article className="ai-follow-up-card" data-testid="ai-follow-up-card" key={question.id}>
            <div className="ai-follow-up-meta">
              <span>Q{String(index + 1).padStart(2, '0')}</span>
              <span>{question.priority === 'high' ? '高優先' : question.priority === 'medium' ? '中優先' : '低優先'}</span>
              {question.required && <b>必填</b>}
            </div>
            <h3>{copy.prompt}</h3>
            <p className="ai-follow-up-reason">補充原因：{copy.reason}</p>
            <label className="sr-only" htmlFor={`follow-up-${question.id}`}>{copy.prompt}</label>
            {question.answerSchema.type === 'single_choice' && Array.isArray(question.answerSchema.choices) ? (
              <ChoiceList
                label={copy.prompt}
                visuallyHiddenLabel
                options={options}
                value={choiceSelections[question.id] ?? ''}
                required={question.required}
                searchable={toolQuestion}
                searchPlaceholder="輸入名稱搜尋，或直接點選分類清單"
                otherValue={otherAnswers[question.id] ?? ''}
                otherPlaceholder={toolQuestion
                  ? '請填寫工具名稱（不適用中港澳工具）'
                  : '請填寫實際情況'}
                onChange={(value) => {
                  setChoiceSelections((current) => ({ ...current, [question.id]: value }));
                  if (value === '__other__') {
                    setAnswers((current) => ({ ...current, [question.id]: otherAnswers[question.id] ?? '' }));
                  } else {
                    setAnswers((current) => ({ ...current, [question.id]: value }));
                  }
                }}
                onOtherChange={(value) => {
                  setOtherAnswers((current) => ({ ...current, [question.id]: value }));
                  setAnswers((current) => ({ ...current, [question.id]: value }));
                }}
              />
            ) : question.answerSchema.type === 'multi_choice' && Array.isArray(question.answerSchema.choices) ? (
              <fieldset className="choice-list-multi">
                <legend className="sr-only">{copy.prompt}</legend>
                {options.filter((option) => option.value !== '__other__').map((option) => {
                  let selected: string[] = [];
                  try {
                    const parsed = JSON.parse(answers[question.id] ?? '[]');
                    if (Array.isArray(parsed)) selected = parsed.filter((item): item is string => typeof item === 'string');
                  } catch {
                    /* empty selection */
                  }
                  return (
                    <label key={option.value} className="choice-list-multi-option">
                      <input
                        type="checkbox"
                        checked={selected.includes(option.value)}
                        onChange={(event) => {
                          setAnswers((current) => {
                            let currentSelected: string[] = [];
                            try {
                              const parsed = JSON.parse(current[question.id] ?? '[]');
                              if (Array.isArray(parsed)) currentSelected = parsed.filter((item): item is string => typeof item === 'string');
                            } catch {
                              /* empty selection */
                            }
                            const next = event.target.checked
                              ? [...new Set([...currentSelected, option.value])]
                              : currentSelected.filter((item) => item !== option.value);
                            return { ...current, [question.id]: JSON.stringify(next) };
                          });
                        }}
                      />
                      {option.label}
                    </label>
                  );
                })}
              </fieldset>
            ) : question.answerSchema.type === 'boolean' ? (
              <ChoiceList
                label={copy.prompt}
                visuallyHiddenLabel
                options={[{ value: 'true', label: '是' }, { value: 'false', label: '否' }]}
                value={answers[question.id] ?? ''}
                required={question.required}
                onChange={(value) => {
                  setAnswers((current) => ({ ...current, [question.id]: value }));
                }}
              />
            ) : question.answerSchema.type === 'date' ? (
              <input
                id={`follow-up-${question.id}`}
                type="date"
                value={answers[question.id] ?? ''}
                aria-required={question.required}
                onChange={(event) => {
                  setAnswers((current) => ({ ...current, [question.id]: event.target.value }));
                }}
              />
            ) : (
              <textarea
                id={`follow-up-${question.id}`}
                value={answers[question.id] ?? ''}
                placeholder={copy.placeholder}
                maxLength={question.answerSchema.maxLength ?? 4_000}
                aria-required={question.required}
                onChange={(event) => {
                  setAnswers((current) => ({ ...current, [question.id]: event.target.value }));
                }}
                rows={3}
              />
            )}
            {tips.length > 0 && (
              <ul className="ai-follow-up-tips">
                {tips.map((tip) => <li key={tip}>{tip}</li>)}
              </ul>
            )}
          </article>
        );
      })}
      {error && <p id="ai-follow-up-error" role="alert">{error}</p>}
      <div className="wizard-actions">
        <button className="primary-action" type="submit" disabled={busy}>{busy ? '處理中…' : '繼續'}</button>
      </div>
    </form>
  );
}
