import type { ConfirmationQuestion, PassportDraft } from './passport-parser';
import { inspectPassportDocument } from '../server/domain/passport-validation';
import { NODE_KIND_GUIDE, type FlowPassPassport } from '../shared/passport-contract';

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

function immutableQuestionFingerprint(question: ConfirmationQuestion): string {
  const answerSchema =
    question.answerSchema ?? ({ type: 'text', maxLength: 400 } as const);
  return JSON.stringify({
    id: question.id,
    version: question.version ?? 1,
    prompt: question.question,
    answerSchema,
    required: question.required ?? false,
    relatedNodeIds: question.related_node_ids,
  });
}

function canonicalPassportForRevision(passport: PassportDraft): FlowPassPassport {
  const inspection = inspectPassportDocument({ passport_draft: passport });
  if (!inspection.canonical) {
    throw new Error('FlowPass draft does not satisfy the canonical revision contract.');
  }
  return inspection.canonical;
}

export function reconcileConfirmationAnswers(
  questions: ConfirmationQuestion[],
  current: ConfirmationAnswerState,
  previousQuestions?: ConfirmationQuestion[],
): ConfirmationAnswerState {
  const previousById = previousQuestions
    ? new Map(
        previousQuestions.map((question) => [
          question.id,
          immutableQuestionFingerprint(question),
        ]),
      )
    : null;

  return Object.fromEntries(
    questions.map((question) => {
      const canReuse =
        current[question.id] &&
        (!previousById ||
          previousById.get(question.id) === immutableQuestionFingerprint(question));

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
  const canonicalPassport = canonicalPassportForRevision(passport);
  const confirmationAnswers = canonicalPassport.follow_up_questions.map(
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
        question: question.prompt,
        priority: question.priority,
        related_node_ids: question.relatedNodeIds,
        status,
        answer_text:
          status === 'unanswered' ? null : answerText || null,
      };
    },
  );

  return JSON.stringify(
    {
      model_instruction:
        'Treat this JSON as instructions, not as content to summarize. Revise the supplied FlowPass draft using the confirmation answers, then return only one valid JSON object whose single root key is passport_draft. Do not add Markdown fences or explanatory text. Do not invent answers for unresolved items.',
      node_kind_guide: NODE_KIND_GUIDE,
      flowpass_revision_request: {
        schema_version: 'flowpass.passport_revision_request.v1',
        task:
          'Revise the supplied FlowPass passport draft using the applicant confirmation answers, then return the updated passport draft as JSON only.',
        source_passport_draft: canonicalPassport,
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
          'Use kind "data" for every input or output content artifact. Keep photo, audio, video, document, personal_data, and creative_asset only in data_category.',
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
