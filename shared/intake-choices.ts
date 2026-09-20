/** Fixed intake choice templates shared by the application wizard. */

export const SENSITIVE_DATA_CHOICES = ['有', '無', '不確定'] as const;
export type SensitiveDataChoice = (typeof SENSITIVE_DATA_CHOICES)[number];

export const RETENTION_DURATION_CHOICES = [
  '上傳後立即刪除',
  '保留 7 天',
  '保留 30 天',
  '保留 90 天',
  '長期保存',
  '其他（自行填寫）',
] as const;

export function isSensitiveNone(value: string): boolean {
  const text = value.normalize('NFKC').trim();
  return text === '無' || text === '沒有' || text === '完全沒有';
}

export function isSensitiveUncertain(value: string): boolean {
  const text = value.normalize('NFKC').trim();
  return text === '不確定' || /^(?:不知道|尚未決定|未決定|待確認|還沒想好|unknown|unsure|not sure|n\/?a)[\s。，,.!！?？]*$/iu.test(text);
}

/** True when the applicant selected 有 or 不確定 — sensitive-data follow-ups may still be asked. */
export function sensitiveDataNeedsFollowUp(value: string): boolean {
  const text = value.normalize('NFKC').trim();
  if (!text || isSensitiveNone(text)) return false;
  return true;
}

export function sensitiveChoiceFromStored(value: string): SensitiveDataChoice | '' {
  const text = value.normalize('NFKC').trim();
  if (!text) return '';
  if (isSensitiveNone(text)) return '無';
  if (isSensitiveUncertain(text)) return '不確定';
  return '有';
}
