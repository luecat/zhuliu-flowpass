export class LineMessagingError extends Error {
  constructor(readonly status: number, message = 'LINE messaging request failed') {
    super(message);
  }
}

export interface LineNotificationPush {
  to: string;
  text: string;
  title: string;
  body: string;
  bodyLabel?: string;
  amountLabel?: string;
  amountValue?: string;
  actionLabel: string;
  updatedAtLabel: string;
  retryKey: string;
  uri: string;
}

export interface LineMessagingClient {
  push(input: LineNotificationPush): Promise<void>;
}

function flexMessage(input: LineNotificationPush) {
  return {
    type: 'flex',
    altText: input.text,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#236B4B',
        paddingAll: '20px',
        contents: [
          { type: 'text', text: 'FlowPass 竹流', color: '#DDF0E7', size: 'sm', weight: 'bold' },
          { type: 'text', text: input.title, color: '#FFFFFF', size: 'xl', weight: 'bold', margin: 'md', wrap: true },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '20px',
        contents: [
          ...(input.body.trim()
            ? [
                ...(input.bodyLabel
                  ? [{ type: 'text', text: input.bodyLabel, color: '#7A8B83', size: 'sm' }]
                  : []),
                { type: 'text', text: input.body, color: '#24332C', size: 'md', margin: input.bodyLabel ? 'sm' : 'none', align: 'start', wrap: true },
              ]
            : []),
          ...(input.amountValue
            ? [
                { type: 'text', text: input.amountLabel ?? '', color: '#7A8B83', size: 'sm', margin: input.body.trim() ? 'xl' : 'none', align: 'center' },
                { type: 'text', text: input.amountValue, color: '#102A20', size: 'xxl', weight: 'bold', margin: 'sm', align: 'center', wrap: true },
              ]
            : []),
          { type: 'separator', margin: 'xl', color: '#D5E4DD' },
          {
            type: 'box',
            layout: 'horizontal',
            margin: 'lg',
            contents: [
              { type: 'text', text: '更新時間', color: '#7A8B83', size: 'sm', flex: 0 },
              { type: 'text', text: input.updatedAtLabel, color: '#41544B', size: 'sm', align: 'end' },
            ],
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '20px',
        paddingTop: '0px',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#236B4B',
            height: 'sm',
            action: { type: 'uri', label: input.actionLabel, uri: input.uri },
          },
        ],
      },
    },
  };
}

export function createLineMessagingClient(options: {
  channelAccessToken: string;
  fetcher?: typeof fetch;
  endpoint?: string;
}): LineMessagingClient {
  const fetcher = options.fetcher ?? fetch;
  const endpoint = options.endpoint ?? 'https://api.line.me/v2/bot/message/push';

  return {
    async push(input) {
      const response = await fetcher(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.channelAccessToken}`,
          'content-type': 'application/json',
          'X-Line-Retry-Key': input.retryKey,
        },
        body: JSON.stringify({ to: input.to, messages: [flexMessage(input)] }),
      });
      if (!response.ok) throw new LineMessagingError(response.status);
    },
  };
}
