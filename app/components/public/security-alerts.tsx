'use client';
import { useEffect, useState } from 'react';
import { PublicApiClient } from '../../lib/public-api';
import type { PublicSecurityAlert } from '../../../shared/security-contract';

export function SecurityAlerts({ caseId }: { caseId: string }) { const [alerts, setAlerts] = useState<PublicSecurityAlert[]>([]); useEffect(() => { void new PublicApiClient().read<{ alerts: PublicSecurityAlert[] }>(`/api/v1/cases/${encodeURIComponent(caseId)}/alerts`).then((value) => setAlerts(value.alerts)).catch(() => undefined); }, [caseId]); return <div aria-label="資安提醒清單">{alerts.length === 0 ? <p>目前沒有需要處理的資安提醒。</p> : <ul>{alerts.map((alert) => <li key={alert.id}><strong>{alert.summary}</strong><span> · {alert.status === 'resolved' ? '已處理' : alert.status === 'acknowledged' ? '已確認收到' : '待處理'} · {alert.severity}</span><p>{alert.guidance}</p><time dateTime={alert.createdAt}>{alert.createdAt}</time>{alert.resolvedAt ? <small>更新於 {alert.resolvedAt}</small> : null}</li>)}</ul>}</div>; }
