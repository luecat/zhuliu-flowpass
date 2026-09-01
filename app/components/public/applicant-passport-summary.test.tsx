import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FLOWPASS_SAMPLE } from '../../passport-sample';
import { inspectPassportJson } from '../../../server/domain/passport-validation';
import { ApplicantPassportSummary } from './applicant-passport-summary';

const passport = inspectPassportJson(JSON.stringify(FLOWPASS_SAMPLE)).canonical!;

describe('ApplicantPassportSummary', () => {
  it('shows applicant-facing flow content without internal diagnostics', () => {
    render(<ApplicantPassportSummary passport={passport} workflowState="follow_up_required" />);
    expect(screen.getByRole('heading', { name: FLOWPASS_SAMPLE.passport_draft.use_case.title })).toBeVisible();
    expect(screen.getByText('資料怎麼流動')).toBeVisible();
    expect(screen.getByText('請先回答下方問題，系統會再整理一次護照。')).toBeVisible();
    expect(screen.queryByText('GRAPH CHECK')).not.toBeInTheDocument();
    expect(screen.queryByText('解析檢查')).not.toBeInTheDocument();
    expect(screen.queryByText('未知欄位')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('$.passport_draft');
  });

  it('lists each flow node once instead of repeating connected pairs', () => {
    const nodes = passport.nodes.slice(0, 4).map((node, index) => ({ ...node, id: `node-${index}`, label: ['A', 'B', 'C', 'D'][index] }));
    const linearPassport = {
      ...passport,
      nodes,
      edges: [
        { ...passport.edges[0], id: 'edge-bc', from_node_id: 'node-1', to_node_id: 'node-2' },
        { ...passport.edges[0], id: 'edge-cd', from_node_id: 'node-2', to_node_id: 'node-3' },
        { ...passport.edges[0], id: 'edge-ab', from_node_id: 'node-0', to_node_id: 'node-1' },
      ],
    };
    render(<ApplicantPassportSummary passport={linearPassport} workflowState="follow_up_required" />);
    const flow = screen.getByRole('heading', { name: '資料怎麼流動' }).closest('section')!;
    expect(flow).toHaveTextContent('A↓B↓C↓D');
    expect(flow).not.toHaveTextContent('→');
    expect(Array.from(flow.querySelectorAll('.applicant-flow-arrow')).map((item) => item.textContent)).toEqual(['↓', '↓', '↓']);
    for (const label of ['A', 'B', 'C', 'D']) expect(flow.querySelectorAll('strong')).toSatisfy((items: NodeListOf<Element>) => Array.from(items).filter((item) => item.textContent === label).length === 1);
  });

  it('replaces internal JSON names and enum literals in applicant-visible model copy', () => {
    const exposedPassport = {
      ...passport,
      use_case: {
        title: 'audience 為 public',
        purpose: '檢查 personal_or_sensitive_data 欄位',
        intended_outcome: '$.passport_draft.use_case',
      },
      nodes: passport.nodes.map((node, index) => index === 0 ? { ...node, label: 'destination_and_audience' } : node),
      safety_actions: [{
        ...passport.safety_actions[0],
        action: '確認 sharing_scope',
        reason: '因 audience 為 public',
      }],
    };

    render(<ApplicantPassportSummary passport={exposedPassport} workflowState="follow_up_required" />);

    expect(document.body.textContent).not.toMatch(/audience|public|personal_or_sensitive_data|destination_and_audience|sharing_scope|passport_draft/i);
    expect(screen.getByRole('heading', { name: 'AI 使用流程' })).toBeVisible();
    expect(screen.getByText('請確認資料內容、分享對象與使用方式符合你的實際情況。')).toBeVisible();
  });

  it('requires confirmation before continuing', () => {
    const onContinue = vi.fn();
    render(<ApplicantPassportSummary passport={passport} workflowState="needs_applicant_confirmation" onContinue={onContinue} />);
    const button = screen.getByRole('button', { name: '確認內容，前往附件' });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: '我已確認以上內容' }));
    fireEvent.click(button);
    expect(onContinue).toHaveBeenCalledOnce();
  });
});
