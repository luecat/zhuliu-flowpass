import { Buffer } from 'node:buffer';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { KeychainSecretProvider } from '../server/config/keychain';

type RichMenu = { richMenuId: string; name?: string; chatBarText?: string; areas?: unknown[] };

const RICH_MENU_NAME = '竹流 FlowPass｜申請檢測進度 FAQ v5';
const LEGACY_RICH_MENU_NAMES = new Set([
  '竹流 FlowPass｜申請檢測查詢 FAQ v4',
  '竹流 FlowPass｜申請與查詢 v3',
  '竹流 FlowPass｜申請與查詢 v2',
  '竹流 FlowPass｜申請與查詢',
]);
const LINE_API = 'https://api.line.me/v2/bot';
const LINE_DATA_API = 'https://api-data.line.me/v2/bot';

export function flowPassRichMenu(liffId: string) {
  const liffBase = `https://liff.line.me/${encodeURIComponent(liffId)}/`;
  return {
    name: RICH_MENU_NAME,
    chatBarText: '選單',
    selected: true,
    size: { width: 2500, height: 1686 },
    areas: [
      {
        bounds: { x: 0, y: 0, width: 1250, height: 843 },
        action: { type: 'uri', label: '申請', uri: `${liffBase}?next=apply` },
      },
      {
        bounds: { x: 1250, y: 0, width: 1250, height: 843 },
        action: { type: 'uri', label: '檢測', uri: `${liffBase}?next=tool-check` },
      },
      {
        bounds: { x: 0, y: 843, width: 1250, height: 843 },
        action: { type: 'uri', label: '進度查詢', uri: `${liffBase}?next=passports` },
      },
      {
        bounds: { x: 1250, y: 843, width: 1250, height: 843 },
        action: { type: 'message', label: 'FAQ', text: '常見問題' },
      },
    ],
  };
}

/**
 * 2×2 menu art. Shared vertical rhythm per cell:
 * icon center ≈ 270px from cell top, title ≈ 560, subtitle ≈ 650.
 * Dividers are black cross lines over the four panels.
 */
