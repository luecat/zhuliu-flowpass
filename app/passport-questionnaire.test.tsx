import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PassportDraft } from './passport-parser';
import { PassportQuestionnaire } from './passport-questionnaire';
import { FLOWPASS_SAMPLE_JSON } from './passport-sample';

function samplePassport(questionCount: number): PassportDraft {
  const passport = JSON.parse(FLOWPASS_SAMPLE_JSON)
    .passport_draft as PassportDraft;
  passport.confirmation_questions = passport.confirmation_questions.slice(
    0,
    questionCount,
  );
  return passport;
}

describe('PassportQuestionnaire', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  it('renders exactly the number of questions in the parsed AI response', () => {
    render(<PassportQuestionnaire passport={samplePassport(3)} />);

    expect(screen.getAllByTestId('answer-question')).toHaveLength(3);
    expect(screen.getByText('0 / 3 已處理')).toBeVisible();
    expect(
      screen.queryByText('公開社群平台具體指哪些（如 Facebook, Instagram, YouTube）？'),
    ).not.toBeInTheDocument();
  });

  it('can generate a revision request when the AI returns no confirmation questions', () => {
    render(<PassportQuestionnaire passport={samplePassport(0)} />);

    expect(screen.getByText('目前沒有待確認問題')).toBeVisible();
    fireEvent.click(
      screen.getByRole('button', { name: '產生給 AI 的 JSON' }),
    );

    const output = screen.getByTestId('revision-json-output');
    expect(
      JSON.parse(output.textContent ?? '').flowpass_revision_request
        .confirmation_answers.answers,
    ).toEqual([]);
    expect(output).toHaveFocus();
  });

  it('moves focus to the revision JSON after generation so the result is visible', () => {
    render(<PassportQuestionnaire passport={samplePassport(1)} />);

    fireEvent.click(
      screen.getByRole('button', { name: '產生給 AI 的 JSON' }),
    );

    expect(screen.getByTestId('revision-json-output')).toHaveFocus();
  });

  it('generates and copies answers with explicit unresolved states', async () => {
    render(<PassportQuestionnaire passport={samplePassport(2)} />);

    const cards = screen.getAllByTestId('answer-question');
    fireEvent.change(
      within(cards[0]).getByRole('textbox', {
        name: /請指定具體使用的「AI 影片生成工具」名稱與供應商？/,
      }),
      { target: { value: '使用 Runway，由 Runway 提供。' } },
    );
    fireEvent.click(
      within(cards[1]).getByRole('button', { name: '不適用' }),
    );

    expect(screen.getByText('2 / 2 已處理')).toBeVisible();
    fireEvent.click(
      screen.getByRole('button', { name: '產生給 AI 的 JSON' }),
    );

    const output = screen.getByTestId('revision-json-output').textContent ?? '';
    const answers = JSON.parse(output).flowpass_revision_request
      .confirmation_answers.answers;
    expect(answers).toHaveLength(2);
    expect(answers[0]).toEqual(
      expect.objectContaining({
        question_id: 'q_01',
        status: 'answered',
        answer_text: '使用 Runway，由 Runway 提供。',
      }),
    );
    expect(answers[1]).toEqual(
      expect.objectContaining({
        question_id: 'q_02',
        status: 'not_applicable',
        answer_text: null,
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: '複製給 AI' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(output));
    expect(screen.getByRole('status')).toHaveTextContent('回覆 JSON 已複製');

    fireEvent.change(
      within(cards[0]).getByRole('textbox', {
        name: /請指定具體使用的「AI 影片生成工具」名稱與供應商？/,
      }),
      { target: { value: '改用 Adobe Firefly。' } },
    );
    expect(screen.getByRole('button', { name: '複製給 AI' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(
      '答案已變更，請重新產生 JSON。',
    );
  });
});
