'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { PublicApiClient } from '../../lib/public-api';
import { formatTaipeiDate } from './applicant-case-status';

export type TimelineEvent = { id: string; eventType: string; publicSummary: string; createdAt: string };

type LoadState = 'loading' | 'ready' | 'error';
type Milestone = TimelineEvent & { milestoneKey: string; sourceIndex: number };

const PUBLIC_SUMMARY: Record<string, string> = {
  received: '申請資料已收到',
  submitted: '申請已送出',
  review_started: '已開始審查',
  documents_requested: '需要補充資料',
  correction_requested: '需要修正資料',
  documents_resubmitted: '補充資料已收到',
  passport_reconfirmed: '更新內容已確認',
  approved: '申請已核定',
  rejected: '審查已完成',
  awaiting_disbursement: '等待撥款',
  disbursed: '款項已撥付',
  closed: '申請已結案',
};

function milestoneKey(eventType: string): string | null {
  if (eventType === 'received' || eventType === 'submitted') return 'submitted';
  if (eventType === 'review_started') return 'review';
  if (eventType === 'documents_requested' || eventType === 'correction_requested' || eventType === 'documents_resubmitted' || eventType === 'passport_reconfirmed') return 'follow-up';
  if (eventType === 'approved' || eventType === 'rejected') return 'decision';
  if (eventType === 'awaiting_disbursement' || eventType === 'disbursed') return 'payment';
  if (eventType === 'closed') return 'closed';
  return null;
}

export function visibleMilestones(events: TimelineEvent[]): Milestone[] {
  const submittedIndex = events.findIndex((event) => event.eventType === 'submitted');
  const hasRequestedFollowUp = events.some((event) => event.eventType === 'documents_requested' || event.eventType === 'correction_requested');
  const latest = new Map<string, Milestone>();

  events.forEach((event, sourceIndex) => {
    const key = milestoneKey(event.eventType);
    if (!key) return;
    if (event.eventType === 'received' && submittedIndex >= 0) return;
    if (key === 'follow-up' && !hasRequestedFollowUp && submittedIndex >= 0 && sourceIndex < submittedIndex) return;
    latest.set(key, {
      ...event,
      publicSummary: PUBLIC_SUMMARY[event.eventType] ?? event.publicSummary,
      milestoneKey: key,
      sourceIndex,
    });
  });

  return [...latest.values()].sort((a, b) => a.sourceIndex - b.sourceIndex).slice(-5);
}

export function CaseTimeline({ caseId, initial = [] }: { caseId: string; initial?: TimelineEvent[] }) {
  const [events, setEvents] = useState(initial);
  const [loadState, setLoadState] = useState<LoadState>(initial.length > 0 ? 'ready' : 'loading');
  const api = useMemo(() => new PublicApiClient(), []);

  const load = useCallback(async () => {
    try {
      const value = await api.read<{ events: TimelineEvent[] }>(`/api/v1/cases/${encodeURIComponent(caseId)}/timeline`);
      setEvents(value.events);
      setLoadState('ready');
    } catch {
      setLoadState('error');
    }
  }, [api, caseId]);

  useEffect(() => {
    if (initial.length > 0) return;
    void api.read<{ events: TimelineEvent[] }>(`/api/v1/cases/${encodeURIComponent(caseId)}/timeline`)
      .then((value) => { setEvents(value.events); setLoadState('ready'); })
      .catch(() => setLoadState('error'));
  }, [api, caseId, initial.length]);

  const milestones = visibleMilestones(events);
  if (loadState === 'loading' && events.length === 0) return <div className="applicant-inline-state" role="status">正在載入處理進度…</div>;
  if (loadState === 'error') return (
    <div className="applicant-inline-state applicant-inline-state--error" role="alert">
      <p>處理進度暫時無法載入。</p>
      <button type="button" className="text-action" onClick={() => { setLoadState('loading'); void load(); }}>重新載入</button>
    </div>
  );
  if (milestones.length === 0) return <div className="applicant-inline-state"><p>目前還沒有可顯示的進度更新。</p></div>;

  return (
    <ol className="applicant-timeline" aria-label="處理進度">
      {milestones.map((event, index) => (
        <li className={index === milestones.length - 1 ? 'is-current' : undefined} key={event.id}>
          <span className="applicant-timeline-marker" aria-hidden="true">{index === milestones.length - 1 ? '●' : '✓'}</span>
          <span className="applicant-timeline-copy">
            <strong>{event.publicSummary}</strong>
            <time dateTime={event.createdAt}>{formatTaipeiDate(event.createdAt, true)}</time>
          </span>
        </li>
      ))}
    </ol>
  );
}
