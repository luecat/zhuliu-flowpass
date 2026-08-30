import { createHmac } from 'node:crypto';

export function createFakeLineServer(secret = 'test-secret') {
  const pushes: Array<{ to: string; text: string; retryKey: string }> = [];
  return {
    signature(body: string): string { return createHmac('sha256', secret).update(body).digest('base64'); },
    pushes,
    async push(to: string, text: string, retryKey: string): Promise<{ messageId: string }> { pushes.push({ to, text, retryKey }); return { messageId: `fake-${pushes.length}` }; },
  };
}
