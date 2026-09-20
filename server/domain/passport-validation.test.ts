import { describe, expect, it } from 'vitest';
import { FLOWPASS_SAMPLE_JSON } from '../../app/passport-sample';
import {
  inspectPassportDocument,
  inspectPassportJson,
  validatePassportDocument,
  validatePassportJson,
} from './passport-validation';

const RAW_EXCERPT = 'RAW-SOURCE-EXCERPT-DO-NOT-RETAIN';
const GRAPH_SENTINEL = 'SOURCE-EXCERPT-SENTINEL-DO-NOT-LOG';
const INVALID_REFERENCE_SENTINEL = 'INVALID-REFERENCE-SENTINEL-DO-NOT-LOG';
const OVERSIZED_SOURCE_MARKER = 'OVERSIZED-SOURCE-MARKER-DO-NOT-RETAIN-';

type MutableRecord = Record<string, unknown>;
type MutableDraft = MutableRecord & {
  nodes: MutableRecord[];
  edges: MutableRecord[];
  safety_actions: MutableRecord[];
  confirmation_questions?: MutableRecord[];
  follow_up_questions: MutableRecord[];
  use_case?: MutableRecord;
  sharing_scope: MutableRecord;
  audit: MutableRecord;
};
type MutableDocument = { passport_draft: MutableDraft };

function legacySample(): MutableDocument {
  return JSON.parse(FLOWPASS_SAMPLE_JSON) as MutableDocument;
}

function canonicalSample(): MutableDocument {
  const document = legacySample();
  const draft = document.passport_draft;
  const legacyQuestions = draft.confirmation_questions;
  if (!legacyQuestions) throw new Error('Legacy fixture has no confirmation questions.');
  draft.follow_up_questions = legacyQuestions.map(
    (question: Record<string, unknown>, index: number) => ({
      id: question.id,
      version: 1,
      prompt: question.question,
      reason: question.reason,
      answerSchema:
        index === 0
          ? { type: 'text', maxLength: 400 }
          : index === 1
            ? { type: 'single_choice', choices: ['是', '否'] }
            : index === 2
              ? { type: 'multi_choice', choices: ['甲', '乙'] }
              : index === 3
                ? { type: 'boolean' }
                : index === 4
                  ? { type: 'date' }
                  : { type: 'text', maxLength: 400 },
      required: index === 0,
      relatedNodeIds: question.related_node_ids,
      priority: question.priority,
      status: 'open',
    }),
  );
  delete draft.confirmation_questions;
  return document;
}

function validOversizedLegacyDocument(): MutableDocument {
  const document = legacySample();
  const draft = document.passport_draft;
  const sourceExcerpt = `${OVERSIZED_SOURCE_MARKER}${'x'.repeat(
    4 * 1024 - OVERSIZED_SOURCE_MARKER.length,
  )}`;

  draft.nodes.forEach((node) => {
    node.source_excerpt = sourceExcerpt;
  });
  while (draft.nodes.length < 80) {
    const index = draft.nodes.length;
    draft.nodes.push({
      ...draft.nodes[0],
      id: `node_extra_${index}`,
      source_excerpt: sourceExcerpt,
    });
  }

  draft.edges.forEach((edge) => {
    edge.source_excerpt = sourceExcerpt;
  });
  while (draft.edges.length < 160) {
    const index = draft.edges.length;
    draft.edges.push({
      ...draft.edges[0],
      id: `edge_extra_${index}`,
      source_excerpt: sourceExcerpt,
    });
  }
  draft.sharing_scope.source_excerpt = sourceExcerpt;
  return document;
}

