# Jinzai LINE Agent

Slack承認型のLINE学生対応AI MVPです。

## What this implements

- LINE / LINE Harness inbound webhook
- Supabase persistence
- OpenClaw draft generation hook, with safe local fallback
- Slack approval UI with customer LINE name/ID, status, classification, risk, recent conversation history, and proposed reply; missing LINE names are enriched from LINE Harness friend data or the LINE profile API when available
- `承認して送信` -> LINE automatic send
- `編集して送信` -> Slack modal -> LINE send
- `修正依頼` -> OpenClaw/fallback再ドラフト -> 新しいSlack承認カード投稿
- `人間対応` / `却下`
- Supabase approval and outgoing-message logs
- LINE delivery-attempt logs with failed-send retry from Slack
- Appointment extraction placeholder and `appointments` persistence
- Knowledge lookup from approved/manual support answers
- Monthly rule lookup for changing answers like payment dates or next-month schedules
- Message templates for stable category-specific reply wording
- Application-based workflow automation for same-day reminders, post-participation forms, and TS/bank-account forms
- Google Sheets sync/writeback for the operator ledger, with configurable column names and dry-run mode
- First LINE replies can auto-link `lineUserId` to Sheets rows by matching student name, furigana, or LINE display name
- Low-risk `確認しました` / `確認できました` / `回答しました` replies can be auto-processed while ambiguous or risky replies still go to Slack for human confirmation
- Optional LINE Harness tag mirroring for operator visibility; Supabase remains the source of truth

## Flow

LINE inbound -> Supabase -> workflow classification -> auto-send for low-risk fixed replies, otherwise OpenClaw/fallback draft -> Slack approval/edit/revision -> LINE send -> Supabase log -> optional Sheets writeback

Draft generation uses, in this order:

1. the current LINE message
2. recent conversation history
3. matching `knowledge_items`
4. matching `monthly_rules` for “今月” / “来月” / explicit month questions

General inquiries stay Slack approval-first. Workflow replies that clearly match `確認しました`, `確認できました`, or `回答しました` are treated as low risk and can be auto-sent; use `LINE_SEND_DRY_RUN=true` while testing.

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
- `LINE_HARNESS_TAG_SYNC_ENABLED` / `LINE_HARNESS_TAG_SYNC_URL` for optional LINE Harness tag mirroring
- `LINE_SEND_DRY_RUN=true` to record planned LINE sends without sending
- `LINE_MARK_AS_READ_ENABLED=true` to mark the triggering LINE user message as read after a successful reply when the inbound webhook includes `message.markAsReadToken`
- `CUSTOMER_SHEET_SPREADSHEET_ID=1-f4cXz1hdN0GCljxgXP88dQpAzYlsGa27TNxPWqTRKI`
- `CUSTOMER_SHEET_TAB_NAME=顧客管理シート`
- `CUSTOMER_SHEET_HEADER_ROW=3` when the customer sheet has memo/title rows above the actual header row
- `GOOGLE_SHEETS_SPREADSHEET_ID` / `GOOGLE_SHEETS_TAB_NAME` as backward-compatible aliases
- `GOOGLE_SHEETS_HEADER_ROW` as the backward-compatible alias for the customer sheet header row
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `SHEETS_COLUMN_MAP_JSON`
- `SHEETS_DRY_RUN=true` to preview all Sheets writes
- `SHEETS_WRITE_DRY_RUN=true` to preview Sheets writeback without writing
- `PARTICIPATION_FORM_SPREADSHEET_ID=1z721QOp_v5TPnmebQ4H6NPj6uFPuz_iZHl0sMo8t4c0`
- `PARTICIPATION_FORM_TAB_NAME=フォームの回答 1`
- `PARTICIPATION_FORM_HEADER_ROW=1`
- `POST_PARTICIPATION_RESPONSES_SPREADSHEET_ID` / `POST_PARTICIPATION_RESPONSES_TAB_NAME` as backward-compatible aliases
- `POST_PARTICIPATION_RESPONSES_HEADER_ROW` as the backward-compatible alias for the participation response sheet header row
- `POST_PARTICIPATION_RESPONSE_COLUMN_MAP_JSON`
- `BANK_FORM_SPREADSHEET_ID=1OjTGevowSpSQJH70ad4m_dBjHSJs2dMOUYaMWeHmi2Q`
- `BANK_FORM_TAB_NAME=フォームの回答 1`
- `BANK_FORM_HEADER_ROW=1`
- `BANK_ACCOUNT_RESPONSES_SPREADSHEET_ID` / `BANK_ACCOUNT_RESPONSES_TAB_NAME` as backward-compatible aliases
- `BANK_ACCOUNT_RESPONSES_HEADER_ROW` as the backward-compatible alias for the bank response sheet header row
- `BANK_ACCOUNT_RESPONSE_COLUMN_MAP_JSON`
- `POST_PARTICIPATION_FORM_URL`
- `BANK_ACCOUNT_FORM_URL`
- `WORKFLOW_TIMEZONE=Asia/Tokyo`
- `SAME_DAY_REMINDER_OFFSET_HOURS=2`
- `POST_FORM_DELAY_HOURS=2`

