import { Buffer } from 'node:buffer';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { KeychainSecretProvider } from '../server/config/keychain';

type RichMenu = { richMenuId: string; name?: string; chatBarText?: string; areas?: unknown[] };

const RICH_MENU_NAME = '竹流 FlowPass｜申請與查詢 v3';
const LEGACY_RICH_MENU_NAMES = new Set([
  '竹流 FlowPass｜申請與查詢 v2',
  '竹流 FlowPass｜申請與查詢',
]);
const LINE_API = 'https://api.line.me/v2/bot';
const LINE_DATA_API = 'https://api-data.line.me/v2/bot';

export function flowPassRichMenu(liffId: string) {
  return {
    name: RICH_MENU_NAME,
    chatBarText: '申請／查詢',
    selected: true,
    size: { width: 2500, height: 1686 },
    areas: [
      {
        bounds: { x: 0, y: 0, width: 1250, height: 1686 },
        action: { type: 'uri', label: '申請', uri: `https://liff.line.me/${encodeURIComponent(liffId)}/?next=apply` },
      },
      {
        bounds: { x: 1250, y: 0, width: 1250, height: 1686 },
        action: { type: 'uri', label: '查詢', uri: `https://liff.line.me/${encodeURIComponent(liffId)}/?next=passports` },
      },
    ],
  };
}

/** Render locally so the official-account menu never depends on a third-party image host. */
export async function flowPassRichMenuImage(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2500" height="1686" viewBox="0 0 2500 1686">
    <rect width="2500" height="1686" fill="#F4F8F6"/>
    <rect width="1250" height="1686" fill="#236B4B"/>
    <rect x="1250" width="1250" height="1686" fill="#FFFFFF"/>
    <path d="M1250 0V1686" stroke="#D5E4DD" stroke-width="8"/>
    <circle cx="625" cy="560" r="190" fill="#BDE6D1" opacity=".24"/>
    <rect x="535" y="455" width="180" height="230" rx="24" fill="none" stroke="#FFFFFF" stroke-width="30"/>
    <path d="M585 440h80v42h-80zM580 545h90M580 605h62M662 620l76-76 30 30-76 76-42 12z" fill="none" stroke="#FFFFFF" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="1875" cy="560" r="190" fill="#DDF0E7"/>
    <circle cx="1840" cy="530" r="82" fill="none" stroke="#236B4B" stroke-width="34"/>
    <path d="M1900 590l92 92" fill="none" stroke="#236B4B" stroke-width="34" stroke-linecap="round"/>
    <text x="625" y="1020" text-anchor="middle" fill="#FFFFFF" font-family="Arial, sans-serif" font-size="118" font-weight="700">申請</text>
    <text x="625" y="1140" text-anchor="middle" fill="#D8F1E4" font-family="Arial, sans-serif" font-size="58">建立新的 FlowPass</text>
    <text x="1875" y="1020" text-anchor="middle" fill="#236B4B" font-family="Arial, sans-serif" font-size="118" font-weight="700">查詢</text>
    <text x="1875" y="1140" text-anchor="middle" fill="#527968" font-family="Arial, sans-serif" font-size="58">查看案件與進度</text>
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

  if (!(await richMenuHasImage(input.channelAccessToken, richMenuId))) {
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
