import type { FlowPassDatabase } from '../connection';
import {
  requireAdminScope,
  requireApplicantScope,
  type AdminScope,
  type ApplicantScope,
} from './scopes';

interface TimelineRow {
  id: string;
  case_id: string;
  sequence_no: number;
  passport_version_id: string | null;
  event_type: string;
  public_summary: string;
  public_data_json: string;
  actor_type: string;
  created_at: string;
}

export interface TimelineEventRecord {
  id: string;
  caseId: string;
  sequenceNo: number;
  passportVersionId: string | null;
  eventType: string;
  publicSummary: string;
  publicDataJson: string;
  actorType: string;
  createdAt: string;
}

function mapTimeline(row: TimelineRow): TimelineEventRecord {
  return {
    id: row.id,
    caseId: row.case_id,
    sequenceNo: row.sequence_no,
    passportVersionId: row.passport_version_id,
    eventType: row.event_type,
    publicSummary: row.public_summary,
    publicDataJson: row.public_data_json,
    actorType: row.actor_type,
    createdAt: row.created_at,
  };
}

export function listTimelineForApplicant(
  database: FlowPassDatabase,
  scope: ApplicantScope,
  caseId: string,
): TimelineEventRecord[] {
  requireApplicantScope(scope);
  const rows = database
    .prepare(
      `SELECT timeline_events.*
       FROM timeline_events
       JOIN cases ON cases.id = timeline_events.case_id
       WHERE timeline_events.case_id = ? AND cases.applicant_id = ? AND cases.deleted_at IS NULL
       ORDER BY timeline_events.created_at ASC, timeline_events.sequence_no ASC`,
    )
    .all(caseId, scope.applicantId) as TimelineRow[];

  return rows.map(mapTimeline);
}

export function listTimelineForAdmin(
  database: FlowPassDatabase,
  scope: AdminScope,
  caseId: string,
): TimelineEventRecord[] {
  requireAdminScope(scope);
  const rows = database
    .prepare('SELECT timeline_events.* FROM timeline_events JOIN cases ON cases.id = timeline_events.case_id WHERE timeline_events.case_id = ? AND cases.deleted_at IS NULL ORDER BY timeline_events.created_at ASC, timeline_events.sequence_no ASC')
    .all(caseId) as TimelineRow[];

  return rows.map(mapTimeline);
}
