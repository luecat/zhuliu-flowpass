import type { ConfirmationQuestion, PassportDraft } from './passport-parser';

export type ConfirmationAnswerStatus =
  | 'answered'
  | 'unanswered'
  | 'not_applicable';

export type ConfirmationAnswerState = Record<
  string,
  {
    status: ConfirmationAnswerStatus;
    answerText: string;
  }
>;

export function reconcileConfirmationAnswers(
  questions: ConfirmationQuestion[],
  current: ConfirmationAnswerState,
  previousQuestions?: ConfirmationQuestion[],
): ConfirmationAnswerState {
  const previousById = previousQuestions
    ? new Map(
        previousQuestions.map((question) => [question.id, question.question]),
      )
    : null;

  return Object.fromEntries(
    questions.map((question) => {
      const canReuse =
        current[question.id] &&
        (!previousById || previousById.get(question.id) === question.question);

      return [
        question.id,
        canReuse
          ? current[question.id]
          : { status: 'unanswered', answerText: '' },
      ];
    }),
  );
}

export function buildPassportRevisionJson(
  passport: PassportDraft,
  answers: ConfirmationAnswerState,
): string {
  const confirmationAnswers = passport.confirmation_questions.map(
    (question) => {
      const current = answers[question.id] ?? {
        status: 'unanswered' as const,
        answerText: '',
      };
      const answerText = current.answerText.trim();
      const status =
        current.status === 'answered' && !answerText
          ? 'unanswered'
          : current.status;

      return {
        question_id: question.id,
        question: question.question,
        priority: question.priority,
        related_node_ids: question.related_node_ids,
        status,
        answer_text:
          status === 'unanswered' ? null : answerText || null,
      };
    },
  );

  return JSON.stringify(
    {
      flowpass_revision_request: {
        schema_version: 'flowpass.passport_revision_request.v1',
        task:
          'Revise the supplied FlowPass passport draft using the applicant confirmation answers, then return the updated passport draft as JSON only.',
        source_passport_draft: passport,
        confirmation_answers: {
          schema_version: 'flowpass.confirmation_answers.v1',
          source_passport: {
            rules_version: passport.audit.rules_version,
            draft_status: passport.audit.draft_status,
          },
          answers: confirmationAnswers,
        },
        revision_rules: [
          'Treat answered items as applicant-provided facts, not independently verified facts.',
          'Do not invent information for unanswered items.',
          'Keep unanswered facts as unknown and retain focused confirmation questions when needed.',
          'Update affected nodes, edges, sharing scope, retention, safety actions, administrative hints, and audit unknown fields only when supported by the answers.',
          'Do not make subsidy, legal, safety, compliance, or approval decisions.',
          'Keep officer review required.',
        ],
        output_contract: {
          format: 'json_only',
          root_key: 'passport_draft',
          preserve_flowpass_passport_schema: true,
          required_audit_status: 'ai_generated_unconfirmed',
          requires_officer_review: true,
        },
      },
    },
    null,
    2,
  );
}
