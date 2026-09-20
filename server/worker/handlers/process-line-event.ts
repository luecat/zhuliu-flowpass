import type { DurableJob } from '../../db/repositories/jobs';
import type { FlowPassDatabase } from '../../db/connection';
import type { FieldCrypto } from '../../crypto/field-crypto';
import type { LineHelpReply, LineMessagingClient, LineTextReply } from '../../adapters/line/messaging-client';
import { classifyLineIntent, isLineHelpKind, lineHelpPresentation, subsidyPolicyReply } from '../../domain/line-intent';
import { reviewStatusLabel } from '../../domain/notification-template';
import { queryPassportToolStatus, queryPublicToolIncidents } from '../../domain/public-tool-status';

export function processLineEvent(job: DurableJob, input: {
  database: FlowPassDatabase;
  crypto?: FieldCrypto;
  lineClient?: LineMessagingClient | null;
  liffId: string;
  now?: string;
}): void {
  if (job.jobType !== 'line_webhook') throw new Error('wrong job type');
  const payload = job.payload as {
    providerEventId?: string;
    eventType?: string;
    replyToken?: string | null;
    text?: string | null;
    userId?: string | null;
  };
  const providerEventId = typeof payload.providerEventId === 'string' ? payload.providerEventId : null;
  if (!providerEventId) throw new Error('webhook payload is invalid');
  const now = input.now ?? new Date().toISOString();

  const replyToken = typeof payload.replyToken === 'string' ? payload.replyToken : null;
  const text = typeof payload.text === 'string' ? payload.text : null;
  const userId = typeof payload.userId === 'string' ? payload.userId : null;

  if (payload.eventType === 'message' && replyToken && text && input.lineClient) {
    const outgoing = buildLineReply({
      text,
      replyToken,
      userId,
      liffId: input.liffId,
      database: input.database,
      crypto: input.crypto,
    });
    void input.lineClient.reply(outgoing).catch(() => {
      // Reply failures should not poison the queue forever; the event is still marked processed.
    });
  }

  input.database.prepare(`UPDATE line_webhook_events SET processing_state = 'processed', processed_at = ? WHERE provider_event_id = ? AND processing_state = 'queued'`).run(now, providerEventId);
}

function buildLineReply(input: {
  text: string;
  replyToken: string;
  userId: string | null;
  liffId: string;
  database: FlowPassDatabase;
  crypto?: FieldCrypto;
}): LineTextReply | LineHelpReply {
  const intent = classifyLineIntent(input.text);
  if (isLineHelpKind(intent.kind)) {
    return { replyToken: input.replyToken, ...lineHelpPresentation(intent.kind, input.liffId) };
  }

  switch (intent.kind) {
    case 'faq':
      return { replyToken: input.replyToken, text: intent.answer };
    case 'subsidy_policy':
      return { replyToken: input.replyToken, text: publishedSubsidyPolicyReply(input.database) };
    case 'tool_status':
      return { replyToken: input.replyToken, text: toolStatusReply(input, intent.tool) };
    case 'case_status':
      return { replyToken: input.replyToken, text: caseInquiryReply(input, 'case_status') };
    case 'subsidy_amount':
      return { replyToken: input.replyToken, text: caseInquiryReply(input, 'subsidy_amount') };
    default: {
      const unexpected: never = intent;
      throw new Error(`Unhandled LINE intent: ${JSON.stringify(unexpected)}`);
    }
  }
}

function publishedSubsidyPolicyReply(database: FlowPassDatabase): string {
  const rule = database.prepare(`
    SELECT subsidy_rate_bps, per_case_cap_twd
    FROM program_rule_versions
    WHERE status = 'published'
    ORDER BY published_at DESC
    LIMIT 1
  `).get() as { subsidy_rate_bps: number; per_case_cap_twd: number } | undefined;
  return subsidyPolicyReply(rule ? { rateBps: rule.subsidy_rate_bps, capTwd: rule.per_case_cap_twd } : null);
}

