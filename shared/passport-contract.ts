import { z } from 'zod';

export const MAX_PASSPORT_NODES = 80;
export const MAX_PASSPORT_EDGES = 160;
export const MAX_FOLLOW_UP_QUESTIONS = 12;
export const MAX_PASSPORT_STRING_BYTES = 4 * 1024;
export const MAX_PASSPORT_JSON_BYTES = 256 * 1024;
export const REDACTED_SOURCE_EXCERPT = '[not retained]' as const;

export const SOURCE_FIELDS = [
  'materials',
  'intended_use',
  'personal_or_sensitive_data',
  'destination_and_audience',
] as const;

export const NODE_KIND_VALUES = [
  'data',
  'ai_tool',
  'plugin',
  'storage',
  'person',
  'organization',
  'destination',
] as const;

export const DATA_CATEGORY_VALUES = [
  'photo',
  'audio',
  'video',
  'document',
  'code',
  'personal_data',
  'creative_asset',
  'other',
] as const;

export const SENSITIVITY_VALUES = ['low', 'medium', 'high', 'unknown'] as const;
export const QUESTION_PRIORITY_VALUES = ['high', 'medium', 'low'] as const;
export const FOLLOW_UP_STATUS_VALUES = [
  'open',
  'answered',
  'superseded',
] as const;

export const NODE_KIND_GUIDE = {
  allowed_values: [...NODE_KIND_VALUES],
  content_artifact_kind: 'data',
  category_only_values: [...DATA_CATEGORY_VALUES],
  rule:
    'For every input or output content artifact, including generated videos and creative assets, use kind "data". Put its format only in data_category. Never use a category_only_values entry as kind.',
} as const;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

const boundedString = z.string().refine(
  (value) => utf8ByteLength(value) <= MAX_PASSPORT_STRING_BYTES,
  `String must be at most ${MAX_PASSPORT_STRING_BYTES} UTF-8 bytes.`,
);
const nonEmptyBoundedString = boundedString.min(1);

const sourceFieldSchema = z.enum(SOURCE_FIELDS);
const canonicalSourceExcerptSchema = z.literal(REDACTED_SOURCE_EXCERPT);

const canonicalPassportNodeSchema = z
  .object({
    id: boundedString,
    kind: z.enum(NODE_KIND_VALUES),
    label: boundedString,
    data_category: z.enum(DATA_CATEGORY_VALUES).nullable(),
    sensitivity: z.enum(SENSITIVITY_VALUES),
    source_field: sourceFieldSchema,
    source_excerpt: canonicalSourceExcerptSchema,
    confidence: z.number().finite().min(0).max(1),
    needs_confirmation: z.boolean(),
  })
;

const canonicalPassportEdgeSchema = z
  .object({
    id: boundedString,
    from_node_id: boundedString,
    to_node_id: boundedString,
    purpose: boundedString,
    source_field: sourceFieldSchema,
    source_excerpt: canonicalSourceExcerptSchema,
    confidence: z.number().finite().min(0).max(1),
    needs_confirmation: z.boolean(),
  })
;

const safetyActionSchema = z
  .object({
    id: boundedString,
    action: boundedString,
    reason: boundedString,
    applies_to_node_ids: z.array(boundedString),
    status: z.literal('required_confirmation'),
    evidence_type: z.enum([
      'applicant_confirmation',
      'system_check',
      'officer_review',
    ]),
  })
;

const answerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), maxLength: z.literal(400) }),
  z
    .object({
      type: z.literal('single_choice'),
      choices: z.array(nonEmptyBoundedString).min(1),
    })
,
  z
    .object({
      type: z.literal('multi_choice'),
      choices: z.array(nonEmptyBoundedString).min(1),
    })
,
  z.object({ type: z.literal('boolean') }),
  z.object({ type: z.literal('date') }),
]);

const followUpQuestionSchema = z
  .object({
    id: boundedString,
    version: z.number().int().positive(),
    prompt: nonEmptyBoundedString,
    reason: nonEmptyBoundedString,
    answerSchema,
    required: z.boolean(),
    relatedNodeIds: z.array(boundedString),
    priority: z.enum(QUESTION_PRIORITY_VALUES),
    status: z.enum(FOLLOW_UP_STATUS_VALUES),
  })
;

