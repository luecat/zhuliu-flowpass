export type AiInputSafetyProjection = {
  answers: Record<string, string>;
  answeredFollowUps: Array<{ question: string; answer: string }>;
};

export type UnsafeAiInput = {
  source: string;
  reason: 'instruction_override' | 'role_impersonation' | 'prompt_exfiltration' | 'control_markup';
};

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
    reason: 'prompt_exfiltration',
    pattern: /(?:reveal|print|show|output|repeat|leak).{0,56}(?:system prompt|hidden prompt|developer message|internal instruction|secret|policy)/iu,
  },
  {
    reason: 'prompt_exfiltration',
    pattern: /(?:顯示|輸出|列出|重複|洩漏|公開).{0,40}(?:系統提示詞|隱藏提示詞|開發者訊息|內部指令|密密|規則)/u,
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
  return null;
}
