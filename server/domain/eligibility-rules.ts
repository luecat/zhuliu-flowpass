import type { RuleEvaluation, RuleStep } from '../../shared/rule-contract';
import { parseUtcRfc3339Timestamp } from '../db/timestamps';
export interface EligibilityInput { submissionAt: string; applicationStartAt: string | null; applicationEndAt: string | null; purchaseAt: string | null; purchaseStartAt: string | null; purchaseEndAt: string | null; ruleVersionId: string; inputSnapshotHash: string; evaluatedAt: string; }
function timestamp(value: string): number { try { return Date.parse(parseUtcRfc3339Timestamp(value, 'ruleDate')); } catch { return Number.NaN; } }
function windowResult(code: string, value: string | null, start: string | null, end: string | null, ruleVersionId: string, hash: string, at: string): RuleEvaluation { if (!value || !start || !end) return { ruleCode: code, outcome: 'missing', reasonCode: 'missing_date_or_window', explanation: '日期或規則期間尚未確認。', ruleVersionId, inputSnapshotHash: hash, evaluatedAt: at, steps: [{ label: '日期', value: value ?? '待確認' }] }; const time = timestamp(value); const startTime = timestamp(start); const endTime = timestamp(end); const valid = Number.isFinite(time) && Number.isFinite(startTime) && Number.isFinite(endTime) && startTime <= endTime; const ok = valid && time >= startTime && time <= endTime; return { ruleCode: code, outcome: ok ? 'pass' : 'fail', reasonCode: !valid ? 'invalid_date_or_window' : ok ? 'within_window' : 'outside_window', explanation: ok ? '日期落在規則期間內。' : !valid ? '日期或規則期間格式無法確認。' : '日期不在規則期間內。', ruleVersionId, inputSnapshotHash: hash, evaluatedAt: at, steps: [{ label: '日期', value }, { label: '開始', value: start }, { label: '結束', value: end }] }; }
export function evaluateEligibility(input: EligibilityInput): { submission: RuleEvaluation; purchase: RuleEvaluation } { return { submission: windowResult('submission_window', input.submissionAt, input.applicationStartAt, input.applicationEndAt, input.ruleVersionId, input.inputSnapshotHash, input.evaluatedAt), purchase: windowResult('purchase_window', input.purchaseAt, input.purchaseStartAt, input.purchaseEndAt, input.ruleVersionId, input.inputSnapshotHash, input.evaluatedAt) }; }

function ageOnDate(birthDate: string, onDate: string): number | null {
  const birth = timestamp(`${birthDate}T00:00:00.000Z`);
  const at = timestamp(onDate);
  if (!Number.isFinite(birth) || !Number.isFinite(at) || at < birth) return null;
  const birthDateObj = new Date(birth);
  const atDateObj = new Date(at);
  let age = atDateObj.getUTCFullYear() - birthDateObj.getUTCFullYear();
  const hadBirthdayYet =
    atDateObj.getUTCMonth() > birthDateObj.getUTCMonth() ||
    (atDateObj.getUTCMonth() === birthDateObj.getUTCMonth() && atDateObj.getUTCDate() >= birthDateObj.getUTCDate());
  if (!hadBirthdayYet) age -= 1;
  return age;
}

/**
 * Bounds come from the published rule version's rules_json and are all optional:
 * minAge/maxAge are measured at submission time, while birthDateFrom/birthDateTo
 * pin a fixed birth cohort ("民國 95 至 100 年出生"). Whichever bounds are
 * configured must all hold; with none configured the rule reports 'missing'.
 */
export function evaluateAgeEligibility(input: {
  birthDate: string | null;
  submissionAt: string;
  minAge?: number;
  maxAge?: number;
  birthDateFrom?: string;
  birthDateTo?: string;
  ruleVersionId: string;
  inputSnapshotHash: string;
  evaluatedAt: string;
}): RuleEvaluation {
  const base = { ruleCode: 'age_eligibility', ruleVersionId: input.ruleVersionId, inputSnapshotHash: input.inputSnapshotHash, evaluatedAt: input.evaluatedAt };
  if (!input.birthDate) {
    return { ...base, outcome: 'missing', reasonCode: 'birth_date_missing', explanation: '出生日期尚未填寫。', steps: [{ label: '出生日期', value: '待確認' }] };
  }
  if (input.minAge === undefined && input.maxAge === undefined && !input.birthDateFrom && !input.birthDateTo) {
    return { ...base, outcome: 'missing', reasonCode: 'age_range_not_configured', explanation: '本方案尚未設定年齡資格區間。', steps: [{ label: '出生日期', value: input.birthDate }] };
  }
  const age = ageOnDate(input.birthDate, input.submissionAt);
  if (age === null) {
    return { ...base, outcome: 'fail', reasonCode: 'invalid_birth_date', explanation: '出生日期格式無法確認。', steps: [{ label: '出生日期', value: input.birthDate }] };
  }
  const steps: RuleStep[] = [{ label: '出生日期', value: input.birthDate }];
  if (input.minAge !== undefined || input.maxAge !== undefined) {
    steps.push({ label: '送件時年齡', value: `${age} 歲` });
    steps.push({ label: '資格年齡區間', value: `${input.minAge ?? '不限'} 至 ${input.maxAge ?? '不限'} 歲` });
  }
  if (input.birthDateFrom || input.birthDateTo) {
    steps.push({ label: '資格出生區間', value: `${input.birthDateFrom ?? '不限'} 至 ${input.birthDateTo ?? '不限'}` });
  }
  const withinMin = input.minAge === undefined || age >= input.minAge;
  const withinMax = input.maxAge === undefined || age <= input.maxAge;
  // Lexicographic comparison is exact for zero-padded YYYY-MM-DD and keeps both
  // bounds inclusive, which is how a published 出生區間 reads.
  const afterFrom = !input.birthDateFrom || input.birthDate >= input.birthDateFrom;
  const beforeTo = !input.birthDateTo || input.birthDate <= input.birthDateTo;
  const withinAge = withinMin && withinMax;
  const withinBirthWindow = afterFrom && beforeTo;
  const ok = withinAge && withinBirthWindow;
  return {
    ...base,
    outcome: ok ? 'pass' : 'fail',
    reasonCode: ok ? 'within_age_range' : withinAge ? 'outside_birth_date_range' : 'outside_age_range',
    explanation: ok
      ? '年齡符合本方案資格區間。'
      : withinAge
        ? `出生日期 ${input.birthDate} 不在本方案資格出生區間內。`
        : `送件時年齡 ${age} 歲，不在本方案資格區間內。`,
    steps,
  };
}
