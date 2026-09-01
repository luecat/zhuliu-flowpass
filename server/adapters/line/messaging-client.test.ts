import { describe, expect, it, vi } from 'vitest';
import { createLineMessagingClient } from './messaging-client';

describe('LINE messaging client', () => {
  it('sends an actionable Flex card with accessible fallback text', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));

    await createLineMessagingClient({ channelAccessToken: 'token', fetcher }).push({
      to: 'U1',
      text: '審核結果：您的 FlowPass 案件狀態已更新，請開啟查看。',
      title: '審核狀態更新',
      body: '案件有新的審核結果，請開啟 FlowPass 查看最新狀態。',
      actionLabel: '查看最新狀態',
      updatedAtLabel: '2026/09/01 10:02',
      uri: 'https://liff.line.me/id/tasks',
      retryKey: 'retry-1',
    });

    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as {
      messages: Array<{ type: string; altText: string; contents: unknown }>;
    };
    const message = payload.messages[0];
    const rendered = JSON.stringify(message.contents);

    expect(init.headers).toEqual(expect.objectContaining({ 'X-Line-Retry-Key': 'retry-1' }));
    expect(message).toMatchObject({
      type: 'flex',
      altText: '審核結果：您的 FlowPass 案件狀態已更新，請開啟查看。',
    });
    expect(rendered).toContain('審核狀態更新');
    expect(rendered).toContain('2026/09/01 10:02');
    expect(rendered).toContain('查看最新狀態');
    expect(rendered).toContain('https://liff.line.me/id/tasks');
  });

  it('renders the approved amount as the visual focus of a Flex card', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));

    await createLineMessagingClient({ channelAccessToken: 'token', fetcher }).push({
      to: 'U1',
      text: '核定通知：核定金額 NT$2,000，請開啟查看。',
      title: '核定通知',
      body: '您的案件已核定。',
      amountLabel: '核定金額',
      amountValue: 'NT$2,000',
      actionLabel: '查看最新狀態',
      updatedAtLabel: '2026/09/01 10:02',
      uri: 'https://liff.line.me/id/tasks',
      retryKey: '0198f080-0000-7000-8000-000000000006',
    });

    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const rendered = JSON.stringify(JSON.parse(String(init.body)).messages[0].contents);
    expect(rendered).toContain('NT$2,000');
    expect(rendered).toContain('核定金額');
  });
});
