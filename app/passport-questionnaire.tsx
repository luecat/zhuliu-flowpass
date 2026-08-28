'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ConfirmationQuestion,
  PassportDraft,
  QuestionPriority,
} from './passport-parser';
import {
  buildPassportRevisionJson,
  reconcileConfirmationAnswers,
  type ConfirmationAnswerState,
  type ConfirmationAnswerStatus,
} from './passport-revision';

type CopyState = 'idle' | 'copied' | 'error';

const priorityLabels: Record<QuestionPriority, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

const answerStatusLabels: Record<ConfirmationAnswerStatus, string> = {
  unanswered: '尚未確認',
  answered: '已回答',
  not_applicable: '不適用',
};

function sortedQuestions(
  questions: ConfirmationQuestion[],
): ConfirmationQuestion[] {
  const order: QuestionPriority[] = ['high', 'medium', 'low'];
  return order.flatMap((priority) =>
    questions.filter((question) => question.priority === priority),
  );
}

function isResolved(
  answer: ConfirmationAnswerState[string] | undefined,
): boolean {
  if (!answer) return false;
  if (answer.status === 'not_applicable') return true;
  return answer.status === 'answered' && Boolean(answer.answerText.trim());
}

export function PassportQuestionnaire({
  passport,
  answerState,
  onAnswerStateChange,
}: {
  passport: PassportDraft;
  answerState?: ConfirmationAnswerState;
  onAnswerStateChange?: (answers: ConfirmationAnswerState) => void;
}) {
  const [internalAnswers, setInternalAnswers] = useState<ConfirmationAnswerState>(() =>
    reconcileConfirmationAnswers(passport.confirmation_questions, {}),
  );
  const [output, setOutput] = useState('');
  const [isDirty, setIsDirty] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const revisionOutputRef = useRef<HTMLPreElement>(null);
  const questions = useMemo(
    () => sortedQuestions(passport.confirmation_questions),
    [passport.confirmation_questions],
  );
  const answers = answerState ?? internalAnswers;
  const resolvedCount = questions.filter((question) =>
    isResolved(answers[question.id]),
  ).length;

  useEffect(() => {
    if (output) revisionOutputRef.current?.focus();
  }, [output]);

  function commitAnswers(
    update: (current: ConfirmationAnswerState) => ConfirmationAnswerState,
  ) {
    const next = update(answers);
    if (onAnswerStateChange) {
      onAnswerStateChange(next);
    } else {
      setInternalAnswers(next);
    }
  }

  function updateAnswer(questionId: string, answerText: string) {
    commitAnswers((current) => {
      const previous = current[questionId] ?? {
        status: 'unanswered' as const,
        answerText: '',
      };
      return {
        ...current,
        [questionId]: {
          status: answerText.trim()
            ? 'answered'
            : previous.status === 'not_applicable'
              ? 'not_applicable'
              : 'unanswered',
          answerText,
        },
      };
    });
    setIsDirty(true);
    setCopyState('idle');
  }

  function markStatus(
    questionId: string,
    status: ConfirmationAnswerStatus,
  ) {
    commitAnswers((current) => ({
      ...current,
      [questionId]: {
        status,
        answerText: current[questionId]?.answerText ?? '',
      },
    }));
    setIsDirty(true);
    setCopyState('idle');
  }

  function generateRevisionJson() {
    setOutput(buildPassportRevisionJson(passport, answers));
    setIsDirty(false);
    setCopyState('idle');
  }

  async function copyRevisionJson() {
    if (!output || isDirty) return;

    try {
      await navigator.clipboard.writeText(output);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  }

  const copyMessage =
    copyState === 'copied'
      ? '回覆 JSON 已複製'
      : copyState === 'error'
        ? '無法自動複製，請直接選取 JSON。'
        : isDirty
          ? '答案已變更，請重新產生 JSON。'
          : '可直接貼給 AI，生成更新後的 FlowPass 護照。';

  if (questions.length === 0) {
    return (
      <section
        className="confirmation-workbench"
        aria-labelledby="confirmation-workbench-heading"
      >
        <div className="confirmation-empty">
          <span aria-hidden="true">✓</span>
          <div>
            <h2 id="confirmation-workbench-heading">目前沒有待確認問題</h2>
            <p>仍可產生零題回覆 JSON，請 AI 完成更新後的護照。</p>
          </div>
        </div>

        <div className="revision-generate-row">
          <p>這份 JSON 會明確帶入空的回答清單。</p>
          <button
            type="button"
            className="generate-button"
            onClick={generateRevisionJson}
          >
            <span aria-hidden="true">✦</span>
            產生給 AI 的 JSON
          </button>
        </div>

        {output && (
          <section
            className="revision-output-panel"
            aria-labelledby="revision-output-heading"
          >
            <div className="revision-output-toolbar">
              <div>
                <span aria-hidden="true">{'{ }'}</span>
                <strong id="revision-output-heading">
                  passport-revision.json
                </strong>
              </div>
              <button
                type="button"
                className="copy-button"
                disabled={isDirty}
                onClick={copyRevisionJson}
              >
                複製給 AI
              </button>
            </div>
            <pre
              ref={revisionOutputRef}
              data-testid="revision-json-output"
              tabIndex={0}
            >
              {output}
            </pre>
            <p
              className={
                copyState === 'error' ? 'copy-status error' : 'copy-status'
              }
              role="status"
              aria-live="polite"
            >
              {copyMessage}
            </p>
          </section>
        )}
      </section>
    );
  }

  return (
    <section
      className="confirmation-workbench"
      aria-labelledby="confirmation-workbench-heading"
    >
      <div className="confirmation-workbench-heading">
        <div>
          <span>CONFIRMATION ROUND</span>
          <h2 id="confirmation-workbench-heading">回答 AI 的待確認問題</h2>
          <p>
            AI 回幾題，這裡就顯示幾題；不知道時可保留「尚未確認」。
          </p>
        </div>
        <strong>{resolvedCount} / {questions.length} 已處理</strong>
      </div>

      <div className="answer-question-list">
        {questions.map((question, index) => {
          const answer = answers[question.id] ?? {
            status: 'unanswered' as const,
            answerText: '',
          };
          const fieldId = `confirmation-answer-${index}`;
          const reasonId = `${fieldId}-reason`;

          return (
            <article
              className={`answer-question-card answer-priority-${question.priority}`}
              data-testid="answer-question"
              key={question.id}
            >
              <div className="answer-question-meta">
                <span>Q{String(index + 1).padStart(2, '0')}</span>
                <b>{priorityLabels[question.priority]}優先</b>
                <code>{question.id}</code>
              </div>
              <h3>{question.question}</h3>
              <p id={reasonId}>{question.reason}</p>

              <div
                className="answer-status-switch"
                role="group"
                aria-label={`${question.question} 回答狀態`}
              >
                {(Object.keys(answerStatusLabels) as ConfirmationAnswerStatus[]).map(
                  (status) => (
                    <button
                      type="button"
                      className={answer.status === status ? 'active' : ''}
                      aria-pressed={answer.status === status}
                      key={status}
                      onClick={() => markStatus(question.id, status)}
                    >
                      {answerStatusLabels[status]}
                    </button>
                  ),
                )}
              </div>

              <label htmlFor={fieldId}>你的回答</label>
              <textarea
                id={fieldId}
                aria-label={`回答：${question.question}`}
                aria-describedby={reasonId}
                value={answer.answerText}
                onChange={(event) =>
                  updateAnswer(question.id, event.target.value)
                }
                placeholder={
                  answer.status === 'not_applicable'
                    ? '可補充不適用的原因'
                    : '輸入答案後會自動標記為「已回答」'
                }
                rows={3}
              />
            </article>
          );
        })}
      </div>

      <div className="revision-generate-row">
        <p>未回答的題目會保留為 unknown，AI 不得自行補完。</p>
        <button
          type="button"
          className="generate-button"
          onClick={generateRevisionJson}
        >
          <span aria-hidden="true">✦</span>
          產生給 AI 的 JSON
        </button>
      </div>

      {output && (
        <section className="revision-output-panel" aria-labelledby="revision-output-heading">
          <div className="revision-output-toolbar">
            <div>
              <span aria-hidden="true">{'{ }'}</span>
              <strong id="revision-output-heading">passport-revision.json</strong>
            </div>
            <button
              type="button"
              className="copy-button"
              disabled={isDirty}
              onClick={copyRevisionJson}
            >
              複製給 AI
            </button>
          </div>
          <pre
            ref={revisionOutputRef}
            data-testid="revision-json-output"
            tabIndex={0}
          >
            {output}
          </pre>
          <p
            className={
              copyState === 'error' ? 'copy-status error' : 'copy-status'
            }
            role="status"
            aria-live="polite"
          >
            {copyMessage}
          </p>
        </section>
      )}
    </section>
  );
}
