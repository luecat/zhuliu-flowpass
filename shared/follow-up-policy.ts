export type FollowUpTopic =
  | 'tool'
  | 'storage'
  | 'retention'
  | 'audience'
  | 'sensitive_data'
  | 'material'
  | 'purpose';

const INTERNAL_REFERENCE_PATTERN = /(?:\$\.[a-z_]|\b(?:newanswers|currentquestionids|answeredfollowups|originalinput|validationissues|invalidstructure|passport_draft|follow_up_questions|personal_or_sensitive_data|destination_and_audience|source_field|source_excerpt|answerSchema)\b|\bq(?:uestion)?[_-]?\d+\b)/iu;

function normalized(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase();
}

export function hasApplicantInternalReference(value: string): boolean {
  return INTERNAL_REFERENCE_PATTERN.test(value);
}

export function followUpTopics(...values: string[]): FollowUpTopic[] {
  const text = normalized(values.join(' '));
  const topics: FollowUpTopic[] = [];
  const includesAny = (needles: readonly string[]) => needles.some((needle) => text.includes(needle));

  if (includesAny(['ai 工具', 'ai工具', '修圖工具', '使用工具', '工具名稱', '供應商', 'tool', 'model', '模型', 'claude', 'chatgpt', 'canva', 'firefly'])) topics.push('tool');
  if (includesAny(['儲存位置', '存放位置', '保存位置', '放在哪', '放哪裡', '存在哪', '雲端', 'google drive', 'dropbox', 'icloud', 'storage'])) topics.push('storage');
  if (includesAny(['保留多久', '保留期間', '保存多久', '保存期間', '刪除', '銷毀', '留存', 'retention'])) topics.push('retention');
  if (includesAny(['分享給誰', '誰會看到', '分享對象', '公開', '社群', 'instagram', 'ig', 'audience', 'destination'])) topics.push('audience');
  if (includesAny(['個資', '個人資料', '敏感', '人臉', '姓名', '肖像', '聯絡方式', 'sensitive', 'personal'])) topics.push('sensitive_data');
  if (includesAny(['資料類型', '哪類資料', '什麼資料', '素材', '檔案類型', 'material'])) topics.push('material');
  if (includesAny(['想用 ai', '用 ai 做', '用途', '要完成什麼', '目的', 'purpose', 'intended_use'])) topics.push('purpose');

  return [...new Set(topics)];
}

export function normalizedFollowUpText(value: string): string {
  return normalized(value).replace(/[\s\p{P}\p{S}]+/gu, '');
}
