import type { DurableJob } from '../../db/repositories/jobs';
import type { FlowPassDatabase } from '../../db/connection';
import type { FieldCrypto } from '../../crypto/field-crypto';
import type { LineMessagingClient } from '../../adapters/line/messaging-client';
import { classifyLineIntent } from '../../domain/line-intent';
import { queryPassportToolStatus, queryPublicToolIncidents } from '../../domain/public-tool-status';

export function processLineEvent(job: DurableJob, input: {
  database: FlowPassDatabase;
  crypto?: FieldCrypto;
  lineClient?: LineMessagingClient | null;
  liffBaseUrl?: string;
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
    const intent = classifyLineIntent(text);
    let reply = 'FlowPass 只回答補助與案件相關問題。請從選單開啟申請頁，或輸入「怎麼申請」「我的案子到哪了」「補助多少」。';
    if (intent.kind === 'faq') reply = intent.answer;
    else if (intent.kind === 'tool_status') {
      const publicIncidents = queryPublicToolIncidents(input.database, intent.tool || null).slice(0, 3);
      const publicSummary = publicIncidents.length === 0
        ? '目前尚無已發布的公開資安事件。'
        : `公開事件包括：${publicIncidents.map((item) => `${item.toolName}「${item.title}」`).join('、')}。`;
      if (!userId || !input.crypto) {
        reply = `${publicSummary}\n完整清單請開選單「檢測」。登入後若與你的護照相關，會另顯示專屬提醒。`;
      } else {
        const subjectHash = input.crypto.hmacLookup(userId, 'line-subject');
        const identity = input.database.prepare('SELECT applicant_id FROM line_identities WHERE line_subject_hmac = ? AND unlinked_at IS NULL').get(subjectHash) as { applicant_id: string } | undefined;
        if (!identity) {
          reply = `${publicSummary}\n尚未綁定申請人身分。請先從 LINE 選單登入，以查看專屬提醒。`;
        } else {
          const check = queryPassportToolStatus(input.database, input.crypto, identity.applicant_id);
          const relevant = check.incidents.filter((item) => item.relevantToPassport);
          const openImpacts = check.impacts.filter((item) => item.status !== 'resolved').length;
          if (openImpacts > 0) {
            reply = `${publicSummary}\n另外你有 ${openImpacts} 則專屬提醒，請開選單「檢測」查看。`;
          } else if (relevant.length > 0) {
            reply = `${publicSummary}\n其中 ${relevant.length} 則與你的護照相關，請開選單「檢測」查看建議作法。`;
          } else if (check.tools.length === 0) {
            reply = `${publicSummary}\n你尚未確認護照工具；確認後若有相關事件會出現專屬提醒。詳情請開選單「檢測」。`;
          } else {
            reply = `${publicSummary}\n目前沒有需要你個人處理的專屬提醒。詳情請開選單「檢測」。`;
          }
        }
      }
    } else if ((intent.kind === 'case_status' || intent.kind === 'subsidy_amount') && userId && input.crypto) {
      const subjectHash = input.crypto.hmacLookup(userId, 'line-subject');
      const identity = input.database.prepare('SELECT applicant_id FROM line_identities WHERE line_subject_hmac = ? AND unlinked_at IS NULL').get(subjectHash) as { applicant_id: string } | undefined;
      if (!identity) {
        reply = '尚未綁定申請人身分。請先從 LINE 選單登入 FlowPass。';
      } else {
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
          reply = '目前還沒有申請案件。請從選單開啟申請頁開始建立護照。';
        } else if (intent.kind === 'case_status') {
          reply = `你的案件 ${latest.case_code} 目前狀態是「${latest.state}」。詳細進度請開啟申請紀錄查看。`;
        } else {
          const amount = latest.approved_amount_twd ?? latest.calculated_amount_twd;
          reply = amount == null
            ? `案件 ${latest.case_code} 尚未完成金額試算。送出申請後可在申請紀錄查看「為什麼是這個金額」。`
            : `案件 ${latest.case_code} 目前金額為 NT$${amount}。逐步推導請到申請紀錄頁查看，避免只看到一個數字。`;
        }
      }
    }
    void input.lineClient.reply({ replyToken, text: reply }).catch(() => {
      // Reply failures should not poison the queue forever; the event is still marked processed.
    });
  }

  input.database.prepare(`UPDATE line_webhook_events SET processing_state = 'processed', processed_at = ? WHERE provider_event_id = ? AND processing_state = 'queued'`).run(now, providerEventId);
}
