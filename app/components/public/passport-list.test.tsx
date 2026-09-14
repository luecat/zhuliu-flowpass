import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PassportList } from './passport-list';

describe('PassportList', () => {
  it('shows the passport use title instead of the administrative program label', () => {
    render(
      <PassportList
        initial={[
          {
            id: 'case',
            caseCode: 'FP-1',
            programName: '軟體補助申請',
            title: '社團招生影片製作與發布',
            year: 2026,
            state: 'approved',
            submittedAt: '2026-01-01T00:00:00.000Z',
            unresolvedTaskCount: 1,
            securityAlert: true,
          },
        ]}
      />,
    );

    expect(screen.getByRole('heading', { name: '2026 年' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /社團招生影片製作與發布/ })).toBeInTheDocument();
    expect(screen.getByText('審核通過')).toBeInTheDocument();
    expect(screen.getByText('2026年1月1日 送出')).toBeInTheDocument();
    expect(screen.queryByText(/FP-1|approved|待辦|資安提醒|示範|軟體補助申請|青年 AI 工具補助/)).not.toBeInTheDocument();
  });

  it('falls back to 用途 when the passport title is missing', () => {
    render(
      <PassportList
        initial={[
          {
            id: 'case-2',
            caseCode: 'FP-2',
            programName: '軟體補助申請',
            year: 2026,
            state: 'submitted',
            submittedAt: null,
            unresolvedTaskCount: 0,
            securityAlert: false,
          },
        ]}
      />,
    );

    expect(screen.getByRole('link', { name: /用途/ })).toBeInTheDocument();
  });
});
