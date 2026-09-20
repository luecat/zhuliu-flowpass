import { followUpTopics, hasApplicantInternalReference } from '../../../shared/follow-up-policy';

const INTERNAL_APPLICANT_TOKENS = [
  'materials',
  'intended_use',
  'personal_or_sensitive_data',
  'destination_and_audience',
  'requested_tool',
  'retention_duration',
  'use_case',
  'passport_draft',
  'sharing_scope',
  'audience',
  'source_field',
  'source_excerpt',
  'needs_confirmation',
  'data_category',
  'sensitivity',
  'retention',
  'storage_location',
  'duration',
  'deletion_plan',
  'safety_actions',
  'follow_up_questions',
  'administrative_hints',
  'unknown_fields',
  'public',
  'self',
  'team',
  'client',
  'unknown',
  'required_confirmation',
  'ai_generated_unconfirmed',
  'newAnswers',
  'currentQuestionIds',
  'answeredFollowUps',
  'originalInput',
  'validationIssues',
  'invalidStructure',
] as const;

const internalApplicantTokenPattern = new RegExp(
  `(?:\\$\\.|\\b(?:${INTERNAL_APPLICANT_TOKENS.join('|')})\\b)`,
  'i',
);

export function applicantVisibleCopy(value: string, fallback: string): string {
  const normalized = value.trim();
  return normalized && !internalApplicantTokenPattern.test(normalized) && !hasApplicantInternalReference(normalized) ? normalized : fallback;
}

export function followUpPromptFallback(questionKey: string): string {
  return followUpApplicantCopy(questionKey, '', '').prompt;
}

export interface FollowUpApplicantCopy {
  prompt: string;
  reason: string;
  placeholder: string;
}

export function followUpApplicantCopy(questionKey: string, prompt: string, reason: string): FollowUpApplicantCopy {
  const topics = followUpTopics(questionKey, prompt, reason);
  const has = (topic: ReturnType<typeof followUpTopics>[number]) => topics.includes(topic);
  if (has('storage') && has('retention')) return {
    prompt: '處理完成後，檔案存放在哪裡、保留多久？',
    reason: '確認檔案存放位置與銷毀時間。',
    placeholder: '例如：存於手機且上傳後刪除，或存於雲端保留 30 天。',
  };
  if (has('tool')) return {
    prompt: '使用哪個 AI 工具？',
    reason: '確認資料處理的服務來源。',
    placeholder: '例如：Adobe Firefly、Canva 或其他工具。',
  };
  if (has('storage')) return {
    prompt: '處理完成後，檔案存放在哪裡？',
    reason: '確認檔案存放位置。',
    placeholder: '例如：僅存於手機，或上傳至 Google Drive。',
  };
  if (has('retention')) return {
    prompt: '處理完成後，檔案保留多久？',
    reason: '確認檔案銷毀時間。',
    placeholder: '例如：上傳後刪除、保留 30 天，或長期保存。',
  };
  if (has('sensitive_data')) return {
    prompt: '資料可能包含哪些敏感內容？',
    reason: '系統需依此評估風險。請確認是否需遮蔽、撤銷金鑰或取得當事人同意。',
    placeholder: '例如：人臉、姓名、密碼、帳號或未成年資料；若無請填「沒有」。',
  };
  if (has('audience')) return {
    prompt: '完成後檔案存放在哪裡、分享給誰？',
    reason: '確認檔案的可見範圍。',
    placeholder: '例如：僅限社團成員，或發布於公開社群。',
  };
  if (has('material')) return {
    prompt: '處理哪一類資料？',
    reason: '確認資料來源格式。',
    placeholder: '例如：社團照片、活動影片或文字稿；請勿貼上實際內容。',
  };
  if (has('purpose')) return {
    prompt: '想用 AI 完成什麼任務？',
    reason: '確認 AI 在流程中的作用。',
    placeholder: '例如：修圖、整理文字或產生摘要。',
  };
  return {
    prompt: applicantVisibleCopy(prompt, '請用一句話補充此資訊。'),
    reason: applicantVisibleCopy(reason, '確保資料流向紀錄準確。'),
    placeholder: '請依實際情況填寫。',
  };
}
