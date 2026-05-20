import crypto from 'node:crypto';
import { config } from './config.js';
export function verifyLineSignature(rawBody, signature) {
    if (!config.LINE_CHANNEL_SECRET || !signature)
        return true;
    const expected = crypto.createHmac('sha256', config.LINE_CHANNEL_SECRET).update(rawBody).digest('base64');
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}
export function extractLineEvents(body) {
    if (body?.lineUserId && body?.text) {
        return [{
                lineUserId: body.lineUserId,
                displayName: body.displayName ?? body.lineDisplayName ?? body.name ?? body.profile?.displayName,
                text: body.text,
                rawPayload: body,
                messageType: body.messageType ?? 'text',
            }];
    }
    const events = Array.isArray(body?.events) ? body.events : [];
    return events
        .filter((event) => event?.type === 'message' && event?.message?.type === 'text' && event?.source?.userId)
        .map((event) => ({
        lineUserId: event.source.userId,
        displayName: event.source?.displayName ?? event.profile?.displayName,
        text: event.message.text,
        rawPayload: event,
        messageType: event.message.type,
    }));
}
async function responseText(res) {
    const text = await res.text();
    return text ? `${res.status} ${text}` : String(res.status);
}
function lineHarnessApiBase(rawUrl) {
    const url = new URL(rawUrl);
    if (/line-harness-admin.*\.pages\.dev$/.test(url.hostname)) {
        throw new Error('LINE_HARNESS_SEND_URL must be the LINE Harness API URL, not the admin UI URL');
    }
    if (url.pathname === '/' || url.pathname === '' || url.pathname === '/api')
        return url.origin;
    return null;
}
function harnessHeaders() {
    return {
        'content-type': 'application/json',
        ...(config.LINE_HARNESS_API_KEY ? { authorization: `Bearer ${config.LINE_HARNESS_API_KEY}` } : {}),
    };
}
async function harnessJson(path) {
    const res = await fetch(path, { headers: harnessHeaders() });
    if (!res.ok)
        throw new Error(`LINE Harness API failed: ${await responseText(res)}`);
    return res.json();
}
async function resolveHarnessFriend(baseUrl, lineUserId) {
    const direct = await fetch(`${baseUrl}/api/friends/${encodeURIComponent(lineUserId)}`, { headers: harnessHeaders() });
    if (direct.ok) {
        const payload = await direct.json();
        if (payload?.success && payload?.data?.id)
            return payload.data;
    }
    else if (direct.status !== 404) {
        throw new Error(`LINE Harness friend lookup failed: ${await responseText(direct)}`);
    }
    const limit = 200;
    for (let offset = 0; offset < 2000; offset += limit) {
        const payload = await harnessJson(`${baseUrl}/api/friends?limit=${limit}&offset=${offset}&includeTags=false`);
        const items = payload?.data?.items ?? [];
        const friend = items.find((item) => item.id === lineUserId || item.lineUserId === lineUserId || item.line_user_id === lineUserId);
        if (friend)
            return friend;
        if (!payload?.data?.hasNextPage)
            break;
    }
    throw new Error(`LINE Harness friend not found for ${lineUserId}`);
}
function friendDisplayName(friend) {
    return friend?.displayName ?? friend?.display_name ?? friend?.name ?? friend?.profile?.displayName ?? friend?.lineName ?? friend?.line_name ?? null;
}
export async function findLineDisplayName(lineUserId) {
    if (config.LINE_HARNESS_SEND_URL) {
        try {
            const apiBase = lineHarnessApiBase(config.LINE_HARNESS_SEND_URL);
            if (apiBase) {
                const friend = await resolveHarnessFriend(apiBase, lineUserId);
                const name = friendDisplayName(friend);
                if (name)
                    return String(name);
            }
        }
        catch {
            // Profile enrichment must never block inbound handling.
        }
    }
    if (config.LINE_CHANNEL_ACCESS_TOKEN) {
        try {
            const res = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(lineUserId)}`, {
                headers: { authorization: `Bearer ${config.LINE_CHANNEL_ACCESS_TOKEN}` },
            });
            if (res.ok) {
                const profile = await res.json();
                if (profile?.displayName)
                    return String(profile.displayName);
            }
        }
        catch {
            // Ignore profile lookup failures; Slack will still show the LINE ID.
        }
    }
    return null;
}
async function sendViaLineHarnessApi(baseUrl, lineUserId, text) {
    const friend = await resolveHarnessFriend(baseUrl, lineUserId);
    const res = await fetch(`${baseUrl}/api/friends/${encodeURIComponent(friend.id)}/messages`, {
        method: 'POST',
        headers: harnessHeaders(),
        body: JSON.stringify({ content: text, messageType: 'text' }),
    });
    if (!res.ok)
        throw new Error(`LINE Harness send failed: ${await responseText(res)}`);
}
export async function sendLineMessage(lineUserId, text) {
    if (config.LINE_HARNESS_SEND_URL) {
        const apiBase = lineHarnessApiBase(config.LINE_HARNESS_SEND_URL);
        if (apiBase) {
            await sendViaLineHarnessApi(apiBase, lineUserId, text);
            return;
        }
        const res = await fetch(config.LINE_HARNESS_SEND_URL, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(config.LINE_HARNESS_API_KEY ? { authorization: `Bearer ${config.LINE_HARNESS_API_KEY}` } : {}),
            },
            body: JSON.stringify({ lineUserId, text, messages: [{ type: 'text', text }] }),
        });
        if (!res.ok)
            throw new Error(`LINE Harness send failed: ${await responseText(res)}`);
        return;
    }
    if (!config.LINE_CHANNEL_ACCESS_TOKEN)
        throw new Error('Set LINE_HARNESS_SEND_URL or LINE_CHANNEL_ACCESS_TOKEN');
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.LINE_CHANNEL_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({ to: lineUserId, messages: [{ type: 'text', text }] }),
    });
    if (!res.ok)
        throw new Error(`LINE push failed: ${await responseText(res)}`);
}
