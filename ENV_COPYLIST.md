# Env copylist

Do not paste real secrets into Discord. Put these directly into the deployment provider's environment-variable screen.

## Required

```env
PORT=8787
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
DEFAULT_CLIENT_ID=00000000-0000-0000-0000-000000000001
SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=
SLACK_APPROVAL_CHANNEL_ID=
OPENCLAW_MODEL_NAME=openclaw
ADMIN_API_KEY=
```

## LINE sending: choose one

### Option A: LINE Harness

```env
LINE_HARNESS_SEND_URL=
LINE_HARNESS_API_KEY=
```

### Option B: Direct LINE official account

```env
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=
```

## Optional AI endpoint

If empty, the safe local fallback draft generator still works.

```env
OPENCLAW_AGENT_URL=
OPENCLAW_AGENT_TOKEN=
```

## After deploy

Run/check:

```bash
npm run check:env
```

Then open:

```text
https://YOUR_DOMAIN/health
```

Expected:

```json
{"ok":true,"service":"jinzai-line-agent","mode":"draft_only"}
```
