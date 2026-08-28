import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { parseFlowPassJson } from './passport-parser';
import { FLOWPASS_SAMPLE_JSON } from './passport-sample';
import { PassportViewer } from './passport-viewer';

describe('PassportViewer', () => {
  it('renders the supplied passport as readable flows', () => {
    const result = parseFlowPassJson(FLOWPASS_SAMPLE_JSON);

    render(<PassportViewer result={result} section="flow" />);

    expect(
      screen.getByRole('heading', { name: '社團招生影片製作與發布' }),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId('readable-flow')).toHaveLength(4);
    expect(screen.getByText('提供照片素材供 AI 生成影片')).toBeVisible();
    expect(screen.getByText('社員照片與錄音原始檔')).toBeVisible();
    expect(screen.getAllByText('AI 影片生成工具')).toHaveLength(3);
    expect(
      screen.getByText(
        '社員照片與錄音原始檔 傳送到 AI 影片生成工具：提供照片素材供 AI 生成影片',
      ),
    ).toBeInTheDocument();
  });

  it('renders draft status, counts, actions, priorities, and unknown fields', () => {
    const result = parseFlowPassJson(FLOWPASS_SAMPLE_JSON);

    render(<PassportViewer result={result} section="details" />);

    expect(screen.getByText('AI 草稿，尚未確認')).toBeVisible();
    const metrics = screen.getByLabelText('護照數量摘要');
    expect(within(metrics).getByText('8')).toBeVisible();
    expect(within(metrics).getByText('4 條連線')).toBeVisible();
    expect(within(metrics).getByText('4 項措施')).toBeVisible();
    expect(within(metrics).getByText('8 個問題')).toBeVisible();
    expect(screen.getByText('高 3')).toBeVisible();
    expect(screen.getByText('中 4')).toBeVisible();
    expect(screen.getByText('低 1')).toBeVisible();
    expect(screen.getAllByTestId('safety-action')).toHaveLength(4);
    expect(screen.getAllByTestId('confirmation-question')).toHaveLength(8);
    expect(screen.getByText('$.retention.duration')).toBeVisible();
    expect(
      screen.getByText('$.administrative_hints.requested_tool'),
    ).toBeVisible();
  });

  it('announces an invalid contract with its exact path', () => {
    const parsed = JSON.parse(FLOWPASS_SAMPLE_JSON);
    delete parsed.passport_draft.use_case;
    const result = parseFlowPassJson(JSON.stringify(parsed));

    render(<PassportViewer result={result} section="details" />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      '$.passport_draft.use_case',
    );
    expect(screen.queryByText('AI 草稿，尚未確認')).not.toBeInTheDocument();
  });

  it('renders HTML-looking JSON values only as text', () => {
    const parsed = JSON.parse(FLOWPASS_SAMPLE_JSON);
    parsed.passport_draft.safety_actions[0].action =
      "<script>alert('x')</script>";
    const result = parseFlowPassJson(JSON.stringify(parsed));
    const { container } = render(
      <PassportViewer result={result} section="details" />,
    );

    expect(screen.getByText("<script>alert('x')</script>")).toBeVisible();
    expect(container.querySelector('script')).toBeNull();
  });
});
