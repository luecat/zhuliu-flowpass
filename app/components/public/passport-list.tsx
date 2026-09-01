'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PublicApiClient } from '../../lib/public-api';
import { applicantCaseStatus, formatTaipeiDate } from './applicant-case-status';

export interface PassportCard {
  id: string;
  caseCode: string;
  programName: string;
  year: number;
  state: string;
  submittedAt: string | null;
  unresolvedTaskCount: number;
  securityAlert: boolean;
}

type LoadState = 'loading' | 'ready' | 'error';

export function PassportList({ initial = [] }: { initial?: PassportCard[] }) {
  const [items, setItems] = useState(initial);
  const [loadState, setLoadState] = useState<LoadState>(initial.length > 0 ? 'ready' : 'loading');
  const api = useMemo(() => new PublicApiClient(), []);

  const load = useCallback(async () => {
    try {
      const value = await api.read<{ passports: PassportCard[] }>('/api/v1/passports');
      setItems(value.passports);
      setLoadState('ready');
    } catch {
      setLoadState('error');
    }
  }, [api]);

  useEffect(() => {
    if (initial.length > 0) return;
    void api.read<{ passports: PassportCard[] }>('/api/v1/passports')
      .then((value) => { setItems(value.passports); setLoadState('ready'); })
      .catch(() => setLoadState('error'));
  }, [api, initial.length]);

  const groups = new Map<number, PassportCard[]>();
  items.forEach((item) => groups.set(item.year, [...(groups.get(item.year) ?? []), item]));

  return (
    <section className="applicant-records" aria-labelledby="passport-list-title">
      <header className="applicant-page-heading">
        <p className="eyebrow">竹流 FlowPass</p>
        <h1 id="passport-list-title">申請紀錄</h1>
        <p>查看每筆申請目前的處理進度。</p>
      </header>

      {loadState === 'loading' && items.length === 0 && (
        <div className="applicant-state-card" role="status">
          <span className="applicant-loading-mark" aria-hidden="true" />
          <p>正在載入申請紀錄…</p>
        </div>
      )}

      {loadState === 'error' && (
        <div className="applicant-state-card applicant-state-card--error" role="alert">
          <h2>暫時無法載入</h2>
          <p>請確認網路連線後再試一次。</p>
          <button type="button" className="secondary-action" onClick={() => { setLoadState('loading'); void load(); }}>重新載入</button>
        </div>
      )}

      {loadState === 'ready' && items.length === 0 && (
        <div className="applicant-state-card">
          <h2>還沒有申請紀錄</h2>
          <p>送出申請後，處理進度會顯示在這裡。</p>
          <Link className="primary-action" href="/app/apply">開始申請</Link>
        </div>
      )}

      {items.length > 0 && [...groups].sort((a, b) => b[0] - a[0]).map(([year, cards]) => (
        <section className="applicant-record-year" key={year} aria-labelledby={`record-year-${year}`}>
          <h2 id={`record-year-${year}`}>{year} 年</h2>
          <ul>
            {cards.map((card) => {
              const status = applicantCaseStatus(card.state);
              return (
                <li key={card.id}>
                  <Link className="applicant-record" href={`/app/passports/${encodeURIComponent(card.id)}`}>
                    <span className="applicant-record-copy">
                      <strong>{card.programName}</strong>
                      <span>{card.submittedAt ? `${formatTaipeiDate(card.submittedAt)}送出` : '送出時間待確認'}</span>
                    </span>
                    <span className={`applicant-status applicant-status--${status.tone}`}>{status.label}</span>
                    <span className="applicant-record-arrow" aria-hidden="true">›</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </section>
  );
}