const sharingScopeSchema = z
  .object({
    audience: z.enum(['self', 'team', 'client', 'public', 'unknown']),
    source_field: z.literal('destination_and_audience'),
    source_excerpt: canonicalSourceExcerptSchema,
    needs_confirmation: z.boolean(),
  })
;

const retentionSchema = z
  .object({
    storage_location: boundedString,
    duration: boundedString,
    deletion_plan: boundedString,
    needs_confirmation: z.boolean(),
  })
;

const invoiceFieldSchema = z.enum([
  'tool_name',
  'purchase_date',
  'amount',
  'invoice_number',
]);

const administrativeHintsSchema = z
  .object({
    requested_tool: boundedString,
    invoice_fields_required: z
      .array(invoiceFieldSchema)
      .length(4)
      .refine(
        (fields) => new Set(fields).size === 4,
        'Invoice fields must be unique.',
      ),
    subsidy_calculation: z.literal('not_performed_by_ai'),
    requires_officer_review: z.literal(true),
  })
;

const auditSchema = z
  .object({
    draft_status: z.literal('ai_generated_unconfirmed'),
    rules_version: z.literal('hackathon-mvp-2026-08-27'),
    unknown_fields: z.array(boundedString),
  })
;

export const FlowPassPassportSchema = z
  .object({
    use_case: z
      .object({
        title: boundedString,
        purpose: boundedString,
        intended_outcome: boundedString,
      })
,
    nodes: z.array(canonicalPassportNodeSchema).max(MAX_PASSPORT_NODES),
    edges: z.array(canonicalPassportEdgeSchema).max(MAX_PASSPORT_EDGES),
    sharing_scope: sharingScopeSchema,
    retention: retentionSchema,
    safety_actions: z.array(safetyActionSchema),
    follow_up_questions: z
      .array(followUpQuestionSchema)
      .max(MAX_FOLLOW_UP_QUESTIONS),
    administrative_hints: administrativeHintsSchema,
    audit: auditSchema,
  })
;

export const PassportDocumentSchema = z
  .object({ passport_draft: FlowPassPassportSchema })
;

export type NodeKind = (typeof NODE_KIND_VALUES)[number];
export type DataCategory = (typeof DATA_CATEGORY_VALUES)[number];
export type Sensitivity = (typeof SENSITIVITY_VALUES)[number];
export type QuestionPriority = (typeof QUESTION_PRIORITY_VALUES)[number];
export type FollowUpQuestionStatus = (typeof FOLLOW_UP_STATUS_VALUES)[number];
export type FlowPassPassport = z.infer<typeof FlowPassPassportSchema>;
export type PassportDocument = z.infer<typeof PassportDocumentSchema>;
export type CanonicalPassportNode = FlowPassPassport['nodes'][number];
export type CanonicalPassportEdge = FlowPassPassport['edges'][number];
export type FollowUpQuestion = FlowPassPassport['follow_up_questions'][number];
export type SafetyAction = FlowPassPassport['safety_actions'][number];

/** Legacy Studio projection retained only while the old browser UI remains. */
export type PassportNode = Omit<CanonicalPassportNode, 'source_excerpt'> & {
  source_excerpt: string;
};
export type PassportEdge = Omit<CanonicalPassportEdge, 'source_excerpt'> & {
  source_excerpt: string;
};
export type ConfirmationQuestion = {
  id: string;
  question: string;
  reason: string;
  related_node_ids: string[];
  priority: QuestionPriority;
  /** Canonical metadata used to determine whether a cached browser answer is reusable. */
  version?: number;
  answerSchema?: FollowUpQuestion['answerSchema'];
  required?: boolean;
  status?: FollowUpQuestionStatus;
};
export type PassportDraft = Omit<
  FlowPassPassport,
  'nodes' | 'edges' | 'sharing_scope' | 'follow_up_questions'
> & {
  nodes: PassportNode[];
  edges: PassportEdge[];
  sharing_scope: Omit<
    FlowPassPassport['sharing_scope'],
    'source_excerpt'
  > & { source_excerpt: string };
  confirmation_questions: ConfirmationQuestion[];
};

export type IssueSeverity = 'error' | 'warning' | 'info';
export type IssueCategory = 'syntax' | 'schema' | 'graph' | 'readiness';
export type ValidationIssue = {
  code: string;
  category: IssueCategory;
  severity: IssueSeverity;
  path: string;
  message: string;
  relatedIds?: string[];
};

