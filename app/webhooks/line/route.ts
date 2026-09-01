import { verifyLineWebhookSignature } from '../../../server/adapters/line/webhook-signature';
import { acceptLineWebhookEvents } from '../../../server/services/line-webhook-service';
import { getPublicRuntime } from '../../../server/public/runtime';

export async function POST(request: Request): Promise<Response> {
  const runtime = getPublicRuntime();
  const secret = runtime?.lineChannelSecret;
  if (!runtime || !secret) return Response.json({ error: 'LINE webhook is not configured' }, { status: 503 });
  const raw = new Uint8Array(await request.arrayBuffer());
  if (!verifyLineWebhookSignature(raw, request.headers.get('x-line-signature'), secret)) return Response.json({ error: 'invalid signature' }, { status: 401 });
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { return Response.json({ error: 'invalid payload' }, { status: 400 }); }
  const events = body && typeof body === 'object' && Array.isArray((body as Record<string, unknown>).events) ? (body as { events: unknown[] }).events : [];
  const result = acceptLineWebhookEvents({ database: runtime.database, clock: runtime.clock }, events);
  return Response.json({ accepted: result.accepted, duplicates: result.duplicates });
}
