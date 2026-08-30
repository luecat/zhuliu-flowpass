import type { FlowPassDatabase } from '../db/connection'; import { listTimelineForApplicant } from '../db/repositories/timeline'; import { PUBLIC_TIMELINE_EVENT_TYPES, type PublicTimelineEvent } from '../../shared/timeline-contract';
import type { ApplicantScope } from '../db/repositories/scopes';
const PUBLIC_EVENT_SET = new Set<string>(PUBLIC_TIMELINE_EVENT_TYPES);
// Older writers use storage-oriented names. Normalize them at the public
// boundary so a migration of historical rows cannot make the applicant
// timeline disappear.
const EVENT_ALIASES: Record<string, PublicTimelineEvent['eventType']> = {
  case_submitted: 'submitted',
  passport_version_created: 'received',
  'answers.saved': 'received',
  document_uploaded: 'documents_resubmitted',
};
function normalizeEventType(event: { eventType: string; publicDataJson: string }): string {
  if (event.eventType !== 'case_state_changed') return EVENT_ALIASES[event.eventType] ?? event.eventType;
  try {
    const state = (JSON.parse(event.publicDataJson) as { state?: unknown }).state;
    if (state === 'awaiting_documents') return 'documents_requested';
    if (state === 'returned_for_correction') return 'correction_requested';
    if (state === 'resubmitted') return 'documents_resubmitted';
    if (state === 'approved' || state === 'rejected' || state === 'awaiting_disbursement' || state === 'disbursed' || state === 'closed') return state;
  } catch { /* fail closed below */ }
  return event.eventType;
}
const PUBLIC_SUMMARIES: Record<PublicTimelineEvent['eventType'], string> = { submitted: '申請已送出', received: '案件已收件', review_started: '已開始審查', documents_requested: '需要補充文件', documents_resubmitted: '補充文件已收到', correction_requested: '需要修正資料', passport_reconfirmed: '護照已重新確認', approved: '案件已核准', rejected: '案件已結束審查', awaiting_disbursement: '等待撥款', disbursed: '已完成撥款', closed: '案件已結案', security_alert_created: '有新的資安提醒', security_alert_updated: '資安提醒已更新' };
export function listPublicTimeline(database: FlowPassDatabase, scope: ApplicantScope, caseId: string): PublicTimelineEvent[] { return listTimelineForApplicant(database, scope, caseId).map((event) => ({ ...event, eventType: normalizeEventType(event) })).filter((event) => PUBLIC_EVENT_SET.has(event.eventType)).map((event) => { const eventType = event.eventType as PublicTimelineEvent['eventType']; return { id: event.id, caseId: event.caseId, sequenceNo: event.sequenceNo, eventType, publicSummary: PUBLIC_SUMMARIES[eventType], publicData: safePublicData(event.publicDataJson), actorType: event.actorType === 'admin' || event.actorType === 'system' ? event.actorType : 'applicant', createdAt: event.createdAt }; }); }
function safePublicData(value: string): Record<string, string | number | boolean | null> { try { const parsed = JSON.parse(value) as unknown; if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}; const allowed: Record<string, string | number | boolean | null> = {}; for (const [key, item] of Object.entries(parsed)) { if (!['kind','mediaType','byteSize','status','reasonCode'].includes(key)) continue; if (typeof item === 'string' && item.length <= 128 && (key !== 'reasonCode' || /^[a-z0-9_]{1,64}$/.test(item))) allowed[key] = item; else if (typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 && item <= 12 * 1024 * 1024) allowed[key] = item; else if (typeof item === 'boolean' || item === null) allowed[key] = item; } return allowed; } catch { return {}; } }
