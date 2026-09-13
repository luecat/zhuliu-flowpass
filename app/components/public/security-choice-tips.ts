const SECURITY_TIP_PATTERNS: Array<{ pattern: RegExp; tip: string }> = [
  {
    pattern: /google\s*drive|dropbox|onedrive|雲端/i,
    tip: '雲端硬碟的預設連結可能具有公開風險，建議設定為限定成員存取。',
  },
  {
    pattern: /人臉|肖像|照片|大頭照/i,
    tip: '含人臉之素材，上傳前請取得當事人同意，並移除名牌與位置資訊。',
  },
  {
    pattern: /api\s*key|api\s*金鑰|金鑰|密碼|token|營業秘密|機密/i,
    tip: '密碼、API 金鑰與機密資訊請先撤銷或替換為假資料，切勿上傳或交給 AI 處理。',
  },
  {
    pattern: /金融|帳號|發票|收據|信用卡|銀行/i,
    tip: '金融帳號與收據請先遮蔽卡號及可識別個資，再交給 AI 處理。',
  },
  {
    pattern: /未成年|學生|兒童|孩童/i,
    tip: '涉及未成年資料時，請確認監護人同意並遵循最小必要原則，避免公開可識別資訊。',
  },
  {
    pattern: /聲音|錄音|訪談/i,
    tip: '錄音上傳前請取得當事人同意，並將可識別姓名替換為代號。',
  },
  {
    pattern: /位置|gps|定位|名牌|地址/i,
    tip: '上傳前請移除定位、名牌與地址等中繼資料。',
  },
  {
    pattern: /公開|社群|發佈|發布/i,
    tip: '公開發布前請確認肖像、聲音與素材授權，避免意外洩漏個資。',
  },
  {
    pattern: /外掛|plugin|extension/i,
    tip: '請確認外掛開發者來源，並僅開啟完成任務所需的最低權限。',
  },
];

export function securityTipForChoice(choice: string): string | null {
  const matched = SECURITY_TIP_PATTERNS.find((item) => item.pattern.test(choice));
  return matched?.tip ?? null;
}

export function securityTipsForSelections(values: string[]): string[] {
  const tips = values
    .map((value) => securityTipForChoice(value))
    .filter((tip): tip is string => Boolean(tip));
  return [...new Set(tips)];
}
