import { describe, expect, it, vi } from 'vitest';
import { createLineMessagingClient } from './messaging-client';

describe('LINE messaging client', () => {
  it('sends an actionable Flex card with accessible fallback text', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));

    await createLineMessagingClient({ channelAccessToken: 'token', fetcher }).push({
      to: 'U1',
      text: '審核通過：符合補助資格。',
      title: '審核通過',
      bodyLabel: '原因',
      body: '符合補助資格。',
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
      altText: '審核通過：符合補助資格。',
    });
    expect(rendered.match(/審核通過/g)).toHaveLength(1);
    expect(rendered.indexOf('審核通過')).toBeLessThan(rendered.indexOf('原因'));
    expect(rendered.indexOf('原因')).toBeLessThan(rendered.indexOf('符合補助資格。'));
    expect(rendered.indexOf('符合補助資格。')).toBeLessThan(rendered.indexOf('更新時間'));
    expect(rendered).toContain('2026/09/01 10:02');
    expect(rendered).toContain('查看最新狀態');
    expect(rendered).toContain('https://liff.line.me/id/tasks');
  });

  it('renders the approved amount as the visual focus of a Flex card', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));

    await createLineMessagingClient({ channelAccessToken: 'token', fetcher }).push({
      to: 'U1',
      text: '核定通知：核定金額 NT$2,000，請開啟查看。',
      title: '審核通過',
      bodyLabel: '原因',
      body: '符合補助資格。',
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

  it('replies with a visual help card and announcement button', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));

    await createLineMessagingClient({ channelAccessToken: 'token', fetcher }).reply({
      replyToken: 'reply-1',
      title: '請改問關鍵字',
      text: '請改問常見問題，或查官方公告。',
      buttons: [
        { label: '公告', uri: 'https://youthhsinchu.hccg.gov.tw/youth/app/artwebsite?id=64&module=artwebsite&serno=null' },
        { label: '進度查詢', uri: 'https://liff.line.me/id/?next=passports' },
      ],
    });

    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as {
      replyToken: string;
      messages: Array<{ type: string; altText: string; contents: unknown }>;
    };
    const rendered = JSON.stringify(payload.messages[0].contents);
    expect(payload.replyToken).toBe('reply-1');
    expect(payload.messages[0].type).toBe('flex');
    expect(rendered).toContain('公告');
    expect(rendered).toContain('進度查詢');
    expect(rendered).toContain('youthhsinchu.hccg.gov.tw');
  });
});
