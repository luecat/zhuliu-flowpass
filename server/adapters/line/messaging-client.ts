export class LineMessagingError extends Error { constructor(readonly status: number, message = 'LINE messaging request failed') { super(message); } }
export interface LineMessagingClient { push(input: { to: string; text: string; retryKey: string; uri: string }): Promise<void>; }
export function createLineMessagingClient(options: { channelAccessToken: string; fetcher?: typeof fetch; endpoint?: string }): LineMessagingClient {
  const fetcher = options.fetcher ?? fetch; const endpoint = options.endpoint ?? 'https://api.line.me/v2/bot/message/push';
  return { async push(input) { const response = await fetcher(endpoint, { method: 'POST', headers: { authorization: `Bearer ${options.channelAccessToken}`, 'content-type': 'application/json', 'X-Line-Retry-Key': input.retryKey }, body: JSON.stringify({ to: input.to, messages: [{ type: 'text', text: `${input.text}\n${input.uri}` }] }) }); if (!response.ok) throw new LineMessagingError(response.status); } };
}
