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

function asRecord(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, any>;
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function extractMarkAsReadToken(payload: unknown): string | null {
  const root = asRecord(payload);
  if (!root) return null;

  const direct = stringValue(root.markAsReadToken)
    ?? stringValue(root.mark_as_read_token)
    ?? stringValue(root.readToken)
    ?? stringValue(root.read_token);
  if (direct) return direct;

  const message = asRecord(root.message);
  const messageToken = stringValue(message?.markAsReadToken)
    ?? stringValue(message?.mark_as_read_token)
    ?? stringValue(message?.readToken)
    ?? stringValue(message?.read_token);
  if (messageToken) return messageToken;

  const rawPayloadToken = extractMarkAsReadToken(root.rawPayload);
  if (rawPayloadToken) return rawPayloadToken;

  const event = asRecord(root.event);
  const eventToken = extractMarkAsReadToken(event);
  if (eventToken) return eventToken;

  const events = Array.isArray(root.events) ? root.events : [];
  for (const item of events) {
    const token = extractMarkAsReadToken(item);
    if (token) return token;
  }

  return null;
}

export function extractLineEvents(body: any): InboundLineMessage[] {
  if (body?.lineUserId && body?.text) {
    const rawPayload = body.rawPayload ?? body;
    return [{
      lineUserId: body.lineUserId,
      displayName: body.displayName ?? body.lineDisplayName ?? body.name ?? body.profile?.displayName,
      text: body.text,
      markAsReadToken: extractMarkAsReadToken(body) ?? undefined,
      rawPayload,
      messageType: body.messageType ?? 'text',
    }];
  }
  const events = Array.isArray(body?.events) ? body.events : [];
  return events
    .filter((event: any) => event?.type === 'message' && event?.message?.type === 'text' && event?.source?.userId)
    .map((event: any) => ({
      lineUserId: event.source.userId,
      displayName: event.source?.displayName ?? event.profile?.displayName,
      text: event.message.text,
      markAsReadToken: extractMarkAsReadToken(event) ?? undefined,
      rawPayload: event,
      messageType: event.message.type,
    }));
}

async function responseText(res: Response) {
  const text = await res.text();
  return text ? `${res.status} ${text}` : String(res.status);
}

function lineHarnessApiBase(rawUrl: string) {
  const url = new URL(rawUrl);
  if (/line-harness-admin.*\.pages\.dev$/.test(url.hostname)) {
    throw new Error('LINE_HARNESS_SEND_URL must be the LINE Harness API URL, not the admin UI URL');
  }
  if (url.pathname === '/' || url.pathname === '' || url.pathname === '/api') return url.origin;
  return null;
}

function harnessHeaders() {
  return {
    'content-type': 'application/json',
    ...(config.LINE_HARNESS_API_KEY ? { authorization: `Bearer ${config.LINE_HARNESS_API_KEY}` } : {}),
  };
}

async function harnessJson(path: string) {
  const res = await fetch(path, { headers: harnessHeaders() });
  if (!res.ok) throw new Error(`LINE Harness API failed: ${await responseText(res)}`);
  return res.json();
}

async function resolveHarnessFriend(baseUrl: string, lineUserId: string) {
  const direct = await fetch(`${baseUrl}/api/friends/${encodeURIComponent(lineUserId)}`, { headers: harnessHeaders() });
  if (direct.ok) {
    const payload = await direct.json() as any;
    if (payload?.success && payload?.data?.id) return payload.data;
  } else if (direct.status !== 404) {
    throw new Error(`LINE Harness friend lookup failed: ${await responseText(direct)}`);
  }

  const limit = 200;
  for (let offset = 0; offset < 2000; offset += limit) {
    const payload = await harnessJson(`${baseUrl}/api/friends?limit=${limit}&offset=${offset}&includeTags=false`) as any;
    const items = payload?.data?.items ?? [];
    const friend = items.find((item: any) => item.id === lineUserId || item.lineUserId === lineUserId || item.line_user_id === lineUserId);
    if (friend) return friend;
    if (!payload?.data?.hasNextPage) break;
  }

  throw new Error(`LINE Harness friend not found for ${lineUserId}`);
}

function friendDisplayName(friend: any) {
  return friend?.displayName ?? friend?.display_name ?? friend?.name ?? friend?.profile?.displayName ?? friend?.lineName ?? friend?.line_name ?? null;
}

export async function findLineDisplayName(lineUserId: string) {
  if (config.LINE_HARNESS_SEND_URL) {
    try {
      const apiBase = lineHarnessApiBase(config.LINE_HARNESS_SEND_URL);
      if (apiBase) {
        const friend = await resolveHarnessFriend(apiBase, lineUserId);
        const name = friendDisplayName(friend);
        if (name) return String(name);
      }
    } catch {
      // Profile enrichment must never block inbound handling.
    }
  }

  if (config.LINE_CHANNEL_ACCESS_TOKEN) {
    try {
      const res = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(lineUserId)}`, {
        headers: { authorization: `Bearer ${config.LINE_CHANNEL_ACCESS_TOKEN}` },
      });
      if (res.ok) {
        const profile = await res.json() as any;
        if (profile?.displayName) return String(profile.displayName);
      }
    } catch {
      // Ignore profile lookup failures; Slack will still show the LINE ID.
    }
  }

  return null;
}

async function sendViaLineHarnessApi(baseUrl: string, lineUserId: string, text: string) {
  const friend = await resolveHarnessFriend(baseUrl, lineUserId);
  const res = await fetch(`${baseUrl}/api/friends/${encodeURIComponent(friend.id)}/messages`, {
    method: 'POST',
    headers: harnessHeaders(),
    body: JSON.stringify({ content: text, messageType: 'text' }),
  });
  if (!res.ok) throw new Error(`LINE Harness send failed: ${await responseText(res)}`);
}

export async function markLineMessageAsRead(markAsReadToken?: string | null) {
  if (!markAsReadToken) return { skipped: true, reason: 'missing_mark_as_read_token' };
  if (!config.LINE_MARK_AS_READ_ENABLED) return { skipped: true, reason: 'line_mark_as_read_disabled' };
  if (config.LINE_SEND_DRY_RUN) return { dryRun: true };
  if (!config.LINE_CHANNEL_ACCESS_TOKEN) return { skipped: true, reason: 'missing_line_channel_access_token' };

  const res = await fetch('https://api.line.me/v2/bot/chat/markAsRead', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ markAsReadToken }),
  });
  if (!res.ok) throw new Error(`LINE mark-as-read failed: ${await responseText(res)}`);
  return { ok: true };
}

export async function syncLineHarnessTags(lineUserId: string, tags: string[]) {
  if (!config.LINE_HARNESS_TAG_SYNC_ENABLED || tags.length === 0 || !config.LINE_HARNESS_SEND_URL) return;

  try {
    if (config.LINE_HARNESS_TAG_SYNC_URL) {
      const res = await fetch(config.LINE_HARNESS_TAG_SYNC_URL, {
        method: 'POST',
        headers: harnessHeaders(),
        body: JSON.stringify({ lineUserId, tags, source: 'jinzai-line-agent' }),
      });
      if (!res.ok) throw new Error(`LINE Harness tag sync failed: ${await responseText(res)}`);
      return;
    }

    const apiBase = lineHarnessApiBase(config.LINE_HARNESS_SEND_URL);
    if (!apiBase) return;
    const friend = await resolveHarnessFriend(apiBase, lineUserId);
    const payload = JSON.stringify({ tags, source: 'jinzai-line-agent' });
    const tagRes = await fetch(`${apiBase}/api/friends/${encodeURIComponent(friend.id)}/tags`, {
      method: 'POST',
      headers: harnessHeaders(),
      body: payload,
    });
    if (tagRes.ok) return;
    if (tagRes.status !== 404 && tagRes.status !== 405) throw new Error(`LINE Harness tag sync failed: ${await responseText(tagRes)}`);

    const patchRes = await fetch(`${apiBase}/api/friends/${encodeURIComponent(friend.id)}`, {
      method: 'PATCH',
      headers: harnessHeaders(),
      body: payload,
    });
    if (!patchRes.ok) throw new Error(`LINE Harness friend tag patch failed: ${await responseText(patchRes)}`);
  } catch (err) {
    // Tags are an operator-facing mirror only. DB status remains the source of truth, so tag sync must never block workflows.
    console.warn('LINE Harness tag sync skipped:', err instanceof Error ? err.message : err);
  }
}

export async function sendLineMessage(lineUserId: string, text: string) {
  if (config.LINE_SEND_DRY_RUN) {
    return { dryRun: true, lineUserId, text };
  }

  if (config.LINE_HARNESS_SEND_URL) {
    const apiBase = lineHarnessApiBase(config.LINE_HARNESS_SEND_URL);
    if (apiBase) {
      await sendViaLineHarnessApi(apiBase, lineUserId, text);
      return { dryRun: false };
    }

    const res = await fetch(config.LINE_HARNESS_SEND_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.LINE_HARNESS_API_KEY ? { authorization: `Bearer ${config.LINE_HARNESS_API_KEY}` } : {}),
      },
      body: JSON.stringify({ lineUserId, text, messages: [{ type: 'text', text }] }),
    });
    if (!res.ok) throw new Error(`LINE Harness send failed: ${await responseText(res)}`);
    return { dryRun: false };
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
  if (!res.ok) throw new Error(`LINE push failed: ${await responseText(res)}`);
  return { dryRun: false };
}
