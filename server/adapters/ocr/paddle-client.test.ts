import { describe, expect, it } from 'vitest';
import { PaddleClient } from './paddle-client';
describe('PaddleClient', () => { it('fails closed unless sandbox preflight enabled', async () => { await expect(new PaddleClient(async () => { throw new Error('network'); }).recognize(new Uint8Array())).rejects.toMatchObject({ code: 'OCR_MANUAL_REVIEW' }); }); });
