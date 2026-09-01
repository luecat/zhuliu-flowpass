import { followUpTopics, hasApplicantInternalReference } from '../../../shared/follow-up-policy';

const INTERNAL_APPLICANT_TOKENS = [
  'materials',
  'intended_use',
  'personal_or_sensitive_data',
  'destination_and_audience',
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
    prompt: '處理完成後，檔案會放在哪裡、保留多久？',
    reason: '確認檔案的存放位置與刪除時間。',
    placeholder: '例如：手機上傳後刪除，或 Google Drive 保留 30 天。',
  };
  if (has('tool')) return {
    prompt: '你會使用哪個 AI 工具？',
    reason: '確認資料會交給哪個服務處理。',
    placeholder: '例如：Adobe Firefly、Canva、ChatGPT，或其他工具。',
  };
  if (has('storage')) return {
    prompt: '處理完成後，檔案會存在哪裡？',
    reason: '確認完成後檔案的存放位置。',
    placeholder: '例如：只存在手機，或上傳到 Google Drive。',
  };
  if (has('retention')) return {
    prompt: '處理完成後，檔案會保留多久？',
    reason: '確認檔案何時會刪除。',
    placeholder: '例如：上傳後刪除、保留 30 天，或長期保存。',
  };
  if (has('sensitive_data')) return {
    prompt: '資料中有沒有人臉、姓名或其他個資？',
    reason: '確認是否需要遮蔽資料或先取得同意。',
    placeholder: '例如：有人臉與姓名；沒有也請直接寫「沒有」。',
  };
  if (has('audience')) return {
    prompt: '完成後會放在哪裡、給誰看到？',
    reason: '確認成果的分享位置與可見範圍。',
    placeholder: '例如：只給社團成員，或公開發布在 Instagram。',
  };
  if (has('material')) return {
    prompt: '你要處理的是哪一類資料？',
    reason: '確認資料會如何進入這個流程。',
    placeholder: '例如：社團照片、活動影片或文字稿；不要貼實際內容。',
  };
  if (has('purpose')) return {
    prompt: '你想用 AI 完成什麼工作？',
    reason: '確認 AI 在流程中負責的工作。',
    placeholder: '例如：修圖、整理文字或產生摘要。',
  };
  return {
    prompt: applicantVisibleCopy(prompt, '請用一句話補充這項資訊。'),
    reason: applicantVisibleCopy(reason, '這項資訊會影響資料流向與送出前的確認內容。'),
    placeholder: '請依照你的實際情況回答。',
  };
}
