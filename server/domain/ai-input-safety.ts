export type AiInputSafetyProjection = {
  answers: Record<string, string>;
  answeredFollowUps: Array<{ question: string; answer: string }>;
};

export type UnsafeAiInput = {
  source: string;
  reason: 'instruction_override' | 'role_impersonation' | 'prompt_exfiltration' | 'control_markup' | 'secret_request';
};

const RELATIVE_ROLES = '(?:奶奶|阿嬤|阿媽|外婆|祖母|爺爺|阿公|外公|祖父|媽媽|母親|爸爸|父親)';
const ACTIVATION_SECRETS = '(?:激活碼|啟用碼|啟動碼|序號|序列號|產品金鑰|授權碼|註冊碼)';
const READ_OUT_VERBS = '(?:念|唸|朗讀|讀給我|說給我|告訴我|給我|吐出)';

const UNSAFE_PATTERNS: ReadonlyArray<{
  reason: UnsafeAiInput['reason'];
  pattern: RegExp;
}> = [
  {
    reason: 'instruction_override',
    pattern: /(?:ignore|disregard|forget|override|bypass).{0,48}(?:previous|prior|above|system|developer|instruction|prompt|policy|rule)/iu,
  },
  {
    reason: 'instruction_override',
    pattern: /(?:忽略|無視|不要理會|遺忘|覆寫|取代|繞過|跳過).{0,32}(?:先前|上述|以上|前面|原本|系統|開發者|指令|提示詞|規則|安全檢查)/u,
  },
  {
    reason: 'role_impersonation',
    pattern: /(?:^|\n)\s*(?:system|developer|assistant|tool|user)\s*(?:message|prompt|instruction|role)?\s*[:：]/imu,
  },
  {
    reason: 'role_impersonation',
    pattern: /(?:^|\n)\s*(?:系統|開發者|助理|工具|使用者)\s*(?:訊息|提示詞|指令|角色)?\s*[:：]/imu,
  },
  {
    reason: 'role_impersonation',
    pattern: /(?:you are now|act as|pretend to be|switch roles?|new role).{0,80}/iu,
  },
  {
    reason: 'role_impersonation',
    pattern: /(?:現在你是|請扮演|假裝你是|切換角色|新的角色).{0,80}/u,
  },
  {
    // "Grandma exploit": casting the assistant as a relative to coax out restricted content.
    reason: 'role_impersonation',
    pattern: new RegExp(`(?:你|妳)(?:現在)?(?:就)?是我(?:的)?(?:已故|過世|死去)?的?${RELATIVE_ROLES}`, 'u'),
  },
  {
    reason: 'role_impersonation',
    pattern: new RegExp(`(?:扮演|假裝成?|化身為?)(?:我(?:的)?)?(?:已故|過世)?的?${RELATIVE_ROLES}`, 'u'),
  },
  {
    reason: 'role_impersonation',
    pattern: /(?:you are|you're|act as|pretend (?:to be|you are)|play|be) (?:my )?(?:late |deceased |dead )?(?:grandma|grandmother|granny|nana|grandpa|grandfather|mom|mother|dad|father)\b/iu,
  },
  {
    reason: 'prompt_exfiltration',
    pattern: /(?:reveal|print|show|output|repeat|leak).{0,56}(?:system prompt|hidden prompt|developer message|internal instruction|secret|policy)/iu,
  },
  {
    reason: 'prompt_exfiltration',
    pattern: /(?:顯示|輸出|列出|重複|洩漏|公開).{0,40}(?:系統提示詞|隱藏提示詞|開發者訊息|內部指令|密密|規則)/u,
  },
  {
    // Asking to have license or activation codes read out; describing such data without a read-out request stays allowed.
    reason: 'secret_request',
    pattern: new RegExp(`${READ_OUT_VERBS}.{0,16}${ACTIVATION_SECRETS}|${ACTIVATION_SECRETS}.{0,24}(?:${READ_OUT_VERBS}|聽)`, 'u'),
  },
  {
    reason: 'secret_request',
    pattern: /(?:read|tell|give|recite|say).{0,32}(?:activation|license|licence|product|serial|cd|registration)[\s-]?(?:key|code|number)s?/iu,
  },
  {
    reason: 'control_markup',
    pattern: /<\s*\/?\s*(?:system|developer|assistant|tool|user|instructions?)\b[^>]*>/iu,
  },
  {
    reason: 'control_markup',
    pattern: /\[(?:system|developer|assistant|tool|instructions?)\]|(?:BEGIN|END)[ _-](?:SYSTEM|PROMPT|INSTRUCTIONS?)/iu,
  },
];

function unsafeReason(value: string): UnsafeAiInput['reason'] | null {
  const normalized = value.normalize('NFKC');
  return UNSAFE_PATTERNS.find(({ pattern }) => pattern.test(normalized))?.reason ?? null;
}

/**
 * Applicant answers are evidence, never model instructions. Reject only clear
 * control-language patterns here; ordinary descriptions continue to the model.
 */
export function detectUnsafeAiInput(projection: AiInputSafetyProjection): UnsafeAiInput | null {
  const values = [
    ...Object.entries(projection.answers),
    ...projection.answeredFollowUps.map((item, index) => [`followUp.${index}`, item.answer] as const),
  ];
  for (const [source, value] of values) {
    const reason = unsafeReason(value);
    if (reason) return { source, reason };
  }
  // Attacks can be split so each field reads as harmless; check the answers as one passage too.
  const reason = unsafeReason(values.map(([, value]) => value).join(' '));
  return reason ? { source: 'combined', reason } : null;
}
