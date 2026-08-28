import { describe, expect, it } from 'vitest';
import type { PassportDraft } from './passport-parser';
import {
  buildPassportRevisionJson,
  reconcileConfirmationAnswers,
  type ConfirmationAnswerState,
} from './passport-revision';
import { FLOWPASS_SAMPLE_JSON } from './passport-sample';

function samplePassport(): PassportDraft {
  return JSON.parse(FLOWPASS_SAMPLE_JSON).passport_draft as PassportDraft;
}

describe('buildPassportRevisionJson', () => {
  it('gives a pasted local model a direct top-level revision command', () => {
    const payload = JSON.parse(buildPassportRevisionJson(samplePassport(), {}));

    expect(payload.model_instruction).toMatch(/treat this JSON as instructions/i);
    expect(payload.model_instruction).toMatch(/return only one valid JSON object/i);
    expect(payload.model_instruction).toMatch(/root key.*passport_draft/i);
  });

  it('emits exactly the confirmation questions supplied by the AI draft', () => {
    const passport = samplePassport();
    passport.confirmation_questions = passport.confirmation_questions.slice(0, 3);
    const answers: ConfirmationAnswerState = {
      q_01: { status: 'answered', answerText: '使用 Runway，由 Runway 提供。' },
      q_02: { status: 'unanswered', answerText: '' },
      q_03: { status: 'not_applicable', answerText: '不會使用雲端資料夾。' },
    };

    const payload = JSON.parse(buildPassportRevisionJson(passport, answers));
    const records =
      payload.flowpass_revision_request.confirmation_answers.answers;

    expect(records).toHaveLength(3);
    expect(records).toEqual([
      expect.objectContaining({
        question_id: 'q_01',
        status: 'answered',
        answer_text: '使用 Runway，由 Runway 提供。',
      }),
      expect.objectContaining({
        question_id: 'q_02',
        status: 'unanswered',
        answer_text: null,
      }),
      expect.objectContaining({
        question_id: 'q_03',
        status: 'not_applicable',
        answer_text: '不會使用雲端資料夾。',
      }),
    ]);
  });

  it('includes the original draft and a parser-compatible AI output contract', () => {
    const passport = samplePassport();

    const payload = JSON.parse(buildPassportRevisionJson(passport, {}));
    const request = payload.flowpass_revision_request;

    expect(request.source_passport_draft.use_case.title).toBe(
      '社團招生影片製作與發布',
    );
    expect(request.confirmation_answers.source_passport).toEqual({
      rules_version: 'hackathon-mvp-2026-08-27',
      draft_status: 'ai_generated_unconfirmed',
    });
    expect(request.output_contract).toEqual(
      expect.objectContaining({
        format: 'json_only',
        root_key: 'passport_draft',
        required_audit_status: 'ai_generated_unconfirmed',
        requires_officer_review: true,
      }),
    );
  });
});

describe('reconcileConfirmationAnswers', () => {
  it('preserves matching question IDs and drops answers for absent questions', () => {
    const questions = samplePassport().confirmation_questions.slice(0, 2);
    const current: ConfirmationAnswerState = {
      q_01: { status: 'answered', answerText: '保留這個答案' },
      q_removed: { status: 'answered', answerText: '應該移除' },
    };

    expect(reconcileConfirmationAnswers(questions, current)).toEqual({
      q_01: { status: 'answered', answerText: '保留這個答案' },
      q_02: { status: 'unanswered', answerText: '' },
    });
  });

  it('drops an answer when a reused ID now refers to different question text', () => {
    const previousQuestions = samplePassport().confirmation_questions.slice(
      0,
      1,
    );
    const nextQuestions = [
      {
        ...previousQuestions[0],
        question: '這是另一份草稿中完全不同的問題？',
      },
    ];
    const current: ConfirmationAnswerState = {
      q_01: { status: 'answered', answerText: '不應套用到新問題' },
    };

    expect(
      reconcileConfirmationAnswers(
        nextQuestions,
        current,
        previousQuestions,
      ),
    ).toEqual({
      q_01: { status: 'unanswered', answerText: '' },
    });
  });
});
