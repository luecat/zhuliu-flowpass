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
        <p>系統持續追蹤本案件使用工具的官方安全動態；若有與您資料流程相關的潛在風險，將在此主動說明並提供應對作法。</p>
      </header>
      {loadState === 'loading' && <div className="applicant-inline-state" role="status">資安提醒載入中…</div>}
      {loadState === 'error' && (
        <div className="applicant-inline-state applicant-inline-state--error" role="alert">
          <p>資安提醒暫時無法載入，請稍後再試。</p>
          <button type="button" className="secondary-action" onClick={() => void load()}>重新載入</button>
        </div>
      )}
      {loadState === 'ready' && alerts.length === 0 && (
        <div className="tool-check-safe-state">
          <p className="tool-check-empty">目前無待處理之資安提醒。</p>
        </div>
      )}
      {loadState === 'ready' && alerts.length > 0 && (
        <ul className="tool-check-list" aria-label="資安提醒清單">
          {alerts.map((alert) => {
            const status = securityAlertStatus(alert.status);
            const severity = securitySeverity(alert.severity);
            const whatHappened = alert.incidentTitle?.trim() || alert.summary?.trim() || '資安提醒';
            return (
              <li key={alert.id}>
                <article className="tool-check-card">
                  <div className="tool-check-card-meta">
                    <span className={`applicant-status applicant-status--${status.tone}`}>{status.label}</span>
                    <span className={`applicant-status applicant-status--${severity.tone}`}>影響程度：{severity.label}</span>
                  </div>
                  <h3>{whatHappened}</h3>
                  {alert.incidentTitle?.trim() && alert.summary?.trim() && alert.incidentTitle.trim() !== alert.summary.trim() && (
                    <p className="tool-check-period">{alert.summary}</p>
                  )}
                  <div className="tool-check-actions">
                    <h4>建議你這樣做</h4>
                    <p>{alert.guidance}</p>
                  </div>
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