export type RepairRecord = {
  path: string;
  nodeId: string;
  from: (typeof DATA_CATEGORY_VALUES)[number];
  to: 'data';
  reason: 'known_data_category_in_kind';
};

export type PassportValidation =
  | { ok: true; value: FlowPassPassport; repairs: RepairRecord[] }
  | { ok: false; errors: ValidationIssue[] };

/**
 * Standard JSON Schema maxLength counts characters, not UTF-8 bytes, and it
 * cannot express a whole-document byte budget. The canonical runtime validator
 * is authoritative for both FlowPass byte limits before any passport is used.
 */
const stringSchema = { type: 'string', maxLength: MAX_PASSPORT_STRING_BYTES } as const;
const nonEmptyStringSchema = {
  type: 'string',
  minLength: 1,
  maxLength: MAX_PASSPORT_STRING_BYTES,
} as const;
const sourceExcerptSchema = { const: REDACTED_SOURCE_EXCERPT } as const;
const sourceFieldJsonSchema = { enum: SOURCE_FIELDS } as const;

export const PASSPORT_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $comment:
    'Standard JSON Schema cannot enforce FlowPass UTF-8 or whole-document byte budgets; the canonical runtime validator is authoritative.',
  'x-flowpass-runtime-limits': {
    string_utf8_bytes_max: MAX_PASSPORT_STRING_BYTES,
    document_utf8_bytes_max: MAX_PASSPORT_JSON_BYTES,
    enforcement: 'canonical runtime validator',
  },
  type: 'object',
  additionalProperties: false,
  required: ['passport_draft'],
  properties: {
    passport_draft: {
      type: 'object',
      additionalProperties: false,
      required: [
        'use_case',
        'nodes',
        'edges',
        'sharing_scope',
        'retention',
        'safety_actions',
        'follow_up_questions',
        'administrative_hints',
        'audit',
      ],
      properties: {
        use_case: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'purpose', 'intended_outcome'],
          properties: {
            title: stringSchema,
            purpose: stringSchema,
            intended_outcome: stringSchema,
          },
        },
        nodes: {
          type: 'array',
          maxItems: MAX_PASSPORT_NODES,
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'id',
              'kind',
              'label',
              'data_category',
              'sensitivity',
              'source_field',
              'source_excerpt',
              'confidence',
              'needs_confirmation',
            ],
            properties: {
              id: stringSchema,
              kind: { enum: NODE_KIND_VALUES },
              label: stringSchema,
              data_category: { enum: [...DATA_CATEGORY_VALUES, null] },
              sensitivity: { enum: SENSITIVITY_VALUES },
              source_field: sourceFieldJsonSchema,
              source_excerpt: sourceExcerptSchema,
              confidence: { type: 'number', minimum: 0, maximum: 1 },
              needs_confirmation: { type: 'boolean' },
            },
          },
        },
        edges: {
          type: 'array',
          maxItems: MAX_PASSPORT_EDGES,
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'id',
              'from_node_id',
              'to_node_id',
              'purpose',
              'source_field',
              'source_excerpt',
              'confidence',
              'needs_confirmation',
            ],
            properties: {
              id: stringSchema,
              from_node_id: stringSchema,
              to_node_id: stringSchema,
              purpose: stringSchema,
              source_field: sourceFieldJsonSchema,
              source_excerpt: sourceExcerptSchema,
              confidence: { type: 'number', minimum: 0, maximum: 1 },
              needs_confirmation: { type: 'boolean' },
            },
          },
        },
        sharing_scope: {
          type: 'object',
          additionalProperties: false,
          required: [
            'audience',
            'source_field',
            'source_excerpt',
            'needs_confirmation',
          ],
          properties: {
            audience: { enum: ['self', 'team', 'client', 'public', 'unknown'] },
            source_field: { const: 'destination_and_audience' },
            source_excerpt: sourceExcerptSchema,
            needs_confirmation: { type: 'boolean' },
          },
        },
        retention: {
          type: 'object',
          additionalProperties: false,
          required: [
            'storage_location',
            'duration',
            'deletion_plan',
            'needs_confirmation',
          ],
          properties: {
            storage_location: stringSchema,
            duration: stringSchema,
            deletion_plan: stringSchema,
            needs_confirmation: { type: 'boolean' },
          },
        },
        safety_actions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'id',
              'action',
              'reason',
              'applies_to_node_ids',
              'status',
              'evidence_type',
            ],
            properties: {
              id: stringSchema,
              action: stringSchema,
              reason: stringSchema,
              applies_to_node_ids: { type: 'array', items: stringSchema },
              status: { const: 'required_confirmation' },
              evidence_type: {
                enum: [
                  'applicant_confirmation',
                  'system_check',
                  'officer_review',
                ],
              },
            },
          },
        },
        follow_up_questions: {
          type: 'array',
          maxItems: MAX_FOLLOW_UP_QUESTIONS,
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'id',
              'version',
              'prompt',
              'reason',
              'answerSchema',
              'required',
              'relatedNodeIds',
              'priority',
              'status',
            ],
            properties: {
              id: stringSchema,
              version: { type: 'integer', minimum: 1 },
              prompt: nonEmptyStringSchema,
              reason: nonEmptyStringSchema,
              answerSchema: {
                oneOf: [
                  {
                    type: 'object',
                    additionalProperties: false,
                    required: ['type', 'maxLength'],
                    properties: { type: { const: 'text' }, maxLength: { const: 400 } },
                  },
                  {
                    type: 'object',
                    additionalProperties: false,
                    required: ['type', 'choices'],
                    properties: {
                      type: { const: 'single_choice' },
                      choices: { type: 'array', minItems: 1, items: nonEmptyStringSchema },
                    },
                  },
                  {
                    type: 'object',
                    additionalProperties: false,
                    required: ['type', 'choices'],
                    properties: {
                      type: { const: 'multi_choice' },
                      choices: { type: 'array', minItems: 1, items: nonEmptyStringSchema },
                    },
                  },
                  {
                    type: 'object',
                    additionalProperties: false,
                    required: ['type'],
                    properties: { type: { const: 'boolean' } },
                  },
                  {
                    type: 'object',
                    additionalProperties: false,
                    required: ['type'],
                    properties: { type: { const: 'date' } },
                  },
                ],
              },
              required: { type: 'boolean' },
              relatedNodeIds: { type: 'array', items: stringSchema },
              priority: { enum: QUESTION_PRIORITY_VALUES },
              status: { enum: FOLLOW_UP_STATUS_VALUES },
            },
          },
        },
        administrative_hints: {
          type: 'object',
          additionalProperties: false,
          required: [
            'requested_tool',
            'invoice_fields_required',
            'subsidy_calculation',
            'requires_officer_review',
          ],
          properties: {
            requested_tool: stringSchema,
            invoice_fields_required: {
              type: 'array',
              minItems: 4,
              maxItems: 4,
              uniqueItems: true,
              items: {
                enum: ['tool_name', 'purchase_date', 'amount', 'invoice_number'],
              },
            },
            subsidy_calculation: { const: 'not_performed_by_ai' },
            requires_officer_review: { const: true },
          },
        },
        audit: {
          type: 'object',
          additionalProperties: false,
          required: ['draft_status', 'rules_version', 'unknown_fields'],
          properties: {
            draft_status: { const: 'ai_generated_unconfirmed' },
            rules_version: { const: 'hackathon-mvp-2026-08-27' },
            unknown_fields: { type: 'array', items: stringSchema },
          },
        },
      },
    },
  },
} as const;

type GenerationSchema = {
  [key: string]: unknown;
  properties: {
    passport_draft: {
      properties: {
        follow_up_questions: {
          items: {
            properties: { answerSchema: unknown };
          };
        };
      };
    };
  };
};

/**
 * LM Studio's local grammar compiler cannot consume the full runtime schema's
 * oneOf branch. Generation therefore uses a flat answerSchema with optional
 * fields; the complete Zod and graph validator remains authoritative before
 * anything is persisted.
 */
export const PASSPORT_GENERATION_JSON_SCHEMA = (() => {
  const schema = structuredClone(PASSPORT_JSON_SCHEMA) as unknown as GenerationSchema;
  delete schema.$schema;
  delete schema.$comment;
  delete schema['x-flowpass-runtime-limits'];
  schema.properties.passport_draft.properties.follow_up_questions.items.properties.answerSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['type'],
    properties: {
      type: { enum: ['text', 'single_choice', 'multi_choice', 'boolean'] },
      maxLength: { type: 'integer', minimum: 1, maximum: 400 },
      choices: {
        type: 'array',
        minItems: 2,
        maxItems: 8,
        items: nonEmptyStringSchema,
      },
    },
  };
  return schema;
})();
