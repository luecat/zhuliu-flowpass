import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CaseTimeline } from './case-timeline';

describe('CaseTimeline', () => {
  it('renders a local-language progress update without technical event data', () => {
    render(<CaseTimeline caseId="case" initial={[{ id: 'e', eventType: 'submitted', publicSummary: '申請已送出', createdAt: '2026-01-01T00:00:00Z' }]} />);

    expect(screen.getByText('申請已送出')).toBeInTheDocument();
    expect(screen.getByText('2026年1月1日 08:00')).toBeInTheDocument();
    expect(screen.queryByText(/2026-01-01T00:00:00Z|submitted|admin/i)).not.toBeInTheDocument();
  });

  it('collapses receipt noise into the single submitted milestone', () => {
    render(<CaseTimeline caseId="case" initial={[
      { id: 'e1', eventType: 'received', publicSummary: '案件已收件', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'e2', eventType: 'received', publicSummary: '案件已收件', createdAt: '2026-01-01T00:01:00Z' },
      { id: 'e3', eventType: 'submitted', publicSummary: '申請已送出', createdAt: '2026-01-01T00:02:00Z' },
    ]} />);

    expect(screen.queryByText('案件已收件')).not.toBeInTheDocument();
    expect(screen.getAllByText('申請已送出')).toHaveLength(1);
  });
});