If `OPENCLAW_AGENT_URL` is empty, the app uses a conservative heuristic draft generator so the approval loop still works.

## Supabase

Run `supabase/schema.sql` in Supabase SQL editor.

If the database already has the earlier MVP schema, you can run only the additive migration in `supabase/ops-hardening-2026-05-19.sql`.

For workflow automation on an existing database, also run `supabase/workflow-automation-2026-05-20.sql`.

Optional for a quick first test: run `supabase/seed-mvp.sql` after editing the placeholder monthly values.

The schema includes:

- `clients`
- `students`
- `conversations`
- `messages`
- `reply_drafts`
- `approvals`
- `slack_reviews`
- `delivery_attempts`
- `appointments`
- `referral_applications`
- `application_workflow_states`
- `student_registration_states`
- `student_workflow_states`
- `workflow_jobs`
- `knowledge_items`
- `monthly_rules`
- `message_templates`

`appointments` includes:

- `appointment_type`
- `scheduled_at`

`student_workflow_states` remains for compatibility with the first MVP. New automation uses `referral_applications` and `application_workflow_states`, because one student can have multiple agent applications.

## Workflow automation

Workflow status is stored in Supabase per application, not per student. LINE Harness tags are only mirrored for human operators when enabled.

Current status values:

- `interested`
- `schedule_pending`
- `application_info_collecting`
- `pre_caution_sent`
- `pre_caution_confirmation_waiting`
- `pre_caution_confirmed`
- `same_day_reminder_pending`
- `same_day_reminder_sent`
- `post_participation_form_waiting`
- `bank_form_send_pending`
- `bank_account_waiting`
- `payment_ready`
- `human_required`

Sheets is treated as `1 row = 1 application`. Default recommended columns:

- `顧客ID`
- `進捗状況`
- `記入日`
- `送客者`
- `名前`
- `フリガナ`
- `LINE名`
- `大学名`
- `卒業予定年度`
- `予約日`
- `予約時間`
- `集客チャネル`
- `着座目的`
- `案件名称`
- `着座単価（売上）`
- `LINEユーザーID`
- `当日リマインド送信日時`
- `参加確認フォーム送信日時`
- `参加確認フォーム回答日時`
- `TS/銀行口座フォーム送信日時`
- `TS/銀行口座フォーム回答日時`
- `最終LINE送信日時`
- `Slack通知日時`
- `エラー内容`
- `備考`

If the production sheet uses different headers, set `SHEETS_COLUMN_MAP_JSON`. Only the headers you want to override are needed:

```json
{
  "applicationId": "顧客ID",
  "lineUserId": "LINE ID",
  "studentName": "名前",
  "studentFurigana": "氏名カナ",
  "lineDisplayName": "LINE表示名",
  "reservationDate": "予約日",
  "reservationTime": "予約時間",
  "agentName": "案件名称"
}
```

The built-in defaults treat `顧客ID` as `application_id`, `進捗状況` as the current status, `予約日 + 予約時間` as the participation datetime, and `案件名称` as the agent/project name. `自動送信対象` and `人間対応フラグ` are not required; auto-send eligibility is derived from status, LINE user ID, and reservation datetime.

If the customer sheet has title or memo rows above the real header row, set `CUSTOMER_SHEET_HEADER_ROW` instead of deleting those rows. For the current production sheet layout, use:

```env
CUSTOMER_SHEET_HEADER_ROW=3
```

The default column reader also accepts common variants such as `申込ID` for `顧客ID`, `Line ユーザーID` for `LINEユーザーID`, and `（フリガナ）` for `フリガナ`. Use `SHEETS_COLUMN_MAP_JSON` when the sheet uses a different label.

LINEユーザーIDは原則として手入力不要です。初回LINE受信時に `lineUserId`, `displayName`, `text` を使って Sheets の `名前` / `フリガナ` / `LINE名` を照合します。

- 一意一致: 同じ名前、同じフリガナ、または同じLINE名の申込行すべてに `LINEユーザーID` を書き戻し、Supabaseにも同期します。
- 複数一致: Slackに候補一覧と `候補に紐づけ` ボタンを出します。
- 不一致: Slackに未紐づけ通知を出します。

`SHEETS_DRY_RUN=true` または `SHEETS_WRITE_DRY_RUN=true` の間は、Sheetsへの書き戻しはプレビュー扱いですが、通常のSheets同期やLINE受信処理の検証はできます。

Sync Sheets into Supabase:

```text
POST /sheets/sync
Authorization: Bearer $ADMIN_API_KEY
```

Use `{"dryRun": true}` or pass test `rows` in the body to preview without writing DB rows.

Write Supabase status/timestamps back to Sheets:

```text
POST /sheets/writeback
Authorization: Bearer $ADMIN_API_KEY
```

