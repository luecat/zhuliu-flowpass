import { describe, expect, it } from 'vitest';
import { FLOWPASS_SAMPLE_JSON } from './passport-sample';
import { parseFlowPassJson } from './passport-parser';

describe('parseFlowPassJson', () => {
  it('summarizes the supplied FlowPass sample', () => {
    const result = parseFlowPassJson(FLOWPASS_SAMPLE_JSON);

    expect(result.status).not.toMatch(/^invalid_/);
    expect(result.summary).toMatchObject({
      nodeCount: 8,
      edgeCount: 4,
      actionCount: 4,
      questionCount: 8,
      priorityCounts: { high: 3, medium: 4, low: 1 },
    });
  });

  it('reports invalid JSON without manufacturing a passport', () => {
    const result = parseFlowPassJson('{"passport_draft":');

    expect(result.status).toBe('invalid_json');
    expect(result.passport).toBeNull();
    expect(result.summary).toBeNull();
    expect(result.issues[0]).toMatchObject({
      category: 'syntax',
      severity: 'error',
      path: '$',
    });
  });

  it('reports a missing passport section with a JSON path', () => {
    const parsed = JSON.parse(FLOWPASS_SAMPLE_JSON);
    delete parsed.passport_draft.use_case;

    const result = parseFlowPassJson(JSON.stringify(parsed));

    expect(result.status).toBe('invalid_contract');
    expect(result.passport).toBeNull();
    expect(
      result.issues.some(
        (issue) => issue.path === '$.passport_draft.use_case',
      ),
    ).toBe(true);
  });
});
