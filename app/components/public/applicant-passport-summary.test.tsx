import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FLOWPASS_SAMPLE } from '../../passport-sample';
import { inspectPassportJson } from '../../../server/domain/passport-validation';
import { ApplicantPassportSummary } from './applicant-passport-summary';

const passport = inspectPassportJson(JSON.stringify(FLOWPASS_SAMPLE)).canonical!;

function stage(title: string) {
  return screen.getByRole('heading', { name: title }).closest('li')!;
}

describe('ApplicantPassportSummary', () => {
  it('shows applicant-facing flow content without internal diagnostics', () => {
    render(<ApplicantPassportSummary passport={passport} workflowState="follow_up_required" />);
    expect(screen.getByRole('heading', { name: FLOWPASS_SAMPLE.passport_draft.use_case.title })).toBeVisible();
    expect(screen.getByRole('heading', { name: '資料怎麼流動' })).toBeVisible();
    expect(screen.getByText('請先回答下方問題，確認後點擊「重新產生資料流向」。')).toBeVisible();
    expect(screen.queryByText('GRAPH CHECK')).not.toBeInTheDocument();
    expect(screen.queryByText('解析檢查')).not.toBeInTheDocument();
    expect(screen.queryByText('未知欄位')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('$.passport_draft');
  });

  it('groups nodes into ordered stages and separates sensitive data', () => {
    render(<ApplicantPassportSummary passport={passport} workflowState="needs_applicant_confirmation" />);
    const stages = screen.getAllByRole('heading', { level: 4 }).map((heading) => heading.textContent);
    expect(stages).toEqual(['用到的資料', '交給 AI 處理', '存放位置', '分享與發布']);

    const data = stage('用到的資料');
    expect(within(data).getByText('社員錄音原始檔')).toHaveClass('applicant-flow-chip');
    expect(within(data).getByText('人臉生物特徵資料')).toHaveClass('is-sensitive');
    expect(within(stage('交給 AI 處理')).getByText('待確認')).toBeVisible();
    expect(within(stage('分享與發布')).getByText('公開')).toBeVisible();
    expect(document.body.textContent).not.toContain('→');
  });

  it('drops the draft header and confirmation tags in record mode', () => {
    render(<ApplicantPassportSummary passport={passport} workflowState="confirmed" mode="record" />);
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
    expect(screen.queryByText('待確認')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '使用時記得' })).toBeVisible();
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
    expect(screen.getByText('請確認資料內容、分享對象與使用方式符合實際情況。')).toBeVisible();
  });

  it('continues with a single confirm button instead of a checkbox', () => {
    const onContinue = vi.fn();
    render(<ApplicantPassportSummary passport={passport} workflowState="needs_applicant_confirmation" onContinue={onContinue} />);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    const button = screen.getByRole('button', { name: '確認無誤，前往附件' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onContinue).toHaveBeenCalledOnce();
  });
});