`SHEETS_WRITE_DRY_RUN=true` makes this endpoint return planned cell updates without touching the production sheet.

Sync existing Google Form response sheets:

```text
POST /sheets/sync-form-responses
Authorization: Bearer $ADMIN_API_KEY
```

This does not use prefilled Google Form URL parameters. Existing form URLs stay unchanged, and the app reads the response sheets instead.

参加確認フォーム回答は管理シートの申込行へ照合します。優先順位:

1. `名前 + 案件名称 + 参加日`
2. `名前 + 参加日`
3. `フリガナ + 案件名称 + 参加日`
4. `名前 + 案件名称`

TS/銀行口座フォーム回答は学生単位で照合します。優先順位:

1. `名前 + フリガナ`
2. `名前 + 大学名`
3. `フリガナ + 大学名`
4. `名前のみ`

一意に決まる場合だけ自動更新します。複数候補または一致なしの場合はSlackへ確認通知を送ります。回答シート列名が違う場合は、各 `*_COLUMN_MAP_JSON` で差し替えできます。

Rebuild scheduled jobs from current applications:

```text
POST /workflow/rebuild-jobs
Authorization: Bearer $ADMIN_API_KEY
```

This creates idempotent application-level jobs:

- `pre_participation_caution`: posts a Slack approval card once the application is ready; LINE is sent only after `承認して送信` or `編集して送信`
- `same_day_participation_reminder`: participation time minus `SAME_DAY_REMINDER_OFFSET_HOURS`
- `post_participation_form`: participation time plus `POST_FORM_DELAY_HOURS`

Run due jobs from Render Cron or another scheduler:

```text
POST /workflow/tick
Authorization: Bearer $ADMIN_API_KEY
```

Use `{"dryRun": true}` to render planned LINE messages without sending. A typical Render Cron can call `/workflow/tick` every 5-15 minutes. Templates with `send_mode=approval_required` are not sent directly; `/workflow/tick` posts a Slack card and stores the rendered text, template key/version, Slack message location, and later approval metadata on the workflow job.

For Render Cron Jobs, use the bundled runner so API keys are read from cron environment variables and never placed in the command:

```bash
npm run cron:ops
```

Recommended cron env:

```text
ADMIN_API_KEY=<same value as the web service>
CRON_BASE_URL=https://jinzai-line-agent.onrender.com
CRON_DRY_RUN=false
WORKFLOW_TICK_LIMIT=20
```

`cron:ops` runs Sheets sync, form-response sync, job rebuild, and workflow tick in that order. For split schedules, use `cron:sheets-sync`, `cron:sync-form-responses`, `cron:rebuild-jobs`, and `cron:workflow-tick`.

List valid statuses:

```text
GET /workflow/statuses
Authorization: Bearer $ADMIN_API_KEY
```

Workflow templates seeded by the workflow migration:

- `pre_participation_caution` with `send_mode=approval_required`
- `same_day_reminder` with `send_mode=auto_send`
- `post_participation_form`
- `bank_account_form`
- `confirm_ack_reply`
- `answered_ack_reply`

Template rows include `key`, `title`, `body`, `version`, `status`, `send_mode`, `updated_by`, `approved_by`, and `approved_at`. Delivery attempts store `template_key` and `template_version` so later audits can see exactly which wording was sent.

## Knowledge, monthly rules, and templates

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

Create or update a reusable message template. Updating creates the next template version for future sends:

```bash
curl -X POST https://YOUR_DOMAIN/message-templates \
  -H "authorization: Bearer $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"key":"same_day_reminder","title":"参加当日リマインド","category":"workflow","body":"参加当日になりました！再度、注意事項なども確認してご参加いただければと思います！\n引き続きよろしくお願いいたします！","priority":170,"sendMode":"auto_send","updatedBy":"operator"}'
```

Approve a template row after review:

```bash
curl -X POST https://YOUR_DOMAIN/message-templates/pre_participation_caution/approve \
  -H "authorization: Bearer $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"approvedBy":"operator"}'
```

List approved-reply candidates that can be turned into knowledge:

```text
GET /knowledge/candidates
Authorization: Bearer $ADMIN_API_KEY
```

List active templates:

```text
GET /message-templates
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
  "markAsReadToken": "optional-line-read-token",
  "messageType": "text",
  "rawPayload": {}
}
```

The endpoint also accepts native LINE webhook `events` format. If LINE Harness forwards the native `message.markAsReadToken`, the app stores it on the incoming message and performs a best-effort `POST https://api.line.me/v2/bot/chat/markAsRead` after a successful Slack-approved or low-risk auto reply. This requires `LINE_CHANNEL_ACCESS_TOKEN`; failures to mark as read are logged as warnings and do not turn a successful LINE send into a failed send.

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
   - `delivery_attempts.status = success`
   - outgoing `messages`

Failure-path check: temporarily unset LINE send credentials, click approve, confirm Slack shows `同じ文面で再送`, `reply_drafts.status = send_failed`, `approvals.action = approve_send_failed`, and `delivery_attempts.status = failed`.
