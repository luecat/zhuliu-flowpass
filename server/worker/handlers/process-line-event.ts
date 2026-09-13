import type { DurableJob } from '../../db/repositories/jobs';
import type { FlowPassDatabase } from '../../db/connection';
import type { FieldCrypto } from '../../crypto/field-crypto';
import type { LineMessagingClient } from '../../adapters/line/messaging-client';
import { classifyLineIntent } from '../../domain/line-intent';
import { queryPassportToolStatus } from '../../domain/public-tool-status';

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
      if (!userId || !input.crypto) {
        reply = '請先從 LINE 選單登入 FlowPass，系統會依你的護照工具自動檢測。';
      } else {
        const subjectHash = input.crypto.hmacLookup(userId, 'line-subject');
        const identity = input.database.prepare('SELECT applicant_id FROM line_identities WHERE line_subject_hmac = ? AND unlinked_at IS NULL').get(subjectHash) as { applicant_id: string } | undefined;
        if (!identity) {
          reply = '尚未綁定申請人身分。請先從 LINE 選單登入 FlowPass。';
        } else {
          const check = queryPassportToolStatus(input.database, input.crypto, identity.applicant_id);
          if (check.tools.length === 0) {
            reply = '目前還沒有已確認護照上的工具。完成護照確認後，選單「檢測」會自動依護照比對公開事件。';
          } else if (check.incidents.length === 0) {
            reply = `已依護照工具（${check.tools.join('、')}）檢測，目前沒有相符的已確認公開事件。詳細結果可開啟選單「檢測」。`;
          } else {
            reply = `已依護照工具（${check.tools.join('、')}）檢測到 ${check.incidents.length} 筆事件，最新為：${check.incidents[0]?.title}。請開啟選單「檢測」查看處置建議。`;
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
