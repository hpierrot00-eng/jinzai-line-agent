# 60-minute production checklist

Goal: ship the MVP loop, not the final polished product.

## What is already verified

- `npm install` passed.
- `npm run typecheck` passed.
- `npm run build` passed.
- Local smoke script exists: `npm run smoke:start`.

## Fastest safe deployment path

Use Render / Railway / Fly / any Node-capable server.

Build command:

```bash
npm install && npm run build
```

Start command:

```bash
npm run start
```

Health check path:

```text
/health
```

## Required environment variables

Use `ENV_COPYLIST.md` as the copy checklist. Do not paste real secrets into chat.

```env
PORT=8787
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
DEFAULT_CLIENT_ID=00000000-0000-0000-0000-000000000001
SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=
SLACK_APPROVAL_CHANNEL_ID=
LINE_HARNESS_SEND_URL=
LINE_HARNESS_API_KEY=
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=
OPENCLAW_AGENT_URL=
OPENCLAW_AGENT_TOKEN=
OPENCLAW_MODEL_NAME=openclaw
ADMIN_API_KEY=
```

Minimum LINE sending requirement: either `LINE_HARNESS_SEND_URL` or `LINE_CHANNEL_ACCESS_TOKEN`.

## Supabase

1. Open SQL Editor.
2. Run `supabase/schema.sql`.
3. Run `supabase/seed-mvp.sql` after editing placeholder monthly values.

## Slack

1. Create app from `slack-app-manifest.yml`.
2. Set Interactivity Request URL:

```text
https://YOUR_DOMAIN/webhooks/slack/interactions
```

3. Install app.
4. Invite bot to approval channel.
5. Set env:
   - `SLACK_BOT_TOKEN`
   - `SLACK_SIGNING_SECRET`
   - `SLACK_APPROVAL_CHANNEL_ID`

## LINE

If using direct LINE webhook:

```text
https://YOUR_DOMAIN/webhooks/line
```

If using LINE Harness normalized inbound:

```text
https://YOUR_DOMAIN/line-harness/inbound
```

## Pre-live validation

After setting env vars, run:

```bash
npm run check:env
```

Then check:

```text
GET https://YOUR_DOMAIN/health
```

## Final live test

1. Send LINE test message: `来月の支払いはいつですか？`
2. Confirm Slack card appears.
3. Click `修正依頼`, enter `もっと短く、断定しないで`.
4. Confirm new Slack card appears.
5. Click `承認して送信`.
6. Confirm LINE receives the message.
7. Confirm Supabase tables:
   - `students`
   - `messages`
   - `reply_drafts`
   - `approvals`
   - `slack_reviews`

## Security notes

- Never paste service-role keys into Discord.
- Put secrets only into deployment environment variables.
- Keep `ADMIN_API_KEY` enabled for `/knowledge-*` and `/monthly-rules` endpoints.
- Do not enable auto-send; current mode is Slack approval first.
