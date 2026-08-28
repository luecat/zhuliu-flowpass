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

  it('repairs a data category mistakenly returned as a node kind', () => {
    const parsed = JSON.parse(FLOWPASS_SAMPLE_JSON);
    parsed.passport_draft.nodes[3].kind = 'creative_asset';
    parsed.passport_draft.nodes[3].data_category = 'video';

    const result = parseFlowPassJson(JSON.stringify(parsed));

    expect(result.status).toBe('valid_with_warnings');
    expect(result.passport?.nodes[3]).toMatchObject({
      id: 'node_data_pii_01',
      kind: 'data',
      data_category: 'video',
    });
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'normalized_node_kind',
        category: 'schema',
        severity: 'warning',
        path: '$.passport_draft.nodes[3].kind',
        relatedIds: ['node_data_pii_01'],
      }),
    );
  });

  it('lists valid node kinds when an unknown kind cannot be repaired', () => {
    const parsed = JSON.parse(FLOWPASS_SAMPLE_JSON);
    parsed.passport_draft.nodes[3].kind = 'creative_output';

    const result = parseFlowPassJson(JSON.stringify(parsed));
    const issue = result.issues.find(
      (item) => item.path === '$.passport_draft.nodes[3].kind',
    );

    expect(result.status).toBe('invalid_contract');
    expect(issue?.message).toContain(
      'data、ai_tool、plugin、storage、person、organization、destination',
    );
    expect(issue?.message).toContain('data_category');
  });

  it('counts sensitivity, unknown fields, and orphan nodes independently', () => {
    const result = parseFlowPassJson(FLOWPASS_SAMPLE_JSON);

    expect(result.status).toBe('valid_with_warnings');
    expect(result.summary?.sensitivityCounts).toEqual({
      low: 2,
      medium: 2,
      high: 4,
      unknown: 0,
    });
    expect(result.summary?.unknownFields).toEqual([
      '$.retention.duration',
      '$.retention.deletion_plan',
      '$.administrative_hints.requested_tool',
    ]);
    expect(
      result.issues.filter((issue) => issue.code === 'orphan_node'),
    ).toHaveLength(3);
  });

  it('rejects an edge that points to a missing node', () => {
    const parsed = JSON.parse(FLOWPASS_SAMPLE_JSON);
    parsed.passport_draft.edges[0].to_node_id = 'node_missing';

    const result = parseFlowPassJson(JSON.stringify(parsed));

    expect(result.status).toBe('invalid_graph');
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'invalid_edge_reference',
        severity: 'error',
        path: '$.passport_draft.edges[0].to_node_id',
        relatedIds: ['node_missing'],
      }),
    );
  });

  it('rejects duplicate and blank IDs in graph collections', () => {
    const parsed = JSON.parse(FLOWPASS_SAMPLE_JSON);
    parsed.passport_draft.nodes[1].id = parsed.passport_draft.nodes[0].id;
    parsed.passport_draft.safety_actions[0].id = '';

    const result = parseFlowPassJson(JSON.stringify(parsed));

    expect(result.status).toBe('invalid_graph');
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['duplicate_node_id', 'blank_action_id']),
    );
  });

  it('rejects self-loops and warns about repeated transfers', () => {
    const parsed = JSON.parse(FLOWPASS_SAMPLE_JSON);
    parsed.passport_draft.edges[0].to_node_id = 'node_mat_01';
    parsed.passport_draft.edges.push({
      ...parsed.passport_draft.edges[1],
      id: 'edge_duplicate',
    });

    const result = parseFlowPassJson(JSON.stringify(parsed));

    expect(result.status).toBe('invalid_graph');
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['self_loop', 'duplicate_edge']),
    );
  });

  it('warns when a valid graph contains a directed cycle', () => {
    const parsed = JSON.parse(FLOWPASS_SAMPLE_JSON);
    parsed.passport_draft.edges.push({
      ...parsed.passport_draft.edges[0],
      id: 'edge_cycle',
      from_node_id: 'node_dest_01',
      to_node_id: 'node_mat_01',
      purpose: '測試回流',
    });

    const result = parseFlowPassJson(JSON.stringify(parsed));

    expect(result.status).toBe('valid_with_warnings');
    expect(result.issues.some((issue) => issue.code === 'graph_cycle')).toBe(
      true,
    );
  });

  it('rejects missing references from actions and questions', () => {
    const parsed = JSON.parse(FLOWPASS_SAMPLE_JSON);
    parsed.passport_draft.safety_actions[0].applies_to_node_ids = [
      'node_missing_action',
    ];
    parsed.passport_draft.confirmation_questions[0].related_node_ids = [
      'node_missing_question',
    ];

    const result = parseFlowPassJson(JSON.stringify(parsed));

    expect(result.status).toBe('invalid_graph');
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'invalid_action_reference',
        'invalid_question_reference',
      ]),
    );
  });

  it('checks retention and public destination graph semantics', () => {
    const parsed = JSON.parse(FLOWPASS_SAMPLE_JSON);
    parsed.passport_draft.retention.storage_location = 'node_dest_01';
    parsed.passport_draft.edges = parsed.passport_draft.edges.filter(
      (edge: { to_node_id: string }) => edge.to_node_id !== 'node_dest_01',
    );

    const result = parseFlowPassJson(JSON.stringify(parsed));

    expect(result.status).toBe('invalid_graph');
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'invalid_retention_storage',
        'public_without_destination_flow',
      ]),
    );
  });

  it('accepts one complete Markdown JSON fence with a warning', () => {
    const result = parseFlowPassJson(
      `\`\`\`json\n${FLOWPASS_SAMPLE_JSON}\n\`\`\``,
    );

    expect(result.status).toBe('valid_with_warnings');
    expect(result.summary?.nodeCount).toBe(8);
    expect(result.issues.some((issue) => issue.code === 'markdown_fence')).toBe(
      true,
    );
  });

  it('accepts a complete Markdown JSON fence with Windows line endings', () => {
    const windowsJson = FLOWPASS_SAMPLE_JSON.replaceAll('\n', '\r\n');
    const result = parseFlowPassJson(
      `\`\`\`json\r\n${windowsJson}\r\n\`\`\``,
    );

    expect(result.status).toBe('valid_with_warnings');
    expect(result.summary?.nodeCount).toBe(8);
    expect(result.issues.some((issue) => issue.code === 'markdown_fence')).toBe(
      true,
    );
  });
});
