'use client';
import { useCallback, useEffect, useState } from 'react';
import { PublicApiClient } from '../../lib/public-api';
import type { PublicSecurityAlert } from '../../../shared/security-contract';
import { formatTaipeiDate, securityAlertStatus, securitySeverity } from './applicant-case-status';

const STATUS_ORDER: Record<string, number> = { open: 0, acknowledged: 1, resolved: 2 };

export function SecurityAlerts({ caseId }: { caseId: string }) {
  const [alerts, setAlerts] = useState<PublicSecurityAlert[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');

  const load = useCallback(async () => {
    setLoadState('loading');
    try {
      const value = await new PublicApiClient().read<{ alerts: PublicSecurityAlert[] }>(`/api/v1/cases/${encodeURIComponent(caseId)}/alerts`);
      setAlerts(value.alerts.slice().sort((a, b) => (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3)));
      setLoadState('ready');
    } catch {
      setLoadState('error');
    }
  }, [caseId]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <section className="applicant-case-section" aria-labelledby={`security-alerts-title-${caseId}`}>
      <header>
        <h2 id={`security-alerts-title-${caseId}`}>資安提醒</h2>
        <p>你用的工具或資料流向出現已知風險時，會在這裡告訴你怎麼處理。</p>
      </header>
      {loadState === 'loading' && <div className="applicant-inline-state" role="status">資安提醒載入中…</div>}
      {loadState === 'error' && (
        <div className="applicant-inline-state applicant-inline-state--error" role="alert">
          <p>資安提醒暫時無法載入。</p>
          <button type="button" className="secondary-action" onClick={() => void load()}>重新載入</button>
        </div>
      )}
      {loadState === 'ready' && alerts.length === 0 && <p className="tool-check-empty">目前沒有需要處理的資安提醒。</p>}
      {loadState === 'ready' && alerts.length > 0 && (
        <ul className="tool-check-list" aria-label="資安提醒清單">
          {alerts.map((alert) => {
            const status = securityAlertStatus(alert.status);
            const severity = securitySeverity(alert.severity);
            return (
              <li key={alert.id}>
                <article className="tool-check-card">
                  <div className="tool-check-card-meta">
                    <span className={`applicant-status applicant-status--${status.tone}`}>{status.label}</span>
                    <span className={`applicant-status applicant-status--${severity.tone}`}>{severity.label}</span>
                  </div>
                  <h3>{alert.summary}</h3>
                  <p>{alert.guidance}</p>
                  <time dateTime={alert.resolvedAt ?? alert.createdAt}>
                    {alert.resolvedAt ? `處理於 ${formatTaipeiDate(alert.resolvedAt)}` : `通知於 ${formatTaipeiDate(alert.createdAt)}`}
                  </time>
                </article>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
