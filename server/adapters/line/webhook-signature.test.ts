import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyLineWebhookSignature } from './webhook-signature';

describe('LINE webhook signature', () => {
  it('verifies the exact raw body', () => {
    const raw = Buffer.from('{"events":[]}');
    const signature = createHmac('sha256', 'secret').update(raw).digest('base64');
    expect(verifyLineWebhookSignature(raw, signature, 'secret')).toBe(true);
    expect(verifyLineWebhookSignature(Buffer.from('{"events":[]}\n'), signature, 'secret')).toBe(false);
  });
});
