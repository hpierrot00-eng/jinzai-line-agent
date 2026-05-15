import crypto from 'node:crypto';
import { config } from './config.js';
import type { InboundLineMessage } from './types.js';

export function verifyLineSignature(rawBody: Buffer, signature?: string) {
  if (!config.LINE_CHANNEL_SECRET || !signature) return true;
  const expected = crypto.createHmac('sha256', config.LINE_CHANNEL_SECRET).update(rawBody).digest('base64');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export function extractLineEvents(body: any): InboundLineMessage[] {
  if (body?.lineUserId && body?.text) {
    return [{ lineUserId: body.lineUserId, displayName: body.displayName, text: body.text, rawPayload: body, messageType: body.messageType ?? 'text' }];
  }
  const events = Array.isArray(body?.events) ? body.events : [];
  return events
    .filter((event: any) => event?.type === 'message' && event?.message?.type === 'text' && event?.source?.userId)
    .map((event: any) => ({
      lineUserId: event.source.userId,
      text: event.message.text,
      rawPayload: event,
      messageType: event.message.type,
    }));
}

export async function sendLineMessage(lineUserId: string, text: string) {
  if (config.LINE_HARNESS_SEND_URL) {
    const res = await fetch(config.LINE_HARNESS_SEND_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.LINE_HARNESS_API_KEY ? { authorization: `Bearer ${config.LINE_HARNESS_API_KEY}` } : {}),
      },
      body: JSON.stringify({ lineUserId, text, messages: [{ type: 'text', text }] }),
    });
    if (!res.ok) throw new Error(`LINE Harness send failed: ${res.status} ${await res.text()}`);
    return;
  }

  if (!config.LINE_CHANNEL_ACCESS_TOKEN) throw new Error('Set LINE_HARNESS_SEND_URL or LINE_CHANNEL_ACCESS_TOKEN');
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to: lineUserId, messages: [{ type: 'text', text }] }),
  });
  if (!res.ok) throw new Error(`LINE push failed: ${res.status} ${await res.text()}`);
}