function toolStatusReply(input: {
  database: FlowPassDatabase;
  crypto?: FieldCrypto;
  userId: string | null;
}, tool: string): string {
  const publicIncidents = queryPublicToolIncidents(input.database, tool || null).slice(0, 3);
  const publicSummary = publicIncidents.length === 0
    ? '目前尚無已發布的公開資安事件。'
    : `公開事件包括：${publicIncidents.map((item) => `${item.toolName}「${item.title}」`).join('、')}。`;
  if (!input.userId || !input.crypto) {
    return `${publicSummary}\n完整清單請開選單「檢測」。登入後若與你的護照相關，會另顯示專屬提醒。`;
  }
  const subjectHash = input.crypto.hmacLookup(input.userId, 'line-subject');
  const identity = input.database.prepare('SELECT applicant_id FROM line_identities WHERE line_subject_hmac = ? AND unlinked_at IS NULL').get(subjectHash) as { applicant_id: string } | undefined;
  if (!identity) {
    return `${publicSummary}\n尚未綁定申請人身分。請先從 LINE 選單登入，以查看專屬提醒。`;
  }
  const check = queryPassportToolStatus(input.database, input.crypto, identity.applicant_id);
  const relevant = check.incidents.filter((item) => item.relevantToPassport);
  const openImpacts = check.impacts.filter((item) => item.status !== 'resolved').length;
  if (openImpacts > 0) {
    return `${publicSummary}\n另外你有 ${openImpacts} 則專屬提醒，請開選單「檢測」查看。`;
  }
  if (relevant.length > 0) {
    return `${publicSummary}\n其中 ${relevant.length} 則與你的護照相關，請開選單「檢測」查看建議作法。`;
  }
  if (check.tools.length === 0) {
    return `${publicSummary}\n你尚未確認護照工具；確認後若有相關事件會出現專屬提醒。詳情請開選單「檢測」。`;
  }
  return `${publicSummary}\n目前沒有需要你個人處理的專屬提醒。詳情請開選單「檢測」。`;
}

function caseInquiryReply(input: {
  database: FlowPassDatabase;
  crypto?: FieldCrypto;
  userId: string | null;
}, kind: 'case_status' | 'subsidy_amount'): string {
  if (!input.userId || !input.crypto) {
    return '尚未綁定申請人身分。請先從 LINE 選單登入 FlowPass。';
  }
  const subjectHash = input.crypto.hmacLookup(input.userId, 'line-subject');
  const identity = input.database.prepare('SELECT applicant_id FROM line_identities WHERE line_subject_hmac = ? AND unlinked_at IS NULL').get(subjectHash) as { applicant_id: string } | undefined;
  if (!identity) {
    return '尚未綁定申請人身分。請先從 LINE 選單登入 FlowPass。';
  }
  const latest = input.database.prepare(`
    SELECT case_code, state, calculated_amount_twd, approved_amount_twd
    FROM cases
    WHERE applicant_id = ? AND deleted_at IS NULL
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(identity.applicant_id) as {
    case_code: string;
    state: string;
    calculated_amount_twd: number | null;
    approved_amount_twd: number | null;
  } | undefined;
  if (!latest) {
    return '目前還沒有申請案件。請從選單開啟申請頁開始建立護照。';
  }
  if (kind === 'case_status') {
    const stateLabel = latest.state === 'draft' ? '尚未送出（草稿）' : reviewStatusLabel(latest.state);
    return `你的案件 ${latest.case_code} 目前狀態是「${stateLabel}」。詳細進度請開啟申請紀錄查看。`;
  }
  const amount = latest.approved_amount_twd ?? latest.calculated_amount_twd;
  return amount == null
    ? `案件 ${latest.case_code} 尚未完成金額試算。送出申請後可在申請紀錄查看「為什麼是這個金額」。`
    : `案件 ${latest.case_code} 目前金額為 NT$${amount}。逐步推導請到申請紀錄頁查看，避免只看到一個數字。`;
}
