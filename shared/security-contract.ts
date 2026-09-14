export const INCIDENT_MATCH_STATUSES = ['possible', 'confirmed_affected', 'not_affected', 'notified'] as const;
export type IncidentMatchStatus = typeof INCIDENT_MATCH_STATUSES[number];

export const ALERT_STATUSES = ['open', 'acknowledged', 'resolved', 'dismissed'] as const;
export type AlertStatus = typeof ALERT_STATUSES[number];

export type PublicSecurityAlert = {
  id: string;
  status: AlertStatus;
  severity: string;
  summary: string;
  incidentTitle: string | null;
  guidance: string;
  createdAt: string;
  resolvedAt: string | null;
};
