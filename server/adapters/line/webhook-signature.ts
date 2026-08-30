import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyLineWebhookSignature(rawBody: Uint8Array, signature: string | null, channelSecret: string): boolean {
  if (!signature || !channelSecret) return false;
  const expected = createHmac('sha256', channelSecret).update(rawBody).digest('base64');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