export async function flowPassRichMenuImage(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2500" height="1686" viewBox="0 0 2500 1686">
    <rect width="2500" height="1686" fill="#F4F8F6"/>
    <rect width="1250" height="843" fill="#236B4B"/>
    <rect x="1250" width="1250" height="843" fill="#2F7A58"/>
    <rect y="843" width="1250" height="843" fill="#FFFFFF"/>
    <rect x="1250" y="843" width="1250" height="843" fill="#EAF4EF"/>

    <!-- black cross dividers -->
    <path d="M1250 0V1686" stroke="#111111" stroke-width="12"/>
    <path d="M0 843H2500" stroke="#111111" stroke-width="12"/>

    <!-- 申請: document icon centered at (625, 270) -->
    <g transform="translate(625 270)" fill="none" stroke="#FFFFFF" stroke-width="28" stroke-linecap="round" stroke-linejoin="round">
      <rect x="-78" y="-110" width="156" height="200" rx="22"/>
      <path d="M-36 -150h72v40h-72z"/>
      <path d="M-42 -20h84M-42 40h56"/>
    </g>
    <text x="625" y="560" text-anchor="middle" fill="#FFFFFF" font-family="Arial, sans-serif" font-size="104" font-weight="700">申請</text>
    <text x="625" y="650" text-anchor="middle" fill="#D8F1E4" font-family="Arial, sans-serif" font-size="44">建立 FlowPass</text>

    <!-- 檢測: shield + check (passport-based), centered at (1875, 270) -->
    <g transform="translate(1875 270)" fill="none" stroke="#FFFFFF" stroke-width="28" stroke-linecap="round" stroke-linejoin="round">
      <path d="M0 -120 L96 -78 V10 C96 78 48 120 0 148 C-48 120 -96 78 -96 10 V-78 Z"/>
      <path d="M-42 8 L-8 42 L52 -28"/>
    </g>
    <text x="1875" y="560" text-anchor="middle" fill="#FFFFFF" font-family="Arial, sans-serif" font-size="104" font-weight="700">檢測</text>
    <text x="1875" y="650" text-anchor="middle" fill="#D8F1E4" font-family="Arial, sans-serif" font-size="44">依護照看事件</text>

    <!-- 進度查詢: steps/checklist, centered at (625, 1113) -->
    <g transform="translate(625 1113)" fill="none" stroke="#236B4B" stroke-width="28" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="0" cy="-88" r="28"/>
      <circle cx="0" cy="0" r="28"/>
      <circle cx="0" cy="88" r="28"/>
      <path d="M0 -60 V-28 M0 28 V60"/>
      <path d="M52 -88 H118 M52 0 H118 M52 88 H118"/>
    </g>
    <text x="625" y="1403" text-anchor="middle" fill="#236B4B" font-family="Arial, sans-serif" font-size="92" font-weight="700">進度查詢</text>
    <text x="625" y="1493" text-anchor="middle" fill="#527968" font-family="Arial, sans-serif" font-size="44">案件處理狀態</text>

    <!-- FAQ: question mark in circle, centered at (1875, 1113) -->
    <g transform="translate(1875 1113)" fill="none" stroke="#236B4B" stroke-width="28" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="0" cy="0" r="118"/>
      <path d="M-34 -36 C-34 -78 34 -78 34 -36 C34 -4 0 4 0 36"/>
      <circle cx="0" cy="78" r="10" fill="#236B4B" stroke="none"/>
    </g>
    <text x="1875" y="1403" text-anchor="middle" fill="#236B4B" font-family="Arial, sans-serif" font-size="104" font-weight="700">FAQ</text>
    <text x="1875" y="1493" text-anchor="middle" fill="#527968" font-family="Arial, sans-serif" font-size="44">常見問題</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function lineRequest(input: { token: string; path: string; method?: 'GET' | 'POST' | 'DELETE'; body?: BodyInit; contentType?: string; baseUrl?: string }) {
  const response = await fetch(`${input.baseUrl ?? LINE_API}${input.path}`, {
    method: input.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${input.token}`,
      ...(input.contentType ? { 'Content-Type': input.contentType } : {}),
    },
    body: input.body,
  });
  if (!response.ok) throw new Error(`LINE Messaging API request failed (${response.status})`);
  return response;
}

async function richMenuHasImage(token: string, richMenuId: string): Promise<boolean> {
  const response = await fetch(`${LINE_DATA_API}/richmenu/${encodeURIComponent(richMenuId)}/content`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`LINE rich menu image lookup failed (${response.status})`);
  return true;
}

export async function provisionRichMenu(input: { liffId: string; channelAccessToken: string; apply?: boolean }): Promise<{ richMenuId: string | null; changed: boolean }> {
  const response = await lineRequest({ token: input.channelAccessToken, path: '/richmenu/list' });
  const payload = await response.json() as { richmenus?: RichMenu[] };
  const existing = (payload.richmenus ?? []).find((menu) => menu.name === RICH_MENU_NAME);
  const legacy = (payload.richmenus ?? []).filter((menu) => menu.name && LEGACY_RICH_MENU_NAMES.has(menu.name));
  if (!input.apply) return { richMenuId: existing?.richMenuId ?? null, changed: !existing };

  const richMenuId = existing?.richMenuId ?? await (async () => {
    const created = await lineRequest({
      token: input.channelAccessToken,
      path: '/richmenu',
      method: 'POST',
      body: JSON.stringify(flowPassRichMenu(input.liffId)),
      contentType: 'application/json',
    });
    const body = await created.json() as { richMenuId?: unknown };
    if (typeof body.richMenuId !== 'string' || !body.richMenuId) throw new Error('LINE did not return a rich menu ID');
    return body.richMenuId;
  })();

  // Always refresh image for a newly named menu; for an existing menu, upload only if missing.
  if (!existing || !(await richMenuHasImage(input.channelAccessToken, richMenuId))) {
    const image = new Uint8Array(await flowPassRichMenuImage()).buffer;
    await lineRequest({
      token: input.channelAccessToken,
      path: `/richmenu/${encodeURIComponent(richMenuId)}/content`,
      method: 'POST',
      body: image,
      contentType: 'image/png',
      baseUrl: LINE_DATA_API,
    });
  }

  await lineRequest({
    token: input.channelAccessToken,
    path: `/user/all/richmenu/${encodeURIComponent(richMenuId)}`,
    method: 'POST',
  });
  for (const menu of legacy) {
    if (menu.richMenuId === richMenuId) continue;
    await lineRequest({
      token: input.channelAccessToken,
      path: `/richmenu/${encodeURIComponent(menu.richMenuId)}`,
      method: 'DELETE',
    });
  }
  return { richMenuId, changed: !existing };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apply = process.argv.includes('--apply');
  const provider = new KeychainSecretProvider();
  void provider.get({ service: process.env.FLOWPASS_KEYCHAIN_SERVICE ?? 'FlowPass', account: 'line-channel-access-token' })
    .then((channelAccessToken) => provisionRichMenu({
      liffId: process.env.NEXT_PUBLIC_FLOWPASS_LIFF_ID ?? '2011336492-ay7OJ4mO',
      channelAccessToken,
      apply,
    }))
    .then((result) => console.log(JSON.stringify({ apply, ...result })))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : 'LINE rich menu setup failed');
      process.exitCode = 1;
    });
}