describe('canonical FlowPass passport validation', () => {
  it('adapts the legacy Studio sample into a redacted canonical passport', () => {
    const document = legacySample();
    document.passport_draft.nodes[0].source_excerpt = RAW_EXCERPT;

    const inspection = inspectPassportJson(JSON.stringify(document));

    expect(inspection.validation).toMatchObject({ ok: true });
    if (!inspection.validation.ok) return;
    expect(inspection.validation.value.follow_up_questions).toHaveLength(8);
    expect(inspection.validation.value.follow_up_questions[0]).toMatchObject({
      id: 'q_01',
      version: 1,
      answerSchema: { type: 'text', maxLength: 400 },
      required: false,
      status: 'open',
    });
    expect(JSON.stringify(inspection.validation.value)).not.toContain(
      RAW_EXCERPT,
    );
    expect(inspection.redactions).toContainEqual({
      code: 'source_excerpt_redacted',
      path: '$.passport_draft.nodes[0].source_excerpt',
    });
    expect(JSON.stringify(inspection.redactions)).not.toContain(RAW_EXCERPT);
  });

  it('accepts every exact follow-up answer-schema branch', () => {
    const result = validatePassportDocument(canonicalSample());

    expect(result).toMatchObject({ ok: true });
  });

  it('returns only a safe syntax issue for malformed JSON', () => {
    const result = validatePassportJson('{"passport_draft":');

    expect(result).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          code: 'invalid_json',
          category: 'syntax',
          severity: 'error',
          path: '$',
        }),
      ],
    });
  });

  it('rejects missing and unexpected contract fields by their safe paths', () => {
    const document = canonicalSample();
    delete document.passport_draft.use_case;
    document.passport_draft.unexpected_raw_value = RAW_EXCERPT;

    const result = validatePassportDocument(document);

    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.errors.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(['$.passport_draft.use_case']),
    );
    expect(result.errors.map((issue) => issue.path)).not.toContain('$.passport_draft.unexpected_raw_value');
    expect(JSON.stringify(result.errors)).not.toContain(RAW_EXCERPT);
  });

  it('rejects a dangling graph edge and duplicate node key', () => {
    const document = canonicalSample();
    document.passport_draft.edges[0].to_node_id = 'node_missing';
    document.passport_draft.nodes[1].id = document.passport_draft.nodes[0].id;

    const result = validatePassportDocument(document);

    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_edge_reference',
          path: '$.passport_draft.edges[0].to_node_id',
        }),
        expect.objectContaining({
          code: 'duplicate_node_id',
          path: '$.passport_draft.nodes[1].id',
        }),
      ]),
    );
    expect(result.errors.every((issue) => issue.relatedIds === undefined)).toBe(true);
  });

  it('repairs only known data categories misplaced in node.kind', () => {
    const document = canonicalSample();
    document.passport_draft.nodes[0].kind = 'photo';

    const result = validatePassportDocument(document);

    expect(result).toMatchObject({
      ok: true,
      repairs: [
        {
          path: '$.passport_draft.nodes[0].kind',
          nodeId: 'node_mat_01',
          from: 'photo',
          to: 'data',
          reason: 'known_data_category_in_kind',
        },
      ],
    });
  });

  it('keeps unknown node kinds invalid instead of inventing a repair', () => {
    const document = canonicalSample();
    document.passport_draft.nodes[0].kind = 'creative_output';

    const result = validatePassportDocument(document);

    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '$.passport_draft.nodes[0].kind',
          code: 'schema_invalid_value',
        }),
      ]),
    );
    expect(JSON.stringify(result.errors)).not.toContain('creative_output');
  });

  it('enforces the exact, answerable follow-up form contract', () => {
    const document = canonicalSample();
    document.passport_draft.follow_up_questions[0].answerSchema = {
      type: 'text',
      maxLength: 399,
    };
    document.passport_draft.follow_up_questions[1].answerSchema = {
      type: 'single_choice',
      choices: [],
    };
    document.passport_draft.follow_up_questions[3].answerSchema = {
      type: 'boolean',
      maxLength: 400,
    };

    const result = validatePassportDocument(document);

    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.errors.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        '$.passport_draft.follow_up_questions[0].answerSchema.maxLength',
        '$.passport_draft.follow_up_questions[1].answerSchema.choices',
      ]),
    );
    expect(result.errors.map((issue) => issue.path)).not.toContain(
      '$.passport_draft.follow_up_questions[3].answerSchema.maxLength',
    );
  });

  it('rejects a follow-up question that points to an absent node', () => {
    const document = canonicalSample();
    document.passport_draft.follow_up_questions[4].relatedNodeIds = [
      'node_missing',
    ];

    const result = validatePassportDocument(document);

    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'invalid_question_reference',
        path: '$.passport_draft.follow_up_questions[4].relatedNodeIds[0]',
      }),
    );
    expect(result.errors.every((issue) => issue.relatedIds === undefined)).toBe(true);
  });

  it('rejects an oversized direct object before redaction through both object APIs', () => {
    const document = validOversizedLegacyDocument();
    const raw = JSON.stringify(document);

    expect(new TextEncoder().encode(raw).byteLength).toBeGreaterThan(256 * 1024);

    const inspection = inspectPassportDocument(document);
    expect(inspection.validation).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: 'raw_document_too_large' })],
    });
    expect(inspection.canonical).toBeNull();
    expect(JSON.stringify(inspection)).not.toContain(OVERSIZED_SOURCE_MARKER);

    expect(validatePassportDocument(document)).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: 'raw_document_too_large' })],
    });
    expect(validatePassportJson(raw)).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: 'raw_json_too_large' })],
    });
  });

  it('fails closed for cyclic direct objects without retaining input content', () => {
    const document = canonicalSample();
    document.passport_draft.unserializable_source = GRAPH_SENTINEL;
    document.passport_draft.self = document;

    const inspection = inspectPassportDocument(document);

    expect(inspection.validation).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: 'raw_document_unserializable' })],
    });
    expect(inspection.canonical).toBeNull();
    expect(JSON.stringify(inspection)).not.toContain(GRAPH_SENTINEL);
  });

  it('keeps graph diagnostics, parser output, and revision requests free of graph sentinels', () => {
    const document = canonicalSample();
    document.passport_draft.edges[0].to_node_id = INVALID_REFERENCE_SENTINEL;
    document.passport_draft.nodes[0].id = GRAPH_SENTINEL;
    document.passport_draft.nodes[1].id = GRAPH_SENTINEL;
    document.passport_draft.edges[3].to_node_id = GRAPH_SENTINEL;
    document.passport_draft.safety_actions[0].applies_to_node_ids = [
      GRAPH_SENTINEL,
    ];
    document.passport_draft.follow_up_questions[0].relatedNodeIds = [
      GRAPH_SENTINEL,
    ];
    document.passport_draft.edges[1].purpose = GRAPH_SENTINEL;
    document.passport_draft.edges.push({
      ...document.passport_draft.edges[1],
      id: 'edge_duplicate_purpose',
    });

    const inspection = inspectPassportDocument(document);
    expect(inspection.validation).toMatchObject({ ok: false });
    expect(JSON.stringify(inspection)).not.toContain(GRAPH_SENTINEL);
    expect(JSON.stringify(inspection)).not.toContain(INVALID_REFERENCE_SENTINEL);
  });

  it('enforces node, edge, question, UTF-8 string, raw, and canonical JSON caps', () => {
    const nodes = canonicalSample();
    for (let index = 0; index < 73; index += 1) {
      nodes.passport_draft.nodes.push({
        ...nodes.passport_draft.nodes[0],
        id: `node_extra_${index}`,
      });
    }
    expect(validatePassportDocument(nodes)).toMatchObject({ ok: false });

    const edges = canonicalSample();
    for (let index = 0; index < 157; index += 1) {
      edges.passport_draft.edges.push({
        ...edges.passport_draft.edges[0],
        id: `edge_extra_${index}`,
      });
    }
    expect(validatePassportDocument(edges)).toMatchObject({ ok: false });

    const questions = canonicalSample();
    for (let index = 0; index < 5; index += 1) {
      questions.passport_draft.follow_up_questions.push({
        ...questions.passport_draft.follow_up_questions[0],
        id: `q_extra_${index}`,
      });
    }
    expect(validatePassportDocument(questions)).toMatchObject({ ok: false });

    const multibyte = canonicalSample();
    const useCase = multibyte.passport_draft.use_case;
    if (!useCase) throw new Error('Canonical fixture has no use case.');
    useCase.title = '中'.repeat(1366);
    expect(validatePassportDocument(multibyte)).toMatchObject({ ok: false });

    const canonicalTooLarge = canonicalSample();
    canonicalTooLarge.passport_draft.audit.unknown_fields = Array.from(
      { length: 65 },
      (_, index) => `${index}-${'a'.repeat(4093)}`,
    );
    expect(validatePassportDocument(canonicalTooLarge)).toMatchObject({
      ok: false,
    });

    const rawTooLarge = JSON.stringify({
      passport_draft: { note: 'a'.repeat(256 * 1024) },
    });
    expect(validatePassportJson(rawTooLarge)).toMatchObject({ ok: false });
  });
});
