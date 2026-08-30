import { KeychainSecretProvider } from '../server/config/keychain';

type RichMenu = { richMenuId: string; name?: string; chatBarText?: string; areas?: unknown[] };
const expected = (liffId: string) => ({ name: 'FlowPass', chatBarText: 'FlowPass', selected: false, size: { width: 2500, height: 1686 }, areas: [{ bounds: { x: 0, y: 0, width: 1250, height: 1686 }, action: { type: 'uri', label: '送出申請', uri: `https://liff.line.me/${liffId}/apply` } }, { bounds: { x: 1250, y: 0, width: 1250, height: 1686 }, action: { type: 'uri', label: '護照查詢', uri: `https://liff.line.me/${liffId}/passports` } }] });

export async function provisionRichMenu(input: { liffId: string; channelAccessToken: string; apply?: boolean; endpoint?: string }): Promise<{ current: RichMenu[]; changed: boolean }> {
  const endpoint = input.endpoint ?? 'https://api.line.me/v2/bot/richmenu/list'; const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${input.channelAccessToken}` } }); if (!response.ok) throw new Error('LINE rich menu list unavailable'); const payload = await response.json() as { richmenus?: RichMenu[] }; const current = payload.richmenus ?? []; const changed = JSON.stringify(current) !== JSON.stringify(expected(input.liffId));
  if (input.apply && changed) { const create = await fetch(endpoint.replace('/list', ''), { method: 'POST', headers: { Authorization: `Bearer ${input.channelAccessToken}`, 'content-type': 'application/json' }, body: JSON.stringify(expected(input.liffId)) }); if (!create.ok) throw new Error('LINE rich menu create failed'); }
  return { current, changed };
}

if (import.meta.url === `file://${process.argv[1]}`) { const apply = process.argv.includes('--apply'); const provider = new KeychainSecretProvider(); void provider.get({ service: process.env.FLOWPASS_KEYCHAIN_SERVICE ?? 'FlowPass', account: 'line-channel-access-token' }).then((token) => provisionRichMenu({ liffId: process.env.NEXT_PUBLIC_FLOWPASS_LIFF_ID ?? 'flowpass-local-liff', channelAccessToken: token, apply })).then((result) => console.log(JSON.stringify({ apply, currentCount: result.current.length, changed: result.changed }))).catch((error) => { console.error(error instanceof Error ? error.message : 'rich menu operation failed'); process.exitCode = 1; }); }
