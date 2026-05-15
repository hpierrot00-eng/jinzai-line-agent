# Jinzai LINE Agent

Slack承認型のLINE学生対応AI MVPです。

## What this implements

- LINE / LINE Harness inbound webhook
- Supabase persistence
- OpenClaw draft generation hook, with safe local fallback
- Slack approval UI
- `承認して送信` -> LINE automatic send
- `編集して送信` -> Slack modal -> LINE send
- `修正依頼` -> OpenClaw/fallback再ドラフト -> 新しいSlack承認カード投稿
- `人間対応` / `却下`
- Supabase approval and outgoing-message logs
- Appointment extraction placeholder and `appointments` persistence
- Knowledge lookup from approved/manual support answers
- Monthly rule lookup for changing answers like payment dates or next-month schedules

## Flow

LINE inbound -> Supabase -> OpenClaw/fallback draft -> Slack approval/edit/revision -> LINE send -> Supabase log

Draft generation uses, in this order:

1. the current LINE message
2. recent conversation history
3. matching `knowledge_items`
4. matching `monthly_rules` for “今月” / “来月” / explicit month questions

Everything starts as `draft_only`. Nothing is auto-sent without Slack approval.

## Setup

```bash
cd jinzai-line-agent
npm install
cp .env.example .env
```

Fill `.env`.

Required:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `SLACK_APPROVAL_CHANNEL_ID`
- one of:
  - `LINE_HARNESS_SEND_URL` + optional `LINE_HARNESS_API_KEY`
  - `LINE_CHANNEL_ACCESS_TOKEN`

Optional:

- `OPENCLAW_AGENT_URL`
- `OPENCLAW_AGENT_TOKEN`
- `ADMIN_API_KEY`

If `OPENCLAW_AGENT_URL` is empty, the app uses a conservative heuristic draft generator so the approval loop still works.

## Supabase

Run `supabase/schema.sql` in Supabase SQL editor.

Optional for a quick first test: run `supabase/seed-mvp.sql` after editing the placeholder monthly values.

The schema includes:

- `clients`
- `students`
- `conversations`
- `messages`
- `reply_drafts`
- `approvals`
- `slack_reviews`
- `appointments`
- `knowledge_items`
- `monthly_rules`

`appointments` includes:

- `appointment_type`
- `scheduled_at`

Sheets sync is intentionally outside the current MVP loop. Add it later after the approval/send/log flow is stable.

## Knowledge and monthly rules

Create a manual knowledge item:

```bash
curl -X POST https://YOUR_DOMAIN/knowledge-items \
  -H "authorization: Bearer $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"title":"支払い時期の基本回答","category":"payment","body":"支払い時期は案件・契約条件により異なるため、必ず確認してから案内する。","priority":10}'
```

Create or update a monthly rule:

```bash
curl -X POST https://YOUR_DOMAIN/monthly-rules \
  -H "authorization: Bearer $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"ruleMonth":"2026-06","category":"payment","label":"2026年6月の支払い予定日","value":"6月末予定","notes":"確定前は断定しない"}'
```

List approved-reply candidates that can be turned into knowledge:

```text
GET /knowledge/candidates
Authorization: Bearer $ADMIN_API_KEY
```

## Slack App config

Enable Interactivity.

Request URL:

```text
https://YOUR_DOMAIN/webhooks/slack/interactions
```

Bot scopes:

- `chat:write`
- `commands` not required

Install the app to the workspace and invite the bot to the approval channel.

## LINE / LINE Harness config

If using direct LINE webhook:

```text
https://YOUR_DOMAIN/webhooks/line
```

If existing LINE Harness is already set up, forward normalized payloads to:

```text
https://YOUR_DOMAIN/line-harness/inbound
```

Supported normalized payload:

```json
{
  "lineUserId": "Uxxxx",
  "displayName": "山田太郎",
  "text": "日程はいつですか？",
  "messageType": "text",
  "rawPayload": {}
}
```

The endpoint also accepts native LINE webhook `events` format.

## Run

```bash
npm run dev
```

Production:

```bash
npm run build
npm run start
```

Health check:

```text
GET /health
```

## Immediate MVP test

See `MVP_TEST_PLAN.md` for the step-by-step test plan.

1. Send a LINE message from a test user.
2. Confirm Slack receives a `LINE問い合わせ対応` approval message.
3. Click `修正依頼` with a comment and confirm a new approval card is posted.
4. Click `承認して送信` on the final card.
5. Confirm the LINE user receives the draft.
6. Confirm Supabase has:
   - incoming `messages`
   - `reply_drafts.status = sent`
   - `approvals.action = approve`
   - outgoing `messages`
